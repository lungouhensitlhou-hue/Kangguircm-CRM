import { z } from "zod";
import { addContact, listLeads, upsertLead } from "@rcm/core";
import { body, json, route } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const p = new URL(req.url).searchParams;
  return listLeads({
    q: p.get("q") ?? undefined, stage: p.get("stage") ?? undefined, state: p.get("state") ?? undefined,
    specialty: p.get("specialty") ?? undefined, minScore: p.get("minScore") ? Number(p.get("minScore")) : undefined,
    sort: (p.get("sort") as any) ?? undefined, limit: Number(p.get("limit") ?? 50), offset: Number(p.get("offset") ?? 0),
  });
});

const Create = z.object({
  name: z.string().min(1).max(200), specialty: z.string().max(200).optional(), city: z.string().max(100).optional(),
  state: z.string().max(2).optional(), website: z.string().max(300).optional(), phone: z.string().max(40).optional(),
  contactName: z.string().max(120).optional(), contactTitle: z.string().max(120).optional(), contactEmail: z.string().max(254).optional(),
});

export const POST = route(async (req, { user }) => {
  const b = Create.parse(await body(req));
  const r = await upsertLead({ ...b, source: "manual" });
  if (b.contactEmail || b.contactName) await addContact(r.organizationId, { full_name: b.contactName, title: b.contactTitle, email: b.contactEmail, source: "manual", is_decision_maker: /manager|director|owner|administrator|ceo|coo|cfo|partner/i.test(b.contactTitle ?? "") });
  return json(r, r.created ? 201 : 200);
});
