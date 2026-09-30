import { query, queryOne, type Queryable } from "./db";
import { z } from "zod";

export const SettingsSchema = z.object({
  senderName: z.string().min(1),
  senderEmail: z.string().email().or(z.literal("")),
  companyName: z.string().min(1),
  /** CAN-SPAM requires a valid physical postal address in every commercial email. */
  physicalAddress: z.string(),
  dailySendCap: z.number().int().min(0).max(2000),
  sendWindowStartHour: z.number().int().min(0).max(23),
  sendWindowEndHour: z.number().int().min(1).max(24),
  timezone: z.string(),
  sendOnWeekends: z.boolean(),
  followupDays: z.array(z.number().int().min(1).max(60)).max(6),
  /** When true, drafts skip human approval. Off by default; sending is opt-in per operator. */
  autoApprove: z.boolean(),
  offer: z.string(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  senderName: "Alex Morgan",
  senderEmail: "",
  companyName: "Kangguircm",
  physicalAddress: "",
  dailySendCap: 25,
  sendWindowStartHour: 8,
  sendWindowEndHour: 17,
  timezone: "America/New_York",
  sendOnWeekends: false,
  followupDays: [3, 7],
  autoApprove: false,
  offer:
    "end-to-end revenue cycle management (coding, claims submission, denial management and A/R follow-up) that lifts collections and shortens days in A/R",
};

export async function getSettings(db: Queryable | null = null): Promise<Settings> {
  const rows = db
    ? (await db.query("SELECT key, value FROM settings")).rows
    : await query<{ key: string; value: unknown }>("SELECT key, value FROM settings");
  const stored: Record<string, unknown> = {};
  for (const r of rows) stored[r.key] = r.value;
  return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...stored });
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = SettingsSchema.parse({ ...current, ...patch });
  for (const [k, v] of Object.entries(next)) {
    await query(
      "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [k, JSON.stringify(v)],
    );
  }
  return next;
}

export async function audit(actor: string, action: string, entity?: string, entityId?: string, data?: unknown) {
  await queryOne("INSERT INTO audit_log (actor, action, entity, entity_id, data) VALUES ($1,$2,$3,$4,$5) RETURNING id", [
    actor,
    action,
    entity ?? null,
    entityId ?? null,
    data === undefined ? null : JSON.stringify(data),
  ]);
}
