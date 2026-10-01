-- Zoho-style basics: follow-up tasks and deals (revenue pipeline).
CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid REFERENCES leads(id) ON DELETE CASCADE,
  title        text NOT NULL,
  kind         text NOT NULL DEFAULT 'other' CHECK (kind IN ('call','email','review','research','other')),
  due_at       timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  notes        text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'manual',
  created_by   text NOT NULL DEFAULT 'system',
  dedupe_key   text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX tasks_open_due_idx ON tasks (due_at) WHERE status = 'open';
CREATE INDEX tasks_lead_idx ON tasks (lead_id);

CREATE TABLE deals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  name           text NOT NULL,
  value_usd      numeric(12,2) NOT NULL DEFAULT 0 CHECK (value_usd >= 0),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  expected_close date,
  notes          text NOT NULL DEFAULT '',
  source         text NOT NULL DEFAULT 'manual',
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);
-- at most one OPEN deal per lead
CREATE UNIQUE INDEX deals_one_open_idx ON deals (lead_id) WHERE status = 'open';
CREATE INDEX deals_status_idx ON deals (status);
