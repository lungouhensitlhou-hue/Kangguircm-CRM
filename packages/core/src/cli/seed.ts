import { closePool, migrate } from "../db";
import { upsertLead, addContact } from "../leads";
import { saveSettings } from "../settings";

await migrate();
const demo = [
  { name: "Riverside Orthopedic Associates", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", website: "riverside-ortho.example", contact: { full_name: "Jane Smith", title: "Practice Manager", email: "jane.smith@riverside-ortho.example" } },
  { name: "Lakeside Cardiology Group", specialty: "Cardiology", city: "Dallas", state: "TX", website: "lakeside-cardio.example", contact: { full_name: "Robert Alvarez", title: "Billing Manager", email: "ralvarez@lakeside-cardio.example" } },
  { name: "Sunrise Urgent Care", specialty: "Urgent Care", city: "Miami", state: "FL", website: "sunrise-uc.example", contact: null },
];
for (const d of demo) {
  const { contact, ...org } = d;
  const r = await upsertLead({ ...org, source: "seed" });
  if (contact) await addContact(r.organizationId, { ...contact, is_decision_maker: true, source: "seed" });
}
if (process.env.SEED_SENDER_EMAIL) {
  await saveSettings({ senderEmail: process.env.SEED_SENDER_EMAIL, physicalAddress: process.env.SEED_ADDRESS ?? "" });
}
console.log(`Seeded ${demo.length} demo leads (example domains, no real data).`);
await closePool();
