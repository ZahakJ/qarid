# المساجلة بلا حساب — `#/match/<CODE>`

Two people, two devices, no accounts. Same rules and verifier as the account
rooms (`/api/room`); a seat secret stands in for the sign-in.

## Credentials

| what | where it lives | strength | server keeps |
|---|---|---|---|
| code | spoken, in every URL | 6 letters (`BADIRU`) | plain |
| invite key | share link `#/match/<CODE>?k=<key>` | 120 bits | SHA-256 |
| seat secret | client localStorage `qarid:match:<CODE>` | 130 bits | SHA-256 |

Secrets are CSPRNG over a 32-symbol alphabet and compared as digests in
constant time. The seat travels as `X-Match-Seat` (HTTP) and as the WebSocket
subprotocol `qarid.seat.<secret>` (a WebView cannot set upgrade headers); never
in a URL. The invite key is spent when the guest sits.

## Endpoints

```
POST /api/match                 {name?, mode, timerS?, strikes, baitId?} → {state, secret, joinKey, shareUrl}
GET  /api/match/:code/state     seat → {state}            (the poller)
POST /api/match/:code/join      {key, name?} → {state, secret}
POST /api/match/:code/knock     {name?} → {knock, secret}  (code only; host decides)
GET  /api/match/:code/knock     knock secret → {knock}     (pending | accepted | rejected)
POST /api/match/:code/admit     host seat → {state}
POST /api/match/:code/refuse    host seat → {state}
POST /api/match/:code/turn      seat, {text} → {verdict, state}
POST /api/match/:code/resign    seat → {state}
GET  /ws/match/:code            subprotocol qarid.seat.<secret>
```

Socket events (`shared/match.ts`): `state`, `join`, `turn`, `verdict` (the
sender's own), `end`, `error`. Every one but `error` is the full snapshot for
that seat, with `rev`; a client keeps the highest `rev` it has seen.
Commands: `turn`, `state`, `ping`.

## States

```
waiting ──join / admit──▶ active ──strikes / timeout / resign / 400-بيت cap──▶ done
   └──expiry (30 min) / host closes──────────────────────────────────────────▶ done
```

- Turn order is chain parity: opening (host) → guest → host…; a strike
  (`wrong_letter`, `not_found`) keeps the turn and re-arms the clock. Other
  refusals change nothing.
- Deadlines are timestamps in the record, resolved on every read and by a
  per-match timer. A dropped socket forfeits nothing.
- An active match with no clock and no activity for 24 h closes without a
  winner; a done match is purged 24 h after it ended (sweep every minute).

## Code

- `server/match/machine.ts` — pure transitions (`now`, `rng` injected).
- `server/match/service.ts` — corpus, store, sockets, timers.
- `server/match/store.ts` — memory (tests) or SQLite at `MATCHES_DB_PATH`
  (default `data/qarid-matches.db`); one JSON row per match.
- `server/routes/match.ts` — HTTP + WebSocket; per-IP buckets for reads,
  creates, knocks and turns; per-seat bucket for socket frames.
- `client/match/` — store, view, entry dialog.
