# Deployment checklist

Do these in order. The app checks most of them for you: **Settings → Connection test** (or `npm run live:check`) reports PASS / WARN / FAIL with a fix for each.

## 1. Run three things
| Process | What | Notes |
|---|---|---|
| Postgres 14+ | database | any managed Postgres works |
| `web` | `npm run db:migrate && npm run start -w @rcm/web` | migrations wait for the database to come up |
| `worker` | `npm run start -w @rcm/worker` | **required**: without it nothing runs. The dashboard shows a red banner if it is missing |

`docker compose up --build` starts all three. Web and worker must share `DATABASE_URL` and the same provider keys.

## 2. Required environment (production)
`DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ chars), `SESSION_SECRET` (32+ random chars), `APP_BASE_URL` (your public **https** address; recipients' unsubscribe links use it).

## 3. Choose providers (any one of each)
- **AI:** one key from `.env.example` (Anthropic, OpenAI, Gemini, Groq, ...). Set `AGENT_MODEL` to a model your account can use.
- **Email:** Resend / SendGrid / Postmark / Mailgun key (or `SMTP_URL`). Verify the **sending domain** at the provider and set SPF/DKIM/DMARC. Use an address on that domain as "Sender email" in Settings.
- **Search (optional):** Brave / Tavily / Serper / SerpAPI.

## 3b. Contact finder (optional mailbox verification)
Works out of the box using the registry's authorized official and published emails. Guessed addresses stay **unverified and unused** until verified. To verify them set `SMTP_VERIFY=on`, `SMTP_VERIFY_HELO` and `SMTP_VERIFY_FROM` (a domain you own). This needs **outbound port 25**, which AWS/GCP/Azure block by default: the Connection test reports it. Use a host that allows it, or leave it off.

## 4. Webhooks (so bounces, complaints and replies are handled)
- Delivery/bounce/complaint: provider dashboard → webhook URL `APP_BASE_URL/api/webhooks/email/<provider>` and set that provider's secret variable (see `.env.example`).
- Replies: point your inbound-parse hook at `APP_BASE_URL/api/inbound` with header `x-webhook-secret: $INBOUND_WEBHOOK_SECRET`.

## 5. Before the first real send
1. Settings: sender name/email, company, **postal address**.
2. Settings → **Full test**: all rows PASS (email row may WARN if you use dry-run).
3. Send one email to yourself: approve, receive, click unsubscribe, confirm it suppresses you.
4. Start small: 10 leads, watch the Agent runs page.

## Common errors and fixes
| You see | Cause | Fix |
|---|---|---|
| Red banner "background worker is not running" | worker process not started or wrong `DATABASE_URL` | start it with the same database |
| Runs stay "queued" | same as above | same |
| "API key was rejected" (any vendor) | typo, extra spaces/quotes, revoked, wrong workspace | re-copy the key; no quotes in `.env` |
| Resend / SendGrid / Postmark "domain / sender not verified" | sender address not on a verified domain | verify the domain, use an address on it in Settings |
| Mailgun 401/403 | public key used, wrong region, sandbox domain | private key, `MAILGUN_REGION=eu` if EU, add sandbox recipients |
| "model not found" | `AGENT_MODEL` not available to your account | set `AGENT_MODEL` to an available model |
| Billing / quota / credits message | provider account out of credits | add credits or a card |
| Discovery: "requires additional search criteria" | registry rejects state-only searches | add a specialty or city |
| Unsubscribe links open localhost | `APP_BASE_URL` not set | set your public https URL |
| Sign-in impossible in production | admin vars missing | set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET` |
| Bounces still emailed | webhook not configured | step 4 |
| Emails marked "sent" but nothing arrives | no email provider configured (dry-run) | set a provider key |
