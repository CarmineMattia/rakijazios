import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_TOKEN_CAP,
  capRequestBody,
  isContentChunk,
  outputTokenCap,
  overOutputCap,
} from "./local-runners.js";

describe("shared-local output cap", () => {
  it("defaults and clamps the env override", () => {
    expect(outputTokenCap(undefined)).toBe(DEFAULT_OUTPUT_TOKEN_CAP);
    expect(outputTokenCap("")).toBe(DEFAULT_OUTPUT_TOKEN_CAP);
    expect(outputTokenCap("abc")).toBe(DEFAULT_OUTPUT_TOKEN_CAP);
    expect(outputTokenCap("-5")).toBe(DEFAULT_OUTPUT_TOKEN_CAP);
    expect(outputTokenCap("10")).toBe(256);
    expect(outputTokenCap("1000")).toBe(1000);
    expect(outputTokenCap("999999")).toBe(32_768);
  });

  it("always sends a max token limit, never above the cap", () => {
    expect(capRequestBody({ messages: [] }, 4096)).toMatchObject({ max_tokens: 4096, max_completion_tokens: 4096 });
    expect(capRequestBody({ max_completion_tokens: 100000 }, 4096)).toMatchObject({ max_tokens: 4096, max_completion_tokens: 4096 });
    expect(capRequestBody({ max_tokens: 300 }, 4096)).toMatchObject({ max_tokens: 300, max_completion_tokens: 300 });
    expect(capRequestBody({ max_tokens: 900, max_completion_tokens: 500 }, 4096)).toMatchObject({ max_tokens: 500 });
    expect(capRequestBody({ max_tokens: "lots", max_completion_tokens: 0 }, 2048)).toMatchObject({ max_tokens: 2048 });
    const body = { model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0.2 };
    expect(capRequestBody(body, 1024)).toMatchObject(body);
  });

  it("counts content chunks, not usage or the final chunk", () => {
    expect(isContentChunk('data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}')).toBe(true);
    expect(isContentChunk('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}')).toBe(false);
    expect(isContentChunk('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}')).toBe(false);
    expect(isContentChunk("data: [DONE]")).toBe(false);
    expect(isContentChunk(": keepalive")).toBe(false);
  });

  it("the backstop only trips clearly past the cap", () => {
    expect(overOutputCap(4096, 4096)).toBe(false);
    expect(overOutputCap(4096 + 410, 4096)).toBe(false);
    expect(overOutputCap(4096 + 411, 4096)).toBe(true);
    expect(overOutputCap(256 + 64, 256)).toBe(false);
    expect(overOutputCap(256 + 65, 256)).toBe(true);
  });
});
