import base64
import glob
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import datetime
from collections import deque
from contextlib import asynccontextmanager
import psutil
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

log= logging.getLogger("syspulse")

IS_WINDOWS=os.name=="nt"
IS_LINUX=sys.platform.startswith("linux")

@asynccontextmanager
async def lifespan(_app):
    _start_heartbeat()
    yield


app=FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

#Networking logic(bip boop whatever)

_net_lock=threading.Lock()
_last_network=psutil.net_io_counters()
_last_net_time=time.time()

def format_speed(value):
    units=["B/s","KB/s","MB/s","GB/s"]
    for unit in units:
        if value<1024:
            return f"{round(value,2)} {unit}"
        value /= 1024
    return f"{round(value,2)} TB/s"

def get_network_speeds():
    global _last_network, _last_net_time
    with _net_lock:
        now=time.time()
        enlapsed=max(now-_last_net_time,0.001)
        cur=psutil.net_io_counters()
        up=max(0,(cur.bytes_sent-_last_network.bytes_sent)/enlapsed)
        down=max(0,(cur.bytes_recv-_last_network.bytes_recv)/enlapsed)
        _last_network,_last_net_time=cur,now
    return {"upload":format_speed(up),"download":format_speed(down)}


#CPU temperature(You gota cool guy or a overthinkin hot potato finder thingy)

def get_cpu_temp():
    if not hasattr(psutil, "sensors_temperatures"):
        return None
    try:
        temps=psutil.sensors_temperatures()
    except Exception:
        return None
    for key in ("coretemp","k10temp","zenpower","cpu_thermal","acpitz"):
        sensors=temps.get(key)
        if not sensors:
            continue
        for s in sensors:
            if s.label in ("Pacakage id 0","Tctl","Tdie"):
                return s.current
        return sensors[0].current
    return None

#Drive Card(magical spinny bois or silicon stuff that spit out data or something like that)

#OS independent (shared helpers)

def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None

def _natural_key(text):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)",text)]

#Linux drives logic(Bcs Windows and Linux couldent agree on a simgle drive return style)

_LINUX_SKIP=("loop","ram","zram","sr","fd","dm-","md","nbd")

def _linux_temp(name):
    """Drive temp from kernel hwmon, NVME no dependency extra, SATA/SAS require drivetemp for some reason"""
    patterns=(
        f"/sys/block/{name}/device/hwmon/hwmon*/temp1_input",
        f"/sys/block/{name}/device/hwmon*/temp1_input",
        f"/sys/block/{name}/device/nvme*/hwmon*/temp1_input",
    )
    for pattern in patterns:
        for path in sorted(glob.glob(pattern)):
            raw= _read(path)
            if raw and raw.lstrip("-").isdigit():
                return int(raw)/1000.0
    return None

def _linux_disks():
    """Only NVME or HDDs, loop,ram,zram,cdrom and all other crap not supported yet(and wont ever be i think)"""
    disks={}
    try:
        names=os.listdir("/sys/block")
    except OSError:
        return disks
    for name in names:
        if name.startswith(_LINUX_SKIP):
            continue
        if not os.path.exists(f"/sys/block/{name}/device"):
            continue
        size = int(_read(f"/sys/block/{name}/size") or 0)*512
        if size==0:
            continue
        rotational = _read(f"/sys/block/{name}/queue/rotational")
        if name.startswith("nvme"):
            kind = "NVMe"
        else:
            kind="HDD" if rotational == "1" else "SSD"
        disks[name]={
            "id":name,
            "io_key":name,
            "name":_read(f"/sys/block/{name}/device/model") or name,
            "kind": kind,
            "health" : None,
            "size": size,
            "temp": _linux_temp(name),
            "volumes": [],
            "used": 0.0,
        }
    return disks

def _linux_parent_disks(kname,disks,depth=0):
    """Shove partiions into their respective disks"""
    if depth > 8:
        return set()
    sys_path=os.path.realpath(f"/sys/class/block/{kname}")
    if not os.path.isdir(sys_path):
        return set()
    if os.path.exists(os.path.join(sys_path,"partition")):
        sys_path=os.path.dirname(sys_path)
        kname=os.path.basename(sys_path)
    if kname in disks:
        return {kname}
    result =set()
    slaves=os.path.join(sys_path,"slaves")
    if os.path.isdir(slaves):
        for s in os.listdir(slaves):
            result |= _linux_parent_disks(s,disks,depth+1)
    return result

