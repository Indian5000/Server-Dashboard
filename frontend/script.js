const API_BASE = (window.API_BASE || "http://localhost:8000").replace(/\/$/, "");
const ENDPOINT = `${API_BASE}/server/system`;
const REFRESH_INTERVAL_MS = 2000;

const el = (id) => document.getElementById(id) || { textContent: '', style: {}, classList: { remove: () => { }, add: () => { } } };
const nodes = {
  cpuValue: el("cpuValue"),
  cpuBar: el("cpuBar"),
  cpuTempValue: el("cpuTempValue"),
  cpuTempBar: el("cpuTempBar"),
  cpuIcon: el("cpuIcon"),
  memoryValue: el("memoryValue"),
  memoryBar: el("memoryBar"),
  swapValue: el("swapValue"),
  swapBar: el("swapBar"),
  diskValue: el("diskValue"),
  diskBar: el("diskBar"),
  uptimeValue: el("uptimeValue"),
  batteryValue: el("batteryValue"),
  batteryNote: el("batteryNote"),
  networkValue: el("networkValue"),
  networkNote: el("networkNote"),
  overallState: el("overallState"),
  overallHint: el("overallHint"),
  connectionStatus: el("connectionStatus"),
  lastUpdated: el("lastUpdated"),
  refreshBtn: el("refreshBtn"),
  endpointValue: el("endpointValue"),
};
function showBiscuit(message, level, time) {

}
nodes.endpointValue.textContent = ENDPOINT;

let inFlight = null;
/* Toast Biscuit Logic*/
const biscuitIcons = {
  success: `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52" class="toast__icon"><style>.checkmark__circle { stroke-dasharray: 166; stroke-dashoffset: 166; stroke-width: 2; stroke-miterlimit: 10; stroke: #7ac142; fill: none; animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards; } .checkmark__check { transform-origin: 50% 50%; stroke-dasharray: 48; stroke-dashoffset: 48; stroke-width: 3; stroke: #7ac142; fill: none; animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.4s forwards; } @keyframes stroke { 100% { stroke-dashoffset: 0; } }</style><circle class="checkmark__circle" cx="26" cy="26" r="25"/><path class="checkmark__check" d="M14.1 27.2l7.1 7.2 16.7-16.8"/></svg>
    `,

  warning: `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52" class="toast__icon"><style>.warn__outline { stroke-dasharray: 140; stroke-dashoffset: 140; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; stroke: var(--accent2, #e5a000); fill: none; animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards; } .warn__line { stroke-dasharray: 20; stroke-dashoffset: 20; stroke-width: 3; stroke-linecap: round; stroke: var(--accent2, #e5a000); fill: none; animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.4s forwards; } .warn__dot { stroke-dasharray: 5; stroke-dashoffset: 5; stroke-width: 3; stroke-linecap: round; stroke: var(--accent2, #e5a000); fill: none; animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.6s forwards; } @keyframes stroke { 100% { stroke-dashoffset: 0; } }</style><path class="warn__outline" d="M26 8 L46 42 L6 42 Z"/><path class="warn__line" d="M26 18 L26 30"/><path class="warn__dot" d="M26 36 L26 36.1"/></svg>
    `,

  error: `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52" class="toast__icon"><style>.error__circle { stroke-dasharray: 166; stroke-dashoffset: 166; stroke-width: 2; stroke-miterlimit: 10; stroke: var(--accent3, #e54b00); fill: none; animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards; } .error__line { stroke-dasharray: 48; stroke-dashoffset: 48; stroke-width: 3; stroke-linecap: round; stroke: var(--accent3, #e54b00); fill: none; } .error__line1 { animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.4s forwards; } .error__line2 { animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.6s forwards; } @keyframes stroke { 100% { stroke-dashoffset: 0; } }</style><circle class="error__circle" cx="26" cy="26" r="25"/><path class="error__line error__line1" d="M16 16 L36 36"/><path class="error__line error__line2" d="M36 16 L16 36"/></svg>
    `,

  info: `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52" class="toast__icon"><style>.info__circle { stroke-dasharray: 166; stroke-dashoffset: 166; stroke-width: 2; stroke-miterlimit: 10; stroke: var(--blue, #00b4e5); fill: none; animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards; } .info__line { stroke-dasharray: 20; stroke-dashoffset: 20; stroke-width: 3; stroke-linecap: round; stroke: var(--blue, #00b4e5); fill: none; animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.4s forwards; } .info__dot { stroke-dasharray: 5; stroke-dashoffset: 5; stroke-width: 3; stroke-linecap: round; stroke: var(--blue, #00b4e5); fill: none; animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.6s forwards; } @keyframes stroke { 100% { stroke-dashoffset: 0; } }</style><circle class="info__circle" cx="26" cy="26" r="25"/><path class="info__dot" d="M26 14 L26 14.1"/><path class="info__line" d="M26 22 L26 36"/></svg>
    `
};
const toastBiscuit = document.querySelector(".toastBiscuit");

