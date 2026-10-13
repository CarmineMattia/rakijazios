/**
 * `rakazo-runner pair --server URL --code CODE [--name NAME] [--replace]` (M2a).
 * Redeems a one-time pairing code. If this config dir already holds a runner's key, the
 * rules in ./existing.ts apply: keep a valid key for the same server and account, refuse
 * (exit 3, nothing changed) when it belongs elsewhere, unless --replace. The device key is
 * never printed and is only sent back to the server that issued it.
 */
import { copyFileSync, chmodSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  assertSecureTransport,
  configDir,
  credentialsPath,
  ensureConfigDir,
  readConfig,
  readCredentials,
  writeConfig,
  writeCredentials,
} from "./config.ts";
import {
  EXIT_REFUSED,
  credentialsHost,
  interpretAdoptAnswer,
  planForExisting,
  refusalMessage,
  sameServer,
} from "./existing.ts";

export { sameServer };

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** Same normalisation as the server: upper-case, drop separators, O→0, I/L→1. */
export function normalizePairingCode(raw: string): string {
  const s = raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== 8 || [...s].some((ch) => !CODE_ALPHABET.includes(ch))) {
    throw new Error("The pairing code looks wrong: it has 8 letters/digits, like K7QF-3MZD");
  }
  return s;
}

export function normalizeServer(raw: string): string {
  const url = assertSecureTransport(raw.trim(), "server");
  return url.origin;
}

export function platformTag(): string {
  return `${process.platform}-${process.arch}`.slice(0, 40);
}

/** Pairing was refused on purpose; nothing on this computer was changed. */
export class PairRefused extends Error {
  readonly exitCode = EXIT_REFUSED;
}

export type PairOutcome =
  | "paired" // new computer
  | "reconnected" // same computer, new key ("New key" code)
  | "adopted" // existing install kept as is (no new key)
  | "replaced" // --replace: paired as a new computer, old credentials backed up
  | "repaired"; // old key no longer worked: paired again, old credentials backed up

export type PairResult = { outcome: PairOutcome; deviceId: string; name: string; backup?: string };

/** Copy the current credentials file aside (0600) before it is replaced. */
function backupCredentials(label: string): string | undefined {
  const src = credentialsPath();
  if (!existsSync(src)) return undefined;
  ensureConfigDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(configDir(), `credentials.${label}-${stamp}.json`);
  copyFileSync(src, dest);
  try {
    chmodSync(dest, 0o600);
  } catch {
    /* Windows */
  }
  return dest;
}

export async function pairDevice(input: {
  server: string;
  code: string;
  name?: string;
  runnerVersion: string;
  replace?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<PairResult> {
  const server = normalizeServer(input.server);
  const code = normalizePairingCode(input.code);
  const name = (input.name?.trim() || hostname() || "My computer").slice(0, 64);
  const doFetch = input.fetchImpl ?? fetch;
  const post = async (extra: Record<string, unknown>) => {
    const res = await doFetch(`${server}/api/local-runners/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, name, platform: platformTag(), runnerVersion: input.runnerVersion, ...extra }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body };
  };
  const store = (r: { deviceId: string; token: string; gatewayWsUrl: string }) => {
    assertSecureTransport(r.gatewayWsUrl, "gateway");
    writeCredentials({ deviceId: r.deviceId, token: r.token, gatewayWsUrl: r.gatewayWsUrl, server });
  };
  const freshPair = async (): Promise<{ deviceId: string; name: string; reused: boolean }> => {
    const { status, body } = await post({});
    if (status < 200 || status >= 300 || !body) {
      throw new Error(`Pairing failed: ${typeof body?.error === "string" ? body.error : `HTTP ${status}`}`);
    }
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    const token = typeof body.token === "string" ? body.token : "";
    const gatewayWsUrl = typeof body.gatewayWsUrl === "string" ? body.gatewayWsUrl : "";
    if (!deviceId || !token || !gatewayWsUrl) throw new Error("Pairing failed: incomplete answer");
    store({ deviceId, token, gatewayWsUrl });
    return { deviceId, name: typeof body.name === "string" ? body.name : name, reused: Boolean(body.reused) };
  };
  const remember = (finalName: string) => writeConfig({ ...readConfig(), server, name: finalName });

  const previous = readCredentials();
  const unreadable = !previous && existsSync(credentialsPath());
  const plan = planForExisting(previous, server, Boolean(input.replace));

  if (plan.action === "refuse") {
    throw new PairRefused(refusalMessage("other_server", { host: plan.host, server, configDir: configDir() }));
  }

  if (plan.action === "adopt") {
    const { status, body } = await post({ adopt: { deviceId: plan.deviceId, token: plan.token } });
    const answer = interpretAdoptAnswer(status, body);
    switch (answer.kind) {
      case "adopted":
        // Credentials stay exactly as they are; only the (non-secret) config is refreshed.
        remember(answer.name || name);
        return { outcome: "adopted", deviceId: answer.deviceId, name: answer.name || name };
      case "rekeyed":
        store(answer);
        remember(answer.name || name);
        return { outcome: "reconnected", deviceId: answer.deviceId, name: answer.name || name };
      case "inactive": {
        const backup = backupCredentials("previous");
        const r = await freshPair();
        remember(r.name);
        return { outcome: "repaired", deviceId: r.deviceId, name: r.name, ...(backup ? { backup } : {}) };
      }
      case "refuse":
        throw new PairRefused(
          refusalMessage(answer.reason, { host: credentialsHost(previous!), server, configDir: configDir() }),
        );
      default:
        throw new Error(`Pairing failed: ${answer.message}`);
    }
  }

  const backup = plan.action === "replace" ? backupCredentials("replaced") : unreadable ? backupCredentials("unreadable") : undefined;
  const r = await freshPair();
  remember(r.name);
  return {
    outcome: plan.action === "replace" ? "replaced" : r.reused ? "reconnected" : "paired",
    deviceId: r.deviceId,
    name: r.name,
    ...(backup ? { backup } : {}),
  };
}
