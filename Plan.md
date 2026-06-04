# SysPulse — Implementation Plan

> Based on [AGENTS.md](./AGENTS.md) requirements.
> Last updated: 2026-06-04

---

## Table of Contents

1. [Phase 1 — Bug Fixes](#phase-1--bug-fixes)
2. [Phase 2 — Color / Polish](#phase-2--color--polish)
3. [Phase 3 — Hamburger Side Menu](#phase-3--hamburger-side-menu)
4. [Phase 4 — Backend: New Data](#phase-4--backend-new-data)
5. [Phase 5 — Frontend: New Cards](#phase-5--frontend-new-cards)
6. [Phase 6 — Wiring It Together](#phase-6--wiring-it-together)
7. [Files to Touch — Summary](#files-to-touch--summary)
8. [Research Reference Tables](#research-reference-tables)
9. [Feature Recommendations (vs Beszel)](#feature-recommendations-vs-beszel)
10. [Open Questions](#open-questions)
11. [Stubbed Features Tracker](#stubbed-features-tracker)

---

## Recommended Execution Order

```
Phase 1 (Bug Fixes)  →  quick wins, immediate stability
      ↓
Phase 2 (Polish)     →  fast visual improvement
      ↓
Phase 4 (Backend)    →  build the data pipeline BEFORE the UI
      ↓                  test with: curl http://localhost:8000/server/system
Phase 3 (Hamburger)  →  pure frontend, independent of new data
      ↓
Phase 5 (New Cards)  →  needs backend data from Phase 4
      ↓
Phase 6 (Wiring)     →  final integration pass
```

---

## Phase 1 — Bug Fixes

### Bug 1: Broken HTML quote in Memory card

- **File**: `frontend/index.html`
- **What**: AGENTS.md says there's a `class="hcard__bar-wrap>` with a missing closing `"` before `>`. Check every `class="hcard__bar-wrap"` attribute in the file (lines 50, 57, 76, 83, 102, 109).
- **Why it matters**: A missing closing `"` causes the browser to parse everything until the next `>` as part of the attribute value — swallowing all child elements inside that div. The bar and value spans would vanish.
- **How to find it**: Search for `hcard__bar-wrap` in the file and verify each instance ends with `">` not just `>`.

---

### Bug 2: `updateStatus()` clobbers the status dot

- **File**: `frontend/script.js`
- **Where**: Line 78 — `nodes.connectionStatus.textContent = message;`
- **Problem**: `textContent` replaces **all** child nodes of `#connectionStatus`, including the `<span class="status-pill__dot">` and `<span class="status-pill__text">`. After the first call, the pulsing dot disappears permanently.
- **Fix approach**: Instead of setting `textContent` on the wrapper pill, target only the `.status-pill__text` child element.
- **Concepts to learn**:
  - Difference between `textContent`, `innerText`, and `innerHTML`
  - `Element.querySelector(".class-name")` — grabs the first matching child

---

### Bug 3: Invalid RGBA value in CSS

- **File**: `frontend/style.css`
- **Where**: Line 204 — `.hcard:hover` box-shadow uses `rgba(0,299,160,.04)`
- **Problem**: `299` exceeds the valid 0–255 range for RGB channels. Browsers silently clamp it to 255, but the resulting color won't match the design intent.
- **Fix**: Change `299` → `229` to match `--accent`'s green channel.
- **Concept**: RGBA color model — each RGB channel is an integer from 0 to 255.

---

## Phase 2 — Color / Polish

### 2a. Replace hardcoded hex gradients in `setProgress()` with CSS classes

- **File**: `frontend/script.js`
- **Where**: Lines 47–59 — the `setProgress()` function has 3 gradient branches with 6 hardcoded hex colors:
  - `#ef4444`, `#f97316` (critical — ≥ 85%)
  - `#f59e0b`, `#facc15` (warning — ≥ 60%)
  - `#60a5fa`, `#34d399` (healthy — < 60%)
  - Plus `#64748b`, `#94a3b8` (null/unknown)
- **Approach**:
  1. In `style.css`, create 4 new classes: `.bar--ok`, `.bar--warn`, `.bar--crit`, `.bar--null`
  2. Each class sets `background: linear-gradient(90deg, ...)` using `var(--accent)`, `var(--accent2)`, `var(--accent3)` instead of hex
  3. In JS, remove the `bar.style.background = ...` lines and instead toggle the appropriate class using `element.classList.add()` / `.remove()`
- **Why**: Single source of truth for colors — change `--accent` in one place and everything updates. No more hunting through JS for hardcoded hex values.
- **Concepts to learn**:
  - `element.classList.add()` / `.remove()` / `.toggle()`
  - CSS `var()` function inside `linear-gradient()`
  - Design tokens / CSS custom properties philosophy
---

### 2b. Adjust `--accent` color

- **File**: `frontend/style.css`
- **Where**: Line 16 — `--accent: #00e5a0;`
- **Change to**: `--accent: #00c896;` (less neon, easier on the eyes)
- **Also update**: Line 17 — `--accent-dim` is derived from accent's RGB values.
  - `#00c896` = `rgb(0, 200, 150)` → update to `rgba(0, 200, 150, .12)`
- **Also check**: The `.hcard:hover` box-shadow rgba after Bug 3 is fixed — make sure the green channel (229 → should also become 200) stays in sync. Or better yet, consider using `color-mix()` or just keep 229 as an approximation.

---

### 2c. Reduce scan-line opacity

- **File**: `frontend/style.css`
- **Where**: Line 67 — `opacity: .25;`
- **Change to**: `opacity: .15;`
- **Why**: The scan line is a decorative effect. At .25 it's distractingly bright; .15 keeps the sci-fi feel without pulling attention.

---

## Phase 3 — Hamburger Side Menu

This phase adds 3 new UI systems: hamburger button, slide drawer, and toast notifications.

### 3a. Hamburger button

- **File**: `frontend/index.html`
- **Where**: Inside `.topbar__left` (line 19), add a `<button>` as the **first child** — before the logo.
- **Design options** (pick one):
  - **SVG approach**: An `<svg viewBox="0 0 24 24">` with three `<line>` elements (y=6, y=12, y=18), `stroke="currentColor"`, `stroke-width="2"`, `stroke-linecap="round"`
  - **CSS approach**: A `<button>` containing 3 `<span>` children, each styled as `display: block; height: 2px; width: 18px; background: currentColor;` inside a flex column with `gap: 4px`
- **Styling**: Same style pattern as `.refresh-btn` — `background: none; border: 1px solid var(--border-hi); color: var(--muted);` with hover state changing to `var(--accent)`
- **Concepts to learn**:
  - SVG `<line>` element: `x1`, `y1`, `x2`, `y2`, `stroke`, `stroke-width`, `stroke-linecap`
  - The classic CSS hamburger icon pattern

---

### 3b. Drawer panel

- **File**: `frontend/index.html`
- **Where**: Add a new `<aside>` element just after `</header>` (after line 32), before `<main>`.
- **Structure**:
  ```
  <aside class="drawer" id="drawer">
    <nav class="drawer__nav">
      <!-- 4 nav buttons -->
      <button class="drawer__btn">🐳  Docker Management</button>
      <button class="drawer__btn">📋  Log Review</button>
      <button class="drawer__btn">💻  SSH Terminal</button>
      <button class="drawer__btn">📁  File Manager</button>
    </nav>
    <div class="drawer__divider"></div>
    <div class="drawer__account">
      <!-- avatar circle + username + sign out -->
      <div class="drawer__avatar">A</div>
      <span class="drawer__username">admin</span>
      <button class="drawer__signout">Sign Out</button>
    </div>
  </aside>
  ```
- **CSS** (in `style.css`):
  - `position: fixed; top: var(--topbar-h); left: 0; bottom: 0; width: 260px;`
  - Default: `transform: translateX(-100%)` — hidden off-screen left
  - Open state: `.drawer--open { transform: translateX(0); }`
  - `transition: transform .3s cubic-bezier(.4, 0, .2, 1);` — Material Design standard easing
  - `background: var(--bg-card); border-right: 1px solid var(--border);`
  - `z-index: 15;` — between topbar (20) and bg-grid (0)
  - Display as `flex; flex-direction: column; justify-content: space-between;`
- **Concepts to learn**:
  - CSS `transform: translateX()` for off-screen slide patterns
  - `cubic-bezier(.4, 0, .2, 1)` — what this curve looks like and why it feels smooth
  - `position: fixed` vs `absolute` — fixed stays in viewport regardless of scroll

---

### 3c. Backdrop overlay

- When drawer is open, show a semi-transparent overlay covering the main content.
- **HTML**: Add a `<div class="drawer-backdrop" id="drawerBackdrop">` right after the `<aside>`.
- **CSS**: `position: fixed; inset: 0; background: rgba(0, 0, 0, .5); z-index: 14; opacity: 0; pointer-events: none; transition: opacity .3s;`
- Open state: `.drawer-backdrop--visible { opacity: 1; pointer-events: auto; }`
- **JS**: Click on backdrop → close drawer (remove `.drawer--open` class, remove `.drawer-backdrop--visible` class).
- **Concepts to learn**:
  - CSS `inset: 0` shorthand (equivalent to `top: 0; right: 0; bottom: 0; left: 0;`)
  - `pointer-events: none` to make an element click-through when invisible
# Done till here
---

### 3d. Toast notification system

- **HTML**: Add `<div class="toast-container" id="toastContainer"></div>` at end of `<body>`, before the `<script>` tag.
- **CSS**:
  - Container: `position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 50; display: flex; flex-direction: column-reverse; gap: .5rem; pointer-events: none;`
  - Individual toast: `pointer-events: auto; font-family: var(--mono); font-size: .75rem; padding: .8rem 1.2rem; background: var(--bg-card); border: 1px solid var(--border-hi); border-radius: var(--r); color: var(--text); animation: toast-in .3s ease, toast-out .3s ease 2.7s forwards;`
  - Keyframes:
    - `@keyframes toast-in`: `from { opacity: 0; transform: translateY(10px); }` → `to { opacity: 1; transform: translateY(0); }`
    - `@keyframes toast-out`: `to { opacity: 0; transform: translateY(-10px); }`
- **JS function** `showToast(message)`:
  1. `document.createElement("div")` with the toast class
  2. Set its `textContent` to the message
  3. Append to `#toastContainer`
  4. `setTimeout(() => toast.remove(), 3000)` — auto-dismiss after 3 seconds
- **Concepts to learn**:
  - `document.createElement()`, `element.appendChild()`, `element.remove()`
  - CSS `animation-fill-mode: forwards` — keeps the element in its final keyframe state (opacity 0)
  - `flex-direction: column-reverse` — newest items appear at bottom, stack upward

---

### 3e. Drawer button click handlers

- **File**: `frontend/script.js`
- **Logic**:
  - Hamburger button → `document.getElementById("drawer").classList.toggle("drawer--open")` + toggle backdrop
  - Each nav button → `showToast("Docker Management — coming soon")` (etc.)
  - Sign Out button → `showToast("Sign Out — coming soon")`
  - Backdrop click → close drawer
- **Concepts to learn**:
  - `addEventListener("click", callback)`
  - `element.classList.toggle("className")` — adds if absent, removes if present

---

## Phase 4 — Backend: New Data

All changes in `backend/main.py`.

### 4a. Drives data (`drives[]` array)

You need **two** pieces of data combined: partition usage AND disk I/O speeds.

**Step 1 — Partition usage**:
- Method: `psutil.disk_partitions(all=False)` → returns list of `sdiskpart` named tuples
- Each has: `device`, `mountpoint`, `fstype`, `opts`
- For each partition, call `psutil.disk_usage(partition.mountpoint)` → returns `total`, `used`, `free`, `percent`
- **Filter out noise**: Skip entries where `fstype` is one of: `squashfs`, `tmpfs`, `devtmpfs`, `overlay` — these are pseudo-filesystems that clutter the output (especially on Ubuntu with snap packages)

**Step 2 — Disk I/O speeds**:
- Method: `psutil.disk_io_counters(perdisk=True)` → returns dict keyed by disk name (e.g., `"sda"`, `"nvme0n1"`)
- Each value has: `read_bytes`, `write_bytes`, `read_count`, `write_count`
- **To calculate speed**: You need to store the previous reading (same delta pattern you already use for network)
  - Create a global `dict` (e.g., `last_disk_io = {}`) storing `{disk_name: (prev_read_bytes, prev_write_bytes, timestamp)}`
  - On each call: `read_speed = (current.read_bytes - prev.read_bytes) / elapsed_seconds`
  - Same for write speed
- **Total Read / Total Write**: Just use raw `read_bytes` / `write_bytes` from `disk_io_counters` — these are cumulative since boot. Format with your existing `format_speed()` helper (or make a `format_bytes()` variant without the `/s`).

**Step 3 — Drive status**:
- If `disk_usage()` succeeds → `"online"`
- If it throws `PermissionError` or `OSError` → `"offline"`
- True "spun down" detection needs `smartctl` (from `smartmontools`) — defer this to later

**Step 4 — Mapping partitions to I/O counters**:
- Partition device is like `/dev/sda1`, I/O counter key is like `sda1`
- Strip `/dev/` prefix: `device.replace("/dev/", "")`
- Some partitions may not have a matching I/O counter — handle gracefully

**Final shape** of each entry in `drives[]`:
```
{
  "device": "/dev/sda1",
  "mountpoint": "/",
  "fstype": "ext4",
  "percent": 45.2,
  "total": 500107862016,
  "used": 226048851968,
  "free": 274058010048,
  "read_speed": 1048576,     // bytes/sec
  "write_speed": 524288,
  "total_read": 10737418240, // bytes since boot
  "total_write": 5368709120,
  "status": "online"
}
```

**Methods to research**:
| Method | What it does |
|:---|:---|
| `psutil.disk_partitions(all=False)` | Lists mounted partitions (excluding pseudo-fs when `all=False`) |
| `psutil.disk_usage("/mountpoint")` | Returns total/used/free/percent for a given path |
| `psutil.disk_io_counters(perdisk=True)` | Returns per-disk read/write byte counters |

---

### 4b. Power data (`power` object)

**Step 1 — Battery basics via psutil**:
- Method: `psutil.sensors_battery()` → returns `sbattery(percent, secsleft, power_plugged)` or `None`
- `percent`: float 0–100
- `secsleft`: int (seconds remaining), OR special constants:
  - `psutil.POWER_TIME_UNLIMITED` → battery is charging, time remaining is N/A
  - `psutil.POWER_TIME_UNKNOWN` → can't determine
- `power_plugged`: `True` (AC connected), `False` (on battery), `None` (can't determine)
- **Derive status string**:
  - `power_plugged == True` AND `percent >= 100` → `"Full"`
  - `power_plugged == True` AND `percent < 100` → `"Charging"`
  - `power_plugged == False` → `"Discharging"`
  - `power_plugged is None` → `"Unknown"`
  - "Charger Error" would need historical tracking (plugged in but percent dropping) — defer for now
- **Time string**: Convert `secsleft` to human-readable:
  - If `POWER_TIME_UNLIMITED` → `"—"`
  - If `POWER_TIME_UNKNOWN` → `"Calculating…"`
  - Otherwise → `f"{secsleft // 3600}h {(secsleft % 3600) // 60}m"`

**Step 2 — Current amperage via sysfs** (Linux only):
- psutil does NOT expose this. You must read directly from the filesystem.
- Path: `/sys/class/power_supply/BAT*/current_now`
- Use Python's `pathlib`:
  ```
  from pathlib import Path
  candidates = list(Path("/sys/class/power_supply").glob("BAT*/current_now"))
  ```
- The file contains a single integer in **microamperes** (µA)
  - Divide by `1_000_000` for Amps
  - Divide by `1_000` for milliAmps (more readable for small batteries)
- Read with `Path.read_text().strip()` then `int()`
- Wrap in `try/except (FileNotFoundError, ValueError, PermissionError)` — file doesn't exist on desktops, VMs, or macOS

**Final shape** of `power`:
```
{
  "percent": 73,
  "status": "Discharging",
  "time_str": "2h 15m",
  "power_plugged": false,
  "amperage": 1.245    // Amps, or null if unavailable
}
```
If no battery at all → `power` can be `null` or `{"percent": null, "status": "AC Powered", ...}`

**Methods/paths to research**:
| Item | Reference |
|:---|:---|
| `psutil.sensors_battery()` | [psutil sensors docs](https://psutil.readthedocs.io/en/latest/#sensors) |
| `psutil.POWER_TIME_UNLIMITED` | Same page — battery constants |
| `psutil.POWER_TIME_UNKNOWN` | Same page |
| `/sys/class/power_supply/BAT*/current_now` | Linux kernel sysfs power supply docs |
| `pathlib.Path.glob()` | [Python pathlib docs](https://docs.python.org/3/library/pathlib.html) |
| `pathlib.Path.read_text()` | Same page |

---

### 4c. Fans data (`fans[]` array)

- Method: `psutil.sensors_fans()` → returns a dict like:
  ```
  {"asus": [sfan(label="cpu_fan", current=3200)]}
  ```
- Each `sfan` named tuple has: `label` (string), `current` (int, RPM)
- **There is no `high`/`max` RPM in psutil** — you must handle this yourself:
  - **Option A** (recommended): Track the max RPM seen so far in a global dict. Update on each poll. Start with a reasonable default like 5000.
    ```
    fan_max_rpm = {}   # global
    # on each poll:
    fan_max_rpm[fan_name] = max(fan_max_rpm.get(fan_name, 0), current_rpm)
    ```
  - **Option B**: Read from sysfs — `/sys/class/hwmon/hwmon*/fan*_max` (not always present)
- **Flatten** the nested dict into a simple list:
  ```
  [
    {"name": "cpu_fan", "current": 3200, "high": 4500},
    {"name": "gpu_fan", "current": 2100, "high": 3000}
  ]
  ```
- Returns `{}` (empty dict) on macOS, Windows, and most VMs — your frontend must handle an empty array

**Methods to research**:
| Method | What it does |
|:---|:---|
| `psutil.sensors_fans()` | Returns dict of fan label → RPM readings |
| `/sys/class/hwmon/hwmon*/fan*_max` | sysfs file for max RPM (optional) |

---

### 4d. New endpoint: `POST /server/fan`

A new route to control fan speed via sysfs PWM.

**Route**: `@app.post("/server/fan")`
**Parameter**: `speed` as a query parameter (0–100), use `from fastapi import Query`
**Logic**:
1. Convert percentage to PWM range: `pwm_value = int(speed * 255 / 100)`
2. Find all hwmon directories: iterate `Path("/sys/class/hwmon").iterdir()`
3. For each directory, check if `pwm1` file exists
4. First write `1` to `pwm1_enable` (switch to manual mode)
5. Then write `pwm_value` (0–255) to `pwm1`
6. Use `Path.write_text(str(value))`
7. Return `{"success": True}` on success
8. On any exception → `{"success": False, "error": str(e)}`

**⚠️ CRITICAL WARNINGS**:
- **Root required**: The FastAPI process must run as root or have write permissions to `/sys/class/hwmon/`. Document this.
- **Hardware damage risk**: Setting fans to 0% with high CPU temps can cause thermal damage. Consider adding a safety check (e.g., refuse to set below 30% if CPU temp > 70°C).
- **Laptop restrictions**: Many laptops have their fan sysfs files read-only. Your endpoint will get `PermissionError` — this is expected. Return the error cleanly.
- **PWM range**: 0–255, NOT 0–100. The query param is 0–100, you convert internally.

**Concepts to learn**:
| Concept | Reference |
|:---|:---|
| `@app.post()` in FastAPI | [FastAPI docs](https://fastapi.tiangolo.com/tutorial/first-steps/) |
| `Query` parameter in FastAPI | [FastAPI query params](https://fastapi.tiangolo.com/tutorial/query-params/) |
| sysfs PWM interface | `/sys/class/hwmon/hwmon*/pwm1` (0–255), `pwm1_enable` (1=manual, 2=auto) |
| `sudo` vs process permissions | Why `sudo echo > file` fails (redirection happens in unprivileged shell) |

---

## Phase 5 — Frontend: New Cards

### 5a. Disk Usage card (replace current static Disk card)

- **File**: `frontend/index.html`
- **Where**: Lines 91–115 — the existing Disk card. **Note**: It has a bug — duplicate `id="card-mem"` (should be `id="card-disk"`). Replace this entire card.
- **New structure**: Keep the same `.hcard` wrapper with icon column, but the metrics section becomes a container `<div class="hcard__metrics" id="diskDrives">` that JS will populate dynamically.
- **JS render function** `renderDrives(drives)`:
  1. Get the container: `document.getElementById("diskDrives")`
  2. Clear it: `container.innerHTML = ""` (important! prevents duplication on each refresh)
  3. Loop over `drives` array, for each drive create:
     - A header showing device name + mountpoint + status badge
     - Usage % bar (reuse your `setProgress()` / class-based approach from Phase 2a)
     - Read speed bar: width = `(read_speed / peak_read_speed) * 100%`
     - Write speed bar: same logic with write values
     - Plain text line: `"Total Read: X GB  |  Total Write: Y GB"`
  4. Append all to container
- **Peak tracking**: Maintain a JS object `const drivePeaks = {}` keyed by device name, tracking max read/write speed seen. Update on each render call.
- **Byte formatting**: Create a helper function (similar to backend's `format_speed`):
  - Input: bytes number
  - Output: `"1.2 GB"`, `"458 MB"`, etc.
  - Loop through units `["B", "KB", "MB", "GB", "TB"]`, dividing by 1024 until < 1024

**Concepts to learn**:
- Dynamic DOM creation: `document.createElement()`, `.className`, `.textContent`, `parent.appendChild(child)`
- `container.innerHTML = ""` to clear children
- Tracking peak values in a plain JS object

---

### 5b. Power card

- **File**: `frontend/index.html` — add a new `.hcard` after the disk card
- **Icon**: SVG battery or lightning bolt — search "battery SVG 24x24 viewBox" for a simple path. Could use something like a `<rect>` for the battery body + a small `<rect>` for the terminal.
- **Structure**:
  - `.hcard__icon-col` with icon + title "PWR" or "BAT"
  - `.hcard__metrics` containing:
    - One `.hcard__row` with battery % bar (same pattern as CPU LOAD)
    - Below: a new `.hcard__text-info` section with plain-text lines:
      - Status: Charging / Discharging / Full
      - Time: "Time Remaining: 2h 15m" or "Time to Full: 45m"
      - Amperage: "Current Draw: 1.24 A"
- **New CSS class** `.hcard__text-info`:
  ```
  font-family: var(--mono);
  font-size: .7rem;
  color: var(--muted);
  padding-top: .5rem;
  display: flex;
  flex-direction: column;
  gap: .3rem;
  ```
- **JS render function** `renderPower(power)`:
  - If `power` is null or `power.percent` is null → show "⚡ AC Powered — no battery detected"
  - Otherwise → populate bar + text fields
  - Decide label based on status: show "Time Remaining" if discharging, "Time to Full" if charging
- **Test trigger**: Define at bottom of script.js:
  ```
  window.__testBattery = function() { /* inject dummy data, call renderPower() */ }
  ```
- **Concepts to learn**:
  - Conditional rendering: `element.style.display = condition ? "flex" : "none"`
  - `window` global assignment for console-callable debug functions
  - Reusable render functions (called from both fetch handler AND test trigger)

---

### 5c. Fan Speed card

- **File**: `frontend/index.html` — add after Power card
- **Key difference from other cards**: This one has interactive `<input type="range">` sliders.
- **Structure per fan** (rendered dynamically by JS):
  - Fan name label + current RPM value
  - Read-only progress bar: width = `(current_rpm / max_rpm) * 100%`
  - Slider: `<input type="range" min="0" max="100" value="50">` with a `<span>` showing current %
- **Visibility**: If `data.fans` is empty → hide entire card: `card.style.display = "none"`
- **Slider CSS** (in `style.css`):
  - Quick approach: `accent-color: var(--accent);` on the input (modern browsers support this)
  - Full custom approach: style `::-webkit-slider-thumb`, `::-webkit-slider-runnable-track`, `::-moz-range-thumb`, `::-moz-range-track`
  - Make the thumb a small circle with `var(--accent)` background
  - Make the track match `.hcard__bar-wrap` styling (4px height, `var(--border)` background)
- **JS event handling**:
  - `"input"` event (fires continuously while dragging) → update the % label text for visual feedback
  - `"change"` event (fires on mouse release) → POST to backend:
    ```
    fetch(`${API_BASE}/server/fan?speed=${value}`, { method: "POST" })
    ```
  - Handle the response: if `success: false`, show a toast with the error message
- **Test trigger**: `window.__testFans = function() { /* inject dummy fans, show card, call render */ }`

**Concepts to learn**:
| Concept | What to research |
|:---|:---|
| `<input type="range">` | The HTML range slider element |
| `"input"` vs `"change"` events | `input` = continuous, `change` = on commit |
| `fetch()` with `method: "POST"` | Second argument to fetch API |
| Slider CSS customization | Vendor-prefixed pseudo-elements for range inputs |
| `accent-color` CSS property | Quick way to theme form controls |

---

## Phase 6 — Wiring It Together

### 6a. Update `fetchSystemInfo()` in `script.js`

After `const data = await response.json();` (around line 124), add calls to new render functions:
```
renderDrives(data.drives);
renderPower(data.power);
renderFans(data.fans);
```
Each function must handle `null`, `undefined`, and empty arrays gracefully (never crash the update loop).

### 6b. Remove old static disk references

- In the `nodes` object (lines 6–29): remove `diskValue` and `diskBar` — these reference elements that no longer exist in the dynamic layout.
- Remove `setMetric(nodes.diskValue, nodes.diskBar, data.disk);` at line 133.

### 6c. Verify the update loop

- `setInterval(fetchSystemInfo, REFRESH_INTERVAL_MS)` at line 170 automatically picks up new data every 2 seconds. No changes needed.
- The dynamic card renderers will be called on every cycle, clearing and rebuilding their contents.

---

## Files to Touch — Summary

| File | Changes |
|:---|:---|
| `frontend/style.css` | Fix rgba bug (line 204), adjust `--accent` + `--accent-dim` (lines 16–17), reduce scan-line opacity (line 67), add bar color classes (`.bar--ok`, etc.), drawer + backdrop styles, toast styles, `.hcard__text-info` styles, slider styles, responsive updates |
| `frontend/index.html` | Fix HTML quote bug (if present), add hamburger button in topbar, add `<aside>` drawer + backdrop, add toast container, fix disk card `id`, replace disk card with dynamic container, add power card, add fan card |
| `frontend/script.js` | Fix `updateStatus()` (line 78), refactor `setProgress()` to use CSS classes, add drawer toggle logic, add `showToast()`, add `renderDrives()`, `renderPower()`, `renderFans()`, add `window.__testBattery()` + `window.__testFans()`, wire new renders into `fetchSystemInfo()`, remove old disk refs |
| `backend/main.py` | Add drives data (`psutil.disk_partitions` + `disk_io_counters`), add power data (`sensors_battery` + sysfs amperage), add fans data (`sensors_fans` + tracked max RPM), add `POST /server/fan` endpoint with sysfs PWM write |

---

## Research Reference Tables

### Python Methods & Modules

| What you need | Method / Module | Docs |
|:---|:---|:---|
| List mounted partitions | `psutil.disk_partitions(all=False)` | [psutil disks](https://psutil.readthedocs.io/en/latest/#disks) |
| Get partition usage | `psutil.disk_usage("/path")` | Same link |
| Per-disk I/O counters | `psutil.disk_io_counters(perdisk=True)` | Same link |
| Battery info | `psutil.sensors_battery()` | [psutil sensors](https://psutil.readthedocs.io/en/latest/#sensors) |
| Battery time constants | `psutil.POWER_TIME_UNLIMITED`, `POWER_TIME_UNKNOWN` | Same link |
| Fan speeds | `psutil.sensors_fans()` | Same link |
| Read sysfs files | `pathlib.Path.read_text()` | [Python pathlib](https://docs.python.org/3/library/pathlib.html) |
| Glob sysfs paths | `pathlib.Path.glob("BAT*/current_now")` | Same link |
| FastAPI POST route | `@app.post("/path")` | [FastAPI tutorial](https://fastapi.tiangolo.com/) |
| Query parameters | `from fastapi import Query` | [FastAPI query params](https://fastapi.tiangolo.com/tutorial/query-params/) |

### JavaScript Concepts

| What you need | Concept to research |
|:---|:---|
| Target a child element | `element.querySelector(".class-name")` |
| Toggle CSS classes | `element.classList.toggle("name")` / `.add()` / `.remove()` |
| Create elements dynamically | `document.createElement("div")` |
| Append to DOM | `parent.appendChild(child)` |
| Clear container | `container.innerHTML = ""` |
| Range slider element | `<input type="range" min="0" max="100">` |
| Slider events | `"input"` (continuous) vs `"change"` (on release) |
| POST request | `fetch(url, { method: "POST" })` |
| Timed removal | `setTimeout(() => element.remove(), 3000)` |
| Debug globals | `window.__testBattery = function() { ... }` |
| CSS `textContent` vs `innerHTML` | Why `textContent` destroys child nodes |

### Linux sysfs Paths

| Path | What it provides |
|:---|:---|
| `/sys/class/power_supply/BAT*/current_now` | Battery current draw in µA |
| `/sys/class/power_supply/BAT*/voltage_now` | Battery voltage in µV (bonus) |
| `/sys/class/hwmon/hwmon*/pwm1` | Fan PWM duty cycle (0–255) |
| `/sys/class/hwmon/hwmon*/pwm1_enable` | Fan control mode (1=manual, 2=auto) |
| `/sys/class/hwmon/hwmon*/fan*_input` | Fan current RPM (read by psutil) |
| `/sys/class/hwmon/hwmon*/fan*_max` | Fan max RPM (not always present) |
| `/sys/class/hwmon/hwmon*/name` | Hwmon device name (e.g., "nct6792") |

---

## Feature Recommendations vs Beszel

These features would make SysPulse the go-to choice for **teens running servers on laptops and weak devices**. Prioritized by impact:

### Priority 1: One-Command Install 🏗️
- **Why**: Beszel needs Docker + hub + agent setup separately. Teens want `curl | bash` and done.
- **How**: A single `install.sh` script that installs Python deps, creates a systemd service, and opens the browser.
- **Research**: systemd unit files, `pip install --user`, `xdg-open`, packaging as `.deb` or using `pipx`.

### Priority 2: Laptop-Aware Mode 🔋
- **Why**: Beszel is designed for always-on rack servers. SysPulse can own the "laptop as server" niche.
- **Features**: Battery death prediction ("server dies in ~2h at this load"), thermal throttle warnings, auto-dim polling when on battery, lid-close behavior alerts.
- **Research**: `psutil.sensors_battery().secsleft`, `/sys/class/dmi/id/chassis_type` to detect laptop vs desktop.

### Priority 3: Discord / Telegram Alerts 🔔
- **Why**: Teens live on Discord, not email. Beszel has alerts but setup is complex.
- **How**: A settings field for a Discord webhook URL. When CPU > 90% for 30s, POST: `{"content": "🔥 CPU at 94% on your laptop!"}`.
- **Research**: [Discord Webhooks docs](https://discord.com/developers/docs/resources/webhook) — it's a single POST request.

### Priority 4: Process Killer 🔫
- **Why**: Beszel has no process management. Teens often have runaway Minecraft servers or Node.js processes eating all RAM.
- **How**: Show top 5 processes by CPU/RAM. Add a "Kill" button.
- **Research**: `psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_percent'])`, `psutil.Process(pid).kill()`.

### Priority 5: Panic Emoji Dashboard 😎🔥💀
- **Why**: Teens instantly understand emoji. Charts and numbers are boring.
- **How**: A toggle between "Simple Mode" (one giant emoji + color that changes with system state) and "Detail Mode" (current dashboard).
  - 😎 = healthy (green)
  - 😰 = elevated (amber)
  - 🔥 = high load (red)
  - 💀 = critical (pulsing red)
- **Research**: Pure CSS/JS — no libraries needed. Just conditional rendering.

### Priority 6: "Is My Port Open?" Checker 🔍
- **Why**: Teens CONSTANTLY struggle with port forwarding. This would be a killer feature.
- **How**: List all listening ports (`psutil.net_connections(kind='inet')` filtered to `LISTEN`), show owning process, and optionally test from outside via an external API.
- **Research**: `psutil.net_connections()`, external port check APIs.

### Bonus Features (lower priority)

| Feature | Why it helps teens |
|:---|:---|
| **Mobile PWA** | They check phones, not desktops. Add `manifest.json` + service worker. |
| **Uptime Streaks** 🏆 | Gamification: "Server uptime: 14 days 🔥". Award badges. Makes them want to maintain their server. |
| **Quick Benchmarks** ⚡ | "Run Benchmark" button → disk/network/memory speed score. Screenshot and share. |
| **Zero-Config Auto-detect** | No YAML, no env vars. Install and everything is detected. Already your approach — lean into it. |

---

## Open Questions

1. **Fan control safety**: Should the `POST /server/fan` endpoint refuse to set fan speed below 30% if CPU temp > 70°C? Or is this deferred?

2. **Partition limit**: Linux with snap can have 10+ partitions. Should the Disk card cap at ~5 and show "Show More", or filter out snap/loop mounts entirely?

3. **Test trigger location**: `window.__testBattery()` and `window.__testFans()` — console-only, or add a hidden "Debug" section in the drawer?

4. **Mobile responsiveness**: Current CSS has `@media (max-width: 500px)`. The new drawer, cards, and slider all need mobile styles. Include in this iteration or defer?

---

## Stubbed Features Tracker

Features that show a toast only — full implementation later:

- [ ] Docker Management page
- [ ] Log Review page
- [ ] SSH Terminal page
- [ ] File Manager page
- [ ] Account overview (real user data, not hardcoded "admin")
- [ ] Sign Out (real auth flow)

Temporary test code to remove after approval:

- [ ] `window.__testBattery()` in `script.js`
- [ ] `window.__testFans()` in `script.js`
