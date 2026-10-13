/*
 * Rakijazios M2a: Settings → My hardware.
 * Pair this or another computer with a one-time code (OS-aware one-liner or a
 * Windows .cmd with the code baked in), see computers online/offline, switch
 * models on/off, pause, give a new key, remove. Hidden unless the server sets
 * RAKAZO_LOCAL_RUNNERS_UI=1 (GET /api/local-runners/config).
 */
(() => {
  if (!location.pathname.startsWith("/app")) return;
  const BASE = "/api/local-runners";
  const NAV_ID = "rk-hw-nav";
  const PANEL_ID = "rk-hw-panel";
  let enabled = null; // null = unknown yet
  let view = { kind: "list" }; // list | add
  let pollTimer = null;
  let listTimer = null;
  let epoch = 0;

  const style = document.createElement("style");
  style.textContent = `
  [data-testid="user-settings"][data-rk-hw="1"] [data-testid="settings-nav"] ~ div:not(#${PANEL_ID}){display:none!important}
  [data-testid="user-settings"][data-rk-hw="1"] [data-testid^="settings-nav-"][aria-current="page"]{background:transparent!important;color:var(--muted-foreground,#a1a1aa)!important}
  #${PANEL_ID}{display:none;min-height:0;min-width:0;flex:1;flex-direction:column;overflow:auto;padding:24px 32px;color:var(--foreground,inherit);font-size:13.5px;line-height:1.45}
  [data-testid="user-settings"][data-rk-hw="1"] #${PANEL_ID}{display:flex}
  #${PANEL_ID} h2{margin:0;font-size:24px;font-weight:500}
  #${PANEL_ID} .rk-hw-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:6px}
  #${PANEL_ID} .rk-hw-copy{margin:0 0 16px;color:var(--muted-foreground,#a1a1aa)}
  #${PANEL_ID} button{border:1px solid var(--border,#3f3f46);border-radius:10px;background:transparent;color:inherit;padding:6px 12px;cursor:pointer;font:inherit}
  #${PANEL_ID} button:disabled{opacity:.5;cursor:default}
  #${PANEL_ID} button.rk-primary{background:#3ec5a8;border-color:#3ec5a8;color:#06231c;font-weight:600}
  #${PANEL_ID} button.rk-danger{color:#fca5a5}
  #${PANEL_ID} .rk-hw-card{border:1px solid var(--border,#3f3f46);border-radius:14px;padding:14px 16px;margin:10px 0}
  #${PANEL_ID} .rk-hw-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  #${PANEL_ID} .rk-hw-name{font-weight:600;font-size:14.5px}
  #${PANEL_ID} .rk-hw-pill{font-size:11.5px;border-radius:999px;padding:1px 8px;border:1px solid currentColor}
  #${PANEL_ID} .rk-on{color:#3ec5a8} #${PANEL_ID} .rk-off{color:#a1a1aa} #${PANEL_ID} .rk-paused{color:#f59e0b}
  #${PANEL_ID} .rk-hw-meta{color:var(--muted-foreground,#a1a1aa);font-size:12.5px;margin:4px 0 8px}
  #${PANEL_ID} .rk-hw-model{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 0;border-top:1px solid var(--border,rgba(255,255,255,.08))}
  #${PANEL_ID} .rk-hw-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  #${PANEL_ID} .rk-switch{appearance:none;width:40px;height:24px;border-radius:999px;border:0!important;background:#3f3f46!important;position:relative;padding:0!important;flex:0 0 auto}
  #${PANEL_ID} .rk-switch[aria-checked="true"]{background:#3ec5a8!important}
  #${PANEL_ID} .rk-switch::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:999px;background:#fff;transition:transform .15s}
  #${PANEL_ID} .rk-switch[aria-checked="true"]::after{transform:translateX(16px)}
  #${PANEL_ID} pre{white-space:pre-wrap;word-break:break-all;background:var(--muted,#18181b);border:1px solid var(--border,#3f3f46);border-radius:10px;padding:10px 12px;margin:6px 0;font-size:12.5px}
  #${PANEL_ID} select,#${PANEL_ID} input[type=text]{background:transparent;color:inherit;border:1px solid var(--border,#3f3f46);border-radius:8px;padding:5px 8px;font:inherit}
  #${PANEL_ID} select option{color:#111}
  #${PANEL_ID} .rk-hw-step{margin:14px 0}
  #${PANEL_ID} .rk-hw-status{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--muted,#18181b)}
  #${PANEL_ID} .rk-hw-err{color:#fca5a5}
  #${PANEL_ID} .rk-hw-ok{color:#3ec5a8;font-weight:600}
  #${PANEL_ID} .rk-hw-hint{color:var(--muted-foreground,#a1a1aa);font-size:12.5px}
  #${PANEL_ID} details summary{cursor:pointer;color:var(--muted-foreground,#a1a1aa);font-size:12.5px;margin-top:8px}`;
  document.head.appendChild(style);

  function el(tag, text, props = {}) {
    const node = document.createElement(tag);
    if (text != null && text !== "") node.textContent = text;
    for (const [k, v] of Object.entries(props)) {
      if (k === "data") for (const [dk, dv] of Object.entries(v)) node.setAttribute(`data-${dk}`, dv);
      else if (k === "attrs") for (const [ak, av] of Object.entries(v)) node.setAttribute(ak, av);
      else node[k] = v;
    }
    return node;
  }

  async function api(path, body) {
    const init = { credentials: "include", headers: { accept: "application/json" } };
    if (body !== undefined) {
      init.method = "POST";
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function detectOs() {
    const p = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`;
    if (/android/i.test(p)) return "android";
    if (/iphone|ipad|ipod|\bios\b/i.test(p)) return "ios";
    if (/mac/i.test(p)) return "macos";
    if (/win/i.test(p)) return "windows";
    return "linux";
  }

  function ago(iso) {
    if (!iso) return "never";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  function stopTimers() {
    clearTimeout(pollTimer);
    clearTimeout(listTimer);
    pollTimer = listTimer = null;
  }

  function settingsRoot() {
    return document.querySelector('[data-testid="user-settings"]');
  }

  function activate(on) {
    const root = settingsRoot();
    if (!root) return;
    if (on) {
      root.setAttribute("data-rk-hw", "1");
      document.getElementById(NAV_ID)?.setAttribute("aria-current", "page");
      view = { kind: "list" };
      render();
    } else {
      if (view.kind === "add" && view.pairing && view.state === "pending") {
        api(`/pairings/${encodeURIComponent(view.pairing.pairingId)}/cancel`, {}).catch(() => {});
      }
      root.removeAttribute("data-rk-hw");
      document.getElementById(NAV_ID)?.removeAttribute("aria-current");
      stopTimers();
      epoch++;
    }
  }

  function panel() {
    return document.getElementById(PANEL_ID);
  }

  function header(title, onBack) {
    const head = el("div", "", { className: "rk-hw-head" });
    head.append(el("h2", title));
    const right = el("div", "", { className: "rk-hw-row" });
    if (onBack) {
      const back = el("button", "Back", { type: "button" });
      back.addEventListener("click", onBack);
      right.append(back);
    }
    const close = el("button", "Close", { type: "button", attrs: { "aria-label": "Close settings" } });
    close.addEventListener("click", () => settingsRoot()?.querySelector('[data-slot="dialog-close"]')?.click());
    right.append(close);
    head.append(right);
    return head;
  }

  // ---------- device list ----------
  async function renderList() {
    const p = panel();
    if (!p) return;
    const my = ++epoch;
    p.replaceChildren(header("My hardware"));
    p.append(
      el(
        "p",
        "Use a model running on your own computer for your bots. Nothing is opened on your computer: a small runner connects out to Rakijazios and only talks to the model server on that computer.",
        { className: "rk-hw-copy" },
      ),
    );
    const add = el("button", "Add a computer", { type: "button", className: "rk-primary", data: { rk: "hw-add" } });
    const note = el("span", "", { className: "rk-hw-hint" });
    const top = el("div", "", { className: "rk-hw-row" });
    top.append(add, note);
    const list = el("div", "", { data: { rk: "hw-list" } });
    const status = el("p", "Loading…", { className: "rk-hw-hint", attrs: { role: "status" } });
    p.append(top, list, status);
    add.addEventListener("click", () => startAdd(null));
    let data;
    try {
      data = await api("/devices");
    } catch (e) {
      if (my !== epoch) return;
      status.textContent = e.message;
      status.className = "rk-hw-err";
      return;
    }
    if (my !== epoch) return;
    status.textContent = data.devices.length ? "" : "No computers yet.";
    if (data.devices.length >= data.maxDevices) {
      add.disabled = true;
      note.textContent = `You can connect up to ${data.maxDevices} computers. Remove one to add another.`;
    }
    for (const d of data.devices) list.append(deviceCard(d));
    listTimer = setTimeout(() => {
      if (my === epoch && view.kind === "list" && settingsRoot()?.getAttribute("data-rk-hw") === "1") renderList();
    }, 10_000);
  }

  function deviceCard(d) {
    const card = el("div", "", { className: "rk-hw-card", data: { "rk-device": d.id } });
    const row = el("div", "", { className: "rk-hw-row" });
    const name = el("span", d.name, { className: "rk-hw-name" });
    const pill = !d.enabled
      ? el("span", "Paused", { className: "rk-hw-pill rk-paused" })
      : d.online
        ? el("span", "Online", { className: "rk-hw-pill rk-on" })
        : el("span", "Offline", { className: "rk-hw-pill rk-off" });
    pill.setAttribute("data-rk", "hw-state");
    const rename = el("button", "Rename", { type: "button" });
    row.append(name, pill, rename);
    card.append(row);
    const meta = [
      d.online ? "Connected now" : `Last seen ${ago(d.lastSeenAt)}`,
      d.platform,
      d.runnerVersion ? `runner ${d.runnerVersion}` : null,
      d.online ? `model server: ${d.modelServer && d.modelServer !== "none" ? d.modelServer : "none found"}` : null,
    ].filter(Boolean);
    card.append(el("div", meta.join(" · "), { className: "rk-hw-meta" }));
    rename.addEventListener("click", () => {
      const input = el("input", "", { type: "text", value: d.name, maxLength: 64 });
      const save = el("button", "Save", { type: "button" });
      row.replaceChildren(input, save);
      input.focus();
      const commit = async () => {
        save.disabled = true;
        try {
          await api(`/devices/${encodeURIComponent(d.id)}`, { name: input.value });
        } catch (e) {
          alert(e.message);
        }
        renderList();
      };
      save.addEventListener("click", commit);
      input.addEventListener("keydown", (ev) => ev.key === "Enter" && commit());
    });

    const models = el("div", "", {});
    if (!d.models.length) {
      models.append(
        el(
          "p",
          d.online
            ? "No models found on this computer. Start Ollama, LM Studio or llama.cpp there; the runner checks every minute."
            : "Models appear here when the computer is online.",
          { className: "rk-hw-hint" },
        ),
      );
    } else {
      models.append(el("div", "Models offered to your bots (off by default):", { className: "rk-hw-hint" }));
    }
    for (const m of d.models) {
      const line = el("div", "", { className: "rk-hw-model", data: { "rk-model": m.id } });
      const label = el("span", m.id + (m.available ? "" : " (not available right now)"));
      const sw = el("button", "", {
        type: "button",
        className: "rk-switch",
        attrs: { role: "switch", "aria-checked": String(Boolean(m.enabled)), "aria-label": `Offer ${m.id}` },
      });
      sw.addEventListener("click", async () => {
        sw.disabled = true;
        try {
          await api(`/devices/${encodeURIComponent(d.id)}/models`, { modelId: m.id, enabled: !m.enabled });
          m.enabled = !m.enabled;
          sw.setAttribute("aria-checked", String(m.enabled));
        } catch (e) {
          alert(e.message);
        } finally {
          sw.disabled = false;
        }
      });
      line.append(label, sw);
      models.append(line);
    }
    card.append(models);

    const actions = el("div", "", { className: "rk-hw-actions" });
    const pause = el("button", d.enabled ? "Pause sharing" : "Resume sharing", { type: "button", data: { rk: "hw-pause" } });
    pause.addEventListener("click", async () => {
      pause.disabled = true;
      try {
        await api(`/devices/${encodeURIComponent(d.id)}`, { enabled: !d.enabled });
      } catch (e) {
        alert(e.message);
      }
      renderList();
    });
    const rotate = el("button", "New key", { type: "button", data: { rk: "hw-rotate" } });
    rotate.addEventListener("click", async () => {
      if (!confirm(`Give "${d.name}" a new key? It disconnects now. Then run the new command on that computer to connect it again (its settings are kept).`)) return;
      rotate.disabled = true;
      try {
        const pairing = await api(`/devices/${encodeURIComponent(d.id)}/rotate`, { os: detectOs() });
        startAdd(pairing, d.name);
      } catch (e) {
        alert(e.message);
        renderList();
      }
    });
    const remove = el("button", "Remove", { type: "button", className: "rk-danger", data: { rk: "hw-remove" } });
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove "${d.name}"? The runner there disconnects and stops. Bots that use its models will stop answering until you choose another model.`)) return;
      remove.disabled = true;
      try {
        await api(`/devices/${encodeURIComponent(d.id)}/revoke`, {});
      } catch (e) {
        alert(e.message);
      }
      renderList();
    });
    actions.append(pause, rotate, remove);
    card.append(actions);
    return card;
  }

  // ---------- add a computer ----------
  async function startAdd(existingPairing, reconnectName) {
    stopTimers();
    const detected = detectOs();
    view = {
      kind: "add",
      os: detected === "android" || detected === "ios" ? "linux" : detected,
      detected,
      autostart: true,
      pairing: existingPairing || null,
      reconnectName: reconnectName || null,
      state: "pending",
      device: null,
      error: null,
    };
    render();
    if (!existingPairing) {
      try {
        view.pairing = await api("/pairings", { os: view.os });
      } catch (e) {
        view.error = e.message;
      }
      render();
    }
    poll();
  }

  function poll() {
    const my = epoch;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (my !== epoch || view.kind !== "add" || !view.pairing) return;
      try {
        const s = await api(`/pairings/${encodeURIComponent(view.pairing.pairingId)}`);
        if (my !== epoch) return;
        const changed = s.status !== view.state || JSON.stringify(s.device) !== JSON.stringify(view.device);
        view.state = s.status;
        view.device = s.device;
        if (changed) renderAdd(true);
        else updateCountdown();
      } catch (e) {
        view.error = e.message;
        renderAdd(true);
      }
      if (["pending", "paired"].includes(view.state) || (view.state === "connected" && !view.device?.models?.length)) poll();
    }, 2000);
  }

  function updateCountdown() {
    const node = panel()?.querySelector('[data-rk="hw-countdown"]');
    if (!node || !view.pairing) return;
    const left = Math.max(0, Math.round((new Date(view.pairing.expiresAt).getTime() - Date.now()) / 1000));
    node.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  }

  function copyButton(text) {
    const b = el("button", "Copy", { type: "button", data: { rk: "hw-copy" } });
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copied";
      } catch {
        b.textContent = "Select and copy";
      }
      setTimeout(() => (b.textContent = "Copy"), 2000);
    });
    return b;
  }

  function downloadCmd(text) {
    const blob = new Blob([text], { type: "application/octet-stream" });
    const a = el("a", "", { href: URL.createObjectURL(blob), download: "Rakijazios-connect.cmd" });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function renderAdd(keepScroll) {
    const p = panel();
    if (!p) return;
    const scroll = p.scrollTop;
    const title = view.reconnectName ? `Reconnect ${view.reconnectName}` : "Add a computer";
    p.replaceChildren(
      header(title, () => {
        if (view.pairing && view.state === "pending") {
          api(`/pairings/${encodeURIComponent(view.pairing.pairingId)}/cancel`, {}).catch(() => {});
        }
        epoch++;
        stopTimers();
        view = { kind: "list" };
        render();
      }),
    );
    if (view.error && !view.pairing) {
      p.append(el("p", view.error, { className: "rk-hw-err" }));
      return;
    }
    const done = view.state === "connected" || view.state === "paired";
    if (!done) {
      p.append(
        el(
          "p",
          view.reconnectName
            ? "The old key no longer works. Run this once on that computer to give it the new key."
            : "Run this once on the computer you want to share. It installs a small runner for your user only (no admin rights), connects it to your account and starts it.",
          { className: "rk-hw-copy" },
        ),
      );
      if (view.detected === "android" || view.detected === "ios") {
        p.append(
          el("p", "Phones can't share a model yet. Open this page on a Linux, macOS or Windows computer, or pick its system below.", {
            className: "rk-hw-err",
          }),
        );
      }
      const osRow = el("div", "", { className: "rk-hw-row rk-hw-step" });
      const select = el("select", "", { attrs: { "aria-label": "System of that computer" }, data: { rk: "hw-os" } });
      for (const [v, label] of [["linux", "Linux"], ["macos", "macOS"], ["windows", "Windows"]]) {
        select.append(el("option", label, { value: v, selected: view.os === v }));
      }
      select.addEventListener("change", () => {
        view.os = select.value;
        renderAdd(true);
      });
      const auto = el("input", "", { type: "checkbox", checked: view.autostart, id: "rk-hw-auto" });
      auto.addEventListener("change", () => {
        view.autostart = auto.checked;
        renderAdd(true);
      });
      const autoLabel = el("label", " Start automatically when I log in", { htmlFor: "rk-hw-auto" });
      autoLabel.prepend(auto);
      osRow.append(el("span", "System:"), select, autoLabel);
      p.append(osRow);

      const cmds = view.pairing?.commands;
      const step = el("div", "", { className: "rk-hw-step", data: { rk: "hw-primary" } });
      if (!cmds) step.append(el("p", "Creating a one-time code…", { className: "rk-hw-hint" }));
      else if (view.os === "windows") {
        const dl = el("button", "Download the installer for Windows", { type: "button", className: "rk-primary", data: { rk: "hw-download" } });
        dl.addEventListener("click", () => downloadCmd(view.autostart ? cmds.windowsCmd : cmds.windowsCmdNoAutostart));
        step.append(
          dl,
          el(
            "p",
            "Then double-click Rakijazios-connect.cmd. If Windows SmartScreen warns you, choose More info → Run anyway. Node.js is downloaded automatically if it is missing.",
            { className: "rk-hw-hint" },
          ),
        );
        const more = el("details", "", {});
        more.append(el("summary", "Prefer PowerShell?"));
        const ps = view.autostart ? cmds.powershell : cmds.powershellNoAutostart;
        more.append(el("pre", ps), copyButton(ps));
        step.append(more);
      } else {
        const cmd = view.autostart ? cmds.unix : cmds.unixNoAutostart;
        step.append(
          el("div", `Open a terminal on that ${view.os === "macos" ? "Mac" : "computer"}, paste this and press Enter:`),
          el("pre", cmd, { data: { rk: "hw-command" } }),
          copyButton(cmd),
          el("p", "Node.js is downloaded automatically if it is missing. No sudo needed.", { className: "rk-hw-hint" }),
        );
      }
      p.append(step);
      p.append(
        el(
          "p",
          "You also need a model server on that computer, e.g. Ollama (ollama.com), LM Studio or llama.cpp. The runner finds it by itself.",
          { className: "rk-hw-hint" },
        ),
      );
      p.append(
        el(
          "p",
          "Already connected that computer before (also with the older runner)? Running this again keeps its connection and settings and only updates the runner. It never replaces another connection unless you add --replace.",
          { className: "rk-hw-hint", data: { rk: "hw-existing-hint" } },
        ),
      );
    }

    const status = el("div", "", { className: "rk-hw-status", attrs: { role: "status" }, data: { rk: "hw-status" } });
    if (view.state === "pending" && view.pairing) {
      status.append(el("span", `Waiting for your computer… One-time code ${view.pairing.code}, expires in `));
      status.append(el("span", "", { data: { rk: "hw-countdown" } }));
    } else if (view.state === "paired") {
      status.append(el("span", `Paired as "${view.device?.name || "your computer"}". Connecting…`));
    } else if (view.state === "connected") {
      status.append(el("div", `✓ ${view.device?.name || "Your computer"} is connected`, { className: "rk-hw-ok" }));
      const models = view.device?.models || [];
      status.append(
        el(
          "div",
          models.length
            ? `Found ${models.length} model${models.length === 1 ? "" : "s"}: ${models.join(", ")}. Switch on the ones you want to offer in the list.`
            : "No model server found yet. Start Ollama, LM Studio or llama.cpp on that computer; it shows up within a minute.",
          { className: "rk-hw-hint" },
        ),
      );
      const ok = el("button", "Done", { type: "button", className: "rk-primary", data: { rk: "hw-done" } });
      ok.addEventListener("click", () => {
        epoch++;
        stopTimers();
        view = { kind: "list" };
        render();
      });
      status.append(el("div", "", {}), ok);
    } else if (view.state === "expired" || view.state === "cancelled") {
      status.append(el("span", view.state === "expired" ? "This code expired. " : "This code was replaced. ", { className: "rk-hw-err" }));
      const again = el("button", "Get a new code", { type: "button" });
      again.addEventListener("click", () => startAdd(null));
      status.append(again);
    }
    if (view.error) status.append(el("div", view.error, { className: "rk-hw-err" }));
    p.append(status);
    updateCountdown();
    if (keepScroll) p.scrollTop = scroll;
  }

  function render() {
    if (view.kind === "add") renderAdd(false);
    else renderList();
  }

  // ---------- mount ----------
  function ensureMounted() {
    const root = settingsRoot();
    if (!root) {
      stopTimers();
      return;
    }
    const nav = root.querySelector('[data-testid="settings-nav"]');
    if (!nav) return;
    if (!document.getElementById(NAV_ID)) {
      const sample = nav.querySelector('[data-testid^="settings-nav-"]:not([aria-current])') || nav.querySelector('[data-testid^="settings-nav-"]');
      const btn = el("button", "", { type: "button", id: NAV_ID, className: sample ? sample.className.replace(/\bbg-muted\b|\btext-foreground\b/g, "") : "" });
      btn.setAttribute("data-testid", "settings-nav-my-hardware-rk");
      btn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4 shrink-0" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
      btn.append(el("span", "My hardware", { className: "whitespace-nowrap" }));
      btn.addEventListener("click", () => activate(true));
      nav.append(btn);
      // Any native section switch leaves My hardware.
      nav.addEventListener(
        "click",
        (ev) => {
          const target = ev.target.closest?.('[data-testid^="settings-nav-"]');
          if (target && target.id !== NAV_ID) activate(false);
        },
        true,
      );
    }
    if (!document.getElementById(PANEL_ID)) {
      const box = el("div", "", { id: PANEL_ID });
      nav.parentElement.append(box);
      if (root.getAttribute("data-rk-hw") === "1") render();
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (enabled) ensureMounted();
    });
  }

  fetch(`${BASE}/config`, { credentials: "include" })
    .then((r) => (r.ok ? r.json() : { enabled: false }))
    .then((cfg) => {
      enabled = Boolean(cfg && cfg.enabled);
      if (!enabled) return;
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
      schedule();
    })
    .catch(() => {});
})();
