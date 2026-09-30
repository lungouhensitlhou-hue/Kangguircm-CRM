-- Reply intelligence: classify inbound replies and keep structured extraction next to the message.
ALTER TABLE messages ADD COLUMN classification text;
ALTER TABLE messages ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
CREATE INDEX messages_class_idx ON messages (classification) WHERE classification IS NOT NULL;
