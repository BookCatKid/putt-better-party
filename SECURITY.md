# Security policy

This is an independent, self-hosted project. It is maintained by one person, on
their own time, and it ships no warranty. That shapes what follows: the reporting
channel is deliberately simple, and the scope is stated honestly rather than
expanded to sound thorough.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting on this repository** — the
_Security_ tab, then _Report a vulnerability_. It is a private channel, it keeps
the discussion attached to the code, and it does not depend on an email address
staying current.

If that form is unavailable, open an issue that says only that you have a security
report and asks for a private channel. **Do not put the details in the issue.**
Issue threads are public once the repository is public, and an issue is not a
disclosure mechanism.

Please include what you can:

- What the problem is, and which part of the service it affects.
- The smallest set of steps that reproduces it.
- What an attacker gains, and what they need first (a room code, a valid join, a
  configured admin hash, direct network access).
- The commit or version from `/health`, if you have one.

## What to expect

There is no support contract and no response-time guarantee. In practice:

- An acknowledgement within about a week.
- An assessment of whether it is in scope and how serious it is.
- A fix committed to `main`, or an explanation of why it will not be fixed.

You will be credited in the changelog if you want to be. If you would rather stay
anonymous, say so and that will be respected.

Please give a reasonable window before publishing. This is a hobby project with a
single maintainer, not a company with an on-call rotation, and a same-day public
writeup mostly guarantees that nobody has looked at it yet.

## Scope

**In scope** — problems in this project's own code:

- Authentication or authorisation failures: acting as another player, acting as
  host without the host token, reaching the admin API without the hash, or
  joining a locked or full room.
- Cross-room or cross-player data exposure: a frame, projection, log record or API
  response carrying a credential or another player's private state.
- Host and origin enforcement: bypassing the allowlist, spoofing a `Host` or
  `Origin`, or using a forwarded header to change what the server believes.
- Denial of service through the service's own surfaces: an unbounded request, an
  amplification, or work that one connection can queue without limit.
- Injection into the database, the event log or the filesystem.
- Stored-state attacks: a checkpoint that is accepted and then causes code
  execution, or a corrupt row that crashes the service instead of being refused.

**Out of scope** — not because they do not matter, but because they are known and
documented:

- **The game client's physics.** Scores are client-reported; the server does not
  simulate shots, so a modified client can report any score it likes. This is an
  architectural limitation recorded in the changelog, not a vulnerability
  disclosure. Do not report it as one.
- **The original game's assets and code.** They belong to their rights holders.
  Report those to the rights holder, not here.
- **putt.day itself.** This project reads its public catalog. A problem in that
  service is theirs to fix; report it to them.
- **Anything requiring a compromised host.** If an attacker already has shell
  access, or can read the database file, the room credentials are theirs. That is
  a hosting problem.
- **Missing hardening headers with no demonstrated impact**, or a scanner finding
  with no exploit path. A report is more useful with a concrete consequence.

## What is already protected

The following are enforced and tested, so a report that one of them is _absent_
should come with evidence that the test is wrong:

| Property           | Behaviour                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Default exposure   | Binds to `127.0.0.1`, so nothing off the machine is reachable                                                                             |
| Proxied deployment | A configured public origin becomes the **only** origin answered; direct loopback gets `403`                                               |
| Origin checks      | Exact match on `Host` and `Origin`, never prefix or suffix                                                                                |
| Forwarded headers  | Never trusted, because without a configured proxy a client can set them                                                                   |
| CORS               | No `Access-Control-*` header on any response, including `OPTIONS`                                                                         |
| Message budgets    | Per-connection token buckets: 120 burst at 60/s, scoreboard 10 burst at 4/s                                                               |
| Upload bounds      | 1 MB JSON body, 2 MB relayed response, 100-course saved playlist, 64 waiting previews                                                     |
| Stored state       | Checkpoints are validated before restore; a corrupt or hostile row is refused                                                             |
| Admin              | Disabled unless a hash is set; **5 login attempts per 60 s**, 8-hour session, `HttpOnly` `SameSite=Strict` cookie, `Secure` only on HTTPS |
| Secrets in transit | No frame, projection or log record carries a session secret or another player's credential                                                |
| Transport headers  | HSTS, frame policy and permissions policy applied once at the edge; HSTS only on an HTTPS deployment                                      |

Verified just now, for reference: a proxied deployment answers `403` to a loopback
`Host` and `200` to its configured origin, and the admin API answers `503` when no
hash is configured.

## If you are deploying this

Most real-world risk is in the deployment, not the code:

- Put a TLS-terminating proxy in front and set `BP_PUBLIC_ORIGIN`. That is what
  makes the proxy authoritative rather than decorative.
- Keep the database and the event log private. They contain room credentials.
- Generate the admin hash with `Bun.password.hash`; never store the password.
- Do not set `BP_TEST_FAIL_MAP_FETCH_CALL` in anything real. It breaks course
  loading on purpose.
- Read the [configuration reference](docs/configuration.md) and the
  [operations guide](docs/operations.md); the security-relevant defaults and the
  reasons for them are there.

## A note on the archive

`private-client/` holds the original game client, archived for private
development. It is not licensed by this project. Do not redistribute it, do not
make this repository public, and do not publish a deployment, without permission
from the rights holders. A vulnerability in that code is not this project's to fix
— but if this project's handling of it creates a problem, that _is_ in scope.
