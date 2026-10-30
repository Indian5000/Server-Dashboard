import base64
import glob
import json
import logging
import os
import platform
import re
import socket
import subprocess
import sys
import threading
import time
import datetime
from collections import deque
from contextlib import asynccontextmanager
import psutil
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from auth import current_user, router as auth_router

log= logging.getLogger("syspulse")

IS_WINDOWS=os.name=="nt"
IS_LINUX=sys.platform.startswith("linux")

@asynccontextmanager
async def lifespan(_app):
    _start_heartbeat()
    _start_sampler()
    yield


app = FastAPI(lifespan=lifespan, root_path=os.getenv("ROOT_PATH", ""))

app.add_middleware(
    CORSMiddleware,
    # Tokens travel in the Authorization header (no cookies), so "*" is safe here.
    # When exposing the dashboard beyond your LAN, list your real origin instead,
    # e.g. allow_origins=["https://dash.example.com"].
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(auth_router)  # /auth/* and /users*

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

_net_last_rates = (0.0, 0.0)


def _net_rates():
    """(upload, download) in bytes/s since the previous call, by anyone."""
    global _last_network, _last_net_time, _net_last_rates
    with _net_lock:
        now = time.time()
        elapsed = now - _last_net_time
        if elapsed < 0.5:  # two callers back to back: reuse the last reading
            return _net_last_rates
        cur = psutil.net_io_counters()
        up = max(0.0, (cur.bytes_sent - _last_network.bytes_sent) / elapsed)
        down = max(0.0, (cur.bytes_recv - _last_network.bytes_recv) / elapsed)
        _last_network, _last_net_time = cur, now
        _net_last_rates = (up, down)
        return _net_last_rates


def get_network_speeds():
    up, down = _net_rates()
    return {"upload": format_speed(up), "download": format_speed(down)}


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

# ───────────────────────── History sampler (feeds the click-through graphs) ─────────────────────────
# A background thread records one sample every 5 s (kept for 1 hour) and the
# average of each minute (kept for 24 hours). It runs whether or not anyone has
# the dashboard open. History lives in memory, so it restarts empty with the server.
_SAMPLE_EVERY = 5
_FINE = deque(maxlen=720)      # 720  x  5 s = 1 hour
_COARSE = deque(maxlen=1440)   # 1440 x 60 s = 24 hours
_hist_lock = threading.Lock()
_sampler_started = False
_latest_cores = []             # per-core load for the CPU detail view
_RANGES = {"5m": 300, "30m": 1800, "1h": 3600, "24h": 86400}
_SCALARS = ("cpu", "cpu_temp", "mem", "swap", "net_up", "net_down", "score")
_DRIVE_FIELDS = ("read", "write", "temp", "percent")


def _cpu_busy(prev, cur):
    """Busy % between two psutil.cpu_times() snapshots (same maths psutil uses).
    Done by hand so the sampler never disturbs psutil's own cpu_percent() state."""
    def split(t):
        idle = t.idle + getattr(t, "iowait", 0.0)
        total = sum(t) - getattr(t, "guest", 0.0) - getattr(t, "guest_nice", 0.0)
        return idle, total

    prev_idle, prev_total = split(prev)
    cur_idle, cur_total = split(cur)
    span = cur_total - prev_total
    if span <= 0:
        return 0.0
    return round(max(0.0, min(100.0, (1 - (cur_idle - prev_idle) / span) * 100)), 1)


def _mean(values):
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else None


def _average_samples(samples):
    out = {"t": samples[-1]["t"]}
    for key in _SCALARS:
        out[key] = _mean([s[key] for s in samples])
    ids = {i for s in samples for i in s["drives"]}
    out["drives"] = {
        i: {f: _mean([s["drives"][i][f] for s in samples if i in s["drives"]]) for f in _DRIVE_FIELDS}
        for i in ids
    }
    return out


def _sampler_loop():
    global _latest_cores
    prev_total = psutil.cpu_times()
    prev_cores = psutil.cpu_times(percpu=True)
    recent_cpu = deque(maxlen=5)  # smoothed, like the live health card
    bucket = []
    warned = False
    _prime_processes()
    time.sleep(1)  # first point after 1 s so the graphs fill in quickly
    while True:
        try:
            cur_total = psutil.cpu_times()
            cur_cores = psutil.cpu_times(percpu=True)
            cpu = _cpu_busy(prev_total, cur_total)
            cores = [_cpu_busy(a, b) for a, b in zip(prev_cores, cur_cores)]
            prev_total, prev_cores = cur_total, cur_cores

            vm = psutil.virtual_memory()
            sw = psutil.swap_memory()
            net_up, net_down = _net_rates()
            drives = get_drives()
            cpu_temp = get_cpu_temp()
            battery = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None

            recent_cpu.append(cpu)
            health = evaluate_health(sum(recent_cpu) / len(recent_cpu), vm.percent, sw.percent,cpu_temp, drives, battery)
            sample = {
                "t": time.time(),
                "cpu": cpu,
                "cpu_temp": cpu_temp,
                "mem": vm.percent,
                "swap": sw.percent,
                "net_up": net_up,
                "net_down": net_down,
                "score": health["score"],
                "drives": {
                    d["id"]: {"read": d["read_speed"], "write": d["write_speed"],
                              "temp": d["temp"], "percent": d["percent"]}
                    for d in drives
                },
            }
            _latest_cores = cores
            bucket.append(sample)
            with _hist_lock:
                _FINE.append(sample)
                if len(bucket) >= 60 // _SAMPLE_EVERY:
                    _COARSE.append(_average_samples(bucket))
                    bucket.clear()
        except Exception:
            if not warned:  # log once, not every 5 s
                log.exception("history sampler error (will keep retrying)")
                warned = True
        time.sleep(_SAMPLE_EVERY)


def _start_sampler():
    global _sampler_started
    with _hist_lock:
        if _sampler_started:
            return
        _sampler_started = True
    threading.Thread(target=_sampler_loop, daemon=True, name="syspulse-sampler").start()


def _to_columns(samples, interval):
    """Row samples -> column arrays, which is what the charts want."""
    ids = sorted({i for s in samples for i in s["drives"]})
    out = {"interval": interval, "t": [round(s["t"], 1) for s in samples]}
    for key in _SCALARS:
        out[key] = [s[key] for s in samples]
    out["drives"] = {
        i: {f: [s["drives"].get(i, {}).get(f) for s in samples] for f in _DRIVE_FIELDS}
        for i in ids
    }
    return out


# ───────────────────────── Detail info (CPU model, per-process usage, ...) ─────────────────────────
_proc_lock = threading.Lock()
_last_proc_call = 0.0


def _prime_processes():
    """psutil needs one earlier call per process before cpu_percent() means anything."""
    for p in psutil.process_iter():
        try:
            p.cpu_percent(None)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass


def _top_processes(n=8):
    global _last_proc_call
    ncpu = psutil.cpu_count() or 1
    with _proc_lock:
        if time.time() - _last_proc_call > 20:  # baseline is stale: take a fresh window
            _prime_processes()
            time.sleep(0.5)
        rows = []
        for p in psutil.process_iter():
            if p.pid == 0:  # Windows "System Idle Process" would top every list
                continue
            try:
                with p.oneshot():
                    rows.append({
                        "pid": p.pid,
                        "name": p.name(),
                        "cpu": round(p.cpu_percent(None) / ncpu, 1),
                        "mem_pct": round(p.memory_percent(), 1),
                        "rss": p.memory_info().rss,
                    })
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        _last_proc_call = time.time()
    return (sorted(rows, key=lambda r: r["cpu"], reverse=True)[:n],
            sorted(rows, key=lambda r: r["rss"], reverse=True)[:n])


def _cpu_model():
    try:
        if IS_LINUX:
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if line.lower().startswith(("model name", "hardware")):
                        return line.split(":", 1)[1].strip()
        if IS_WINDOWS:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
                return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
    except Exception:
        pass
    return platform.processor() or "Unknown CPU"


_cpu_hist = deque(maxlen=5)  # smoothed so one CPU spike doesn't flip the health state
_cpu_lock = threading.Lock()

@app.get("/server/system")
def systeminfo(user: dict = Depends(current_user)):
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
        "cpu_temp": cpu_temp,
        "health": health,
    }


