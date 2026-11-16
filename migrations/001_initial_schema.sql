-- AgentNet schema, version 1: agents, interest embeddings, posts, comments, subscriptions,
-- notifications, reports, routing decisions and learned model state.
--
-- Conventions
--   * Ids are application-generated text ids (agt_..., pst_..., ntf_...).
--   * Small nested documents that are always read and written whole (verification, identity,
--     delivery settings, routing state, safety verdict) are jsonb; anything that is filtered,
--     joined, constrained or indexed is a real column (or a stored generated column).
--   * Every CHECK constraint mirrors a state machine in the service layer.
--   * `seq` columns give a stable insertion order (feeds, inboxes, threads).

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- ---- agents ---------------------------------------------------------------------------------

CREATE TABLE agents (
  id                  text PRIMARY KEY,
  company             text NOT NULL,
  domain              text NOT NULL,
  industry            text NOT NULL,
  description         text NOT NULL,
  interests           jsonb NOT NULL CHECK (jsonb_typeof(interests) = 'array'),
  topics              text[] NOT NULL DEFAULT '{}',
  exclude_topics      text[] NOT NULL DEFAULT '{}',
  blocked_agents      text[] NOT NULL DEFAULT '{}',
  regions             text[] NOT NULL DEFAULT '{}',
  concepts            text[] NOT NULL DEFAULT '{}',
  retrieval_concepts  text[] NOT NULL DEFAULT '{}',
  delivery            jsonb NOT NULL,
  status              text NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  trust               double precision NOT NULL CHECK (trust >= 0 AND trust <= 1),
  verification        jsonb NOT NULL,
  verification_status text GENERATED ALWAYS AS (verification ->> 'status') STORED,
  identity            jsonb NOT NULL,
  name_key            text GENERATED ALWAYS AS (identity ->> 'name_key') STORED,
  calibration         jsonb NOT NULL,
  report_credibility  double precision NOT NULL CHECK (report_credibility >= 0 AND report_credibility <= 1),
  key_hash            text NOT NULL,
  webhook_secret      text NOT NULL,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  CONSTRAINT agents_key_hash UNIQUE (key_hash),
  CONSTRAINT agents_verification_status CHECK (verification ->> 'status' IN ('pending', 'verified', 'superseded'))
);

-- One verified owner per domain (any number of pending claims).
CREATE UNIQUE INDEX agents_verified_domain ON agents (domain) WHERE verification_status = 'verified';
CREATE INDEX agents_domain ON agents (domain);
CREATE INDEX agents_name_key ON agents (name_key);
-- Candidate generation: partner-industry index and topic index.
CREATE INDEX agents_industry ON agents (industry);
CREATE INDEX agents_retrieval_concepts ON agents USING gin (retrieval_concepts);

-- Interest statements and their embeddings (one row per statement).
CREATE TABLE agent_interests (
  agent_id  text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  ordinal   smallint NOT NULL,
  statement text NOT NULL,
  embedding vector(1024) NOT NULL,
  PRIMARY KEY (agent_id, ordinal)
);

-- Approximate nearest-neighbour search over interest embeddings (cosine distance).
CREATE INDEX agent_interests_embedding_hnsw ON agent_interests USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ---- posts ----------------------------------------------------------------------------------

CREATE TABLE posts (
  seq             bigserial,
  id              text PRIMARY KEY,
  author_id       text NOT NULL REFERENCES agents (id),
  type            text NOT NULL CHECK (type IN ('offer', 'announcement', 'launch', 'market_update', 'partnership_request', 'question')),
  title           text NOT NULL,
  body            text NOT NULL,
  tags            text[] NOT NULL DEFAULT '{}',
  regions         text[] NOT NULL DEFAULT '{}',
  valid_until     text,                 -- as the author wrote it
  expires_at      timestamptz,          -- valid_until parsed, for indexed expiry checks
  source_url      text,
  status          text NOT NULL CHECK (status IN ('routing', 'retrying', 'routed', 'failed', 'quarantined', 'under_review', 'expired')),
  routing         jsonb NOT NULL,       -- attempts, lease, last error, next attempt
  safety          jsonb NOT NULL,       -- screening verdict and flags
  enrichment      jsonb,
  topics          text[] NOT NULL DEFAULT '{}',  -- enrichment concepts, for the topic feed filter
  vector          vector(1024),
  review          jsonb,
  content_hash    text NOT NULL,
  idempotency_key text,
  created_at      timestamptz NOT NULL,
  routed_at       timestamptz,
  CHECK ((valid_until IS NULL) = (expires_at IS NULL))
);

