import {
  decodeFrame,
  encodeFrame,
  type InferRequestFrame,
  type ProtocolFrame,
} from "./protocol.ts";
import { assertSameOriginLoopback, loopbackRequestUrl } from "./loopback.ts";
import type { RunnerCredentials, RunnerStatus } from "./config.ts";
import { discoverModelServer, filterModels, type DiscoveredModel } from "./discover.ts";
import { executeHostTool } from "./host-tools.ts";
import { loadPermissions, localAllows } from "./permissions.ts";

export type { RunnerCredentials } from "./config.ts";

export type RunnerOptions = {
  credentials: RunnerCredentials;
  /** Fixed model server (RAKAZO_RUNNER_MODEL_URL / config). Undefined = auto-detect. */
  modelBaseUrl?: string;
  /** Optional comma-separated allowlist (RAKAZO_RUNNER_MODELS). */
  modelFilter?: string;
  runnerVersion: string;
  platform?: string;
  log?: (line: string) => void;
  /** Status updates for status.json (never includes secrets). */
  onStatus?: (status: Omit<RunnerStatus, "updatedAt">) => void;
  /** Called once when the server removed/re-keyed this computer or the token is refused. */
  onFatal?: (reason: string) => void;
  /** Test hook */
  fetchImpl?: typeof fetch;
};

const HEARTBEAT_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DISCOVERY_MS = 60_000;
const MAX_UNAUTHORIZED = 3;
/** M2b: no frame at all from the server for this long = dead link (half-open TCP, NAT drop). */
const SERVER_SILENCE_MS = 50_000;
/** M2b: socket open + hello accepted (first policy) must happen within this. */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Exponential backoff with jitter (50-100% of the step), so many runners do not
 * reconnect in lock-step after a server restart.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(step * (0.5 + 0.5 * random()));
}

