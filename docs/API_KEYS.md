# API keys

An API key lets a script, an integration or an AI agent use a Scout workspace without a
password. Send it as `x-api-key: px_live_...`. Keys are managed under Settings > API keys by
workspace owners and admins.

## What a key is

- `px_live_` followed by 43 base64url characters: 32 random bytes (256 bits). Keys issued
  before this release carry 24 bytes; they keep working, because a key is looked up by the
  SHA-256 of the whole string and nothing caps its length.
- Only the hash is stored. The key itself is shown once, when it is created or rotated, and
  never again. The first 12 characters (the prefix) are kept to tell keys apart in the list,
  the security log and the notice email.
- Access is `full` (the default) or `read`. A read-only key may only make GET and HEAD
  requests; anything else answers `403 insufficient_scope`.

## When a key works

A key is accepted when it has not been revoked and either has no expiry or its expiry is
still ahead. An expired key, a revoked key and a key that never existed all get the same
`401 unauthorized`, so the answer does not say whether a key once worked.

The list (`GET /v1/auth/api-keys`) gives each key a `status`:

| status     | meaning                                   |
|------------|-------------------------------------------|
| `active`   | works; no expiry, or more than 7 days left |
| `expiring` | works; expires within 7 days              |
| `expired`  | its expiry has passed                     |
| `revoked`  | revoked by a person, or replaced at once by a rotation |

## Creating a key

`POST /v1/auth/api-keys` (owner or admin, signed in as a person)

```json
{ "name": "CI", "scope": "read", "expiresInDays": 90 }
```

`expiresInDays` is 1 to 730. Leave it out (or send `null`) for a key that never expires, which
is what every key made before expiry existed is. The answer carries `expiresAt` and the key.

## Rotating a key

`POST /v1/auth/api-keys/:id/rotate` (owner or admin, signed in as a person)

```json
{ "overlapMinutes": 60 }
```

- A new key is made with the same name and access, linked to the old one (`rotatedFromId`),
  and returned once.
- `overlapMinutes` (0 to 1440, default 0) is how long the old key keeps working, so a
  deployment can switch keys without a gap. 0 revokes the old key at once. An overlap never
  extends a key that was due to expire sooner.
- The new key's expiry is `expiresInDays` when given. Otherwise it follows the old key: a key
  that never expired is replaced by one that never expires, and one that had an expiry is
  replaced by one with the same lifetime, counted from now.
- Only a key that still works can be rotated (`409 api_key_not_active` otherwise), and only
  once while its replacement is live (`409 api_key_already_rotated`).
- A rotation is not refused at the workspace's key limit: the old key is retired by the same
  request.
- Another workspace's key, or an id that does not exist, answers `404`.

The security log records `apikey.rotated` with both prefixes (never a key), and the person
who rotated it gets the same notice email as for a created key.

## Revoking a key

`DELETE /v1/auth/api-keys/:id` stops the key at once. It cannot be undone.

## From the SDK

```ts
const created = await scout.auth.createApiKey("CI", { scope: "read", expiresInDays: 90 });
const { apiKeys } = await scout.auth.listApiKeys();
const next = await scout.auth.rotateApiKey(created.id, { overlapMinutes: 60 });
await scout.auth.revokeApiKey(next.id);
```

## Rolling back

The previous release does not know about expiry, so after a rollback an expired key works
again until it is revoked. Revoke keys you want stopped rather than
relying on their expiry across a rollback.
