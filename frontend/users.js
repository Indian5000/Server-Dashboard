/* users.js - "User management" (admins) and "Account" (change my password) dialogs.
 * Needs auth.js loaded first. Every rule is also enforced by the backend, so hiding
 * a button here is only for tidiness, never for security.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const usersDlg = $("usersDialog");
  const accountDlg = $("accountDialog");

  const when = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleString() : "never");

  function say(el, text, kind = "error") {
    el.textContent = text || "";
    el.className = `form-msg ${text ? "form-msg--" + kind : ""}`;
  }

  function closeDrawer() {
    // the side menu would otherwise stay open behind the dialog
    $("drawer").classList.remove("drawer--open");
    $("drawerBackdrop").classList.remove("drawer-backdrop--visible");
    $("menuBtn").classList.remove("active");
  }

  /* ───────────── user management ───────────── */
  let rows = [];

  async function loadUsers() {
    try {
      rows = await Auth.json("/users");
      renderUsers(); // (leave the message line alone: it may be the result of the action that triggered this reload)
    } catch (err) {
      if (!(err instanceof AuthError)) say($("usersMsg"), err.message);
    }
  }

  async function patchUser(id, body, okText) {
    try {
      await Auth.json(`/users/${id}`, { method: "PATCH", body });
      say($("usersMsg"), okText, "ok");
    } catch (err) {
      if (err instanceof AuthError) return;
      say($("usersMsg"), err.message);
    }
    await loadUsers(); // always re-sync with the server (also reverts a rejected change)
  }

  function resetCell(u) {
    const cell = mk("td", { class: "users-actions" });
    const showButtons = () => {
      cell.replaceChildren(...[
        mk("button", { class: "btn btn--small", type: "button", onclick: showForm }, "Reset password"),
        u.id !== Auth.user().id &&
          mk("button", {
            class: "btn btn--small btn--danger", type: "button",
            onclick: async () => {
              if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
              try {
                await Auth.json(`/users/${u.id}`, { method: "DELETE" });
                say($("usersMsg"), `Deleted ${u.username}.`, "ok");
              } catch (err) {
                if (!(err instanceof AuthError)) say($("usersMsg"), err.message);
              }
              loadUsers();
            },
          }, "Delete"),
      ].filter(Boolean));
    };
    const showForm = () => {
      const input = mk("input", {
        type: "password", placeholder: "New password (8+)", autocomplete: "new-password",
        "aria-label": `New password for ${u.username}`,
      });
      cell.replaceChildren(
        input,
        mk("button", {
          class: "btn btn--small btn--primary", type: "button",
          onclick: () => patchUser(u.id, { password: input.value }, `Password changed for ${u.username}. They were signed out.`),
        }, "Save"),
        mk("button", { class: "btn btn--small", type: "button", onclick: showButtons }, "Cancel"),
      );
      input.focus();
    };
    showButtons();
    return cell;
  }

  function renderUsers() {
    const me = Auth.user();
    $("usersBody").replaceChildren(...rows.map((u) => {
      const isMe = me && u.id === me.id;
      const role = mk("select", {
        "aria-label": `Role for ${u.username}`,
        onchange: (e) => patchUser(u.id, { role: e.target.value }, `${u.username} is now ${e.target.value}.`),
      },
        mk("option", { value: "viewer", selected: u.role === "viewer" }, "Viewer"),
        mk("option", { value: "admin", selected: u.role === "admin" }, "Admin"),
      );
      return mk("tr", { class: u.disabled ? "is-disabled" : "" },
        mk("td", {}, u.username, isMe && mk("span", { class: "badge" }, "you")),
        mk("td", {}, role),
        mk("td", { class: "users-status" },
          mk("span", { class: u.disabled ? "status-off" : "status-on" }, u.disabled ? "Disabled" : "Active"),
          !isMe && mk("button", {
            class: "btn btn--small", type: "button",
            onclick: () => patchUser(u.id, { disabled: !u.disabled }, `${u.username} ${u.disabled ? "enabled" : "disabled"}.`),
          }, u.disabled ? "Enable" : "Disable")),
        mk("td", { class: "muted" }, when(u.last_login)),
        resetCell(u),
      );
    }));
  }

  $("newUserForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      username: $("newUserName").value.trim(),
      password: $("newUserPass").value,
      role: $("newUserRole").value,
    };
    try {
      await Auth.json("/users", { method: "POST", body });
      $("newUserName").value = "";
      $("newUserPass").value = "";
      say($("usersMsg"), `Created ${body.username.toLowerCase()}.`, "ok");
    } catch (err) {
      if (err instanceof AuthError) return;
      say($("usersMsg"), err.message);
    }
    loadUsers();
  });

  $("usersBtn").addEventListener("click", () => {
    closeDrawer();
    say($("usersMsg"), "");
    openDialog(usersDlg);
    loadUsers();
  });

  /* ───────────── change my password ───────────── */
  $("accountBtn").addEventListener("click", () => {
    closeDrawer();
    $("accountForm").reset();
    say($("accountMsg"), "");
    const me = Auth.user();
    $("accountWho").textContent = me ? `${me.username} · ${me.role === "admin" ? "Administrator" : "Viewer"}` : "";
    openDialog(accountDlg);
  });

  $("accountForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const current = $("accCurrent").value, next = $("accNew").value;
    if (next !== $("accConfirm").value) return say($("accountMsg"), "The two new passwords do not match.");
    try {
      await Auth.json("/auth/change-password", { method: "POST", body: { current_password: current, new_password: next } });
      $("accountForm").reset();
      say($("accountMsg"), "Password changed. Other devices have been signed out.", "ok");
    } catch (err) {
      if (!(err instanceof AuthError)) say($("accountMsg"), err.message);
    }
  });
})();
