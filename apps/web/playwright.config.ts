import { defineConfig } from "@playwright/test";
import fs from "node:fs";

// The sandbox ships a pinned Chromium build; use it when present, otherwise Playwright's default.
const local = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3190", trace: "retain-on-failure", launchOptions: fs.existsSync(local) ? { executablePath: local, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] } },
  webServer: { command: "node e2e/stack.mjs", url: "http://127.0.0.1:3199", reuseExistingServer: false, timeout: 180_000, stdout: "pipe", stderr: "pipe" },
});
