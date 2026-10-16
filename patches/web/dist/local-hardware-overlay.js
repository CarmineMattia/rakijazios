/*
 * Rakijazios M2a: Settings → My hardware.
 * Pair this or another computer with a one-time code (OS-aware one-liner or a
 * Windows .cmd with the code baked in), see computers online/offline, switch
 * models on/off, pause, give a new key, remove. Hidden unless the server sets
 * RAKAZO_LOCAL_RUNNERS_UI=1 (GET /api/local-runners/config).
 * M2b: "Bots on my computer" — bind each of your bots to one computer + model
 * (replaces the operator SQL). Lives here rather than in the bot panel, whose
 * minified markup is too fragile to overlay.
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
  #${PANEL_ID} .rk-hw-limits{margin:8px 0;font-size:13px}
  #${PANEL_ID} .rk-hw-limits label{display:flex;gap:8px;align-items:center;justify-content:space-between;margin:4px 0}
  #${PANEL_ID} .rk-hw-limits input{width:90px}
  #${PANEL_ID} .rk-hw-usage svg{display:block;margin:8px 0}
  #${PANEL_ID} .rk-hw-usage table{font-size:12.5px;border-collapse:collapse}
  #${PANEL_ID} .rk-hw-usage td{padding:2px 10px 2px 0}
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
    const botsSection = el("div", "", { data: { rk: "hw-bots" } });
    p.append(botsSection);
    renderBots(botsSection, my).catch(() => {});
    const usageSection = el("div", "", { data: { rk: "hw-usage" } });
    p.append(usageSection);
    renderUsage(usageSection, my, data.devices).catch(() => {});
    const refresh = () => {
      if (my !== epoch || view.kind !== "list" || settingsRoot()?.getAttribute("data-rk-hw") !== "1") return;
      // Do not redraw under the user's hands (an open picker or rename box).
      const active = document.activeElement;
      if (active && panel()?.contains(active) && /^(SELECT|INPUT)$/.test(active.tagName)) {
        listTimer = setTimeout(refresh, 10_000);
        return;
      }
      renderList();
    };
    listTimer = setTimeout(refresh, 10_000);
  }

  // Computers whose "Limits" section is open (kept across the 10 s list refresh).
  const openLimits = new Set();

  function limitsBlock(d) {
    const box = el("details", "", { className: "rk-hw-limits", data: { rk: "hw-limits" } });
    if (openLimits.has(d.id)) box.open = true;
    box.addEventListener("toggle", () => (box.open ? openLimits.add(d.id) : openLimits.delete(d.id)));
    const l = d.limits || { maxConcurrent: 2, perUserPerMinute: 20, dailyRequestCap: null, personDailyCap: null, dailyTokenCap: null };
    const caps = [
      l.dailyRequestCap ? `${l.dailyRequestCap}/day` : null,
      l.personDailyCap ? `${l.personDailyCap}/day per person` : null,
      l.dailyTokenCap ? `${l.dailyTokenCap.toLocaleString()} tokens/day` : null,
    ].filter(Boolean);
    box.append(el("summary", `Limits: ${l.maxConcurrent} at a time · ${l.perUserPerMinute}/min per person · ${caps.length ? caps.join(" · ") : "no daily cap"}`));
    const field = (label, key, value, min, max, placeholder) => {
      const row = el("label", label);
      const input = el("input", "", { type: "number", value: value ?? "", attrs: { min: String(min), max: String(max), step: "1", ...(placeholder ? { placeholder } : {}) }, data: { "rk-limit": key } });
      row.append(input);
      box.append(row);
      return input;
    };
    const conc = field("Answers at the same time", "maxConcurrent", l.maxConcurrent, 1, 8);
    const rate = field("Requests per person per minute (other people)", "perUserPerMinute", l.perUserPerMinute, 1, 600);
    const cap = field("Daily requests from other people (empty = no cap)", "dailyRequestCap", l.dailyRequestCap, 1, 100000, "no cap");
    const pcap = field("Daily requests per person (empty = no cap)", "personDailyCap", l.personDailyCap, 1, 100000, "no cap");
    const tcap = field("Daily tokens from other people (empty = no cap)", "dailyTokenCap", l.dailyTokenCap, 1000, 1000000000, "no cap");
    box.append(el("p", "Your own bots are only limited by \"at the same time\". People in your shared groups get a clear notice when a limit is reached.", { className: "rk-hw-hint" }));
    const save = el("button", "Save limits", { type: "button", data: { rk: "hw-limits-save" } });
    const msg = el("span", "", { className: "rk-hw-hint", data: { rk: "hw-limits-msg" } });
    save.addEventListener("click", async () => {
      save.disabled = true;
      msg.textContent = "Saving…";
      try {
        const body = { maxConcurrent: Number(conc.value), perUserPerMinute: Number(rate.value), dailyRequestCap: cap.value === "" ? null : Number(cap.value), personDailyCap: pcap.value === "" ? null : Number(pcap.value), dailyTokenCap: tcap.value === "" ? null : Number(tcap.value) };
        const r = await api(`/devices/${encodeURIComponent(d.id)}/limits`, body);
        d.limits = r.limits;
        msg.textContent = "Saved.";
      } catch (e) {
        msg.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    });
    box.append(save, msg);
    return box;
  }

  async function renderUsage(section, my, devices) {
    let data;
    try {
      data = await api("/usage?days=14");
    } catch {
      return;
    }
    if (my !== epoch) return;
    section.replaceChildren(el("h4", "Usage (last 14 days)"));
    section.className = "rk-hw-usage";
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const per = days.map((day) => {
      const rows = data.daily.filter((r) => r.day === day);
      const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
      return { day, requests: sum("requests"), peer: sum("peerRequests"), refused: sum("refused"), tokens: sum("inputTokens") + sum("outputTokens") };
    });
    const total = per.reduce((n, x) => n + x.requests, 0);
    if (!total && !per.some((x) => x.refused)) {
      section.append(el("p", "No answers from your computers yet.", { className: "rk-hw-hint", data: { rk: "hw-usage-empty" } }));
      return;
    }
    const max = Math.max(1, ...per.map((x) => x.requests + x.refused));
    const W = 14 * 22, H = 80, NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(H + 16)); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Answers per day, last 14 days: ${total} in total`);
    svg.setAttribute("data-rk", "hw-usage-chart");
    const rect = (x, y, w, h, fill, title) => {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", x); r.setAttribute("y", y); r.setAttribute("width", w); r.setAttribute("height", Math.max(0, h)); r.setAttribute("fill", fill);
      const t = document.createElementNS(NS, "title"); t.textContent = title; r.append(t);
      svg.append(r);
    };
    per.forEach((x, i) => {
      const own = x.requests - x.peer;
      const hOwn = (own / max) * H, hPeer = (x.peer / max) * H, hRef = (x.refused / max) * H;
      const label = `${x.day}: ${x.requests} answers (${x.peer} for other people), ${x.refused} refused, ${x.tokens} tokens`;
      rect(i * 22 + 3, H - hOwn, 16, hOwn, "#60a5fa", label);
      rect(i * 22 + 3, H - hOwn - hPeer, 16, hPeer, "#a78bfa", label);
      rect(i * 22 + 3, H - hOwn - hPeer - hRef, 16, hRef, "#f87171", label);
      if (i % 2 === 0) {
        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", String(i * 22 + 2)); t.setAttribute("y", String(H + 13)); t.setAttribute("font-size", "9"); t.setAttribute("fill", "currentColor");
        t.textContent = x.day.slice(5); svg.append(t);
      }
    });
    section.append(svg);
    const peer = per.reduce((n, x) => n + x.peer, 0), refused = per.reduce((n, x) => n + x.refused, 0), tokens = per.reduce((n, x) => n + x.tokens, 0);
    section.append(el("p", `${total} answers (blue: you, purple: other people ${peer}), ${refused} refused by limits (red), ${tokens} tokens.`, { className: "rk-hw-hint", data: { rk: "hw-usage-total" } }));
    if (data.people.length) {
      const table = el("table", "", { data: { rk: "hw-usage-people" } });
      for (const person of data.people) {
        const tr = el("tr", "");
        tr.append(el("td", person.name), el("td", `${person.requests} answers`), el("td", person.refused ? `${person.refused} refused` : ""), el("td", `${person.tokens} tokens`));
        table.append(tr);
      }
      section.append(table);
    }
  }

  // Last "Check now" result per computer (kept across the 10 s list refresh).
  const checkResults = new Map();

  function healthText(d) {
    const h = d.health || {};
    const r = h.report;
    const parts = [];
    if (d.online && r) {
      parts.push(r.modelServerOk ? `Model server OK (${r.models} model${r.models === 1 ? "" : "s"})` : "Model server not answering on that computer");
    }
    if (h.inFlight) parts.push(`${h.inFlight} answering now`);
    if (h.queued) parts.push(`${h.queued} waiting`);
    if (h.lastAnswerAt) parts.push(`last answer ${ago(h.lastAnswerAt)}`);
    if (h.lastFailure) parts.push(`last problem ${ago(h.lastFailure.at)}: ${h.lastFailure.message}`);
    else if (r && r.lastError) parts.push(`last problem ${ago(new Date(r.lastErrorAt).toISOString())}: ${r.lastError}`);
    if (!d.online && h.lastDisconnect) parts.push(`disconnected ${ago(h.lastDisconnect.at)} (${h.lastDisconnect.reason})`);
    return parts.join(" · ");
  }

  function checkText(res) {
    if (!res) return "";
    if (res.error) return `Check failed: ${res.error}`;
    if (!res.online) return "Not reachable: the runner on that computer isn't connected. Check that it is on and running.";
    if (!res.supported) return `This runner (${res.runnerVersion || "old"}) can't run checks. Update it to ${res.latestRunnerVersion} to use Check now.`;
    const h = res.health;
    return h.modelServerOk
      ? `All good: model server answered in ${h.latencyMs ?? "?"} ms with ${h.models} model${h.models === 1 ? "" : "s"}.`
      : "Runner connected, but no model server is answering on that computer. Start Ollama, LM Studio or llama.cpp there.";
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
    const health = healthText(d);
    if (health) card.append(el("div", health, { className: "rk-hw-meta", data: { rk: "hw-health" } }));
    if (d.updateAvailable) {
      card.append(
        el(
          "p",
          `Update available: runner ${d.latestRunnerVersion}. Press "New key" and run the new command on that computer; it updates the runner and keeps this computer and its settings.`,
          { className: "rk-hw-hint", data: { rk: "hw-update" } },
        ),
      );
    }
    const checkLine = el("div", checkText(checkResults.get(d.id)), { className: "rk-hw-hint", data: { rk: "hw-check-result" } });
    card.append(checkLine);
    card.append(limitsBlock(d));
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
    const check = el("button", "Check now", { type: "button", data: { rk: "hw-check" } });
    check.addEventListener("click", async () => {
      check.disabled = true;
      checkLine.textContent = "Checking…";
      let res;
      try {
        res = await api(`/devices/${encodeURIComponent(d.id)}/check`, {});
      } catch (e) {
        res = { error: e.message };
      }
      checkResults.set(d.id, res);
      checkLine.textContent = checkText(res);
      check.disabled = false;
    });
    actions.append(check, pause, rotate, remove);
    card.append(actions);
    return card;
  }

  // ---------- M2b: bots on my computer ----------
  async function renderBots(section, my) {
    const [botsRes, offered] = await Promise.all([api("/bots"), api("/offered-models")]);
    if (my !== epoch) return;
    section.append(el("h3", "Bots on my computer", { attrs: { style: "margin:22px 0 4px;font-size:16px;font-weight:600" } }));
    section.append(
      el(
        "p",
        "Pick which computer and model a bot uses. Only models you switched on above are listed. A bot on your computer answers only you and groups that are not shared, never external channels.",
        { className: "rk-hw-hint" },
      ),
    );
    const choices = [];
    for (const d of offered.devices) {
      for (const m of d.models) {
        choices.push({
          value: `${d.id}|${m.id}`,
          label: `${m.id} — ${d.name}${d.paused ? " (paused)" : d.online ? (m.availableNow ? "" : " (not available now)") : " (offline)"}`,
          deviceId: d.id,
          modelId: m.id,
        });
      }
    }
    if (!botsRes.bots.length) {
      section.append(el("p", "You have no bots yet.", { className: "rk-hw-hint" }));
      return;
    }
    for (const b of botsRes.bots) {
      const line = el("div", "", { className: "rk-hw-model", data: { "rk-bot": b.id } });
      const left = el("div", "", {});
      left.append(el("span", b.name, { className: "rk-hw-name" }));
      if (b.needsSetup) {
        left.append(el("div", "Pick a computer for this bot; it can't answer until you do.", { className: "rk-hw-err", attrs: { style: "font-size:12.5px" } }));
      }
      const select = el("select", "", { attrs: { "aria-label": `Computer and model for ${b.name}` } });
      select.append(el("option", "Not on my computer", { value: "" }));
      const current = b.onMyComputer && b.deviceId && b.modelId ? `${b.deviceId}|${b.modelId}` : "";
      for (const c of choices) select.append(el("option", c.label, { value: c.value }));
      if (current && !choices.some((c) => c.value === current)) {
        select.append(el("option", `${b.modelId} (switched off)`, { value: current, disabled: true }));
      }
      select.value = current;
      if (b.onMyComputer && !current) {
        select.prepend(el("option", "Choose…", { value: "__pick", disabled: true }));
        select.value = "__pick";
      }
      const msg = el("span", "", { className: "rk-hw-hint", attrs: { role: "status" } });
      select.addEventListener("change", async () => {
        select.disabled = true;
        msg.textContent = "Saving…";
        try {
          const pick = choices.find((c) => c.value === select.value);
          await api(`/bots/${encodeURIComponent(b.id)}/model`, pick ? { deviceId: pick.deviceId, modelId: pick.modelId } : { clear: true });
          msg.textContent = pick ? "Saved" : "Saved — uses the space default model again";
          msg.className = "rk-hw-ok";
        } catch (e) {
          msg.textContent = e.message;
          msg.className = "rk-hw-err";
        } finally {
          select.disabled = false;
        }
      });
      const right = el("div", "", { className: "rk-hw-row" });
      right.append(msg, select);
      line.append(left, right);
      section.append(line);
    }
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
