/* AI Generated thingies- GO
auth.js - sign in / sign out, session handling and small shared helpers.
 *
 * Load this FIRST (before charts.js / detail.js / users.js / script.js).
 *
 * Flow
 *   page load -> GET /auth/status
 *       setup_required  -> "Create the admin account" form (first run only)
 *       otherwise       -> saved token? GET /auth/me -> dashboard, else the sign-in form
 *   signed in -> fires "auth:ready" (script.js starts polling)
 *   sign out / expired session -> fires "auth:logout" and shows the sign-in form
 *
 * The token is kept in sessionStorage (forgotten when the tab closes) or, when
 * "Keep me signed in" is ticked, in localStorage.
 */
const API_BASE = (window.API_BASE || "http://localhost:8000").replace(/\/$/, "");

/** Thrown when the server says our session is no longer valid. */
class AuthError extends Error {}

/** Tiny DOM builder: mk("button", { class: "btn", onclick: fn }, "Save") */
function mk(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props || {})) {
    if (val == null || val === false) continue;
    if (key === "class") node.className = val;
    else if (key.startsWith("on") && typeof val === "function") node.addEventListener(key.slice(2), val);
    else if (key in node && key !== "list") node[key] = val;
    else node.setAttribute(key, val === true ? "" : val);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/** <dialog> helpers that also work in browsers without showModal(). */
function openDialog(dlg) {
  if (!dlg || dlg.open) return;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}
function closeDialog(dlg) {
  if (!dlg) return;
  if (typeof dlg.close === "function") {
    dlg.close(); // the browser fires the "close" event itself
  } else {
    dlg.removeAttribute("open");
    dlg.dispatchEvent(new Event("close"));
  }
}

/** fetch() that adds the sign-in token and reacts to an expired session. */
async function authFetch(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const token = Auth.token();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    Auth.expire();
    throw new AuthError("Session expired");
  }
  return res;
}

