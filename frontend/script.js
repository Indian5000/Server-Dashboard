const API_BASE = (window.API_BASE || "http://localhost:8000").replace(/\/$/, "");
const ENDPOINT = `${API_BASE}/server/system`;
const REFRESH_INTERVAL_MS = 2000;

const el = (id) => document.getElementById(id);
const nodes = {
  cpuValue: el("cpuValue"),
  cpuBar: el("cpuBar"),
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

nodes.endpointValue.textContent = ENDPOINT;

let inFlight = null;

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
  if (pct === null) {
    bar.style.background = "linear-gradient(90deg, #64748b, #94a3b8)";
  } else if (pct >= 85) {
    bar.style.background = "linear-gradient(90deg, #ef4444, #f97316)";
  } else if (pct >= 60) {
    bar.style.background = "linear-gradient(90deg, #f59e0b, #facc15)";
  } else {
    bar.style.background = "linear-gradient(90deg, #60a5fa, #34d399)";
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
  nodes.connectionStatus.textContent = message;
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
