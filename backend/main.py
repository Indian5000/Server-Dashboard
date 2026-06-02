import psutil, time
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
last_network = psutil.net_io_counters()
last_time = time.time()


def format_speed(value):

    units = ["B/s", "KB/s", "MB/s", "GB/s"]

    for unit in units:

        if value < 1024:
            return f"{round(value, 2)} {unit}"

        value /= 1024

    return f"{round(value, 2)} TB/s"
@app.get("/server/system")
def systeminfo():
    cpu = psutil.cpu_percent(interval=1)
    memory = psutil.virtual_memory().percent
    swap_mem = psutil.swap_memory().percent
    disk = psutil.disk_usage("/").percent
    network = (psutil.net_io_counters().bytes_sent+ psutil.net_io_counters().bytes_recv)
    uptime_hr = (time.time() - psutil.boot_time()) // 3600
    uptime_min = ((time.time() - psutil.boot_time())% 3600) // 60
    battery = psutil.sensors_battery()
    battery_percent = (battery.percent if battery else None)
    global last_network
    global last_time

    current_network = psutil.net_io_counters()
    current_time = time.time()

    elapsed = current_time - last_time

    upload_speed = (
        current_network.bytes_sent
      - last_network.bytes_sent
    ) / elapsed

    download_speed = (
     current_network.bytes_recv
       - last_network.bytes_recv
    ) / elapsed

    last_network = current_network
    last_time = current_time
    return {
        "cpu": cpu,
        "memory": memory,
        "swap": swap_mem,
        "disk": disk,
        "network": {"upload": format_speed(upload_speed), 
                    "download": format_speed(download_speed)},
        "uptime":f"{int(uptime_hr)}h {int(uptime_min)}m",
        "battery": battery_percent
     }