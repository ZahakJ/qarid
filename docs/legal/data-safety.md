# Data kept by a قريض deployment

The privacy page (`#/privacy`, `client/views/PrivacyView.tsx`) says the same in
Arabic. Everything below lives in `USERS_DB_PATH`; the corpus database holds no
user data.

| Data | Required | Notes |
|---|---|---|
| Username | yes | also the public `#/u/<name>` handle |
| Password | yes | scrypt hash only |
| Recovery code | yes | scrypt hash only, shown once |
| Display name | no | |
| Avatar | no | stored as uploaded |
| Duel stats, ترسانة snapshot | no | the snapshot only if the reader publishes it |
| Room and match history | — | created by playing a room |
| IP address | — | read per request for rate limiting (`server/ratelimit.ts`), not stored |

Nothing is shared with third parties: no ads, no analytics, no email.

Deletion is self-serve and immediate, at `#/u/<name>` → «احذف حسابي», in the app
and on the web. It removes the account, sessions, tokens, avatar, published
ترسانة and match history; finished matches keep their text under «لاعب محذوف».

Before publishing a deployment, fill `OPERATOR_CONTACT`,
`OPERATOR_JURISDICTION` and `POLICY_EFFECTIVE` in `PrivacyView.tsx`.
