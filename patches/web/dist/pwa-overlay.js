/* Rakijazios PWA: registers the service worker and offers "Install app" on Android/Chromium phones/tablets. */
(() => {
  if (window.__rkPwa) return;
  window.__rkPwa = true;
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e) => console.warn("[rk-pwa] sw register failed", e));
    });
  }
  // Phone layout fixes (≤ 480 px wide). Composer: on a 393 px screen the bot avatar, attach, voice, send
  // and context ring left the text box only 128 px (a few words per line). The header already shows the
  // bot, so drop the avatar there and tighten the gaps.
  const style = document.createElement("style");
  style.id = "rk-mobile-fixes";
  style.textContent = `@media (max-width: 480px) {
  [data-testid="composer-bar"] { gap: 6px !important; padding-inline-start: 8px !important; padding-inline-end: 6px !important; }
  [data-testid="composer-bar"] > [data-testid="composer-avatar"] { display: none !important; }
  [data-testid="composer-bar"] textarea { min-width: 0 !important; }
}
/* Settings: below md the dialog was a floating card with 1 rem margins and a sideways tab strip whose
   later tabs (Usage, Updates, My hardware) started off-screen with no hint. Full-screen sheet, a fade on the
   strip's edge, and bigger close button. */
@media (max-width: 767px) {
  [data-testid="user-settings"][data-slot="dialog-content"] {
    top: 0 !important; left: 0 !important; translate: none !important; transform: none !important;
    width: 100vw !important; height: 100dvh !important; max-width: none !important; max-height: none !important;
    border-radius: 0 !important; padding-top: env(safe-area-inset-top) !important; padding-bottom: env(safe-area-inset-bottom) !important;
  }
  [data-testid="settings-nav"] {
    scroll-snap-type: x proximity; scroll-padding-inline: 12px;
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
            mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
  }
  [data-testid="settings-nav"].rk-nav-end { -webkit-mask-image: none; mask-image: none; }
  [data-testid="settings-nav"] > button { scroll-snap-align: start; min-height: 40px; }
  [aria-label="Close user settings"] { min-width: 40px !important; min-height: 40px !important; }
}`;
  (document.head || document.documentElement).append(style);

  // Keep the chosen settings tab in view and drop the edge fade once the strip is scrolled to its end.
  const navEnd = (nav) => nav.classList.toggle("rk-nav-end", nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 4);
  document.addEventListener("click", (e) => {
    const tab = e.target instanceof Element ? e.target.closest('[data-testid="settings-nav"] > button') : null;
    if (tab && window.innerWidth < 768) tab.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, true);
  document.addEventListener("scroll", (e) => {
    if (e.target instanceof Element && e.target.matches('[data-testid="settings-nav"]')) navEnd(e.target);
  }, true);

  const DISMISS = "rk-pwa-install-dismissed";
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  // Phones and tablets only: Chromium fires beforeinstallprompt on desktop too, where the toast just covered
  // the chat header. Touch = primary pointer is coarse (a touchscreen laptop with a mouse/trackpad is not).
  const touchDevice = () => window.matchMedia("(pointer: coarse)").matches;
  // Bottom edge of the chat header (row holding chat-header-status), so the toast goes below it, never over it.
  function headerBottom() {
    let b = 0;
    const status = document.querySelector('[data-testid="chat-header-status"]');
    for (let n = status; n && n !== document.body; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.width >= window.innerWidth * 0.5 && r.height < 160) { b = Math.max(b, r.bottom); break; }
    }
    for (const h of document.querySelectorAll("header")) {
      const r = h.getBoundingClientRect();
      if (r.height && r.top < 40 && r.bottom < 200) b = Math.max(b, r.bottom);
    }
    const t = document.querySelector('[data-testid="transcript"]');
    const tr = t && t.getBoundingClientRect();
    if (tr && tr.height && tr.top < 200) b = Math.max(b, tr.top);
    return Math.round(b);
  }
  function place() {
    const bar = document.getElementById("rk-pwa-install");
    if (!bar) return;
    const b = headerBottom();
    bar.style.top = b ? b + 8 + "px" : "calc(72px + env(safe-area-inset-top))";
  }
  let deferred = null;
  let placer = null;
  function remove() { document.getElementById("rk-pwa-install")?.remove(); if (placer) { clearInterval(placer); placer = null; } window.removeEventListener("resize", place); }
  function show() {
    if (!deferred || standalone() || localStorage.getItem(DISMISS) || !touchDevice()) return;
    if (document.getElementById("rk-pwa-install")) return;
    const bar = document.createElement("div");
    bar.id = "rk-pwa-install";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", "Install Rakijazios");
    bar.style.cssText = "position:fixed;left:12px;right:12px;top:calc(64px + env(safe-area-inset-top));z-index:2147483000;max-width:420px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:#1b1b1f;color:#f4f4f5;border:1px solid #2e2e33;box-shadow:0 8px 30px rgba(0,0,0,.45);font:14px/1.3 system-ui,sans-serif";
    const icon = document.createElement("img"); icon.src = "/icon-192.png"; icon.alt = ""; icon.width = 32; icon.height = 32; icon.style.borderRadius = "8px";
    const text = document.createElement("span"); text.textContent = "Install Rakijazios on this phone"; text.style.flex = "1";
    const yes = document.createElement("button"); yes.type = "button"; yes.dataset.rk = "pwa-install"; yes.textContent = "Install";
    yes.style.cssText = "border:0;border-radius:10px;padding:8px 14px;min-height:40px;background:#d5964f;color:#1b1b1f;font-weight:600";
    const no = document.createElement("button"); no.type = "button"; no.dataset.rk = "pwa-install-dismiss"; no.textContent = "Not now"; no.setAttribute("aria-label", "Not now");
    no.style.cssText = "border:0;background:transparent;color:#a1a1aa;padding:8px;min-height:40px";
    yes.onclick = async () => { const d = deferred; deferred = null; remove(); if (d) { d.prompt(); await d.userChoice.catch(() => null); } };
    no.onclick = () => { localStorage.setItem(DISMISS, String(Date.now())); remove(); };
    bar.append(icon, text, yes, no);
    document.body.append(bar);
    place();
    // The header can render after the prompt fires (route change, sidebar toggle): keep it below.
    window.addEventListener("resize", place);
    placer = setInterval(place, 500);
  }
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; show(); });
  window.addEventListener("appinstalled", () => { deferred = null; remove(); });
  window.RakijaziosPwa = { show, remove, place, headerBottom, touchDevice };
})();