function showBiscuit(message, level = "info", time = 3000) {

  const toast = document.createElement("div");
  toast.className = "toast";
  const icon = biscuitIcons[level] || biscuitIcons.info;
  toast.innerHTML = `
        ${icon}
        <div class="toast__message">${message}</div>
    `;
  const outDelay = Math.max(0, time - 600);
  toast.style.animation = `toast-in .35s cubic-bezier(.22,1,.36,1), toast-out .6s ease ${outDelay}ms forwards`;
  let timer = null;
  if (time >= 1000) {
    timer = document.createElement("div");
    timer.className = "toast__timer";
    toast.appendChild(timer);
  }
  if (timer) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        timer.style.transition = `transform ${time}ms linear`;
        timer.style.transform = "scaleX(0)";
      });
    });
  }
  toastBiscuit.appendChild(toast);


  setTimeout(() => {
    toast.remove();
  }, time);
}
/* Hamburga Logic */
const drawer = document.getElementById("drawer");
const menuBtn = document.getElementById("menuBtn");
const backdrop = document.getElementById("drawerBackdrop");

menuBtn.addEventListener("click", () => {
  drawer.classList.toggle("drawer--open");
  menuBtn.classList.toggle("active");
  backdrop.classList.toggle("drawer-backdrop--visible");
});
backdrop.addEventListener("click", () => {
  drawer.classList.remove("drawer--open");
  backdrop.classList.remove("drawer-backdrop--visible");
  menuBtn.classList.remove("active");
});
function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(100, Math.max(0, num));
}