def _linux_fill_usage(disks):
    seen=set()
    for part in psutil.disk_partitions(all=False):
        kname=os.path.basename(os.path.realpath(part.device))
        if kname in seen:
            continue
        parents=_linux_parent_disks(kname,disks)
        if not parents:
            continue
        try:
            usage=psutil.disk_usage(part.mountpoint)
        except OSError:
            continue
        seen.add(kname)
        for p in parents:
            disks[p]["used"]+= usage.used /len(parents)
            disks[p]["volumes"].append(part.mountpoint)


#Windows logic segment (Brought to you by microslop, not really)
_PS_SCRIPT = r"""# use of ai START
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$result = foreach ($d in Get-Disk) {
    $letters = @(Get-Partition -DiskNumber $d.Number | Where-Object { $_.DriveLetter } | ForEach-Object { "$($_.DriveLetter):" })
    $pd = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq [string]$d.Number }
    $rel = $null
    if ($pd) { $rel = $pd | Get-StorageReliabilityCounter }
    [pscustomobject]@{
        number  = [int]$d.Number
        name    = [string]$d.FriendlyName
        size    = [int64]$d.Size
        media   = [string]$pd.MediaType
        bus     = [string]$d.BusType
        health  = [string]$pd.HealthStatus
        temp    = $rel.Temperature
        letters = $letters
    }
}
ConvertTo-Json -InputObject @($result) -Compress -Depth 3
"""#use of ai END

_WIN_TTL=30 #powershell slow as hell, caching topology+temps required otherwise code go boom
_win_cache= {"ts":0.0,"data":[]}
_win_lock=threading.Lock()

def _run_powershell(script, timeout=30):
    encoded=base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    proc= subprocess.run(
        ["powershell.exe", "-NoProfile","-NonInteractive", "-ExecutionPolicy","Bypass","-EncodedCommand",encoded],
        capture_output=True,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW",0),
    )
    return proc.stdout.decode("utf-8-sig",errors="replace")

def _windows_topology():
    with _win_lock:
        if time.time() - _win_cache["ts"]< _WIN_TTL:
            return _win_cache["data"]
        try:
            raw= _run_powershell(_PS_SCRIPT).strip()
            data= json.loads(raw) if raw else[]
            if isinstance(data, dict):
                data=[data]
            _win_cache["data"]=[d for d in data if isinstance(d,dict)]
        except Exception:
            log.exception("PowerShell drive query failed")
        _win_cache["ts"]=time.time()
        return _win_cache["data"]


def _windows_disks():
    disks={}
    for d in _windows_topology():
        num = d.get("number")
        if num is None:
            continue
        letters=d.get("letters")or[]
        if isinstance(letters,str):
            letters=[letters]
        bus,media=d.get("bus") or "",d.get("media") or ""
        if bus=="NVMe":
            kind="NVMe"
        elif media in ("SSD", "HDD"):
            kind=media
        else:
            kind=bus or "Disk"
        key=f"PhysicalDrive{num}"
        disks[key]={
            "id":key,
            "io_key":key,
            "name": d.get("name") or key,
            "kind": kind,
            "health": d.get("health") or None,
            "size": int(d.get("size") or 0),
            "temp": d.get("temp") or None, 
            "volumes":[],
            "used":0.0,
            "_letters":letters,
        }
    return disks


def _windows_fill_usage(disks):
    for disk in disks.values():
        for letter in disk.pop("_letters",[]):
            mount=letter.rstrip("\\")+"\\"
            try:
                usage=psutil.disk_usage(mount)
            except OSError:
                continue
            disk["used"]+=usage.used
            disk["volumes"].append(letter)

#Drive read write speed logic (How fast your information blackboxes are eating or spitting info)

_io_lock=threading.Lock()
_io_state={"t": time.time(),"counters": psutil.disk_io_counters(perdisk=True) or {},"speeds": {}}


