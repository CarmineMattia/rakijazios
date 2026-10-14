# Rakijazios on your phone: PWA + Cloudflare Tunnel

Two independent parts:

1. **PWA**: the web app can be installed on Android (and added to the iOS home screen). Shipped in
   `patches/web/dist` (manifest, icons, `sw.js`, `pwa-overlay.js`). Works today on `http://localhost` / `127.0.0.1`.
   On a phone it needs **https**, because browsers only allow service workers and installing on secure origins.
   `http://192.168.x.x:5173` still works as a normal website, just without install or offline shell.
2. **Cloudflare Tunnel**: gives Host-001 a public `https://` address without opening a port on the router or
   firewall. `cloudflared` dials **out** to Cloudflare; nothing listens on the host. Nothing here is installed
   or running yet. The steps below are for Carmine.

## 1. PWA

| Piece | What it does |
|---|---|
| `site.webmanifest` | Name "Rakijazios", start `/app`, standalone, theme `#0d0d0e`; icons 192/512 (`any`) and 192/512 (`maskable`), made from `docs/assets/logo.png` |
| `sw.js` | Caches the **app shell only**: `/`, hashed `/assets/*` (cache-first), overlays/icons (stale-while-revalidate). Page loads are network-first, so a deploy shows up on the next load; the cached shell is used only when offline. **Never** touches `/api`, `/rpc`, `/novnc`, `/.well-known`, WebSockets, non-GET or cross-origin requests; those always go to the network. Redirected or `no-store` responses are never stored. |
| `pwa-overlay.js` | Registers the worker (secure origins only). On Android/Chromium, shows an "Install Rakijazios on this phone" bar (Install / Not now, remembered) under the header. Also has the phone layout fixes (composer width, full-screen settings, settings tab strip). |

Rolling back the worker: bump `VERSION` in `sw.js` (old caches are deleted on activate), or ship an `sw.js` that
calls `self.registration.unregister()`.

## 2. Cloudflare Tunnel: what Carmine must do / provide

### Option A: quick test, no account, no domain (temporary URL)

On Host-001, install cloudflared (`sudo dnf install cloudflared` from Cloudflare's repo, or the binary from
github.com/cloudflare/cloudflared/releases), then:

```sh
cloudflared tunnel --url http://127.0.0.1:5173
```

It prints a random `https://<words>.trycloudflare.com` URL that is valid until you stop it. To try it, set the app settings
from §3 to that URL (`RAKAZO_ALLOWED_HOSTS=.trycloudflare.com`), restart, open it on the phone. The URL changes on every
run, so this is only for a test; re-pair runners (§3) if you test them through it.

### Option B: permanent (your own domain)

You need to provide:

1. **A Cloudflare account** (free plan is enough).
2. **A domain whose DNS is on Cloudflare** (add the site in the dashboard and switch the registrar's nameservers to the two
   Cloudflare ones), and the hostname you want, e.g. `rakijazios.<your-domain>`.
3. Pick **one** way to run it:

**B1: dashboard-managed tunnel + compose sidecar (recommended, nothing to install on the host):**

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → *Create a tunnel* → Cloudflared → name `host-001`.
2. Copy the token it shows (the long string after `--token`). **Do not paste it into the repo, .env, chat or a PR.**
   ```sh
   mkdir -p ~/.config/rakijazios && umask 077
   printf 'TUNNEL_TOKEN=%s\n' '<paste token>' > ~/.config/rakijazios/cloudflared.env
   chmod 600 ~/.config/rakijazios/cloudflared.env
   ```
3. In the tunnel → *Public hostname* → add `rakijazios.<your-domain>`, service **HTTP**, URL **`web:5173`**.
4. Change the app settings (§3), then start:
   ```sh
   cd ~/projects/rakazo
   docker compose -f docker-compose.images.yml -f docker-compose.override.yml \
     -f infra/cloudflared/docker-compose.tunnel.yml up -d web cloudflared
   ```

**B2: locally-managed tunnel + systemd user service:**

```sh
cloudflared tunnel login                      # opens a browser; writes ~/.cloudflared/cert.pem
cloudflared tunnel create host-001            # writes ~/.cloudflared/<TUNNEL_ID>.json (credentials)
cloudflared tunnel route dns host-001 rakijazios.<your-domain>
cp infra/cloudflared/config.example.yml ~/.cloudflared/config.yml   # fill in <TUNNEL_ID>, <user>, <your-domain>
cp infra/cloudflared/rakijazios-cloudflared.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now rakijazios-cloudflared
loginctl enable-linger "$USER"
```

`cert.pem` and `<TUNNEL_ID>.json` stay in `~/.cloudflared/` (outside the repo; `.gitignore` also blocks them).

### Recommended hardening (optional)

- Keep `SIGNUPS_ENABLED`/`SIGNUP_ALLOWLIST` restrictive: the app is now reachable from the internet.
- Cloudflare Access (SSO in front of the app) works for people, but must **bypass** `/api/local-runners/*`
  (runners authenticate with their own key, can't do SSO) and `/api/auth/magic-link/*` (links opened from mail).

## 3. App settings that change with a public https URL

Set by Carmine in `~/projects/rakazo/.env` (not changed by this PR), then restart `api worker web`.
`https://rakijazios.<your-domain>` is used as the example.

| Setting | Now (default) | With the tunnel | Why |
|---|---|---|---|
| `WEB_ORIGIN` | `http://127.0.0.1:5173` / LAN IP | `https://rakijazios.<your-domain>` | Links in mails, CORS/trusted origins, and the runner WebSocket URL handed out at pairing (`wss://…/api/local-runners/ws`, derived from this) |
| `BETTER_AUTH_URL` | same as above | `https://rakijazios.<your-domain>` | Auth base URL; magic-link verify URLs are built from it. With `https` Better Auth sets **Secure** cookies (`__Secure-` prefix) |
| `API_URL` | same as above | `https://rakijazios.<your-domain>` | Public API base used by clients |
| `RAKAZO_ALLOWED_HOSTS` (new, web) | unset | `rakijazios.<your-domain>` (or `.trycloudflare.com`) | Vite's preview server rejects unknown `Host` headers ("Blocked request"); this PR's `vite.config.ts` accepts these extra hosts. Passed to `web` by `infra/cloudflared/docker-compose.tunnel.yml` |
| `SMTP_URL` / `EMAIL_FROM` | Mailpit (local catcher) | a real provider (e.g. the commented Resend line) | Magic links must reach a real inbox to sign in from a phone. With a public origin and no SMTP the API refuses the built-in email capture on purpose |
| `RAKAZO_RUNNER_GATEWAY_WS_URL` | unset | leave unset | Only to override the derived `wss://` URL |

Effects to expect:

- **Cookies become Secure.** Sign in through the https URL. `http://<LAN-IP>:5173` sessions stop working after the switch;
  `http://localhost:5173` on Host-001 itself keeps working.
- **Runners.** Existing computers keep the server URL they were paired with. A runner on Host-001 can stay on loopback.
  Other computers that should use the tunnel: *My hardware → New key* and re-pair against the https URL (the runner only
  accepts `wss://` for non-loopback servers).
- **Magic links** in old mails point at the old origin; request a new one.
- Ollama (`127.0.0.1:11434`) is not exposed: only `web:5173` is routed, and runners reach models locally.

## 4. Rollback

Stop the tunnel (`docker compose … stop cloudflared` or `systemctl --user disable --now rakijazios-cloudflared`),
restore the old `.env` values, restart `api worker web`. In the Cloudflare dashboard delete the tunnel (this also
invalidates its token).
