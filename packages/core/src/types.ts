export const STAGES = [
  "new",
  "researching",
  "researched",
  "outreach_drafted",
  "contacted",
  "replied",
  "meeting",
  "won",
  "lost",
  "disqualified",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  researching: "Researching",
  researched: "Researched",
  outreach_drafted: "Draft ready",
  contacted: "Contacted",
  replied: "Replied",
  meeting: "Meeting",
  won: "Won",
  lost: "Lost",
  disqualified: "Disqualified",
};

export type RunKind = "discover" | "research" | "outreach" | "send" | "chat" | "sweep" | "smoke" | "reply" | "contacts";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Organization {
  id: string;
  npi: string | null;
  name: string;
  entity_type: "organization" | "individual";
  specialty: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  website: string | null;
  ehr: string | null;
  size_estimate: string | null;
  website_confidence?: number | null;
  aliases: string[];
  source: string;
}

export interface Contact {
  id: string;
  organization_id: string;
  full_name: string | null;
  title: string | null;
  email: string | null;
  email_status: string;
  email_source: "published" | "pattern";
  email_confidence: number;
  phone: string | null;
  is_decision_maker: boolean;
  source: string;
  source_url: string | null;
}

export interface Lead {
  id: string;
  organization_id: string;
  stage: Stage;
  score: number;
  score_reasons: string[];
  notes: string;
  tags: string[];
  sequence_id: string | null;
  sequence_paused: boolean;
  next_action_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRun {
  id: string;
  kind: RunKind;
  status: RunStatus;
  input: Record<string, any>;
  output: Record<string, any> | null;
  lead_id: string | null;
  parent_id: string | null;
  attempts: number;
  max_attempts: number;
  run_at: string;
  idempotency_key: string | null;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Message {
  id: string;
  lead_id: string;
  contact_id: string | null;
  direction: "outbound" | "inbound";
  step: number;
  to_email: string | null;
  subject: string;
  body: string;
  status: "draft" | "approved" | "rejected" | "sent" | "failed" | "received" | "cancelled";
  unsub_token: string | null;
  template_id: string | null;
  variant: string | null;
  classification: string | null;
  meta: Record<string, any>;
  provider: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  first_opened_at: string | null;
  open_count: number;
  error: string | null;
  approved_by: string | null;
  sent_at: string | null;
  created_at: string;
}
