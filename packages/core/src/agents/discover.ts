import { z } from "zod";
import { upsertLead } from "../leads";
import { enqueueRun } from "../queue";
import { PermanentError, type Handler } from "./runtime";

export const DiscoverInput = z.object({
  states: z.array(z.string().length(2)).max(20).default([]),
  city: z.string().optional(),
  taxonomy: z.string().optional(),
  type: z.enum(["NPI-1", "NPI-2"]).default("NPI-2"),
  limit: z.number().int().min(1).max(1000).default(50),
  autoResearch: z.boolean().default(false),
  researchTop: z.number().int().min(0).max(200).default(25),
}).refine((v) => !!(v.taxonomy?.trim() || v.city?.trim()), {
  message: "Give a specialty (or a city): the NPPES registry does not allow searching by state alone",
});

export const discoverHandler: Handler = async (ctx) => {
  const parsed = DiscoverInput.safeParse(ctx.run.input);
  if (!parsed.success) throw new PermanentError(`Invalid discovery input: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const inp = parsed.data;
  const states = inp.states.length ? inp.states : [undefined];
  let created = 0, existing = 0, fetched = 0;
  const newLeadIds: string[] = [];

  for (const state of states) {
    let skip = 0;
    const want = Math.min(inp.limit, 1200); // registry paging ceiling (skip <= 1000, limit <= 200)
    let got = 0;
    while (got < want) {
      await ctx.checkCancelled();
      const page = Math.min(200, want - got);
      const results = await ctx.deps.npi.search({ state, city: inp.city, taxonomy: inp.taxonomy, type: inp.type, limit: page, skip });
      await ctx.tool("npi.search", { state, taxonomy: inp.taxonomy, skip, limit: page }, { returned: results.length });
      fetched += results.length;
      for (const org of results) {
        const r = await upsertLead(org);
        if (r.created) { created++; newLeadIds.push(r.leadId); } else existing++;
      }
      got += results.length;
      skip += page;
      await ctx.progress(`${state ?? "all states"}: ${got}/${want} scanned, ${created} new leads`);
      if (results.length < page) break;
    }
  }

  let queued = 0;
  if (inp.autoResearch) {
    for (const id of newLeadIds.slice(0, inp.researchTop)) {
      await enqueueRun({ kind: "research", leadId: id, parentId: ctx.run.id, idempotencyKey: `research:${id}:${ctx.run.id}`, createdBy: "agent" });
      queued++;
    }
    await ctx.log(`Queued ${queued} research run(s)`);
  }
  return { fetched, created, existing, researchQueued: queued };
};