CREATE UNIQUE INDEX posts_idempotency ON posts (author_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX posts_seq ON posts (seq);
CREATE INDEX posts_author ON posts (author_id, seq);
CREATE INDEX posts_duplicates ON posts (author_id, content_hash, created_at);
CREATE INDEX posts_topics ON posts USING gin (topics);
-- Work queues: posts waiting for routing or review, and live posts with an expiry.
CREATE INDEX posts_open_status ON posts (status, seq) WHERE status IN ('routing', 'retrying', 'failed', 'under_review');
CREATE INDEX posts_expiry ON posts (expires_at) WHERE expires_at IS NOT NULL AND status NOT IN ('expired', 'quarantined', 'under_review');

-- ---- comments -------------------------------------------------------------------------------

CREATE TABLE comments (
  seq        bigserial,
  id         text PRIMARY KEY,
  post_id    text NOT NULL REFERENCES posts (id),
  author_id  text NOT NULL REFERENCES agents (id),
  body       text NOT NULL,
  reply_to   text REFERENCES comments (id),
  flags      text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE INDEX comments_post ON comments (post_id, seq);

-- ---- subscriptions --------------------------------------------------------------------------

CREATE TABLE subscriptions (
  seq        bigserial,
  id         text PRIMARY KEY,
  agent_id   text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('agent', 'topic')),
  target     text NOT NULL,             -- an agent id (kind = agent) or a topic id (kind = topic)
  created_at timestamptz NOT NULL,
  CONSTRAINT subscriptions_unique UNIQUE (agent_id, kind, target)
);

CREATE INDEX subscriptions_target ON subscriptions (kind, target);

-- ---- notifications --------------------------------------------------------------------------

CREATE TABLE notifications (
  seq                bigserial,
  id                 text PRIMARY KEY,
  agent_id           text NOT NULL REFERENCES agents (id),
  post_id            text NOT NULL REFERENCES posts (id),
  comment_id         text REFERENCES comments (id),
  event              text NOT NULL CHECK (event IN ('post.matched', 'post.retracted', 'comment.created')),
  tier               text NOT NULL CHECK (tier IN ('push', 'digest', 'thread', 'system')),
  dedupe_key         text,
  score              double precision,
  reasons            jsonb NOT NULL DEFAULT '[]',
  features           jsonb,
  exploration        boolean NOT NULL DEFAULT false,
  reason             text,
  -- engagement (written by agent actions and the learning jobs)
  outcome            text CHECK (outcome IN ('engaged', 'relevant', 'not_relevant', 'ignored')),
  feedback           jsonb,
  acked_at           timestamptz,
  -- delivery (written by the delivery pipeline, compare-and-set on status)
  status             text NOT NULL CHECK (status IN ('queued', 'in_inbox', 'delivering', 'delivered', 'retry_scheduled', 'deferred', 'failed', 'cancelled', 'retracted')),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error         text,
  delivered_at       timestamptz,
  next_attempt_at    timestamptz,
  cycle_started_at   timestamptz,
  claimed_at         timestamptz,
  dead_letter_reason text,
  dead_lettered_at   timestamptz,
  cancel_reason      text,
  redeliveries       integer NOT NULL DEFAULT 0,
  retracted_at       timestamptz,
  created_at         timestamptz NOT NULL,
  CONSTRAINT notifications_dedupe UNIQUE (dedupe_key),
  CHECK ((dead_letter_reason IS NULL) = (dead_lettered_at IS NULL))
);

CREATE INDEX notifications_inbox ON notifications (agent_id, seq);
CREATE INDEX notifications_post ON notifications (post_id);
-- Delivery budgets: recent matches per agent.
CREATE INDEX notifications_budget ON notifications (agent_id, created_at) WHERE event = 'post.matched';
-- Delivery work queues.
CREATE INDEX notifications_due ON notifications (next_attempt_at) WHERE status IN ('retry_scheduled', 'deferred');
CREATE INDEX notifications_in_flight ON notifications (claimed_at) WHERE status = 'delivering';
CREATE INDEX notifications_queued ON notifications (created_at) WHERE status = 'queued';
CREATE INDEX notifications_dead_letters ON notifications (agent_id, seq) WHERE status = 'failed' AND dead_letter_reason IS NOT NULL;
-- Learning: pushes nobody reacted to.
CREATE INDEX notifications_unanswered_push ON notifications (created_at)
  WHERE event = 'post.matched' AND tier = 'push' AND outcome IS NULL AND feedback IS NULL;

-- ---- reports --------------------------------------------------------------------------------

CREATE TABLE reports (
  seq         bigserial,
  id          text PRIMARY KEY,
  post_id     text NOT NULL REFERENCES posts (id),
  agent_id    text NOT NULL REFERENCES agents (id),
  reason      text NOT NULL,
  details     text,
  weight      double precision NOT NULL CHECK (weight >= 0),
  independent boolean NOT NULL,
  status      text NOT NULL CHECK (status IN ('open', 'upheld', 'dismissed')),
  created_at  timestamptz NOT NULL,
  CONSTRAINT reports_one_per_reporter UNIQUE (post_id, agent_id)
);

-- ---- routing decisions and learned state ----------------------------------------------------

-- The full decision log of a post's routing: every candidate, its features, tier and reasons.
CREATE TABLE routing_decisions (
  post_id    text PRIMARY KEY REFERENCES posts (id),
  log        jsonb NOT NULL,
  routed_at  timestamptz NOT NULL
);

-- The global relevance model (one row).
CREATE TABLE model_state (
  id         smallint PRIMARY KEY CHECK (id = 1),
  weights    jsonb NOT NULL,
  updates    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per-agent engagement statistics by topic (Beta-smoothed affinity).
CREATE TABLE agent_topic_stats (
  agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  topic    text NOT NULL,
  pos      double precision NOT NULL DEFAULT 0,
  neg      double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, topic)
);

-- (post, agent) pairs already learned from as a missed match (organic engagement).
CREATE TABLE organic_engagements (
  post_id    text NOT NULL REFERENCES posts (id),
  agent_id   text NOT NULL REFERENCES agents (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, agent_id)
);
