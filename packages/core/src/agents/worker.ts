import os from "node:os";
import { claimRun, completeRun, failRun, enqueueRun, getRun } from "../queue";
import { emitEvent } from "../queue";
import { RunContext, RunCancelled, PermanentError, type Deps, type Handler } from "./runtime";
import { researchHandler } from "./research";
import { outreachHandler } from "./outreach";
import { sendHandler } from "./send";
import { discoverHandler } from "./discover";
import { sweepHandler } from "./sweep";
import { chatHandler } from "./chat";
import { smokeHandler } from "./smoke";
import { replyHandler } from "./reply";
import type { AgentRun, RunKind } from "../types";

export const HANDLERS: Record<RunKind, Handler> = {
  discover: discoverHandler,
  research: researchHandler,
  outreach: outreachHandler,
  send: sendHandler,
  chat: chatHandler,
  sweep: sweepHandler,
  smoke: smokeHandler,
  reply: replyHandler,
};

/** Execute one claimed run to completion (or scheduled retry). Never throws. */
export async function executeRun(run: AgentRun, deps: Deps): Promise<"succeeded" | "failed" | "queued" | "cancelled"> {
  const ctx = new RunContext(run, deps);
  const handler = HANDLERS[run.kind];
  try {
    if (!handler) throw new PermanentError(`No handler for run kind "${run.kind}"`);
    await ctx.log(`Started ${run.kind} (attempt ${run.attempts}/${run.max_attempts})`);
    const output = await handler(ctx);
    await completeRun(run.id, output, { tokensIn: ctx.usage.tokensIn, tokensOut: ctx.usage.tokensOut, costUsd: ctx.costUsd });
    const after = await getRun(run.id);
    if (after?.status === "succeeded") await ctx.log(`Finished ${run.kind}`, output);
    return (after?.status ?? "succeeded") as any;
  } catch (e) {
    if (e instanceof RunCancelled) { await ctx.log("Cancelled"); return "cancelled"; }
    const msg = (e as Error).message ?? String(e);
    const status = await failRun(run.id, msg, !(e instanceof PermanentError));
    await emitEvent(run.id, "error", status === "queued" ? `${msg} (will retry)` : msg);
    return status;
  }
}

export async function processOne(workerId: string, deps: Deps): Promise<boolean> {
  const run = await claimRun(workerId);
  if (!run) return false;
  await executeRun(run, deps);
  return true;
}

export interface LoopOptions { pollMs?: number; concurrency?: number; sweepEveryMs?: number; signal?: AbortSignal; log?: (m: string) => void }

/** Long-running worker: N concurrent claim loops plus a periodic sweep scheduler. */
export async function runWorker(deps: Deps, o: LoopOptions = {}): Promise<void> {
  const id = `${os.hostname()}:${process.pid}`;
  const poll = o.pollMs ?? 1000;
  const conc = o.concurrency ?? 3;
  const log = o.log ?? ((m) => console.log(`[worker] ${m}`));
  const stopped = () => !!o.signal?.aborted;
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); o.signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

  const loop = async (n: number) => {
    while (!stopped()) {
      try {
        const did = await processOne(`${id}#${n}`, deps);
        if (!did) await sleep(poll);
      } catch (e) {
        log(`loop ${n} error: ${(e as Error).message}`);
        await sleep(poll * 3);
      }
    }
  };
  const scheduler = async () => {
    const every = o.sweepEveryMs ?? 60_000;
    while (!stopped()) {
      try {
        const bucket = Math.floor(Date.now() / every);
        await enqueueRun({ kind: "sweep", idempotencyKey: `sweep:${bucket}`, maxAttempts: 1 });
      } catch (e) { log(`scheduler error: ${(e as Error).message}`); }
      await sleep(every);
    }
  };
  log(`started ${id} (concurrency ${conc}, llm=${deps.llm?.name ?? "off (rule-based fallbacks)"}, mailer=${deps.mailer.name})`);
  await Promise.all([...Array.from({ length: conc }, (_, i) => loop(i)), scheduler()]);
  log("stopped");
}
