/**
 * Shared-local runner WebSocket frame codec (M1).
 * Frames are JSON text messages with a `type` discriminant.
 */

export type HelloFrame = {
  type: "hello";
  deviceId: string;
  token: string;
  runnerVersion: string;
  offeredModels: string[];
  /** M2a: e.g. "linux-x64" (informational) */
  platform?: string;
  /** M2a: which local server was found, e.g. "ollama"; "none" when nothing answers */
  modelServer?: string;
};

export type HeartbeatFrame = { type: "heartbeat"; at?: number };
export type HeartbeatAckFrame = { type: "heartbeat_ack"; at?: number };

export type ModelsFrame = {
  type: "models";
  models: Array<{ id: string; name?: string; contextWindow?: number }>;
  /** M2a: which local server answered, or "none" */
  modelServer?: string;
};

export type InferRequestFrame = {
  type: "infer.request";
  id: string;
  model: string;
  body: Record<string, unknown>;
};

export type InferChunkFrame = {
  type: "infer.chunk";
  id: string;
  /** Raw SSE line (without trailing newline), e.g. `data: {...}` */
  data: string;
};

export type InferDoneFrame = {
  type: "infer.done";
  id: string;
  status: number;
  usage?: Record<string, unknown>;
};

export type InferErrorFrame = {
  type: "infer.error";
  id: string;
  message: string;
  retryable: boolean;
};

export type InferCancelFrame = { type: "infer.cancel"; id: string };

export type PolicyFrame = {
  type: "policy";
  maxInFlight?: number;
  hardTimeoutMs?: number;
  /** M2a: false = the owner paused sharing for this computer */
  enabled?: boolean;
  /** M2a: models the owner switched on; anything else is refused locally too */
  allowedModels?: string[];
};

/** reason: "revoked" | "rotated" | "replaced" | "maintenance" | … */
export type ByeFrame = { type: "bye"; reason?: string };

export type ClientToServerFrame =
  | HelloFrame
  | HeartbeatFrame
  | ModelsFrame
  | InferChunkFrame
  | InferDoneFrame
  | InferErrorFrame;

export type ServerToClientFrame =
  | HeartbeatAckFrame
  | InferRequestFrame
  | InferCancelFrame
  | PolicyFrame
  | ByeFrame;

export type ProtocolFrame = ClientToServerFrame | ServerToClientFrame;

const CLIENT_TYPES = new Set([
  "hello",
  "heartbeat",
  "models",
  "infer.chunk",
  "infer.done",
  "infer.error",
]);

const SERVER_TYPES = new Set([
  "heartbeat_ack",
  "infer.request",
  "infer.cancel",
  "policy",
  "bye",
]);

export function encodeFrame(frame: ProtocolFrame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(raw: string): ProtocolFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON frame");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frame must be a JSON object");
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") throw new Error("Frame missing type");
  if (!CLIENT_TYPES.has(type) && !SERVER_TYPES.has(type)) {
    throw new Error(`Unknown frame type: ${type}`);
  }
  return parsed as ProtocolFrame;
}

export function isClientFrame(frame: ProtocolFrame): frame is ClientToServerFrame {
  return CLIENT_TYPES.has(frame.type);
}

export function isServerFrame(frame: ProtocolFrame): frame is ServerToClientFrame {
  return SERVER_TYPES.has(frame.type);
}
