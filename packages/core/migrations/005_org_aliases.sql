-- "Doing business as" names from the registry: the public brand a practice's website is usually named after.
ALTER TABLE organizations ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';
