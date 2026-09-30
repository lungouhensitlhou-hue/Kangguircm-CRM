import { query, queryOne } from "../db";
import { getSettings } from "../settings";
import { isSuppressed, isWithinSendWindow, nextSendWindow, senderReady, sentToday, unsubscribeUrl } from "../compliance";
import { setStage, getLead } from "../leads";
import { enqueueRun } from "../queue";
import type { Message } from "../types";
import { PermanentError, type Handler } from "./runtime";

export const sendHandler: Handler = async (ctx) => {
  const id = ctx.run.input.messageId as string;
  const msg = id ? await queryOne<Message>("SELECT * FROM messages WHERE id = $1", [id]) : null;
  if (!msg) throw new PermanentError("Message not found");
  if (msg.status === "sent") return { skipped: "already_sent" };
  if (msg.status !== "approved") { await ctx.log(`Message is ${msg.status}, not approved; nothing sent`); return { skipped: msg.status }; }
  const s = await getSettings();
  const to = msg.to_email!;

  if (await isSuppressed(to)) {
    await query("UPDATE messages SET status = 'cancelled', error = 'recipient suppressed' WHERE id = $1", [msg.id]);
    await ctx.log(`${to} is on the suppression list; cancelled`, undefined, "warn");
    return { skipped: "suppressed" };
  }
  const ready = senderReady(s);
  if (!ready.ok) {
    await query("UPDATE messages SET error = $2 WHERE id = $1", [msg.id, `Set ${ready.missing.join(", ")} in Settings`]);
    throw new PermanentError(`Sender identity incomplete: missing ${ready.missing.join(", ")}`);
  }

  const now = ctx.now;
  const defer = async (reason: string, at: Date) => {
    await query("UPDATE agent_runs SET status = 'queued', run_at = $2, attempts = GREATEST(attempts - 1, 0), locked_at = NULL, locked_by = NULL WHERE id = $1", [ctx.run.id, at]);
    await ctx.log(`Deferred: ${reason}; retry at ${at.toISOString()}`);
    return { deferred: true, until: at.toISOString(), reason };
  };
  if (!isWithinSendWindow(now, s)) return await defer("outside send window", nextSendWindow(now, s));
  if ((await sentToday()) >= s.dailySendCap) return await defer(`daily cap of ${s.dailySendCap} reached`, nextSendWindow(new Date(now.getTime() + 3600_000 * 4), s));

  try {
    const url = unsubscribeUrl(msg.unsub_token!);
    const out = await ctx.deps.mailer.send({
      to,
      from: `${s.senderName} <${s.senderEmail}>`,
      subject: msg.subject,
      text: msg.body,
      headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    await query("UPDATE messages SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, error = NULL WHERE id = $1", [msg.id, ctx.deps.mailer.name, out.id]);
  } catch (e) {
    const final = ctx.run.attempts >= ctx.run.max_attempts;
    await query("UPDATE messages SET error = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END WHERE id = $1", [msg.id, (e as Error).message, final]);
    throw e;
  }

  const lead = await getLead(msg.lead_id);
  if (lead && !["replied", "meeting", "won", "lost", "disqualified"].includes(lead.stage)) await setStage(lead.id, "contacted", "agent");
  const nextDays = s.followupDays[msg.step - 1];
  await query("UPDATE leads SET next_action_at = $2, updated_at = now() WHERE id = $1", [msg.lead_id, nextDays ? new Date(now.getTime() + nextDays * 86400_000) : null]);
  await ctx.log(`Sent step ${msg.step} to ${to} via ${ctx.deps.mailer.name}`);
  return { messageId: msg.id, provider: ctx.deps.mailer.name };
};

/** Queue the send job for an approved message (idempotent). */
export async function queueSend(messageId: string, leadId: string) {
  return enqueueRun({ kind: "send", leadId, input: { messageId }, idempotencyKey: `send:${messageId}`, createdBy: "user" });
}
