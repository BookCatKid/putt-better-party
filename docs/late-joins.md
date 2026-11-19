# Late admission and disconnects

Who may join a party that has already started, and what a disconnect means. This is
server policy, chosen here and pinned by `tests/late-joins.test.js`; the original
client only renders the roster and the spectator reason the server sends.

## The three policies

The host picks one in the lobby. They differ in exactly one thing: _when_ a newcomer
becomes a player. None of them can alter a score that already exists.

| Policy      | During countdown        | During play, before the deadline | During play, after the deadline | During results | At `final` |
| ----------- | ----------------------- | -------------------------------- | ------------------------------- | -------------- | ---------- |
| `never`     | spectator, next match   | spectator, next match            | spectator, next match           | spectator      | next match |
| `next-hole` | waits for the next hole | waits for the next hole          | waits for the next hole         | next hole      | next match |
| `always`    | **player, this hole**   | **player, this hole**            | waits for the next hole         | next hole      | next match |

A spectator is told which of these applies through `spectatorReason`: `next-hole`,
`next-match`, `eliminated`, `round-forfeit` or `host-spectator`. The client renders
those as different sentences, so "waiting for the next hole" and "you are out" are
never confused.

### Why `always` still refuses an expired hole

"Always" means "this hole, while it is still open". If a round timer has already
passed its deadline, the hole is effectively over and a newcomer would be given a
score for time they could not have played. They wait for the next hole instead. The
same applies during `hole-results`: the hole is finished, so admitting someone would
let them claim a score they did not earn.

### Fairness

- A late arrival is admitted with `participated: true` but **zero** prior holes. They
  score only the holes they actually play, so their total is never back-filled.
- An identity that was **eliminated** or **deliberately moved to spectators** cannot
  be re-admitted: `admittedParticipants` is checked first. A late joiner cannot be
  used to reset a losing position.
- A late joiner counts toward `initialPlayers`, which is what the elimination
  "one survivor left" rule uses, so admitting someone cannot strand a solo match.
- A newcomer during `hole-results` cannot submit a score for the finished hole: the
  completion handler requires the `playing` phase.

## Disconnects

**A disconnect is not a forfeit.** `close()` keeps the player, their identity and
their progress, and broadcasts a `bye` for the old connection id so their ghost
disappears. They may reconnect with the same document and carry on.

**A full reload is a forfeit**, because a new document has lost the local physics
state. That is covered separately in [rejoining an active round](round-rejoin.md).

**The last player disconnecting mid-hole leaves the round open.** The room does not
silently forfeit the hole or finalize the match, because the player may be coming
back and their score depends on the round still being open. A reconnect resumes; a
round timer, if the host set one, still ends the hole on schedule.

**An all-disconnected room is kept, not destroyed.** No socket connected means the
room is idle; it is reclaimed after the idle limit (see
`src/room-expiry.ts`), which is long enough for a router restart. Until then the
identities and scores are intact for whoever returns.

**In elimination, the match ends when nobody is left alive**, or when a multiplayer
match is down to a single survivor. That is the one case where a disconnect can end
a match without a reconnect: the remaining player has already won it.

## What the tests pin

`tests/late-joins.test.js`:

- `always` admits mid-hole and the newcomer scores only that hole.
- `always` refuses a newcomer whose arrival is past the round deadline.
- `never` keeps a newcomer out of every phase and admits them at the rematch.
- A newcomer during results waits for the next hole and cannot score the finished one.
- The last player disconnecting mid-hole preserves the round for a reconnect.

Existing coverage that this builds on: `next-hole late arrivals spectate through a
restart and enter only the following hole`, `spectators count toward capacity and late
joiners become spectators`, and `late join policy is host-only, validated and restored
with backward-compatible defaults`.
