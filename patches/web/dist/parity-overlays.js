/**
 * Rakijazios parity overlays (P0–P9): bot model bind, tool permissions,
 * routines, marketplace, computer-use gate, auth status.
 * Loaded as a deferred script from index.html.
 */
(() => {
  const BASE = "/api";
  const el = (tag, text, attrs = {}) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") n.className = v;
      else if (k === "onclick") n.onclick = v;
      else n.setAttribute(k, v);
    }
    return n;
  };

  async function api(path, opts = {}) {
    const res = await fetch(BASE + path, {
      credentials: "include",
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function panel(title) {
    const root = el("div", null, {
      className: "rk-parity-panel",
      style:
        "position:fixed;inset:auto 16px 16px auto;z-index:99990;max-width:420px;width:min(420px,calc(100vw - 32px));background:#161618;color:#f2f2f0;border:1px solid #2a2a2e;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:14px 16px;font:14px/1.4 system-ui,sans-serif",
    });
    root.append(el("h3", title, { style: "margin:0 0 10px;font-size:15px" }));
    const body = el("div");
    root.append(body);
    const close = el("button", "Close", {
      style: "margin-top:12px;background:#2a2a2e;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer",
      onclick: () => root.remove(),
    });
    root.append(close);
    document.body.append(root);
    return body;
  }

  async function openBotModelPicker(botId) {
    const body = panel("On my computer");
    body.append(el("p", "Loading offered models…", { className: "rk-muted" }));
    try {
      const [offered, bot] = await Promise.all([
        api("/local-runners/offered-models"),
        api(`/local-runners/bots/${encodeURIComponent(botId)}`),
      ]);
      body.replaceChildren();
      // API shapes: offered-models → { devices: [{ id, name, online, state, paused, models: [{ id, availableNow }] }] },
      // bots/:id → { onMyComputer, deviceId, modelId, online, state, modelServerOk }.
      const devices = offered.devices || [];
      const linkText = (d) =>
        d.paused ? " · paused" : d.online ? "" : d.state === "reconnecting" ? " · reconnecting" : " · offline";
      if (bot.onMyComputer && bot.deviceId) {
        const dev = devices.find((d) => d.id === bot.deviceId);
        const status = bot.online
          ? bot.modelServerOk === false
            ? " (model server not answering)"
            : ""
          : bot.state === "reconnecting"
            ? " (reconnecting)"
            : " (offline)";
        const current = el("p", `Current: ${dev ? dev.name : "your computer"} · ${bot.modelId || "no model"}${status}`);
        current.setAttribute("data-rk", "bot-runs-on");
        body.append(current);
        body.append(
          el("button", "Stop using my computer", {
            style: "margin:6px 0 12px;display:block",
            onclick: async () => {
              await api(`/local-runners/bots/${encodeURIComponent(botId)}/model`, {
                method: "POST",
                body: JSON.stringify({ clear: true }),
              });
              openBotModelPicker(botId);
            },
          }),
        );
      }
      const models = devices.flatMap((d) =>
        (d.models || []).map((m) => ({ deviceId: d.id, deviceName: d.name, modelId: m.id, suffix: linkText(d) })),
      );
      if (!models.length) {
        body.append(el("p", "No models offered yet. Connect a computer in My hardware and turn models on."));
        return;
      }
      for (const m of models) {
        const row = el("button", `${m.deviceName} · ${m.modelId}${m.suffix}`, {
          style:
            "display:block;width:100%;text-align:left;margin:4px 0;padding:8px;border-radius:8px;border:1px solid #2a2a2e;background:#1c1c1f;color:#f2f2f0;cursor:pointer",
          onclick: async () => {
            await api(`/local-runners/bots/${encodeURIComponent(botId)}/model`, {
              method: "POST",
              body: JSON.stringify({ deviceId: m.deviceId, modelId: m.modelId }),
            });
            openBotModelPicker(botId);
          },
        });
        body.append(row);
      }
    } catch (e) {
      body.replaceChildren(el("p", e.message || String(e)));
    }
  }

  async function openToolPermissions() {
    const body = panel("Tool permissions");
    try {
      const data = await api("/host-tools/permissions");
      body.replaceChildren();
      body.append(el("p", `Default: ${data.permission}${data.ceiling ? ` (ceiling ${data.ceiling})` : ""}`));
      const select = el("select");
      for (const v of ["ask", "always", "never"]) {
        const o = el("option", v);
        o.value = v;
        if (v === data.permission) o.selected = true;
        select.append(o);
      }
      body.append(select);
      body.append(
        el("button", "Save", {
          style: "margin-left:8px",
          onclick: async () => {
            await api("/host-tools/permissions", {
              method: "POST",
              body: JSON.stringify({ permission: select.value }),
            });
            openToolPermissions();
          },
        }),
      );
      body.append(
        el("p", "Actions needing approval appear in chat as Allow once / Always / Deny.", {
          style: "margin-top:10px;opacity:.75;font-size:12px",
        }),
      );
    } catch (e) {
      body.replaceChildren(el("p", e.message || String(e)));
    }
  }

  async function openRoutines(botId) {
    const body = panel("Routines");
    try {
      const data = await api(`/parity/bots/${encodeURIComponent(botId)}/routines`);
      body.replaceChildren();
      const list = data.routines || [];
      if (!list.length) {
        body.append(el("p", "No routines yet. Ask the bot to schedule one, or create a schedule from chat."));
        return;
      }
      for (const r of list) {
        const row = el("div", null, { style: "border-top:1px solid #2a2a2e;padding:8px 0" });
        row.append(el("strong", r.name || r.id));
        row.append(el("div", `active=${r.active} cron=${r.cron || "-"}`, { style: "font-size:12px;opacity:.75" }));
        const pause = el("button", r.active ? "Pause" : "Resume", {
          style: "margin-top:6px;margin-right:6px",
          onclick: async () => {
            const path = r.active ? "pause" : "resume";
            await api(`/parity/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(r.id)}/${path}`, {
              method: "POST",
              body: "{}",
            });
            openRoutines(botId);
          },
        });
        row.append(pause);
        row.append(
          el("button", "Run now", {
            style: "margin-top:6px",
            onclick: async () => {
              await api(
                `/parity/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(r.id)}/run-now`,
                { method: "POST", body: "{}" },
              );
              alert("Routine queued to run now.");
              openRoutines(botId);
            },
          }),
        );
        body.append(row);
      }
    } catch (e) {
      body.replaceChildren(el("p", e.message || String(e)));
    }
  }

  async function openMarketplace() {
    const body = panel("Marketplace");
    try {
      const data = await api("/parity/marketplace");
      body.replaceChildren();
      const bots = data.bots || [];
      if (!bots.length) {
        body.append(el("p", "No published bots yet. Publish one from its settings."));
        return;
      }
      for (const b of bots) {
        const row = el("div", null, { style: "padding:8px 0;border-top:1px solid #2a2a2e" });
        row.append(el("div", `${b.title || b.name} — ${b.summary || "runs as owner"}`));
        row.append(
          el("button", "Add to chat", {
            style: "margin-top:6px",
            onclick: async () => {
              await api(`/parity/marketplace/${encodeURIComponent(b.botId)}/add-to-chat`, {
                method: "POST",
                body: "{}",
              });
              alert("Pinned. The bot still runs as its owner (private by default).");
            },
          }),
        );
        body.append(row);
      }
    } catch (e) {
      body.replaceChildren(el("p", e.message || String(e)));
    }
  }

  async function openMcpCatalog() {
    const body = panel("Connectors (MCP)");
    try {
      const data = await api("/parity/mcp/catalog");
      body.replaceChildren();
      for (const item of data.catalog || []) {
        const row = el("div", null, { style: "border-top:1px solid #2a2a2e;padding:8px 0" });
        row.append(el("strong", item.name));
        row.append(
          el("div", `${(item.connectors || []).join(", ")}${item.oauth ? " · OAuth" : ""}`, {
            style: "font-size:12px;opacity:.75",
          }),
        );
        body.append(row);
      }
      body.append(
        el("p", data.note || "Connect via Settings → MCP.", {
          style: "margin-top:10px;opacity:.75;font-size:12px",
        }),
      );
    } catch (e) {
      body.replaceChildren(el("p", e.message || String(e)));
    }
  }

  // ---- Per-action approvals: a paused host action shows this card until decided or expired ----
  const decided = new Set();
  let shownApprovalId = null;

  function showApprovalCard(approval) {
    if (!approval || !approval.id) return;
    const existing = document.getElementById("rk-host-approval");
    if (existing) existing.remove();
    shownApprovalId = approval.id;
    const card = el("div", null, {
      id: "rk-host-approval",
      role: "alertdialog",
      "data-approval-id": approval.id,
      style:
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99995;background:#1a1a1e;color:#f2f2f0;border:1px solid #3a3a40;border-radius:12px;padding:14px 16px;max-width:480px;width:calc(100vw - 32px);box-shadow:0 12px 40px rgba(0,0,0,.5);font:14px system-ui",
    });
    card.append(el("strong", "Allow this on your computer?"));
    card.append(
      el("div", `${approval.action || "tool"}${approval.target ? `: ${approval.target}` : ""}`, {
        className: "rk-approval-target",
        style: "margin:8px 0;opacity:.85;word-break:break-all;font-family:ui-monospace,monospace;font-size:12px",
      }),
    );
    if (approval.expiresAt) {
      card.append(
        el("div", `Expires at ${new Date(approval.expiresAt).toLocaleTimeString()} if not answered.`, {
          style: "margin:0 0 8px;opacity:.6;font-size:12px",
        }),
      );
    }
    const status = el("div", null, { className: "rk-approval-status", style: "margin-top:8px;font-size:12px;opacity:.8" });
    const row = el("div", null, { style: "display:flex;gap:8px;flex-wrap:wrap" });
    const decide = async (decision) => {
      for (const b of row.querySelectorAll("button")) b.disabled = true;
      try {
        await api(`/host-tools/approvals/${encodeURIComponent(approval.id)}/decision`, {
          method: "POST",
          body: JSON.stringify({ decision }),
        });
        decided.add(approval.id);
        card.remove();
        shownApprovalId = null;
      } catch (e) {
        decided.add(approval.id);
        status.textContent = e.message || String(e);
        setTimeout(() => card.remove(), 4000);
        shownApprovalId = null;
      }
    };
    const scope = approval.target ? "this exact command/path" : `all ${approval.action || "these"} actions`;
    row.append(el("button", "Allow once", { "data-decision": "allow-once", onclick: () => decide("allow-once") }));
    row.append(el("button", `Always (${scope}, this computer)`, { "data-decision": "always", onclick: () => decide("always") }));
    row.append(el("button", "Deny", { "data-decision": "deny", onclick: () => decide("deny") }));
    card.append(row, status);
    document.body.append(card);
  }

  async function pollApprovals() {
    let delay = 4000;
    try {
      if (document.visibilityState !== "hidden") {
        const data = await api("/host-tools/approvals");
        const list = (data.approvals || []).filter((a) => !decided.has(a.id));
        const shown = document.getElementById("rk-host-approval");
        if (shown && shownApprovalId && !list.some((a) => a.id === shownApprovalId) && !decided.has(shownApprovalId)) {
          shown.remove(); // expired or decided elsewhere
          shownApprovalId = null;
        }
        if (list[0] && !document.getElementById("rk-host-approval")) showApprovalCard(list[0]);
      }
    } catch {
      delay = 30000; // signed out or offline: back off
    }
    setTimeout(pollApprovals, delay);
  }

  async function openAuthStatus() {
    const body = panel("Account security");
    try {
      const data = await api("/parity/auth/status");
      body.replaceChildren();
      body.append(el("p", `Password set: ${data.hasPassword ? "yes" : "no"}`));
      body.append(el("p", `Passkeys: ${data.passkeyCount}`));
      body.append(
        el("p", "Set a password from Settings → Account (Better Auth). Passkeys use /api/auth/passkey when enabled.", {
          style: "opacity:.75;font-size:12px",
        }),
      );
    } catch (e) {
      body.replaceChildren(el("p", e.message || String(e)));
    }
  }

  /**
   * The bot whose chat is open. Same parsing as the app's routes (/app/:botId for a bot
   * chat, /app/g/:groupId for a group; see also bot-time-prefs.js), plus the older
   * /bots/<id> and ?botId= forms.
   */
  function currentBotId() {
    const parts = location.pathname.split("/");
    if (parts[1] === "app" && parts[2] && parts[2] !== "g") {
      try {
        return decodeURIComponent(parts[2]);
      } catch {
        return null;
      }
    }
    const m = location.pathname.match(/\/bots\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    return new URLSearchParams(location.search).get("botId");
  }

  function installMenu() {
    if (document.getElementById("rk-parity-fab")) return;
    const fab = el("div", null, {
      id: "rk-parity-fab",
      style:
        "position:fixed;right:16px;bottom:16px;z-index:99980;display:flex;flex-direction:column;gap:6px",
    });
    const mk = (label, fn) =>
      el("button", label, {
        style:
          "background:#1f6feb;color:#fff;border:0;border-radius:999px;padding:8px 12px;cursor:pointer;font:12px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.35)",
        onclick: fn,
      });
    fab.append(mk("Permissions", () => openToolPermissions()));
    fab.append(mk("Marketplace", () => openMarketplace()));
    fab.append(mk("Connectors", () => openMcpCatalog()));
    fab.append(mk("Security", () => openAuthStatus()));
    fab.append(
      mk("On my PC", () => {
        const id = currentBotId();
        if (!id) {
          alert("Open a bot chat first, then use On my PC.");
          return;
        }
        openBotModelPicker(id);
      }),
    );
    fab.append(
      mk("Routines", () => {
        const id = currentBotId();
        if (!id) {
          alert("Open a bot chat first.");
          return;
        }
        openRoutines(id);
      }),
    );
    document.body.append(fab);
  }

  // A tool result can announce a pending approval right away; polling picks it up otherwise.
  window.addEventListener("rakijazios:host-tool-permission", (ev) => {
    const a = ev && ev.detail && (ev.detail.approval || ev.detail);
    if (a && a.id) showApprovalCard(a);
  });
  if (!window.__rkApprovalPoll) {
    window.__rkApprovalPoll = true;
    setTimeout(pollApprovals, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installMenu);
  } else {
    installMenu();
  }

  window.RakijaziosParity = {
    currentBotId,
    openBotModelPicker,
    openToolPermissions,
    openRoutines,
    openMarketplace,
    openMcpCatalog,
    openAuthStatus,
    showApprovalCard,
    pollApprovals,
  };
})();