def _io_speeds():
    with _io_lock:
        now=time.time()
        dt=now-_io_state["t"]
        if dt<0.5:
            return _io_state["speeds"]
        cur=psutil.disk_io_counters(perdisk=True) or {}
        speeds={}
        for key,c in cur.items():
            prev = _io_state["counters"].get(key)
            if prev:
                speeds[key]=(
                    max(0.0, (c.read_bytes-prev.read_bytes)/dt),
                    max(0.0, (c.write_bytes-prev.write_bytes)/dt),
                )
        _io_state.update(t=now,counters=cur,speeds=speeds)
        return speeds


#Compile and readout(spit out everything we know rn to a dictionary and get it ready to get flown to frontend)

def get_drives():
    if IS_WINDOWS:
        disks= _windows_disks()
        _windows_fill_usage(disks)
    elif IS_LINUX:
        disks=_linux_disks()
        _linux_fill_usage(disks)
    else:
        return[]

    speeds=_io_speeds()
    drives=[]
    for disk in sorted(disks.values(),key=lambda d: _natural_key(d["id"])):
        size=disk["size"]
        used=min(disk["used"],size) if size else disk["used"]
        free= max(size-used,0)
        read_speed,write_speed=speeds.get(disk["io_key"],(0.0,0.0))
        drives.append({
            "id": disk["id"],
            "name": disk["name"],
            "kind":disk["kind"],
            "health":disk["health"],
            "size": size,
            "used": int(used),
            "free": int(free),
            "percent": round(used / size * 100, 1) if size else 0,
            "temp": disk["temp"],
            "volumes": disk["volumes"],
            "read_speed": read_speed,
            "write_speed": write_speed,
        })
    return drives

if IS_WINDOWS: #load up cache so that first request aint slow
    threading.Thread(target=_windows_topology,daemon=True).start()


#-------------Uptime Percentage Thingy--------

_HB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "heartbeats.log")
_HB_INTERVAL = 60
_HB_TOLERANCE = 150
_HB_WINDOW = 7 * 24 * 3600
_hb_lock = threading.Lock()
_hb_started = False
_uptime_cache = {"ts": 0.0, "val": 100.0}

def _load_heartbeats():
    try:
        with open(_HB_FILE) as f:
            return sorted(int(line) for line in f if line.strip().isdigit())
    except OSError:
        return []


def _start_heartbeat():
    global _hb_started
    with _hb_lock:
        if _hb_started:
            return
        _hb_started = True

    cutoff = time.time() - _HB_WINDOW  # drop old history so the file stays small
    keep = [t for t in _load_heartbeats() if t >= cutoff]
    try:
        with open(_HB_FILE, "w") as f:
            f.writelines(f"{t}\n" for t in keep)
    except OSError:
        log.exception("could not prune heartbeat file")

    def loop():
        while True:
            try:
                with open(_HB_FILE, "a") as f:
                    f.write(f"{int(time.time())}\n")
            except OSError:
                log.exception("could not write heartbeat")
            time.sleep(_HB_INTERVAL)

    threading.Thread(target=loop, daemon=True).start()


def get_uptime_percent():
    now = time.time()
    if now - _uptime_cache["ts"] < 30:
        return _uptime_cache["val"]

    beats = [t for t in _load_heartbeats() if t >= now - _HB_WINDOW]
    if not beats or now - beats[0] < 1:
        val = 100.0
    else:
        total = now - beats[0]
        up = 0.0
        for a, b in zip(beats, beats[1:]):
            gap = b - a
            up += gap if gap <= _HB_TOLERANCE else _HB_INTERVAL
        tail = now - beats[-1]
        up += tail if tail <= _HB_TOLERANCE else _HB_INTERVAL
        val = min(100.0, up / total * 100)

    val = round(val, 2)
    _uptime_cache.update(ts=now, val=val)
    return val

#----------Overall Health part----------

_STATES = ["healthy", "fair", "degraded", "unstable", "critical"]
_STATE_LABEL = {"healthy": "Healthy", "fair": "Fair", "degraded": "Degraded",
                "unstable": "Unstable", "critical": "Critical"}
