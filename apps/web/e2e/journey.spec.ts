import { expect, test, type Page } from "@playwright/test";

const PW = "e2e-password-123";
const SITE = "http://127.0.0.1:3191";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("founder@e2e.test");
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("auth: protected pages and APIs require a session; bad passwords are rejected", async ({ page, request }) => {
  await page.goto("/leads");
  await expect(page).toHaveURL(/\/login$/);
  expect((await request.get("/api/leads")).status()).toBe(401);
  expect((await request.post("/api/discover", { data: { states: ["TX"] } })).status()).toBe(401);
  expect((await request.get("/api/health")).status()).toBe(200);
  await page.getByLabel("Email").fill("founder@e2e.test");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".notice.err")).toContainText("Invalid email or password");
  await login(page);
  // cross-site mutation with a valid cookie is blocked
  const cookies = await page.context().cookies();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const evil = await request.post("/api/discover", { headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, data: { states: ["TX"] } });
  expect(evil.status()).toBe(403);
});

test("settings: sender identity is required before approving, then saved", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("Missing: physical mailing address, sender email")).toBeVisible();
  await page.getByLabel("Sender email").fill("sam@kangguircm.test");
  await page.getByLabel(/Physical mailing address/).fill("100 Main St, Suite 5, Austin, TX 78701");
  await page.getByLabel("Window start (hour)").fill("0");
  await page.getByLabel("Window end (hour)").fill("24");
  await page.getByLabel("Also send on weekends").check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText("Settings saved");
  await page.reload();
  await expect(page.getByText("Sender identity is complete")).toBeVisible();
});

test("discovery agent: registry search runs on the worker and streams live progress", async ({ page }) => {
  await login(page);
  await page.goto("/leads");
  await page.getByLabel("States (comma-separated)").fill("TX");
  await page.getByLabel("Specialty / taxonomy").fill("Orthopedic");
  await page.getByLabel("Limit").fill("5");
  await page.getByLabel(/Automatically research/).uncheck();
  await page.getByRole("button", { name: "Start discovery run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 30_000 });
  await expect(page.getByTestId("run-log")).toContainText("scanned, 2 new leads");
  await expect(page.getByTestId("run-output")).toContainText('"created": 2');
  await page.goto("/leads");
  await expect(page.getByRole("link", { name: "E2e Orthopedic Associates" })).toBeVisible();
  await expect(page.getByRole("link", { name: "E2e Heart Clinic" })).toBeVisible();
  await page.getByLabel("Search", { exact: true }).fill("heart");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("link", { name: "E2e Orthopedic Associates" })).toHaveCount(0);
});

test("system self-test streams events over SSE", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  await page.getByRole("button", { name: "Run system self-test" }).click();
  await expect(page.getByTestId("run-log")).toContainText("Smoke step 4/4", { timeout: 20_000 });
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
});

