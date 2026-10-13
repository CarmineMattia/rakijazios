import { describe, expect, it } from "vitest";
import { decideSharedLocalAccess, type SharedLocalAccessRow } from "./local-runner-pairing.js";

const OWNER = "owner_1";
const base: SharedLocalAccessRow = {
  bot_id: "bot_1",
  run_user_id: OWNER,
  run_status: "running",
  run_trigger: "user",
  bot_user_id: OWNER,
  bot_model_provider: "shared-local",
  bot_model_id: "gemma",
  bot_archived: false,
  thread_group_id: null,
  thread_bot_id: "bot_1",
  thread_external: false,
  group_share_count: 0,
  group_granted: false,
  bind_device_id: "dev_1",
  bind_model_id: "gemma",
  device_user_id: OWNER,
  device_status: "active",
  device_enabled: true,
  model_enabled: true,
  model_advertised: true,
  model_context_window: 32768,
};
const type = (row: Partial<SharedLocalAccessRow> | undefined, owner = OWNER, model?: string) => {
  const d = decideSharedLocalAccess(owner, row ? { ...base, ...row } : undefined, model);
  return d.ok ? "ok" : d.type;
};

describe("decideSharedLocalAccess (M2b gateway rule)", () => {
  it("allows a live run of the owner's bound bot, routed to the bound computer", () => {
    expect(decideSharedLocalAccess(OWNER, base, "gemma")).toEqual({ ok: true, deviceId: "dev_1", modelId: "gemma", contextWindow: 32768, botId: "bot_1", groupId: null });
    expect(type({ run_status: "leased" })).toBe("ok");
  });
  it("ends with the run, and never for another owner", () => {
    expect(type(undefined)).toBe("shared_local_run_ended");
    for (const run_status of ["completed", "failed", "cancelled", "queued"]) expect(type({ run_status })).toBe("shared_local_run_ended");
    expect(type({}, "someone_else")).toBe("shared_local_run_ended");
    expect(type({ bot_user_id: "other" })).toBe("shared_local_unbound");
  });
  it("M2c: a shared group needs a grant; other threads fail closed", () => {
    const g = { thread_group_id: "g1", thread_bot_id: null };
    expect(type({ ...g, group_share_count: 1, group_granted: true })).toBe("ok");
    expect(type({ ...g, group_share_count: 1, group_granted: false })).toBe("shared_local_group_denied");
    expect(type({ ...g, group_share_count: 0, group_granted: false })).toBe("ok");
    expect(type({ thread_bot_id: "another_bot" })).toBe("shared_local_thread_denied");
    expect(type({ thread_bot_id: null })).toBe("shared_local_thread_denied");
    expect(type({ ...g, group_share_count: 1, group_granted: true, thread_external: true })).toBe("shared_local_external_denied");
    const d = decideSharedLocalAccess(OWNER, { ...base, ...g, group_share_count: 1, group_granted: true });
    expect(d.ok && d.groupId).toBe("g1");
  });
  it("refuses external channels and ungranted shared groups", () => {
    expect(type({ thread_external: true })).toBe("shared_local_external_denied");
    expect(type({ run_trigger: "messaging" })).toBe("shared_local_external_denied");
    expect(type({ run_trigger: "webhook" })).toBe("shared_local_external_denied");
    expect(type({ thread_group_id: "g1", thread_bot_id: null, group_share_count: 2 })).toBe("shared_local_group_denied");
    expect(type({ thread_group_id: "g1", thread_bot_id: null, group_share_count: 0 })).toBe("ok");
  });
  it("checks binding, computer and model on every request", () => {
    expect(type({ bind_device_id: null, bind_model_id: null })).toBe("shared_local_unbound");
    expect(type({ bot_model_provider: "openrouter" })).toBe("shared_local_unbound");
    expect(type({ device_status: "revoked" })).toBe("shared_local_removed");
    expect(type({ device_user_id: "other" })).toBe("shared_local_removed");
    expect(type({ device_enabled: false })).toBe("shared_local_paused");
    expect(type({ model_enabled: false })).toBe("shared_local_model_off");
    expect(type({ model_advertised: false })).toBe("shared_local_model_off");
    expect(type({ bot_model_id: "other" })).toBe("shared_local_model_off");
    expect(type({}, OWNER, "another-model")).toBe("shared_local_model_off");
  });
});