export class LocalRunnerClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastServerFrameAt = 0;
  private readonly inFlight = new Map<string, AbortController>();
  private readonly log: (line: string) => void;
  private readonly opts: RunnerOptions;
  private server: { kind: string; baseUrl: string } | null = null;
  private models: DiscoveredModel[] = [];
  private modelsKey = "";
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private policy: { enabled: boolean; allowed: Set<string> | null } = { enabled: true, allowed: null };
  private unauthorized = 0;
  private connected = false;
  private readonly startedAt = Date.now();
  private lastError: { message: string; at: number } | null = null;
  private healthKey = "";
  /** The last probe found a model server (a pinned URL can be set but not answering). */
  private serverOk = false;
  private computerUseGate = process.env.RAKAZO_COMPUTER_USE_GATE === "1";
  private hostToolsEnabled = process.env.RAKAZO_HOST_TOOLS !== "0";
  private egressAllowed = process.env.RAKAZO_HOST_EGRESS === "1";

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((line) => console.error(`[runner] ${line}`));
  }

  /** Current local model server and models (for status / tests). */
  get localModels(): { server: string; models: string[] } {
    return { server: this.server?.kind ?? "none", models: this.models.map((m) => m.id) };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshModels();
    this.discoveryTimer = setInterval(() => void this.refreshModels(), DISCOVERY_MS);
    this.discoveryTimer.unref?.();
    this.connect();
  }

  private status(state: RunnerStatus["state"], detail?: string): void {
    if (state === "connected" && !detail && !this.policy.enabled) detail = "sharing paused in Rakijazios";
    let server: string | undefined;
    try {
      server = new URL(this.opts.credentials.gatewayWsUrl).host;
    } catch {
      server = undefined;
    }
    this.opts.onStatus?.({
      state,
      ...(detail ? { detail } : {}),
      ...(server ? { server } : {}),
      modelServer: this.server?.kind ?? "none",
      models: this.models.map((m) => m.id),
      pid: process.pid,
    });
  }

  /** Re-detect the local model server and push the model list when it changed. */
  async refreshModels(): Promise<void> {
    const fixed = this.opts.modelBaseUrl;
    if (fixed) {
      // RAKAZO_RUNNER_MODEL_URL / config pins the server: never switch to another port.
      const found = await discoverModelServer(fixed, this.opts.fetchImpl, { only: true });
      this.server = { kind: found?.kind ?? "openai-compatible", baseUrl: fixed };
      this.models = filterModels(found?.models ?? [], this.opts.modelFilter);
      this.serverOk = Boolean(found);
      if (!found) {
        let where = "the configured address";
        try {
          where = new URL(fixed).host;
        } catch {}
        this.noteError(`Pinned model server (${where}) is not answering`);
      }
    } else {
      const found = await discoverModelServer(this.server?.baseUrl, this.opts.fetchImpl);
      this.server = found ? { kind: found.kind, baseUrl: found.baseUrl } : null;
      this.models = filterModels(found?.models ?? [], this.opts.modelFilter);
      this.serverOk = Boolean(found);
    }
    if (!this.server) this.noteError("No local model server is answering on this computer");
    const key = `${this.server?.baseUrl ?? ""}|${this.models.map((m) => `${m.id}:${m.contextWindow ?? ""}`).join(",")}`;
    if (key !== this.modelsKey) {
      this.modelsKey = key;
      this.log(
        this.server
          ? `model server ${this.server.kind} (${this.server.baseUrl}): ${this.models.length} model(s) ${this.models.map((m) => m.id).join(", ")}`
          : "no local model server found (checked Ollama, LM Studio, llama.cpp, vLLM, KoboldCpp, Jan); will retry every minute",
      );
      if (this.connected) this.sendModels();
      this.status(this.connected ? "connected" : "connecting");
    }
  }

  /** Remember the last local problem (short, no paths or secrets) for the owner's health view. */
  private noteError(message: string): void {
    const short = message.replace(/\s+/g, " ").slice(0, 200);
    if (this.lastError?.message === short && Date.now() - this.lastError.at < 60_000) return;
    this.lastError = { message: short, at: Date.now() };
    this.sendHealth();
  }

  /** Current health report (what `health` frames carry; also for tests). */
  healthReport() {
    return {
      type: "health" as const,
      modelServer: this.server?.kind ?? "none",
      modelServerOk: this.serverOk,
      models: this.models.length,
      inFlight: this.inFlight.size,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      ...(this.lastError ? { lastError: this.lastError.message, lastErrorAt: this.lastError.at } : {}),
    };
  }

  /** Send `health` when it changed (or always, for a check). */
  private sendHealth(checkId?: string, latencyMs?: number): void {
    if (!this.connected) return;
    const frame = {
      type: "health" as const,
      modelServer: this.server?.kind ?? "none",
      modelServerOk: this.serverOk,
      models: this.models.length,
      inFlight: this.inFlight.size,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      ...(this.lastError ? { lastError: this.lastError.message, lastErrorAt: this.lastError.at } : {}),
      ...(checkId ? { checkId } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    };
    const key = `${frame.modelServer}|${frame.modelServerOk}|${frame.models}|${this.lastError?.at ?? ""}`;
    if (!checkId && key === this.healthKey) return;
    this.healthKey = key;
    this.send(frame);
  }

  private async healthCheck(id: string): Promise<void> {
    const t0 = Date.now();
    await this.refreshModels().catch((err) => {
      this.serverOk = false;
      this.noteError(`Model server check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.sendHealth(id.slice(0, 64), Date.now() - t0);
  }

  private sendModels(): void {
    this.send({
      type: "models",
      models: this.models.map((m) => (m.contextWindow ? { id: m.id, contextWindow: m.contextWindow } : { id: m.id })),
      modelServer: this.server?.kind ?? "none",
    });
  }

  private fatal(reason: string): void {
    if (this.stopped) return;
    this.log(`stopping: ${reason}`);
    this.status(reason === "unauthorized" ? "unauthorized" : "revoked", reason);
    this.stop(false);
    this.opts.onFatal?.(reason);
  }

  stop(writeStatus = true): void {
    this.stopped = true;
    this.connected = false;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    if (writeStatus) this.status("stopped");
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const [, ctrl] of this.inFlight) ctrl.abort();
    this.inFlight.clear();
    try {
      this.ws?.close(1000, "runner stop");
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.opts.credentials.gatewayWsUrl;
    this.log(`connecting ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    this.status("connecting");
    // A black-holed connect or an unanswered hello would otherwise sit in
    // "connecting" forever; give up and back off instead.
    const connectTimer = setTimeout(() => {
      if (!this.connected && this.ws === ws) teardown("connect timeout");
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();
    ws.addEventListener("open", () => {
      this.lastServerFrameAt = Date.now();
      // The backoff resets only once the server accepts the hello (first policy).
      this.log("connected; sending hello");
      // The device token goes in the first frame, never in the URL.
      const capabilities = ["inference"];
      if (this.hostToolsEnabled) capabilities.push("host-tools");
      if (this.computerUseGate) capabilities.push("computer-use");
      this.send({
        type: "hello",
        deviceId: this.opts.credentials.deviceId,
        token: this.opts.credentials.token,
        runnerVersion: this.opts.runnerVersion,
        offeredModels: this.models.map((m) => m.id),
        ...(this.opts.platform ? { platform: this.opts.platform } : {}),
        modelServer: this.server?.kind ?? "none",
        capabilities,
        computerUseGate: this.computerUseGate,
      });
      // The detailed models frame follows the first policy (hello accepted).
      this.clearHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        // The server acks every heartbeat; silence means the link is dead even
        // if the OS has not noticed yet. Reconnect instead of waiting forever.
        if (Date.now() - this.lastServerFrameAt > SERVER_SILENCE_MS) {
          teardown("server silent; reconnecting");
          return;
        }
        this.send({ type: "heartbeat", at: Date.now() });
      }, HEARTBEAT_MS);
    });

    ws.addEventListener("message", (ev) => {
      if (this.ws === ws) this.lastServerFrameAt = Date.now();
      void this.onMessage(String(ev.data));
    });

    // Undici does not always emit "close" after a failed handshake, so both
    // events funnel into one idempotent teardown per socket.
    let tornDown = false;
    const teardown = (why: string) => {
      if (tornDown) return;
      tornDown = true;
      clearTimeout(connectTimer);
      if (this.ws !== ws && this.ws !== null) {
        // A newer socket already took over; only tidy this one.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.connected = false;
      this.clearHeartbeat();
      this.log(why);
      if (!this.stopped) this.status("offline", why);
      if (this.ws === ws) this.ws = null;
      for (const [, ctrl] of this.inFlight) ctrl.abort();
      this.inFlight.clear();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.scheduleReconnect();
    };

    ws.addEventListener("close", (ev) => {
      if (ev.code === 1008 && ev.reason === "unauthorized") {
        this.unauthorized += 1;
        if (this.unauthorized >= MAX_UNAUTHORIZED) {
          this.fatal("unauthorized");
          return;
        }
      }
      if (ev.code === 1008 && ev.reason === "too many attempts") {
        this.reconnectAttempt = Math.max(this.reconnectAttempt, 10); // wait the maximum
      }
      teardown(`closed code=${ev.code} reason=${ev.reason || "-"}`);
    });

    ws.addEventListener("error", () => {
      teardown("websocket error");
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = reconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.log(`reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(frame: ProtocolFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeFrame(frame));
  }

  private async onMessage(raw: string): Promise<void> {
    let frame: ProtocolFrame;
    try {
      frame = decodeFrame(raw);
    } catch (err) {
      this.log(`bad frame: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    switch (frame.type) {
      case "heartbeat_ack":
        return;
      case "policy":
        this.unauthorized = 0;
        if (!this.connected) {
          this.connected = true;
          this.reconnectAttempt = 0;
          this.status("connected");
          this.sendModels();
          this.healthKey = "";
          this.sendHealth();
        }
        this.policy = {
          enabled: frame.enabled !== false,
          allowed: Array.isArray(frame.allowedModels)
            ? new Set(frame.allowedModels.filter((m): m is string => typeof m === "string"))
            : this.policy.allowed,
        };
        this.status("connected");
        this.log(
          `policy enabled=${this.policy.enabled} models=${this.policy.allowed ? [...this.policy.allowed].join(",") || "(none)" : "-"} maxInFlight=${frame.maxInFlight ?? "-"}`,
        );
        return;
      case "bye":
        this.log(`server bye: ${frame.reason ?? ""}`);
        if (frame.reason === "revoked" || frame.reason === "rotated") {
          this.fatal(frame.reason);
        }
        return;
      case "tool.invoke": {
        if (!this.hostToolsEnabled) {
          this.send({
            type: "tool.denied",
            id: frame.id,
            reason: "host-tools disabled on this runner",
          });
          return;
        }
        void (async () => {
          const perms = await loadPermissions();
          const target =
            typeof frame.args?.command === "string"
              ? frame.args.command
              : typeof frame.args?.path === "string"
                ? frame.args.path
                : undefined;
          const decision = localAllows(perms, frame.action, target);
          // Server already decided allow; local mirror only hard-denies (never / grant never).
          // "ask" locally does not re-block — approval UX lives in Rakijazios.
          const localDecision: "allow" | "deny" =
            decision === "deny" || perms.permission === "never" || perms.ceiling === "never"
              ? "deny"
              : "allow";
          return executeHostTool({
            action: frame.action,
            args: frame.args ?? {},
            timeoutMs: frame.timeoutMs,
            computerUseGate: this.computerUseGate || perms.computerUseGate === true,
            egressAllowed: this.egressAllowed || perms.egressAllowed === true,
            localDecision,
          });
        })().then((result) => {
          if (!result.ok && result.denied) {
            this.send({ type: "tool.denied", id: frame.id, reason: result.error });
            return;
          }
          if (!result.ok) {
            this.send({ type: "tool.result", id: frame.id, ok: false, error: result.error });
            return;
          }
          this.send({ type: "tool.result", id: frame.id, ok: true, output: result.output });
        });
        return;
      }
      case "infer.cancel": {
        const ctrl = this.inFlight.get(frame.id);
        if (ctrl) {
          this.log(`cancel ${frame.id}`);
          ctrl.abort();
        }
        return;
      }
      case "health.check":
        await this.healthCheck(frame.id);
        return;
      case "infer.request":
        await this.handleInfer(frame);
        return;
      default:
        return;
    }
  }

  /** Local refusal reason, or null when the request may run. */
  private refusal(model: string): string | null {
    if (!this.policy.enabled) return "Sharing is paused for this computer";
    if (this.policy.allowed && !this.policy.allowed.has(model)) {
      return `Model ${model} is not offered by this computer`;
    }
    if (!this.server) return "No local model server is running on this computer";
    return null;
  }

  private async handleInfer(frame: InferRequestFrame): Promise<void> {
    const refused = this.refusal(frame.model);
    if (refused) {
      this.log(`infer.request id=${frame.id} model=${frame.model} refused: ${refused}`);
      this.send({ type: "infer.error", id: frame.id, message: refused, retryable: false });
      return;
    }
    const baseUrl = this.server!.baseUrl;
    const ctrl = new AbortController();
    this.inFlight.set(frame.id, ctrl);
    this.log(`infer.request id=${frame.id} model=${frame.model}`);
    try {
      const url = loopbackRequestUrl(baseUrl, "/chat/completions");
      assertSameOriginLoopback(baseUrl, url);
      const body = { ...frame.body, model: frame.model, stream: true };
      const res = await (this.opts.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        // Never follow a redirect away from the configured loopback server.
        redirect: "error",
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        this.noteError(`Model ${frame.model}: local model server answered HTTP ${res.status}`);
        this.send({
          type: "infer.error",
          id: frame.id,
          message: `Local model HTTP ${res.status}: ${text.slice(0, 200)}`,
          retryable: res.status >= 500,
        });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line) continue;
          this.send({ type: "infer.chunk", id: frame.id, data: line });
        }
      }
      if (buf.trim()) {
        this.send({ type: "infer.chunk", id: frame.id, data: buf.trimEnd() });
      }
      this.send({ type: "infer.done", id: frame.id, status: res.status });
      this.log(`infer.done id=${frame.id} status=${res.status}`);
    } catch (err) {
      if (ctrl.signal.aborted) {
        this.send({
          type: "infer.error",
          id: frame.id,
          message: "Cancelled",
          retryable: false,
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log(`infer.error id=${frame.id}: ${message}`);
      this.noteError(`Model ${frame.model}: ${message}`);
      this.send({
        type: "infer.error",
        id: frame.id,
        message,
        retryable: true,
      });
    } finally {
      this.inFlight.delete(frame.id);
    }
  }
}
