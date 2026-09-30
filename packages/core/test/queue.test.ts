import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cancelRun, claimRun, completeRun, enqueueRun, failRun, getRun, listEvents, emitEvent, reclaimStaleRuns } from "../src/queue";
import { query } from "../src/db";
import { resetDb, setupDb, teardownDb, makeDeps } from "./helpers";
import { executeRun, processOne } from "../src/agents/worker";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);

describe("durable queue", () => {
  it("enqueue is idempotent by key", async () => {
    const a = await enqueueRun({ kind: "smoke", idempotencyKey: "k1" });
    const b = await enqueueRun({ kind: "smoke", idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
    expect((await query("SELECT count(*)::int n FROM agent_runs"))[0].n).toBe(1);
  });

  it("concurrent workers never double-claim a run", async () => {
    for (let i = 0; i < 6; i++) await enqueueRun({ kind: "smoke" });
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => claimRun(`w${i}`)));
    const got = claims.filter(Boolean);
    expect(got).toHaveLength(6);
    expect(new Set(got.map((r) => r!.id)).size).toBe(6);
    expect(got.every((r) => r!.attempts === 1 && r!.status === "running")).toBe(true);
  });

  it("does not claim future-dated runs", async () => {
    await enqueueRun({ kind: "smoke", runAt: new Date(Date.now() + 60_000) });
    expect(await claimRun("w")).toBeNull();
  });

  it("retries with backoff then fails permanently", async () => {
    const r = await enqueueRun({ kind: "smoke", maxAttempts: 2 });
    let c = (await claimRun("w"))!;
    expect(await failRun(c.id, "boom")).toBe("queued");
    const queued = (await getRun(r.id))!;
    expect(queued.status).toBe("queued");
    expect(new Date(queued.run_at).getTime()).toBeGreaterThan(Date.now());
    await query("UPDATE agent_runs SET run_at = now() WHERE id = $1", [r.id]);
    c = (await claimRun("w"))!;
    expect(c.attempts).toBe(2);
    expect(await failRun(c.id, "boom again")).toBe("failed");
    const done = (await getRun(r.id))!;
    expect(done.status).toBe("failed");
    expect(done.error).toBe("boom again");
    expect(done.finished_at).not.toBeNull();
  });

  it("non-retryable errors fail immediately", async () => {
    await enqueueRun({ kind: "smoke" });
    const c = (await claimRun("w"))!;
    expect(await failRun(c.id, "bad input", false)).toBe("failed");
  });

  it("reclaims runs whose worker died", async () => {
    await enqueueRun({ kind: "smoke" });
    const c = (await claimRun("dead-worker"))!;
    await query("UPDATE agent_runs SET locked_at = now() - interval '1 hour' WHERE id = $1", [c.id]);
    expect(await reclaimStaleRuns(600)).toBe(1);
    expect((await getRun(c.id))!.status).toBe("queued");
  });

  it("cancels queued and running runs, and the handler stops", async () => {
    const r = await enqueueRun({ kind: "smoke", input: { steps: 10, delayMs: 50 } });
    const c = (await claimRun("w"))!;
    const p = executeRun(c, makeDeps());
    setTimeout(() => cancelRun(r.id), 120);
    expect(await p).toBe("cancelled");
    expect((await getRun(r.id))!.status).toBe("cancelled");
    const events = await listEvents(r.id);
    expect(events.some((e) => e.message === "Cancelled")).toBe(true);
    expect(events.filter((e) => e.type === "progress").length).toBeLessThan(10);
  });

  it("completed run records output and streams ordered events", async () => {
    const r = await enqueueRun({ kind: "smoke", input: { steps: 3, delayMs: 5 } });
    expect(await processOne("w", makeDeps())).toBe(true);
    const done = (await getRun(r.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.output).toEqual({ ok: true, steps: 3 });
    const ev = await listEvents(r.id);
    expect(ev.map((e) => e.message)).toEqual(["Started smoke (attempt 1/3)", "Smoke step 1/3", "Smoke step 2/3", "Smoke step 3/3", "Finished smoke"]);
    const after = await listEvents(r.id, ev[2].id);
    expect(after).toHaveLength(2);
    expect(await processOne("w", makeDeps())).toBe(false);
  });

  it("a crashing handler is retried via the queue, then failed", async () => {
    const r = await enqueueRun({ kind: "smoke", input: { fail: true }, maxAttempts: 2 });
    expect(await processOne("w", makeDeps())).toBe(true);
    expect((await getRun(r.id))!.status).toBe("queued");
    await query("UPDATE agent_runs SET run_at = now() WHERE id = $1", [r.id]);
    await processOne("w", makeDeps());
    const f = (await getRun(r.id))!;
    expect(f.status).toBe("failed");
    expect(f.error).toContain("smoke test failure");
  });

  it("completeRun/emitEvent are safe against non-running rows", async () => {
    const r = await enqueueRun({ kind: "smoke" });
    await completeRun(r.id, { x: 1 });
    expect((await getRun(r.id))!.status).toBe("queued");
    await emitEvent(r.id, "info", "hi", { a: 1 });
    expect((await listEvents(r.id))[0].data).toEqual({ a: 1 });
  });
});
