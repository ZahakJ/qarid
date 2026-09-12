# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private reporting — the **Security** tab → *Report a
vulnerability* — which opens a channel visible only to the maintainers.

Tell us what you can: what you did, what happened, and what you think an
attacker gets from it. A rough report of something real is far more useful than
a polished report of nothing. If you have a proof of concept, include it; if
you would rather describe the class of problem than hand over a working
exploit, that is fine too.

You should get an acknowledgement within a week. If a fix is warranted we will
tell you when it ships, and credit you unless you would rather we did not.

## What is in scope

This is a self-hosted application, so "in scope" means a defect in **this
code** that a deployment cannot configure its way out of. Most usefully:

- **Anything that writes to the corpus artefact.** It is opened read-only and a
  stray write should throw; a path that gets around that is a real bug.
- **Cross-account access** through the accounts database — reading, changing or
  deleting another reader's دواوين, profile or sessions.
- **Authentication and session handling**: password verification, the recovery
  code flow, cookie/bearer token issuance, session revocation on password
  change.
- **The CSRF and origin model.** The server refuses cross-site requests from
  sibling subdomains and allowlists exactly three Capacitor WebView origins —
  a way past that gate is in scope.
- **The مساجلة room protocol.** A match is decided entirely server-side
  precisely so a client cannot lie about a بيت; a client-driven way to score,
  to see the opponent's بيت early, or to join a room without its key is a bug.
- **Injection** anywhere the scraped corpus reaches a query, a template or an
  HTML attribute. The corpus is scraped text and is treated as untrusted.
- **Stored XSS** through anything a reader types: a ديوان title or description,
  a display name, a profile.

## What is not

- A deployment that has not set `PUBLIC_ORIGIN`, or that exposes the server
  directly instead of behind TLS. The server binds loopback by design.
- Anything requiring an attacker to already hold your session cookie, bearer
  token, recovery code or signing keystore.
- Rate limits tuned to your own taste. They are in-memory and per-process by
  design; a deployment behind several processes should put a limiter in front.
- Denial of service by asking for very large pages. Limits are enforced, and
  the corpus is 1.6 GB of read-only SQLite — slow is not the same as insecure.
- Vulnerabilities in the corpus dataset itself, which this project ingests and
  does not vouch for.

## No bounty

There is no money here. This is one person's side project, published so others
can read it and run it. Credit and thanks are what is on offer.
