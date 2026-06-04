const API_BASE = (window.API_BASE || "http://localhost:8000").replace(/\/$/, "");
const ENDPOINT = `${API_BASE}/server/system`;
const REFRESH_INTERVAL_MS = 2000;

const el = (id) => document.getElementById(id) || { textContent: '', style: {}, classList: { remove: () => {}, add: () => {} } };
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
function showBiscuit(message,level,time) {

}
nodes.endpointValue.textContent = ENDPOINT;

let inFlight = null;
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
  icon.classList.remove('heat-1','heat-2','heat-3','heat-4');
  const score = (temp !== null && temp !== undefined)
    ? (load * 0.5 + (temp/100)*100*0.5)
    : load;
  if (score>=90) icon.classList.add('heat-4');
  else if(score>=75) icon.classList.add('heat-3');
  else if(score>=40) icon.classList.add('heat-1');
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
    const temp=data.cpu_temp ?? null;
    nodes.cpuTempValue.textContent=temp !== null ? `${Math.round(temp)}°C` : 'N/A';
    setProgress(nodes.cpuTempBar, temp !== null ? (temp/100) * 100 : null);
    updateCpuHeat(data.cpu,temp);
    setMetric(nodes.memoryValue, nodes.memoryBar, data.memory);
    setMetric(nodes.swapValue, nodes.swapBar, data.swap);
    setMetric(nodes.diskValue, nodes.diskBar, data.disk);

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
