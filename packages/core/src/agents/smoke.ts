import type { Handler } from "./runtime";

/** Proves the UI -> queue -> worker -> event stream -> UI loop end to end. */
export const smokeHandler: Handler = async (ctx) => {
  const steps = Math.min(Number(ctx.run.input.steps ?? 3), 20);
  const delay = Math.min(Number(ctx.run.input.delayMs ?? 300), 5000);
  if (ctx.run.input.fail) throw new Error("smoke test failure requested");
  for (let i = 1; i <= steps; i++) {
    await ctx.checkCancelled();
    await new Promise((r) => setTimeout(r, delay));
    await ctx.progress(`Smoke step ${i}/${steps}`);
  }
  return { ok: true, steps };
};
