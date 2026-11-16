-- Human review of suspicious company identities, and per-agent learning budgets.
--
-- A verified agent whose domain imitates another verified company's (hdfcbank-rewards.example,
-- phonepay.example) or whose domain confirms a name another domain also confirms is queued for a
-- moderator. Until approved, its name is not shown as verified and its posts are digest-only.

CREATE TABLE identity_reviews (
  seq           bigserial,
  id            text PRIMARY KEY,
  agent_id      text NOT NULL REFERENCES agents (id),
  kind          text NOT NULL CHECK (kind IN ('lookalike_domain', 'shared_name')),
  status        text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  details       jsonb NOT NULL,
  created_at    timestamptz NOT NULL,
  decided_at    timestamptz,
  decision_note text,
  CHECK ((status = 'pending') = (decided_at IS NULL))
);

-- One open review per agent and kind; the moderators' queue.
CREATE UNIQUE INDEX identity_reviews_open ON identity_reviews (agent_id, kind) WHERE status = 'pending';
CREATE INDEX identity_reviews_queue ON identity_reviews (status, seq);

-- How much this agent's feedback has moved the shared relevance model today (feedback poisoning cap).
ALTER TABLE agents ADD COLUMN learning_budget jsonb;
