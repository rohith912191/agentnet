-- "Brands": verified, active agents whose own domain confirms a distinctive company name, not under
-- identity review. Every domain verification compares the new domain against them (look-alike
-- check), and post screening indexes their names. Without this index each verification scanned
-- every agent (found by the 100K-agent benchmark); with it, the cost follows the number of brands.
-- The predicate must stay identical to PostgresRepository.brandCandidates() for the planner to use it.

CREATE INDEX agents_brands ON agents (id)
  WHERE status = 'active'
    AND verification_status = 'verified'
    AND (identity ->> 'name_matches_domain') = 'true'
    AND COALESCE(identity ->> 'name_conflict', 'false') <> 'true'
    AND COALESCE(identity ->> 'review', '') NOT IN ('pending', 'rejected')
    AND (identity ->> 'distinctive') = 'true';