_SEV_WEIGHT = {"info": 5, "warning": 15, "critical": 35}
_SEV_ORDER = {"critical": 0, "warning": 1, "info": 2}


def _level(value, info, warning, critical):
    """Map a reading to a severity using (info, warning, critical) thresholds."""
    if value >= critical:
        return "critical"
    if value >= warning:
        return "warning"
    if info is not None and value >= info:
        return "info"
    return None


def evaluate_health(cpu_avg, memory, swap, cpu_temp, drives, battery):
    issues = []

    def add(severity, source, message):
        if severity:
            issues.append({"severity": severity, "source": source, "message": message})

    add(_level(cpu_avg, 80, 90, 98), "CPU", f"CPU load averaging {cpu_avg:.0f}%")
    if cpu_temp is not None:
        add(_level(cpu_temp, 70, 80, 90), "CPU", f"CPU temperature at {cpu_temp:.0f}°C")
    add(_level(memory, 80, 90, 95), "MEMORY", f"RAM usage at {memory:.0f}%")
    add(_level(swap, 50, 80, 95), "SWAP", f"Swap usage at {swap:.0f}%")

    for d in drives:
        name = d["name"]
        add(_level(d["percent"], 75, 85, 95), "DISK", f"{name} is {d['percent']:.0f}% full")
        if d["temp"] is not None:
            warn, crit = (50, 60) if d["kind"] == "HDD" else (70, 80)
            add(_level(d["temp"], None, warn, crit), "DISK", f"{name} temperature at {d['temp']:.0f}°C")
        status = (d.get("health") or "").strip().lower()
        if status and status != "healthy":
            add("critical" if status == "unhealthy" else "warning", "DISK",
                f"{name} reports health status: {d['health']}")

    if battery is not None and battery.power_plugged is False:
        add(_level(100 - battery.percent, None, 80, 90), "BATTERY",
            f"Running on battery, {battery.percent:.0f}% left")

    score = max(0, 100 - sum(_SEV_WEIGHT[i["severity"]] for i in issues))
    idx = 0 if score >= 90 else 1 if score >= 75 else 2 if score >= 55 else 3 if score >= 35 else 4
    severities = {i["severity"] for i in issues}
    if "critical" in severities:
        idx = max(idx, 3)
    elif "warning" in severities:
        idx = max(idx, 1)

    issues.sort(key=lambda i: _SEV_ORDER[i["severity"]])
    state = _STATES[idx]
    summary = ("All systems nominal" if not issues
    else f"{len(issues)} issue{'s' if len(issues) != 1 else ''} found · score {score}/100")
    return {"state": state, "label": _STATE_LABEL[state], "score": score,
            "summary": summary, "issues": issues}



#----------Endpoint-----------

_cpu_hist = deque(maxlen=5)  # smoothed so one CPU spike doesn't flip the health state
_cpu_lock = threading.Lock()

@app.get("/server/system")
def systeminfo():
    cpu = psutil.cpu_percent(interval=1)
    with _cpu_lock:
        _cpu_hist.append(cpu)
        cpu_avg = sum(_cpu_hist) / len(_cpu_hist)
    memory = psutil.virtual_memory().percent
    swap_mem = psutil.swap_memory().percent

    try:
        drives = get_drives()
    except Exception:
        log.exception("drive collection failed")
        drives = []

    cpu_temp = get_cpu_temp()
    battery = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None

    try:
        health = evaluate_health(cpu_avg, memory, swap_mem, cpu_temp, drives, battery)
    except Exception:
        log.exception("health evaluation failed")
        health = None

    up = time.time() - psutil.boot_time()
    now = datetime.datetime.now().astimezone()

    return {
        "cpu": cpu,
        "memory": memory,
        "swap": swap_mem,
        "drives": drives,
        "network": get_network_speeds(),
        "uptime": f"{int(up // 3600)}h {int((up % 3600) // 60)}m",
        "uptime_seconds": int(up),
        "uptime_percent": get_uptime_percent(),
        "server_time": {
            "epoch": time.time(),
            "utc_offset_min": int(now.utcoffset().total_seconds() // 60),
        },
        "battery": battery.percent if battery else None,
        "cpu_temp": get_cpu_temp(),
        "health": health,
    }