-- Delivery + engagement tracking. Opens are self-hosted (pixel), provider events cover delivery/bounce/complaint.
ALTER TABLE messages
  ADD COLUMN delivered_at    timestamptz,
  ADD COLUMN bounced_at      timestamptz,
  ADD COLUMN first_opened_at timestamptz,
  ADD COLUMN open_count      integer NOT NULL DEFAULT 0;

CREATE TABLE email_events (
  id         bigserial PRIMARY KEY,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  provider   text NOT NULL,
  type       text NOT NULL,
  email      text,
  detail     text,
  dedupe_key text UNIQUE,
  meta       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_events_msg_idx ON email_events (message_id, created_at);
CREATE INDEX messages_provider_id_idx ON messages ((trim(both '<>' from provider_message_id))) WHERE provider_message_id IS NOT NULL;
