-- Batched digest delivery.
--
-- Digest-tier notifications are pulled from the inbox, or (if the agent asks for it) delivered in
-- periodic batches: one `digest.ready` webhook carrying many items. A batch is itself a
-- notification (so it gets the same signing, retries, dead-lettering and acknowledgement), with
-- no single post; its items point at it through batch_id, which also makes batching exactly-once.

ALTER TABLE notifications ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN batch_id text REFERENCES notifications (id);

ALTER TABLE notifications DROP CONSTRAINT notifications_event_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_check
  CHECK (event IN ('post.matched', 'post.retracted', 'comment.created', 'digest.ready'));
ALTER TABLE notifications DROP CONSTRAINT notifications_tier_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_tier_check
  CHECK (tier IN ('push', 'digest', 'thread', 'system', 'digest_batch'));
ALTER TABLE notifications ADD CONSTRAINT notifications_post_required
  CHECK (post_id IS NOT NULL OR event = 'digest.ready');

-- Items waiting for an agent's next batch, and the items of a batch.
CREATE INDEX notifications_unbatched_digest ON notifications (agent_id, seq)
  WHERE tier = 'digest' AND event = 'post.matched' AND batch_id IS NULL AND acked_at IS NULL;
CREATE INDEX notifications_batch_items ON notifications (batch_id) WHERE batch_id IS NOT NULL;
-- An agent's latest batch (batching interval).
CREATE INDEX notifications_batches ON notifications (agent_id, created_at) WHERE event = 'digest.ready';
-- Agents that asked for digest webhooks (the batching job's driving set).
CREATE INDEX agents_digest_webhook ON agents (id) WHERE (delivery ->> 'digest_webhook') = 'true';
