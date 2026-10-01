-- Reusable email templates, configurable multi-step sequences, tags and saved views.
CREATE TABLE templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  subject    text NOT NULL,
  body       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- steps: [{ "delayDays": 0, "templateIds": ["uuid", ...] }]; templateIds absent/empty = AI-written; several ids = A/B test.
CREATE TABLE sequences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  steps      jsonb NOT NULL DEFAULT '[]',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sequences_one_default_idx ON sequences (is_default) WHERE is_default;
ALTER TABLE leads
  ADD COLUMN sequence_id     uuid REFERENCES sequences(id) ON DELETE SET NULL,
  ADD COLUMN sequence_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN tags            text[] NOT NULL DEFAULT '{}';
CREATE INDEX leads_tags_idx ON leads USING gin (tags);
ALTER TABLE messages
  ADD COLUMN template_id uuid REFERENCES templates(id) ON DELETE SET NULL,
  ADD COLUMN variant     text;
CREATE TABLE saved_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  filters    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
