import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverModelServer, filterModels, parseModelList } from "./discover.ts";

function fakeFetch(map: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!(url in map)) throw new Error("ECONNREFUSED");
    const body = map[url];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("model discovery", () => {
  it("parses OpenAI-style lists and drops junk", () => {
    const out = parseModelList({
      data: [{ id: "gemma4:26b" }, { id: "gemma4:26b" }, { id: "bad id" }, { id: 3 }, { id: "x".repeat(201) }, { id: "qwen", context_length: 32768 }],
    });
    assert.deepEqual(out, [{ id: "gemma4:26b" }, { id: "qwen", contextWindow: 32768 }]);
    assert.equal(parseModelList({ models: [] }), null);
    assert.equal(parseModelList(null), null);
  });

  it("filters by RAKAZO_RUNNER_MODELS", () => {
    const models = [{ id: "a" }, { id: "b" }];
    assert.deepEqual(filterModels(models, ""), models);
    assert.deepEqual(filterModels(models, " b ,c"), [{ id: "b" }]);
  });

  it("probes loopback candidates in order and returns the first that answers", async () => {
    const found = await discoverModelServer(
      undefined,
      fakeFetch({ "http://127.0.0.1:1234/v1/models": { data: [{ id: "lm" }] } }),
    );
    assert.equal(found?.kind, "lm-studio");
    assert.deepEqual(found?.models, [{ id: "lm" }]);
  });

  it("with a pinned URL never probes other ports", async () => {
    const found = await discoverModelServer(
      "http://127.0.0.1:9999/v1",
      fakeFetch({ "http://127.0.0.1:11434/v1/models": { data: [{ id: "ollama" }] } }),
      { only: true },
    );
    assert.equal(found, null);
  });

  it("refuses non-loopback model servers", async () => {
    await assert.rejects(() => discoverModelServer("http://192.168.1.10:11434/v1", fakeFetch({}), { only: true }));
  });
});
