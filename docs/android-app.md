# Rakijazios Android app (APK): plan

> Status: design + proof of concept (2026-10-20). Nothing is deployed and live (Host-001) is unchanged.
> PoC: `android/twa/`, built by `scripts/android-twa-build.sh` and `.github/workflows/android.yml`.

## What we start from

- Rakijazios has **no web source code of its own**. The UI is the upstream Rakazo image's prebuilt bundle
  (`/app/apps/web/dist`, hashed `assets/*.js`), and this repo bind-mounts `patches/web/dist` over it: the
  same hashed assets plus our overlay scripts (`*-overlay.js`), the PWA files (`site.webmanifest`, `sw.js`,
  icons) and `patches/web/vite.config.ts`.
- The browser talks **same-origin** to everything: Vite preview serves the dist and proxies `/api`, `/rpc`,
  `/novnc` and the runner WebSocket to the api container. The bundle uses relative URLs.
- Auth is Better Auth with **host-bound session cookies** (`__Secure-` and Secure on https), `trustedOrigins`
  from `WEB_ORIGIN`/`BETTER_AUTH_URL`, and magic links aligned to that one origin (`patches/auth/index.ts`).
- PWA (#20) is in main: manifest (`start_url /app`, standalone), `sw.js` (app-shell cache only, never `/api`,
  `/rpc`, `/.well-known`), install bar in `pwa-overlay.js`.
- There is **no push notification code** at all yet (no Push API, no FCM). Voice is `getUserMedia` in the
  upstream `CallView` (Settings → Voice); live voice mode (`docs/live-voice-mode.md`) is an idea, not built.
- A phone needs a stable **https origin**. Today that means Cloudflare Tunnel option B (own domain,
  `docs/mobile-and-tunnel.md`); a `trycloudflare.com` URL changes on every run.

## Options compared

| | **TWA (Bubblewrap-style, from the PWA)** | **Capacitor** | **React Native / Expo** |
|---|---|---|---|
| What the APK is | A thin launcher; the user's **Chrome** renders `https://<host>/app` full-screen | A native shell with an Android **WebView** | A new native app |
| Code shared with today's app | **100%.** No web code in the APK; every deploy (overlays, upstream image bump) shows up in the app with no rebuild | Remote mode (`server.url`): ~100%. Bundled mode: we'd have to copy the upstream dist into the APK and rebuild on every deploy, and the relative `/api` calls break (they'd hit `https://localhost`) | **~0% of the UI.** There is no UI source here to reuse; chat, settings, sharing, My hardware, overlays all rewritten. Only the `@rakazo/contracts` types carry over |
| API, CORS, cookies | Same origin, **Chrome's cookie jar**: works exactly like the PWA, nothing to change in auth | Remote mode: same origin inside the WebView, but a **separate cookie jar** from Chrome. Bundled mode: cross-origin (`https://localhost` → host), needs CORS with credentials, `SameSite=None` cookies or bearer tokens, plus `trustedOrigins` changes in a patched auth file | Cross-origin native client: bearer tokens (Better Auth `bearer()` is already on), token storage, all RPC calls re-done |
| Magic link | App Link on `https://<host>` opens the app; verification sets the cookie in Chrome, which the TWA shares. Works even if the link opens in Chrome instead | App Link + `appUrlOpen` handler that loads the URL in the WebView (plugin code). If the link opens in Chrome, the session lands in the wrong jar | App Link + custom handling of the verify call, then token |
| Push notifications | **Web Push** from `sw.js`, shown as app notifications (notification delegation, already in the PoC manifest). The same server work also gives push to the plain PWA | No Web Push in Android WebView: needs **FCM** (Firebase project, `google-services.json`, plugin) and an FCM sender on the server | FCM / Expo push + server sender |
| Mic (live voice) | `getUserMedia` with Chrome's permission prompt, like the PWA | Works (WebView permission bridge + `RECORD_AUDIO`) | Native audio, best control |
| Files | `<input type=file>` and downloads as in Chrome | Same, plus native Filesystem plugin if needed | Native |
| Background | Same as a Chrome tab: no background work; mic while screen off not guaranteed | Can add a foreground-service plugin (e.g. keep a voice call alive) | Full native background (foreground service) |
| Needs on the phone | Chrome (or another TWA browser; else falls back to a Custom Tab with a URL bar) | Android System WebView (always there) | Nothing extra |
| Needs on the server | `/.well-known/assetlinks.json` with the signing key's SHA-256 | Same for App Links | Same for App Links |
| Effort to a usable APK | **~2–3 days** after the domain exists | ~5–8 days (remote mode + deep links + FCM) | **Months** |
| Skills | TypeScript/web only; the Android part is ~100 lines of config | Mostly web, some Java/Kotlin plugin config | React Native, native build tooling |

## Recommendation: TWA

TWA is the only option that keeps **one code base** for laptop, PWA and APK, needs **no auth or CORS change**
(same origin and same cookies as the PWA), and needs no native code. All the work Carmine would do anyway
(Web Push in `sw.js`, mobile layout, voice UI) lands in the web overlays and benefits browser, PWA and APK
at once. Its real limits are: Chrome is required, there's no background work, and a stable https domain with
`assetlinks.json` is mandatory.

**When to revisit:** if live voice mode must keep running with the screen off, or a native feature appears
that Chrome can't give, move to **Capacitor in remote mode** (still the same web app, adds a foreground service
and FCM). React Native only makes sense if Rakijazios ever owns its UI source instead of overlaying upstream.

## Proof of concept (in this PR)

- `android/twa/`: Gradle project (AGP 8.13, compile/target SDK 36, min SDK 24) using Google's
  `androidbrowserhelper` `LauncherActivity`. It opens `https://<twaHost>/app`, has an App Link intent filter
  (`autoVerify`) for the whole host, notification delegation, and the manifest colours. Package
  `app.rakijazios.twa`.
