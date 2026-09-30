import type { Organization } from "./types";

/** Specialties with heavy coding/denial complexity: the best fit for outsourced RCM. */
const HIGH_VALUE = [
  "orthop", "cardio", "gastro", "oncolog", "urolog", "dermat", "ophthal", "neuro", "pain", "radiolog",
  "surgery", "surgical", "ambulatory", "physical therapy", "urgent care", "anesthes",
];
const MEDIUM_VALUE = ["family", "internal medicine", "pediatric", "ob", "gyn", "psych", "behavioral", "primary care", "podiatr", "chiropract"];

export interface ScoreInput {
  org: Pick<Organization, "specialty" | "ehr" | "size_estimate" | "website" | "entity_type">;
  hasDecisionMakerEmail: boolean;
  hasAnyContact: boolean;
  confidence?: number;
  painPoints?: number;
}

export function scoreLead(input: ScoreInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 10;
  const spec = (input.org.specialty ?? "").toLowerCase();
  if (HIGH_VALUE.some((s) => spec.includes(s))) { score += 25; reasons.push("High-complexity specialty (+25)"); }
  else if (MEDIUM_VALUE.some((s) => spec.includes(s))) { score += 12; reasons.push("Mid-complexity specialty (+12)"); }
  if (input.org.entity_type === "organization") { score += 8; reasons.push("Group / facility (+8)"); }
  if (input.org.website) { score += 5; reasons.push("Has website (+5)"); }
  if (input.org.ehr) { score += 6; reasons.push(`Known EHR: ${input.org.ehr} (+6)`); }
  const size = (input.org.size_estimate ?? "").toLowerCase();
  const n = parseInt(size.match(/\d+/)?.[0] ?? "0", 10);
  if (n >= 10) { score += 15; reasons.push("Larger practice (10+ providers) (+15)"); }
  else if (n >= 3) { score += 10; reasons.push("Multi-provider practice (+10)"); }
  else if (n >= 1) { score += 3; reasons.push("Small practice (+3)"); }
  if (input.hasDecisionMakerEmail) { score += 20; reasons.push("Decision-maker email found (+20)"); }
  else if (input.hasAnyContact) { score += 8; reasons.push("Contact found (+8)"); }
  if ((input.painPoints ?? 0) > 0) { score += Math.min(8, input.painPoints! * 3); reasons.push("Billing pain signals found (+)"); }
  if ((input.confidence ?? 0) >= 0.6) { score += 5; reasons.push("High research confidence (+5)"); }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}
