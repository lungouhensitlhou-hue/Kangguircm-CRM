import { z } from "zod";
import { addContact, getLead } from "@rcm/core";
import { HttpError, body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
const C = z.object({ full_name: z.string().max(120).optional(), title: z.string().max(120).optional(), email: z.string().max(254).optional(), phone: z.string().max(40).optional(), is_decision_maker: z.boolean().optional() });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const lead = await getLead(params.id);
  if (!lead) throw new HttpError(404, "Lead not found");
  const c = await addContact(lead.organization_id, { ...C.parse(await body(req)), source: "manual" });
  if (!c) throw new HttpError(400, "Provide a valid email or a name");
  return c;
});
