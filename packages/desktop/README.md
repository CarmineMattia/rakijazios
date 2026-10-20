# Rakijazios Desktop (P6)

Electron shell that loads your Rakijazios web origin and can embed/start the
local `rakazo-runner` (inference + host-tools).

## Run

```bash
cd packages/desktop
npm install
RAKIJAZIOS_URL=https://your-rakijazios.example npm start
```

Optional:

- `RAKIJAZIOS_AUTOSTART_RUNNER=1` — start `rakazo-runner run` on launch
- `RAKAZO_RUNNER_BIN=/path/to/rakazo-runner` — override binary discovery

## Build installers

```bash
npm run dist
```

Requires `electron-builder`. Publish AppImage/DMG/NSIS artifacts and point
`GET /api/parity/desktop/manifest` download URLs at them.

## Auto-update (stub)

Release builds will use `electron-updater` against the same manifest endpoint.
Until then, reinstall from the published AppImage/DMG/NSIS; the main process
logs a stub check on launch when `RAKIJAZIOS_CHECK_UPDATES=1`.
