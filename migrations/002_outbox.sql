-- Transactional outbox and consumer ledger (durable events).
--
-- Every event (post.published, notification.created, comment.created) is inserted in the same
-- transaction as the row that caused it, so an event exists if and only if its row does. A relay
-- publishes unpublished rows to Redis Streams and marks them; consumers record what they have
-- processed, so an event delivered twice (relay retry, consumer crash before XACK) runs once.

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  event_id     text NOT NULL,
  type         text NOT NULL CHECK (type IN ('post.published', 'notification.created', 'comment.created')),
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT outbox_event_id UNIQUE (event_id)
);

-- The relay's work queue: unpublished events in commit order.
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
-- Pruning of published events.
CREATE INDEX outbox_published ON outbox (published_at) WHERE published_at IS NOT NULL;

CREATE TABLE processed_events (
  consumer     text NOT NULL,
  event_id     text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE INDEX processed_events_age ON processed_events (processed_at);
