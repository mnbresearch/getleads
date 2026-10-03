-- Accounts created by "Sign in with Google" before email verification was tracked.
--
-- Google had already verified those addresses, but nothing recorded it: the only trace is
-- the workspace's `org.created` event (via = google). Events are pruned after 90 days, after
-- which such an account would be indistinguishable from one registered with a password by
-- someone who never proved they own the address - and the next Google sign-in would treat
-- it as that (password disabled, sessions and API keys revoked). Record the fact on the user
-- row now, while the evidence still exists.
UPDATE users u
SET email_verified_at = COALESCE(u.email_verified_at, u.created_at)
FROM events e
WHERE e.org_id = u.org_id
  AND e.type = 'org.created'
  AND e.data->>'via' = 'google'
  AND lower(e.data->>'email') = lower(u.email)
  AND u.email_verified_at IS NULL;