- Host is a build parameter, never committed: `-PtwaHost=rakijazios.<domain>` or `RAKIJAZIOS_TWA_HOST`
  (CI: repo variable `RAKIJAZIOS_TWA_HOST`). The default `rakijazios.example.com` builds but is not usable.
- `scripts/android-twa-build.sh`: builds `android/twa/app/build/outputs/apk/debug/app-debug.apk`
  (needs JDK 17, Gradle 8.14+, Android SDK platform 36).
- `scripts/android-assetlinks.mjs <SHA256…>`: prints the `assetlinks.json` for given key fingerprints.
- `.github/workflows/android.yml`: builds the debug APK on PRs that touch `android/**` and uploads it as the
  artifact `rakijazios-twa-debug-apk` (with an `assetlinks.debug.json` for that build's throwaway key).
- Verified on the box: the APK builds (about 4.9 MB) and its manifest has the host, `autoVerify`, launch URL and asset statements.
  Not yet run on a phone (no domain yet).

`/.well-known/assetlinks.json` will be served from `patches/web/dist/.well-known/assetlinks.json`: Vite preview
serves dist files in dev mode including `.well-known`, and `sw.js` never intercepts `/.well-known/`. To check in M1:
the real response must be `200`, `application/json`, with no redirect. If Cloudflare Access is put in front, it
must bypass `/.well-known/assetlinks.json` too.

## Signing

- **Debug:** Gradle signs with the machine's own `~/.android/debug.keystore` (CI: a new throwaway key every
  run). Fine for testing; each debug key needs its fingerprint in `assetlinks.json` to open full-screen.
- **Release keystore lives outside the repo**, on Host-001:
  ```sh
  mkdir -p ~/.config/rakijazios/android && chmod 700 ~/.config/rakijazios/android
  keytool -genkeypair -v -keystore ~/.config/rakijazios/android/release.jks \
    -alias rakijazios -keyalg RSA -keysize 4096 -validity 10000
  chmod 600 ~/.config/rakijazios/android/release.jks
  ```
  plus `~/.config/rakijazios/android/keystore.properties` (600) with `storeFile`, `storePassword`, `keyAlias`,
  `keyPassword`. `app/build.gradle` reads that file (or `RAKIJAZIOS_KEYSTORE_PROPERTIES`) only if it exists.
  `.gitignore` blocks `*.jks`, `*.keystore`, `keystore.properties`.
- **Back it up offline** (password manager + encrypted USB). If the key is lost, sideloaded users must uninstall
  and reinstall. With Play, use **Play App Signing**: Google holds the app key, ours is only an upload key
  (resettable), and Play's app-signing fingerprint must also go in `assetlinks.json`.
- Release signing in CI (keystore as a GitHub secret) is not planned for now. Release builds run on Host-001.

## Distribution (checked 2026-10-20)

- **Sideload the APK** (GitHub release or direct link). This works today. Google's **Android developer verification**
  is enforced since 2026-09-30 only in Brazil, Indonesia, Singapore and Thailand, with a **global rollout in 2027**.
  After that, an unregistered APK needs the "advanced flow" on each phone, while `adb install` stays free.
  For family and friends the free **limited distribution** account (no fee, no ID, up to 20 authorized
  devices) registers the package name. Sources: developer.android.com/developer-verification,
  developer.android.com/developer-verification/guides/limited-distribution.
- **Google Play:** **US$25 one-time** registration fee (ID verification may be asked). **Personal accounts created
  after 2023-11-13** need a **closed test with at least 12 testers opted in for 14 consecutive days** before
  production. The **internal testing** track (up to 100 testers) has no such requirement and is enough
  for a private group. Play also needs a privacy policy and a Data safety form. Sources: Play Console Help
  answers 6112435 and 14151465.
- Suggested path: sideload / limited distribution first; Play internal testing only if Carmine wants
  updates through the store.

## Milestones

| # | What | Who / prerequisite | Effort |
|---|---|---|---|
| M0 | TWA PoC + debug APK in CI (this PR) | done | 0.5 d |
| M1 | Permanent tunnel on a domain; `.env` origins switched; release keystore; `assetlinks.json` with its fingerprint; build with the real host; install on Carmine's phone; check full-screen (no URL bar) | **Carmine: domain + Cloudflare (tunnel B), keystore password** | 0.5–1 d |
| M2 | Phone QA: magic link opens the app and stays signed in, mic in Call view, file upload/download, back button, rotation, update after a deploy | tester + Carmine's phone | 1 d |
| M3 | Web Push: VAPID keys (outside repo), additive `push_subscriptions` table, `sw.js` `push`/`notificationclick`, notify on bot reply and mention, opt-in toggle. Benefits PWA too | own PR | 3–5 d |
| M4 | Release flow: versioning, signed APK on Host-001, sideload page or limited distribution registration; Play internal testing optional | Carmine: account choice | 1 d |
| M5 | Only if needed: background voice → Capacitor remote mode spike | decision after live voice exists | 3–5 d |

## Open questions for Carmine

1. **Domain:** which domain/hostname (e.g. `rakijazios.<domain>`) on Cloudflare? Without one, the APK can't verify.
2. **Distribution:** sideload/limited distribution (free, ≤20 devices) or a Play account (US$25; internal
   testing for a private group, 12 testers × 14 days for public)?
3. **Package name:** keep `app.rakijazios.twa`? It can't change after the first public install.
4. **Which notifications** matter first (bot replied, mention in a group, runner offline)?
5. Must **voice** keep working with the screen off? If yes, plan M5.
