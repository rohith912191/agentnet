-- Hard routing filter: an agent never receives posts from authors in these industries
-- (for example, a company that does not want to hear from its competitors' sector).
-- Applied with the other eligibility filters, before scoring.

ALTER TABLE agents ADD COLUMN blocked_industries text[] NOT NULL DEFAULT '{}';
