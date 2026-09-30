import { query, queryOne } from "./db";
import { audit, getSettings } from "./settings";
import { assembleBody, hasUnsubscribeIntent, isSuppressed, senderReady, suppress, normalizeEmail } from "./compliance";
import { queueSend } from "./agents/send";
import { setStage } from "./leads";
import type { Message } from "./types";

export async function listMessages(opts: { status?: string; leadId?: string; limit?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) { params.push(opts.status); where.push(`m.status = $${params.length}`); }
  if (opts.leadId) { params.push(opts.leadId); where.push(`m.lead_id = $${params.length}`); }
  params.push(opts.limit ?? 100);
  return query<Message & { org_name: string; contact_name: string | null }>(
    `SELECT m.*, o.name AS org_name, c.full_name AS contact_name
     FROM messages m JOIN leads l ON l.id = m.lead_id JOIN organizations o ON o.id = l.organization_id
     LEFT JOIN contacts c ON c.id = m.contact_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.created_at DESC LIMIT $${params.length}`,
    params,
  );
}

export async function getMessage(id: string): Promise<Message | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return queryOne<Message>("SELECT * FROM messages WHERE id = $1", [id]);
}

/** Edit a draft. The compliance footer is regenerated so operators can never strip it. */
export async function editDraft(id: string, patch: { subject?: string; body?: string }, actor: string): Promise<Message> {
  const m = await getMessage(id);
  if (!m) throw new Error("Message not found");
  if (m.status !== "draft") throw new Error(`Only drafts can be edited (this is ${m.status})`);
  const s = await getSettings();
  const body = patch.body !== undefined ? assembleBody(patch.body, s, m.unsub_token!) : m.body;
  const subject = (patch.subject ?? m.subject).trim();
  if (!subject) throw new Error("Subject is required");
  const row = await queryOne<Message>("UPDATE messages SET subject = $2, body = $3 WHERE id = $1 RETURNING *", [id, subject, body]);
  await audit(actor, "edit_draft", "message", id);
  return row!;
}

export async function approveMessage(id: string, actor: string): Promise<Message> {
  const m = await getMessage(id);
  if (!m) throw new Error("Message not found");
  if (m.status !== "draft") throw new Error(`Only drafts can be approved (this is ${m.status})`);
  if (await isSuppressed(m.to_email!)) {
    await query("UPDATE messages SET status = 'cancelled', error = 'recipient suppressed' WHERE id = $1", [id]);
    throw new Error("Recipient is on the suppression list; draft cancelled");
  }
  const ready = senderReady(await getSettings());
  if (!ready.ok) throw new Error(`Complete Settings first: ${ready.missing.join(", ")}`);
  const row = await queryOne<Message>("UPDATE messages SET status = 'approved', approved_by = $2, approved_at = now(), error = NULL WHERE id = $1 RETURNING *", [id, actor]);
  await queueSend(id, m.lead_id);
  await audit(actor, "approve_message", "message", id);
  return row!;
}

export async function rejectMessage(id: string, actor: string): Promise<void> {
  const m = await getMessage(id);
  if (!m) throw new Error("Message not found");
  if (m.status !== "draft" && m.status !== "approved") throw new Error(`Cannot reject a ${m.status} message`);
  await query("UPDATE messages SET status = 'rejected' WHERE id = $1", [id]);
  await audit(actor, "reject_message", "message", id);
}

/** One-click unsubscribe by token (public endpoint). Idempotent. */
export async function unsubscribeByToken(token: string): Promise<{ ok: boolean; email?: string }> {
  const m = await queryOne<Message>("SELECT * FROM messages WHERE unsub_token = $1", [token]);
  if (!m || !m.to_email) return { ok: false };
  await suppress(m.to_email, "unsubscribe");
  await audit("recipient", "unsubscribe", "message", m.id, { email: m.to_email });
  return { ok: true, email: m.to_email };
}

/**
 * Record an inbound reply (from an inbound-email webhook). Matches the sender to a known contact,
 * stops further sequence steps, and honors opt-out language by suppressing the address.
 */
export async function recordInbound(input: { from: string; subject?: string; body: string }): Promise<{ matched: boolean; suppressed: boolean; leadId?: string }> {
  const email = normalizeEmail(input.from.replace(/^.*<([^>]+)>.*$/, "$1"));
  const contact = await queryOne<{ id: string; organization_id: string }>(
    "SELECT id, organization_id FROM contacts WHERE lower(email) = $1 LIMIT 1",
    [email],
  );
  const domain = email.split("@")[1];
  const lead = contact
    ? await queryOne<{ id: string }>("SELECT id FROM leads WHERE organization_id = $1", [contact.organization_id])
    : await queryOne<{ id: string }>(
        `SELECT l.id FROM leads l JOIN organizations o ON o.id = l.organization_id
         WHERE o.website ILIKE $1 ORDER BY l.updated_at DESC LIMIT 1`,
        [`%${domain}%`],
      );
  const optOut = hasUnsubscribeIntent(`${input.subject ?? ""}\n${input.body}`);
  if (optOut) await suppress(email, "reply-opt-out");
  if (!lead) return { matched: false, suppressed: optOut };
  await query(
    "INSERT INTO messages (lead_id, contact_id, direction, to_email, subject, body, status) VALUES ($1,$2,'inbound',$3,$4,$5,'received')",
    [lead.id, contact?.id ?? null, email, (input.subject ?? "").slice(0, 300), input.body.slice(0, 20000)],
  );
  // Stop the sequence: cancel anything unsent.
  await query("UPDATE messages SET status = 'cancelled', error = 'lead replied' WHERE lead_id = $1 AND direction = 'outbound' AND status IN ('draft','approved')", [lead.id]);
  await setStage(lead.id, optOut ? "disqualified" : "replied", "inbound");
  return { matched: true, suppressed: optOut, leadId: lead.id };
}
