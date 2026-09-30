import { SettingsSchema, getSettings, saveSettings, senderReady, audit } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async () => {
  const s = await getSettings();
  return { settings: s, ready: senderReady(s), sending: process.env.SMTP_URL ? "smtp" : "dry-run" };
});
export const PUT = route(async (req, { user }) => {
  const patch = SettingsSchema.partial().parse(await body(req));
  const s = await saveSettings(patch);
  await audit(user!.email, "update_settings", "settings", undefined, Object.keys(patch));
  return { settings: s, ready: senderReady(s) };
});
