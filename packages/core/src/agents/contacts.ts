import { query, queryOne } from "../db";
import { getContacts, getLead } from "../leads";
import { enqueueRun } from "../queue";
import { getSettings } from "../settings";
import { candidates, inferPattern, parseName, type Pattern } from "../providers/email-patterns";
import { findDomain } from "./domain-finder";
import { pickContact } from "./outreach";
import { PermanentError, type Handler } from "./runtime";
import type { Contact } from "../types";

const hostOf = (website: string) => new URL(website).hostname.replace(/^www\./, "").toLowerCase();
const usableDomain = (d: string) => d.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(d) && !/^localhost$/.test(d);
const hasUsableEmail = (c: Contact) => !!c.email && c.email_status !== "invalid" && c.email_status !== "bounced";

async function bumpPattern(domain: string, pattern: Pattern) {
  await query("INSERT INTO email_patterns (domain, pattern) VALUES ($1,$2) ON CONFLICT (domain, pattern) DO UPDATE SET hits = email_patterns.hits + 1, updated_at = now()", [domain, pattern]);
}

/**
 * Contact finder (the in-house "Apollo"): people → website domain → address candidates → mailbox verification.
 * Guessed addresses carry source='pattern' and a confidence; they are only used for outreach once verified
 * (or when the operator allows guesses), so a wrong guess can never silently become a bounce.
 */
export const contactsHandler: Handler = async (ctx) => {
  const leadId = ctx.run.lead_id ?? (ctx.run.input.leadId as string);
  const lead = leadId ? await getLead(leadId) : null;
  if (!lead) throw new PermanentError("Lead not found");
  const org = lead.org;
  const s = await getSettings();
  const summary = { website: org.website, verified: 0, guessed: 0, domainFound: false };

  // 1. Website / domain
  let website = org.website;
  if (!website) {
    const aliases = org.aliases ?? [];
    const found = await findDomain(ctx.deps.web, { ...org, aliases }, (m) => ctx.log(m), { guess: ctx.deps.domainGuess !== false });
    if (found) {
      website = found.website;
      summary.domainFound = true;
      await query("UPDATE organizations SET website = $2, website_confidence = $3, updated_at = now() WHERE id = $1", [org.id, website, found.confidence]);
      await ctx.log(`Found website ${website} (${found.via}, confidence ${found.confidence}: ${found.reasons.join(", ")})`);
    } else await ctx.log("Could not confidently identify the practice's website; add it on the lead to continue", undefined, "warn");
  }
  const finish = async (out: Record<string, unknown>) => {
    const usable = await pickContact(org.id, s.allowGuessedEmails);
    if (ctx.run.input.thenOutreach && usable) {
      await enqueueRun({ kind: "outreach", leadId: lead.id, parentId: ctx.run.id, input: { step: 1 }, idempotencyKey: `outreach:${lead.id}:1`, createdBy: "agent" });
      await ctx.log("Queued outreach drafting");
    }
    return { ...summary, ...out, usableContact: !!usable };
  };
  if (!website) return finish({ skipped: "no_website" });
  const domain = hostOf(website);
  if (!usableDomain(domain)) return finish({ skipped: "unusable_domain" });
  if (ctx.deps.mxCheck && !(await ctx.deps.mxCheck(domain))) { await ctx.log(`${domain} has no mail server; cannot build addresses`, undefined, "warn"); return finish({ skipped: "no_mail_server" }); }

  // 2. Learn this domain's address pattern from people whose address is already published
  const contacts = await getContacts(org.id);
  for (const c of contacts) {
    if (c.email && c.full_name && c.email_source === "published" && c.email.endsWith(`@${domain}`)) {
      const p = inferPattern(c.email, c.full_name);
      if (p) await bumpPattern(domain, p);
    }
  }
  const learned = (await query<{ pattern: Pattern }>("SELECT pattern FROM email_patterns WHERE domain = $1 ORDER BY hits DESC", [domain])).map((r) => r.pattern);
  if (learned.length) await ctx.log(`Known address pattern at ${domain}: ${learned.join(", ")}`);

  // 3. For each named person without a usable address, build and verify candidates
  const targets = contacts
    .filter((c) => c.full_name && parseName(c.full_name) && !hasUsableEmail(c))
    .sort((a, b) => Number(b.is_decision_maker) - Number(a.is_decision_maker))
    .slice(0, 3);
  if (!targets.length) await ctx.log("No named person without an address to look up");

  const save = async (c: Contact, email: string, status: string, confidence: number) => {
    const clash = await queryOne("SELECT 1 FROM contacts WHERE organization_id = $1 AND lower(email) = $2 AND id <> $3", [org.id, email, c.id]);
    if (clash) return;
    await query("UPDATE contacts SET email = $2, email_source = 'pattern', email_status = $3, email_confidence = $4 WHERE id = $1", [c.id, email, status, confidence]);
  };

  for (const c of targets) {
    await ctx.checkCancelled();
    const cands = candidates(c.full_name!, domain, learned);
    if (!cands.length) continue;
    const top = cands[0];
    if (!ctx.deps.smtpVerify) {
      await save(c, top.email, "unverified", top.learned ? 45 : 25);
      summary.guessed++;
      await ctx.log(`${c.full_name}: best guess ${top.email} (unverified; mailbox verification is off)`);
      continue;
    }
    let settled = false;
    for (const cand of cands.slice(0, 6)) {
      const r = await ctx.deps.smtpVerify(cand.email);
      await ctx.tool("smtp.verify", { email: cand.email }, { status: r.status, reason: r.reason });
      if (r.status === "valid") {
        await save(c, cand.email, "verified", cand.learned ? 95 : 90);
        await bumpPattern(domain, cand.pattern);
        summary.verified++;
        await ctx.log(`${c.full_name}: verified ${cand.email}`);
        settled = true; break;
      }
      if (r.status === "catch-all") { await save(c, top.email, "risky", top.learned ? 55 : 35); summary.guessed++; await ctx.log(`${c.full_name}: ${domain} accepts any address (catch-all); kept ${top.email} as risky`); settled = true; break; }
      if (r.status === "unknown") { await save(c, top.email, "unverified", top.learned ? 45 : 25); summary.guessed++; await ctx.log(`${c.full_name}: could not verify (${r.reason}); kept ${top.email} unverified`); settled = true; break; }
      // invalid → try the next candidate
    }
    if (!settled) await ctx.log(`${c.full_name}: none of the likely addresses exist at ${domain}`, undefined, "warn");
  }
  return finish({ targets: targets.length });
};