test("research → draft → approve → send → reply → unsubscribe (full outreach loop)", async ({ page, request }) => {
  await login(page);
  // add a lead whose website is the fixture site
  await page.goto("/leads");
  await page.getByLabel("Practice / facility").fill("Riverside Orthopedics");
  await page.locator("#a-spec").fill("Orthopedic Surgery");
  await page.locator("#a-city").fill("Austin");
  await page.locator("#a-state").fill("TX");
  await page.locator("#a-web").fill(SITE);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.getByText("Lead added.")).toBeVisible();
  await page.getByLabel("Search", { exact: true }).fill("Riverside");
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("link", { name: "Riverside Orthopedics" }).click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);

  // research + draft on the worker
  await page.getByRole("button", { name: "Research + draft email" }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 30_000 });
  await expect(page.getByTestId("run-log")).toContainText("Profile saved");

  // nothing sent yet: draft sits in Approvals for the right person
  await page.goto("/approvals");
  const draft = page.getByTestId("draft").first();
  await expect(draft).toContainText("Riverside Orthopedics");
  await expect(draft).toContainText("jane.smith@e2e-ortho.test");
  await expect(draft).toContainText("runs on athenahealth"); // written by the AI provider, not the template
  await expect(draft).toContainText("required by CAN-SPAM");
  await expect(draft).toContainText("100 Main St, Suite 5, Austin, TX 78701");
  await draft.getByLabel("Subject").fill("Billing help for Riverside");
  await draft.getByRole("button", { name: "Approve & queue send" }).click();
  await expect(page.getByTestId("draft")).toHaveCount(0, { timeout: 10_000 });

  // worker sends (dry-run) and the lead moves to Contacted
  await page.goto("/leads");
  await page.getByLabel("Search", { exact: true }).fill("Riverside");
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("link", { name: "Riverside Orthopedics" }).click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
  await expect(async () => { await page.reload(); await expect(page.locator(".head .badge", { hasText: "Contacted" })).toBeVisible(); }).toPass({ timeout: 30_000 });
  await expect(page.getByText("via dry-run")).toBeVisible();
  await expect(page.getByText("AI-extracted profile")).toBeVisible();
  await expect(page.getByText("Ghost Person")).toHaveCount(0); // hallucinated contact was dropped by the grounding check
  await page.getByText("Show").first().click();
  const bodyText = await page.locator(".email").first().innerText();
  const token = bodyText.match(/\/unsubscribe\/([A-Za-z0-9_-]+)/)![1];
  expect(bodyText).toContain("Kangguircm");

  // inbound reply webhook: secret required
  expect((await request.post("/api/inbound", { data: { from: "jane.smith@e2e-ortho.test", body: "hi" } })).status()).toBe(401);
  const rep = await request.post("/api/inbound", { headers: { "x-webhook-secret": "e2e-inbound-secret" }, data: { from: "Jane Smith <jane.smith@e2e-ortho.test>", subject: "Re: Billing help", body: "Interesting, call me Thursday." } });
  expect(await rep.json()).toMatchObject({ matched: true, suppressed: false });
  await page.reload();
  await expect(page.locator(".head .badge", { hasText: "Replied" })).toBeVisible();

  // recipient unsubscribes via the public page (GET never unsubscribes; confirm click does)
  const anon = await page.context().browser()!.newContext();
  const p2 = await anon.newPage();
  await p2.goto(`http://127.0.0.1:3190/unsubscribe/${token}`);
  await expect(p2.getByRole("heading", { name: "Unsubscribe" })).toBeVisible();
  await p2.getByRole("button", { name: "Confirm unsubscribe" }).click();
  await expect(p2.getByRole("status")).toContainText("unsubscribed");
  const oneClick = await anon.request.post(`http://127.0.0.1:3190/api/unsubscribe/${token}`);
  expect(oneClick.status()).toBe(200);
  expect((await anon.request.post(`http://127.0.0.1:3190/api/unsubscribe/bogus`)).status()).toBe(404);
  await anon.close();

  await page.goto("/settings");
  await expect(page.getByText("jane.smith@e2e-ortho.test").first()).toBeVisible();
});

test("pipeline board moves a lead between stages", async ({ page }) => {
  await login(page);
  await page.goto("/pipeline");
  const card = page.locator(".kcard", { hasText: "E2e Heart Clinic" });
  await card.getByLabel("Move E2e Heart Clinic").selectOption("meeting");
  await expect(page.locator('[data-stage="meeting"]')).toContainText("E2e Heart Clinic");
  await page.reload();
  await expect(page.locator('[data-stage="meeting"]')).toContainText("E2e Heart Clinic");
});

test("chat agent uses the configured AI provider's tool-calling", async ({ page }) => {
  await login(page);
  await page.goto("/chat");
  await expect(page.getByText("AI is not configured")).toHaveCount(0);
  await page.getByLabel("Message").fill("How is my pipeline?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("chat-msgs")).toContainText(/AI summary: \d+ leads in your pipeline\./, { timeout: 20_000 });
  await page.goto("/settings");
  await expect(page.locator(".badge.ok", { hasText: "custom" }).first()).toBeVisible();
});

test("CSV import creates leads and contacts", async ({ page }) => {
  await login(page);
  await page.goto("/leads");
  await page.getByLabel("CSV text").fill("name,city,state,contact_name,contact_email,title\nCsv Urgent Care,Miami,FL,Pat Lee,pat@csv-uc.test,Practice Manager\n");
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("Imported: 1 new")).toBeVisible();
  await page.getByLabel("Search", { exact: true }).fill("Csv Urgent");
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("link", { name: "Csv Urgent Care" }).click();
  await expect(page.getByText("pat@csv-uc.test")).toBeVisible();
  await expect(page.getByText("decision maker")).toBeVisible();
});