const Auth = (() => {
  const KEY = "syspulse.token";
  const $ = (id) => document.getElementById(id);
  let memToken = null;     // works even if the browser blocks storage
  let user = null;
  let mode = "login";      // "login" | "setup"
  let backendDown = false;

  /* ---- token storage ---- */
  const token = () => {
    if (memToken) return memToken;
    try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch (_) { return null; }
  };
  function saveToken(value, remember) {
    clearToken();
    memToken = value;
    try { (remember ? localStorage : sessionStorage).setItem(KEY, value); } catch (_) { /* storage blocked */ }
  }
  function clearToken() {
    memToken = null;
    try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch (_) { /* ignore */ }
  }

  /* ---- API helpers ---- */
  function errorText(data, status) {
    const d = data && data.detail;
    if (Array.isArray(d)) return d.map((x) => x.msg || String(x)).join("; ");
    return d || `Request failed (HTTP ${status})`;
  }
  async function request(path, { method = "GET", body, auth = true, signal } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && token()) headers.Authorization = `Bearer ${token()}`;
    const res = await fetch(API_BASE + path, {
      method, headers, signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && auth) {
      expire();
      throw new AuthError("Session expired");
    }
    return res;
  }
  /** request() + parse JSON + throw an Error with the server's message on failure. */
  async function json(path, opts) {
    const res = await request(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(data, res.status));
    return data;
  }

  /* ---- the sign-in screen ---- */
  function setError(msg) { $("authError").textContent = msg || ""; }

  function showScreen(newMode, message = "") {
    mode = newMode;
    $("authScreen").hidden = false;
    document.body.classList.add("is-locked");
    const setup = mode === "setup";
    $("authTitle").textContent = setup ? "Create the admin account" : "Sign in";
    $("authHint").textContent = setup
      ? "First run: this account will be the administrator. You can add more users afterwards."
      : "Enter your SysPulse account details.";
    $("authConfirmRow").hidden = !setup;
    $("authPass").autocomplete = setup ? "new-password" : "current-password";
    $("authSubmit").textContent = setup ? "Create account" : "Sign in";
    $("authPass").value = "";
    $("authConfirm").value = "";
    setError(message);
    setTimeout(() => $("authUser").focus(), 0);
  }

  function hideScreen() {
    $("authScreen").hidden = true;
    document.body.classList.remove("is-locked");
    setError("");
  }

  function setBusy(busy) {
    $("authSubmit").disabled = busy;
    $("authSubmit").classList.toggle("is-busy", busy);
  }

  async function submit(event) {
    event.preventDefault();
    if (backendDown) { backendDown = false; return init(); }
    const username = $("authUser").value.trim();
    const password = $("authPass").value;
    if (!username || !password) return setError("Enter a username and a password.");
    if (mode === "setup" && password !== $("authConfirm").value) return setError("The two passwords do not match.");
    setBusy(true);
    setError("");
    try {
      const remember = $("authRemember").checked;
      const data = await json(mode === "setup" ? "/auth/setup" : "/auth/login", {
        method: "POST", auth: false, body: { username, password, remember },
      });
      saveToken(data.token, remember);
      signedIn(data.user);
    } catch (err) {
      setError(err instanceof TypeError ? `Cannot reach the backend at ${API_BASE}.` : err.message);
    } finally {
      setBusy(false);
    }
  }

  /* ---- state changes ---- */
  function signedIn(u) {
    user = u;
    $("authUser").value = "";
    hideScreen();
    $("drawerAvatar").textContent = (u.username[0] || "?").toUpperCase();
    $("drawerUsername").textContent = u.username;
    $("drawerRole").textContent = u.role === "admin" ? "Administrator" : "Viewer";
    document.querySelectorAll("[data-admin-only]").forEach((n) => { n.hidden = u.role !== "admin"; });
    window.dispatchEvent(new CustomEvent("auth:ready", { detail: u }));
  }

  function closeAllDialogs() {
    document.querySelectorAll("dialog[open]").forEach((d) => closeDialog(d));
  }

  /** The server rejected our token (expired, signed out elsewhere, account disabled). */
  function expire() {
    if (!user && !$("authScreen").hidden) return; // already showing the sign-in form
    clearToken();
    user = null;
    closeAllDialogs();
    window.dispatchEvent(new Event("auth:logout"));
    showScreen("login", "Your session has ended. Please sign in again.");
  }

  async function signOut() {
    try { await request("/auth/logout", { method: "POST" }); } catch (_) { /* sign out locally anyway */ }
    clearToken();
    user = null;
    closeAllDialogs();
    window.dispatchEvent(new Event("auth:logout"));
    showScreen("login");
  }

  async function init() {
    backendDown = false;
    try {
      const status = await json("/auth/status", { auth: false });
      if (status.setup_required) return showScreen("setup");
      if (token()) {
        try { return signedIn(await json("/auth/me")); }
        catch (err) { if (err instanceof AuthError) return; /* expire() already showed the form */ }
      }
      showScreen("login");
    } catch (_) {
      backendDown = true;
      showScreen("login", `Cannot reach the backend at ${API_BASE}. Is it running? Press the button to retry.`);
      $("authSubmit").textContent = "Retry";
    }
  }

  /* ---- wiring ---- */
  $("authForm").addEventListener("submit", submit);
  $("signoutBtn").addEventListener("click", signOut);

  // every <dialog> closes via its [data-close] buttons or a click on its backdrop
  document.addEventListener("click", (e) => {
    const closer = e.target.closest("[data-close]");
    if (closer) return closeDialog(closer.closest("dialog"));
    if (e.target instanceof HTMLDialogElement && e.target.classList.contains("modal")) closeDialog(e.target);
  });

  // start once every script has loaded, so no listener can miss "auth:ready"
  window.addEventListener("load", init);

  return { token, json, request, expire, init, user: () => user, isSignedIn: () => user !== null };
})();
