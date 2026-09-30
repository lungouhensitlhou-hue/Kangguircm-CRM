/** Turns a vendor's raw HTTP failure into an instruction a non-engineer can act on. */
export function hintFor(provider: string, status: number, body: string): string | null {
  const b = body.toLowerCase();
  const p = provider.toLowerCase();
  if (status === 401 || (status === 403 && /api.?key|unauthor|invalid.*(token|key)|authentication/.test(b))) {
    if (p === "resend" && /restricted/.test(b)) return "This Resend key is sending-only; it cannot call that endpoint (sending still works).";
    return "The API key was rejected. Re-copy the full key (no spaces or quotes), and check it is active and belongs to the right account/workspace.";
  }
  if (status === 402 || /insufficient_quota|credit|billing|exceeded your current quota|payment/.test(b)) return "Billing problem: the account is out of credits or has no payment method. Add credits or a card in the provider's billing page.";
  if (status === 429) return "Rate limit reached. The job will retry automatically; if it keeps happening, lower WORKER_CONCURRENCY or upgrade the plan.";
  if (p === "resend" && (status === 403 || status === 422) && /domain|verif|testing emails|own email/.test(b)) return "Resend only sends from a verified domain. Verify your domain at resend.com/domains and use an address on it as the sender email in Settings.";
  if (p === "sendgrid" && status === 403) return "SendGrid rejected the sender. Complete Single Sender Verification or Domain Authentication for the sender email, and make sure the API key has Mail Send permission.";
  if (p === "postmark" && /sender signature|not confirmed|not a valid|from address/.test(b)) return "Postmark requires a confirmed Sender Signature (or verified domain) for the From address. Confirm it in Postmark, and use exactly that address in Settings.";
  if (p === "postmark" && /pending approval|inactive/.test(b)) return "Your Postmark account is still pending approval. Contact Postmark support or use a test server token.";
  if (p === "mailgun" && (status === 401 || status === 403 || /sandbox|authorized recipients/.test(b))) return "Mailgun rejected the request. Use the private API key (not the public one), the exact sending domain, and for sandbox domains add the recipient to Authorized Recipients. Use MAILGUN_REGION=eu for EU accounts.";
  if (status === 404 && /model/.test(b)) return "That model name is not available to this account. Set AGENT_MODEL to a model you have access to (check the provider's model list).";
  if (status === 404) return "Endpoint or resource not found. Check the base URL / domain / region settings.";
  if (status === 400 && /max_tokens|max_completion_tokens/.test(b)) return "This model does not accept that token-limit parameter. Try a different AGENT_MODEL, or use the provider's OpenAI-compatible preset.";
  if (status >= 500) return "The provider had a server error. The job will retry automatically.";
  return null;
}
