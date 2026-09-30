-- Kangguircm RCM command center: initial schema.
-- NOTE: this database is intentionally PHI-free (lead-generation data only).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  npi           text UNIQUE,
  name          text NOT NULL,
  entity_type   text NOT NULL DEFAULT 'organization' CHECK (entity_type IN ('organization','individual')),
  specialty     text,
  address       text,
  city          text,
  state         text,
  zip           text,
  phone         text,
  website       text,
  ehr           text,
  size_estimate text,
  source        text NOT NULL DEFAULT 'manual',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizations_state_idx ON organizations (state);
CREATE INDEX organizations_specialty_idx ON organizations (lower(specialty));
CREATE UNIQUE INDEX organizations_name_loc_idx ON organizations (lower(name), lower(coalesce(city,'')), lower(coalesce(state,'')));

CREATE TABLE contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  full_name         text,
  title             text,
  email             text,
  email_status      text NOT NULL DEFAULT 'unverified' CHECK (email_status IN ('unverified','verified','bounced','invalid')),
  phone             text,
  is_decision_maker boolean NOT NULL DEFAULT false,
  source            text NOT NULL DEFAULT 'manual',
  source_url        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_org_email_idx ON contacts (organization_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX contacts_email_idx ON contacts (lower(email));

CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  stage           text NOT NULL DEFAULT 'new' CHECK (stage IN
                    ('new','researching','researched','outreach_drafted','contacted','replied','meeting','won','lost','disqualified')),
  score           integer NOT NULL DEFAULT 0,
  score_reasons   jsonb NOT NULL DEFAULT '[]',
  notes           text NOT NULL DEFAULT '',
  next_action_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_stage_idx ON leads (stage);
CREATE INDEX leads_score_idx ON leads (score DESC);

CREATE TABLE research_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  summary         text NOT NULL DEFAULT '',
  ehr             text,
  size_estimate   text,
  specialties     jsonb NOT NULL DEFAULT '[]',
  pain_points     jsonb NOT NULL DEFAULT '[]',
  decision_makers jsonb NOT NULL DEFAULT '[]',
  sources         jsonb NOT NULL DEFAULT '[]',
  confidence      numeric(3,2) NOT NULL DEFAULT 0,
  method          text NOT NULL DEFAULT 'heuristic',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_profiles_lead_idx ON research_profiles (lead_id, created_at DESC);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  direction           text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  step                integer NOT NULL DEFAULT 1,
  to_email            text,
  subject             text NOT NULL DEFAULT '',
  body                text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','sent','failed','received','cancelled')),
  unsub_token         text UNIQUE,
  provider            text,
  provider_message_id text,
  error               text,
  approved_by         text,
  approved_at         timestamptz,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_lead_idx ON messages (lead_id, created_at);
CREATE INDEX messages_status_idx ON messages (status);

CREATE TABLE suppressions (
  email      text PRIMARY KEY,
  reason     text NOT NULL DEFAULT 'unsubscribe',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- agent_runs doubles as the durable job queue (claimed with FOR UPDATE SKIP LOCKED).
CREATE TABLE agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  input           jsonb NOT NULL DEFAULT '{}',
  output          jsonb,
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  parent_id       uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  run_at          timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  locked_by       text,
  error           text,
  tokens_in       integer NOT NULL DEFAULT 0,
  tokens_out      integer NOT NULL DEFAULT 0,
  cost_usd        numeric(10,4) NOT NULL DEFAULT 0,
  created_by      text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX agent_runs_queue_idx ON agent_runs (run_at) WHERE status = 'queued';
CREATE INDEX agent_runs_lead_idx ON agent_runs (lead_id);
CREATE INDEX agent_runs_created_idx ON agent_runs (created_at DESC);

CREATE TABLE agent_events (
  id         bigserial PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  type       text NOT NULL,
  message    text NOT NULL DEFAULT '',
  data       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_events_run_idx ON agent_events (run_id, id);

CREATE TABLE chat_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  text NOT NULL DEFAULT 'default',
  role       text NOT NULL CHECK (role IN ('user','assistant')),
  content    text NOT NULL,
  run_id     uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_thread_idx ON chat_messages (thread_id, created_at);

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  data       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
