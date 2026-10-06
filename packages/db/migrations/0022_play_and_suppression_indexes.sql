-- Two indexes found missing in review. Additive.

-- play_candidates.run_id is ON DELETE SET NULL: without an index every deleted run (a play
-- being deleted, a workspace purge, run retention) scanned the whole candidates table.
CREATE INDEX IF NOT EXISTS play_candidates_run_idx ON play_candidates (run_id) WHERE run_id IS NOT NULL;

-- The platform-wide do-not-contact list is matched by mailbox: the address with any "+tag"
-- removed. That expression is evaluated for every import row, candidate and send, and had no
-- index to use.
CREATE INDEX IF NOT EXISTS global_suppressions_base_idx ON global_suppressions ((regexp_replace(email, '^([^+@]+)\+[^@]*@', '\1@')));
