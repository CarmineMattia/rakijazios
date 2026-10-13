import { describe, expect, it } from "vitest";
import { SlotQueue } from "./local-runners.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("M3b slot queue", () => {
  it("takes a free slot at once and waits when busy, first come first served", async () => {
    const q = new SlotQueue({ waitMs: 2000, max: 4, pollMs: 10 });
    let used = 1;
    const cap = 1;
    const free = () => used < cap;
    const order: string[] = [];
    const a = q.acquire("d", free).then((r) => { order.push(`a:${r}`); if (r === "ok") used++; });
    await sleep(5);
    const b = q.acquire("d", free).then((r) => { order.push(`b:${r}`); if (r === "ok") used++; });
    await sleep(30);
    expect(q.waiting("d")).toBe(2);
    used = 0; // one slot frees
    await sleep(40);
    expect(order).toEqual(["a:ok"]);
    used = 0; // and another
    await Promise.all([a, b]);
    expect(order).toEqual(["a:ok", "b:ok"]);
    expect(q.waiting("d")).toBe(0);
    expect(await q.acquire("d", () => true)).toBe("ok");
  });
  it("gives up after the wait time, refuses when the queue is full, and honours abort / gone", async () => {
    const q = new SlotQueue({ waitMs: 60, max: 1, pollMs: 10 });
    const t0 = Date.now();
    const waiting = q.acquire("d", () => false);
    expect(await q.acquire("d", () => false)).toBe("busy"); // queue full
    expect(await waiting).toBe("busy");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    const ac = new AbortController();
    const p = q.acquire("d", () => false, ac.signal);
    ac.abort();
    expect(await p).toBe("aborted");
    let gone = false;
    const g = q.acquire("d", () => (gone ? "gone" : false));
    gone = true;
    expect(await g).toBe("gone");
    expect(q.waiting("d")).toBe(0);
  });
});
