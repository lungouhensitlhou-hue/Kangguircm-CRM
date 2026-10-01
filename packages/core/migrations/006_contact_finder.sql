-- Contact finder: where an email came from, how sure we are, and learned per-domain address patterns.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_email_status_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_email_status_check CHECK (email_status IN ('unverified','verified','risky','bounced','invalid'));
ALTER TABLE contacts
  ADD COLUMN email_source text NOT NULL DEFAULT 'published' CHECK (email_source IN ('published','pattern')),
  ADD COLUMN email_confidence smallint NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN website_confidence smallint;
CREATE TABLE email_patterns (
  domain     text NOT NULL,
  pattern    text NOT NULL,
  hits       integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, pattern)
);
