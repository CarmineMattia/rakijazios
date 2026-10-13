/**
 * Local model server discovery (M2a).
 * Only loopback addresses are probed; nothing found is not an error (the
 * runner stays connected and re-checks every minute).
 */
import { loopbackRequestUrl, parseLoopbackBaseUrl } from "./loopback.ts";

export type ModelServerCandidate = { kind: string; baseUrl: string };

/** Well-known OpenAI-compatible servers, in probe order. */
export const MODEL_SERVER_CANDIDATES: readonly ModelServerCandidate[] = [
  { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { kind: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { kind: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
  { kind: "vllm", baseUrl: "http://127.0.0.1:8000/v1" },
  { kind: "koboldcpp", baseUrl: "http://127.0.0.1:5001/v1" },
  { kind: "jan", baseUrl: "http://127.0.0.1:1337/v1" },
];

export type DiscoveredModel = { id: string; contextWindow?: number };

const MAX_MODELS = 200;
const MAX_ID_LENGTH = 200;

/** Parse an OpenAI-style `GET /models` body. Returns null when the shape is wrong. */
export function parseModelList(body: unknown): DiscoveredModel[] | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    // Printable, bounded ids only; the server enforces the same limits.
    if (!trimmed || trimmed.length > MAX_ID_LENGTH || !/^[\x21-\x7e]+$/.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    const ctx =
      (item as { context_length?: unknown; context_window?: unknown }).context_length ??
      (item as { context_window?: unknown }).context_window;
    out.push(
      typeof ctx === "number" && Number.isSafeInteger(ctx) && ctx > 0
        ? { id: trimmed, contextWindow: ctx }
        : { id: trimmed },
    );
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** Keep only ids listed in a comma-separated filter (RAKAZO_RUNNER_MODELS); empty = keep all. */
export function filterModels(models: DiscoveredModel[], filter: string | undefined): DiscoveredModel[] {
  const wanted = (filter ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!wanted.length) return models;
  const set = new Set(wanted);
  return models.filter((m) => set.has(m.id));
}

export async function listModels(
  baseUrl: string,
  timeoutMs = 2_000,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredModel[] | null> {
  parseLoopbackBaseUrl(baseUrl);
  try {
    const res = await fetchImpl(loopbackRequestUrl(baseUrl, "/models"), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) return null;
    return parseModelList(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

/**
 * Find a model server: the configured base first (when given), then the
 * well-known loopback ports. Returns the first server that answers with a
 * valid model list (possibly empty).
 */
export async function discoverModelServer(
  preferred: string | undefined,
  fetchImpl: typeof fetch = fetch,
  opts: { only?: boolean } = {},
): Promise<{ kind: string; baseUrl: string; models: DiscoveredModel[] } | null> {
  const candidates: ModelServerCandidate[] = [];
  if (preferred) {
    const known = MODEL_SERVER_CANDIDATES.find((c) => c.baseUrl === preferred);
    candidates.push({ kind: known?.kind ?? "openai-compatible", baseUrl: preferred });
  }
  for (const c of opts.only ? [] : MODEL_SERVER_CANDIDATES) {
    if (!candidates.some((x) => x.baseUrl === c.baseUrl)) candidates.push(c);
  }
  for (const c of candidates) {
    const models = await listModels(c.baseUrl, 1_500, fetchImpl);
    if (models) return { ...c, models };
  }
  return null;
}
