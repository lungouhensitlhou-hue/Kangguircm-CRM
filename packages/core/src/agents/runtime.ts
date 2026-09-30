import { emitEvent, isCancelled } from "../queue";
import type { AgentRun } from "../types";
import type { LLM, Usage } from "../providers/llm";
import { costUsd } from "../providers/llm";
import type { NpiClient } from "../providers/npi";
import type { WebTools } from "../providers/web";
import type { Mailer } from "../providers/mailer";
import type { MxCheck } from "../providers/mx";

export interface Deps {
  llm: LLM | null;
  /** Cheaper/faster model for bulk extraction and critique. Falls back to `llm`. */
  fastLlm?: LLM | null;
  /** Domain can receive mail? Defaults to "yes" when omitted. */
  mxCheck?: MxCheck;
  npi: NpiClient;
  web: WebTools;
  mailer: Mailer;
  now?: () => Date;
}

export class RunCancelled extends Error {
  constructor() { super("run cancelled"); }
}
/** Errors that retrying cannot fix (bad input, missing lead). */
export class PermanentError extends Error {}

export class RunContext {
  usage: Usage = { tokensIn: 0, tokensOut: 0 };
  costUsd = 0;
  constructor(readonly run: AgentRun, readonly deps: Deps) {}

  get now(): Date { return this.deps.now?.() ?? new Date(); }

  async log(message: string, data?: unknown, type = "info") { await emitEvent(this.run.id, type, message, data); }
  async progress(message: string, data?: unknown) { await emitEvent(this.run.id, "progress", message, data); }
  async tool(name: string, input: unknown, result: unknown) { await emitEvent(this.run.id, "tool", name, { input, result }); }

  /** The model used for bulk/cheap steps (extraction, critique). */
  get fast(): LLM | null { return this.deps.fastLlm ?? this.deps.llm; }

  addUsage(u: Usage, llm: LLM | null = this.deps.llm) {
    this.usage.tokensIn += u.tokensIn;
    this.usage.tokensOut += u.tokensOut;
    const model = (llm as any)?.model as string | undefined;
    if (model) this.costUsd += costUsd(model, u);
  }

  async checkCancelled() { if (await isCancelled(this.run.id)) throw new RunCancelled(); }
}

export type Handler = (ctx: RunContext) => Promise<Record<string, unknown>>;
