import { describe, expect, it } from "vitest";
import {
  matchAutoReview,
  normalizePermission,
  resolveWithCeiling,
  isHostToolAction,
} from "./host-tool-permissions.js";

describe("host-tool-permissions", () => {
  it("normalizes unknown permission to ask", () => {
    expect(normalizePermission("nope")).toBe("ask");
    expect(normalizePermission("always")).toBe("always");
  });

  it("applies ceiling so always cannot exceed ask", () => {
    expect(resolveWithCeiling("always", "ask")).toBe("ask");
    expect(resolveWithCeiling("ask", "never")).toBe("never");
    expect(resolveWithCeiling("never", "ask")).toBe("never");
    expect(resolveWithCeiling("always", null)).toBe("always");
  });

  it("matches auto-review allow/block rules", () => {
    expect(matchAutoReview("run-command rm -rf /", [], ["rm -rf"], true)).toBe("block");
    expect(matchAutoReview("run-command ls", ["ls"], [], true)).toBe("allow");
    expect(matchAutoReview("run-command ls", ["ls"], [], false)).toBe(null);
  });

  it("recognizes host actions", () => {
    expect(isHostToolAction("run-command")).toBe(true);
    expect(isHostToolAction("explode")).toBe(false);
  });
});