@app.get("/server/history")
def history(window: str = Query("30m", alias="range"), user: dict = Depends(current_user)):
    seconds = _RANGES.get(window)
    if seconds is None:
        raise HTTPException(400, f"range must be one of: {', '.join(_RANGES)}")
    with _hist_lock:
        fine, coarse = list(_FINE), list(_COARSE)
    use_coarse = seconds > 3600 and len(coarse) >= 2
    source, interval = (coarse, 60) if use_coarse else (fine, _SAMPLE_EVERY)
    cutoff = time.time() - seconds
    return _to_columns([s for s in source if s["t"] >= cutoff], interval)


@app.get("/server/detail")
def detail(user: dict = Depends(current_user)):
    vm, sw = psutil.virtual_memory(), psutil.swap_memory()
    freq = None
    try:
        f = psutil.cpu_freq()
        if f:
            freq = {"current": round(f.current), "max": round(f.max) if f.max else None}
    except Exception:
        pass
    try:
        load = [round(x, 2) for x in psutil.getloadavg()]
    except (AttributeError, OSError):
        load = None
    by_cpu, by_mem = _top_processes()
    return {
        "host": {"hostname": socket.gethostname(), "os": platform.platform(terse=True)},
        "cpu": {
            "model": _cpu_model(),
            "physical": psutil.cpu_count(logical=False),
            "logical": psutil.cpu_count(),
            "freq_mhz": freq,
            "load_avg": load,
            "cores": list(_latest_cores),
        },
        "memory": {
            "total": vm.total, "used": vm.used, "available": vm.available,
            "cached": getattr(vm, "cached", None),
            "swap_total": sw.total, "swap_used": sw.used,
        },
        "processes": {"cpu": by_cpu, "memory": by_mem},
    }