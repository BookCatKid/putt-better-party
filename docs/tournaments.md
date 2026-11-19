# Tournaments

A tournament is a **run of matches** inside one party, ranked by **accumulated points**
rather than by a single match. It is optional and off by default; when it is off the
party behaves exactly as before.

The backlog item allowed brackets or standings. This is the standings form, because it
needs no seeding or byes and it composes with the match lifecycle that already exists:
a tournament is the same rematch flow, repeated a fixed number of times.

## Structure

- The host sets **Tournament** and a **round count** (2–20, chosen in the lobby; the
  lobby offers 2, 3, 4, 5, 6, 8 and 10).
- Each match is a normal match: same courses, same timer, same elimination or stroke
  play, same team rule if it is on. Nothing about a hole changes.
- After every finalized match the tournament table is updated. The host returns to the
  lobby with **Back to lobby** and starts the next match in the usual way.
- The run ends when the configured number of matches has been played. The table is
  marked **complete** and stays visible on the results screen and in the lobby until the
  host starts another match, at which point a **new tournament** begins.

## Scoring

- Points are **`competitors - rank + 1`**. With three competitors the winner earns 3,
  second 2, last 1; with two, 2 and 1. Last place still earns a point for turning up,
  and a larger field is worth more, so a win is never worth less than a win in a
  smaller match.
- A competitor who **misses a match keeps their points** and is not charged for the
  gap. They fall behind naturally rather than being reset.
- **Order**: points, then match wins, then the lower cumulative stroke total, then
  name. Ranks are dense and assigned after sorting.
- The **competitor is whatever the final board ranked**: a player normally, a **team
  slot** in team play. The tournament table and the board therefore agree about who
  earned what. Because team membership is re-formed each match, a team tournament ranks
  the _slots_ (`Team 1`, `Team 2`), not fixed rosters — that is the honest reading of a
  rule whose sides change between matches.
- A match ended early with **End party** is a finalized match and counts, with the
  standings as they stood. A skipped _course_ is not a separate match and does not.

## Interaction with the rest of the party

- **Rematch** is how a tournament advances. The current match's `roundHistory` is
  cleared as usual; the tournament table is not.
- **Restart** (host restart of the hole) does not finalize a match, so it does not
  score.
- **Turning the rule off** clears the table rather than hiding stale points, so turning
  it back on starts cleanly.
- **Changing the round count** applies to the next tournament, not the one in progress:
  the count is copied into the table when the run starts.
- **Late joiners** enter the current match under the late-join policy and start with
  zero tournament points. They can still win the run if there are enough matches left.

## Storage

The tournament table is persisted in the room checkpoint alongside the match history:
the round count, how many matches have been played, whether the run is complete, and
each competitor's name, points, wins, matches and cumulative strokes. It contains no
course specification, session or capability token. A checkpoint written before
tournaments existed restores with no table, and a malformed table is rejected rather
than half-loaded.

## What the tests pin

`tests/tournament.test.js`:

- Off by default, with no table anywhere.
- `competitors - rank + 1` points and dense ranks.
- Accumulation across matches, and completion after the configured rounds.
- A competitor who misses a match keeps their points.
- A finished run restarts cleanly at the next match.
- Turning the rule off clears the table.
- Composition with team play, ranking the team slots.
- Checkpoint round-trip, and an older checkpoint restoring without a table.
- The round count is bounded and validated.

`tests/persistence.test.js` rejects thirteen malformed table shapes. `check-tournament.mjs`
drives the lobby controls, the results panel, its survival through a rematch, and the
completed state in a real browser.
