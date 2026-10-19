# Rakijazios ↔ Grok Bot parity (without cloning)

This track implements a **self-hosted** agent runtime with the same *classes* of
capability as Grok Bot, without depending on Cursor/xAI subscriptions.

## Status

| Phase | Area | Status |
|---|---|---|
| P0 | Tool permissions + M2b bot→computer/model bind | Done + tests |
| P1 | Host-tools (shell/file) + permissions.json mirror | Done + tests |
| P2 | Routines UI + pause/resume/run-now | Done |
| P3 | Transcripts + background shells (start/kill/send-input) | Done + tests |
| P4 | MCP catalog + secrets list | Done (OAuth via existing broker) |
| P5 | Computer-use gate + Linux drivers | Done (grim/xdotool/ydotool) |
| P6 | Electron desktop shell + update stub | Done + smoke test |
| P7 | Marketplace publish + add-to-chat (private-by-default) | Done |
| P8 | Auth status (password/passkey paths) | Done |
| P9 | i18n strings IT/EN/DE/FR/ES | Done |

## Tests

```bash
# Runner host-tools + permissions mirror
cd runner && npm test

# Capability matrix (routes, overlays, desktop files)
node --test tests/parity-matrix.test.mjs

# Desktop package smoke (no Electron install required)
node --test packages/desktop/smoke.test.cjs

# Pure permission helpers (when vitest is available in upstream tree)
# pnpm exec vitest run apps/api/src/host-tool-permissions.test.ts
```

## Key endpoints

- `GET/POST /api/host-tools/permissions`, `POST /api/host-tools/grants`
- `GET /api/local-runners/offered-models`
- `POST /api/local-runners/bots/:botId/model`
- `GET /api/parity/bots/:botId/routines`
- `POST /api/parity/bots/:botId/routines/:id/run-now`
- `GET/POST /api/parity/background-shells`, `…/:id/kill`, `…/:id/send-input`
- `GET /api/parity/marketplace`, `POST …/publish`, `POST …/add-to-chat`
- `GET/POST /api/parity/devices/:deviceId/computer-use`
- `GET /api/parity/mcp/catalog`, `/api/parity/secrets`, `/api/parity/i18n`
- `GET /api/parity/desktop/manifest`

## Runner env

- `RAKAZO_HOST_TOOLS=0` — disable host-tools
- `RAKAZO_HOST_ROOT` — allowlisted workspace (default `~/Rakijazios`)
- `RAKAZO_HOST_EGRESS=1` — allow curl/wget-style commands
- `RAKAZO_COMPUTER_USE_GATE=1` — advertise computer-use capability
- Local mirror: `~/.config/rakazo-runner/permissions.json` (0600)

## UI

`patches/web/dist/parity-overlays.js` floating menu: Permissions, Marketplace,
Connectors, Security, On my PC, Routines. Approval cards via
`window.dispatchEvent(new CustomEvent('rakijazios:host-tool-permission', { detail }))`.
