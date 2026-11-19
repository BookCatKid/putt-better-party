# Scoring, ranking and the final board

This records what is **proven from the original client**, what is **this project's
own server policy**, and where the two must not be confused. Exact parity with the
official server is **not claimed**: the official server was not available to read,
so anything it decided is unknown and is not described here as fact.

## Proven from the pinned client

All of this is read from `GameRoot-7kMtVtdO.js` in the archived bundle, and each
point is something the client _displays_ rather than decides.

**The client does not sort the standings.** It renders `standings` in the order the
server sends (`standings.map(...)`), and the in-round HUD shows `standings.slice(0, 10)`
plus the viewer's own row if they are outside the top ten. There is no ranking
comparator anywhere in the game bundle — the only `sort` calls there are for replay
bar widths and unrelated lists. **Ranking is therefore server policy**, and in this
project that server is ours.

**`rank` is supplied by the server and drives the podium.** The final screen builds
a table from `final.podium` keyed by `rank`, then reads ranks **1, 2 and 3** for the
three podium slots, and indexes the medals `['🥇','🥈','🥉']` by `rank - 1`. A
consequence that constrains the server: **ranks must be 1-based and dense**, or a
podium slot would be empty.

**`final` carries both `podium` and `standings`.** The podium is the top three; the
full list is rendered beneath it. The client uses the supplied list, not a
recomputation.

**The flags it renders are server-supplied.** `alive` drives the strike-through on a
board row; `role === 'spectator'` shows the eye; `ready` shows the check. The
in-round board also displays the server's `alive` and `holed` counts.

**Round transitions are server-driven.** `phase` moves the client between lobby,
countdown, playing, hole-results and final; the client has no transition logic of
its own. A rematch arrives as a fresh match identity, not as a client-side reset.

## This project's own policy

None of the following is a claim about the official server. It is what our server
does, chosen for this game and pinned by tests.

**Ranking order** (`Room.standings`): more holes survived first; then still alive
before eliminated; then fewer total strokes; then less total time; then name. The
first two keys are the round's own outcome, the next two break a tie on merit, and
the last makes the order total and stable.

**Ties do not share a place.** Equal scorecards get distinct ranks, decided by name.
This is deliberate: the client looks podium slots up by rank 1, 2, 3 and indexes one
medal per rank, so a shared place would leave a slot empty. The official server may
have behaved differently; that is unknown.

**The podium is the first three standings**, sent with their ranks, which satisfies
the client's lookup by construction.

**Only participants are ranked.** A player who never took part in a hole is not in
the standings at all, so a spectator cannot outrank a player.

**Timeout penalty**: a non-finisher who is still in a stroke-play round completes the
hole at `par + 5`. Elimination, by contrast, removes the player from the hole.

**Rematch** starts a new match with a new `matchId`; the previous rounds stay in
`roundHistory`, and a restart of the same course keeps the current match identity.

## What the tests pin

- _standings rank by holes survived, then life, then strokes, then time, then name_ —
  the ordering rule and dense ranks.
- _equal scores get distinct ranks, decided by name_ — the tie policy.
- _the final frame carries a podium whose ranks fill the three medals_ — podium
  length, rank order, and that the full standings agree.
- _a full reload during play cannot reset progress_ — a reload cannot buy a better
  rank by abandoning a hole it was losing.

## What is not claimed

Exact parity with the official server's scoring, tie-breaking, penalty values or
rematch semantics. The client proves only how these are _displayed_; the values
behind them are this project's decisions, and they are documented here so a future
change is a deliberate policy change rather than an accidental divergence.