function formatBytes(bytes, decimals = 1) {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatBattery(value) {
  if (value === null || value === undefined || value === "") return "Unavailable";
  const num = Number(value);
  return Number.isFinite(num) ? `${Math.round(num)}%` : "Unavailable";
}

function setProgress(bar, value) {
  const pct = clampPercent(value);
  bar.style.width = pct === null ? "0%" : `${pct}%`;
  bar.classList.remove("bar--ok", "bar--warn", "bar--crit", "bar--null");
  if (pct === null) {
  } else if (pct >= 85) {
    bar.classList.add("bar--crit")
  } else if (pct >= 60) {
    bar.classList.add("bar--warn")
  } else {
    bar.classList.add("bar--ok")
  }
}

function setMetric(valueNode, barNode, rawValue) {
  const pct = clampPercent(rawValue);
  valueNode.textContent = pct === null ? "—" : `${Math.round(pct)}%`;
  setProgress(barNode, pct);
}

function prettyUpdatedAt(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function updateStatus(state, message) {
  nodes.connectionStatus.classList.remove("status-loading", "status-online", "status-offline");
  nodes.connectionStatus.classList.add(`status-${state}`);
  nodes.connectionStatus.querySelector(".status-pill__text").textContent = message;
}

function networkText(network) {
  if (!network || typeof network !== "object") return "Network unavailable";
  const upload = network.upload ?? "—";
  const download = network.download ?? "—";
  return `↑ ${upload} / ↓ ${download}`;
}

function overallCopy(cpu, memory, disk) {
  const highest = Math.max(cpu ?? 0, memory ?? 0, disk ?? 0);
  if (highest >= 90) return ["High load detected", "One or more resources are under heavy pressure."];
  if (highest >= 70) return ["Moderate load", "Usage is elevated but still within a manageable range."];
  return ["System healthy", "Resource usage is currently within a comfortable range."];
}

function updateCpuHeat(load, temp) {
  const icon = nodes.cpuIcon;
  icon.classList.remove('heat-1', 'heat-2', 'heat-3', 'heat-4');
  const score = (temp !== null && temp !== undefined)
    ? (load * 0.5 + (temp / 100) * 100 * 0.5)
    : load;
  if (score >= 90) icon.classList.add('heat-4');
  else if (score >= 75) icon.classList.add('heat-3');
  else if (score >= 40) icon.classList.add('heat-1');
}

async function fetchSystemInfo() {
  if (inFlight) inFlight.abort();
  inFlight = new AbortController();

  const timeout = setTimeout(() => inFlight.abort(), 7000);

  try {
    updateStatus("loading", "Refreshing…");
    const response = await fetch(ENDPOINT, {
      method: "GET",
      signal: inFlight.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    setMetric(nodes.cpuValue, nodes.cpuBar, data.cpu);
    const temp = data.cpu_temp ?? null;
    nodes.cpuTempValue.textContent = temp !== null ? `${Math.round(temp)}°C` : 'N/A';
    setProgress(nodes.cpuTempBar, temp !== null ? (temp / 100) * 100 : null);
    updateCpuHeat(data.cpu, temp);
    setMetric(nodes.memoryValue, nodes.memoryBar, data.memory);
    setMetric(nodes.swapValue, nodes.swapBar, data.swap);

    // Render dynamic disk drives
    const diskContainer = document.getElementById("diskMetricsContainer");
    if (diskContainer && data.drives) {
      diskContainer.innerHTML = '';
      data.drives.forEach(drive => {
        const tempStr = drive.temp !== null ? `${Math.round(drive.temp)}°C` : 'N/A';
        const tempPct = drive.temp !== null ? Math.min(100, (drive.temp / 100) * 100) : 0;
        const tempClass = drive.temp >= 75 ? 'bar--crit' : drive.temp >= 50 ? 'bar--warn' : 'bar--ok';
        const usageClass = drive.percent >= 90 ? 'bar--crit' : drive.percent >= 75 ? 'bar--warn' : 'bar--ok';

        const maxSpeed = 500 * 1024 * 1024; // Visual cap at 500 MB/s
        const readPct = Math.min(100, (drive.read_speed / maxSpeed) * 100);
        const writePct = Math.min(100, (drive.write_speed / maxSpeed) * 100);

        const driveHtml = `
                <div class="disk-drive">
                    <div class="disk-drive__header">
                        <span class="disk-drive__name">${drive.device} (${drive.mountpoint})</span>
                        <span class="status-pill status-${drive.status.toLowerCase()}" style="margin-left: .5rem; padding: .1rem .4rem;">
                            <span class="status-pill__dot"></span>
                        </span>
                        <span class="disk-drive__health">SMART: ${drive.health || 'N/A'}</span>
                    </div>
                    
                    <div class="hcard__row">
                        <span class="hcard__label">USAGE</span>
                        <div class="hcard__bar-wrap">
                            <div class="hcard__bar ${usageClass}" style="width: ${drive.percent}%"></div>
                        </div>
                        <span class="hcard__val">${Math.round(drive.percent)}% (${formatBytes(drive.used, 0)}/${formatBytes(drive.total, 0)})</span>
                    </div>
                    
                    <div class="hcard__row">
                        <span class="hcard__label">TEMP</span>
                        <div class="hcard__bar-wrap">
                            <div class="hcard__bar ${tempClass}" style="width: ${tempPct}%"></div>
                        </div>
                        <span class="hcard__val">${tempStr}</span>
                    </div>
                    
                    <div class="hcard__row" style="margin-top: .75rem; margin-bottom: .25rem;">
                        <span class="hcard__label" style="width: auto;">R/W SPEED</span>
                        <div style="flex: 1;"></div>
                        <span style="font-family: var(--mono); font-size: .85rem; color: var(--text);">
                            R: ${formatBytes(drive.read_speed)}/s | W: ${formatBytes(drive.write_speed)}/s
                        </span>
                    </div>
                    
                    <div class="disk-drive__stats" style="font-size: .8rem; color: var(--text); padding-top: .25rem;">
                        Total Read: ${formatBytes(drive.total_read)} | Total Write: ${formatBytes(drive.total_write)}
                    </div>
                </div>
            `;
        diskContainer.insertAdjacentHTML('beforeend', driveHtml);
      });
    }

    nodes.uptimeValue.textContent = data.uptime ?? "—";
    nodes.batteryValue.textContent = formatBattery(data.battery);
    nodes.networkValue.textContent = networkText(data.network);
    nodes.networkNote.textContent = data.network
      ? "Upload and download speeds are reported by the backend."
      : "Network data is unavailable from the backend.";
    nodes.batteryNote.textContent =
      data.battery === null || data.battery === undefined
        ? "Battery data unavailable on this device."
        : "Battery level reported by the backend.";

    const [state, hint] = overallCopy(data.cpu, data.memory, data.disk);
    nodes.overallState.textContent = state;
    nodes.overallHint.textContent = hint;

    nodes.lastUpdated.textContent = prettyUpdatedAt();
    updateStatus("online", "Live");
    //showBiscuit("REMOVE ME", "info", 3000);
  } catch (error) {
    if (error.name === "AbortError") {
      nodes.overallState.textContent = "Request timed out";
      nodes.overallHint.textContent = "The backend did not answer within the timeout window.";
    } else {
      nodes.overallState.textContent = "Backend unavailable";
      nodes.overallHint.textContent = "Check that FastAPI is running and the endpoint is reachable.";
    }

    updateStatus("offline", "Offline");
  } finally {
    clearTimeout(timeout);
  }
}

nodes.refreshBtn.addEventListener("click", fetchSystemInfo);

fetchSystemInfo();
setInterval(fetchSystemInfo, REFRESH_INTERVAL_MS);
