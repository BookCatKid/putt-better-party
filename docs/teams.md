# Team play

An optional rule that scores the party by team instead of by player. It is
**independent**: it changes what the party is scored by, not how a hole is played, and
it composes with either elimination or stroke play. When it is off, nothing about the
room, the board or the scorecard changes.

The pinned client only renders what the server sends, so all of the following is
server policy, pinned by `tests/team-mode.test.js`.

## Formation

- **Two teams**, `Team 1` and `Team 2`, with fixed names and hues so the scoreboard is
  readable without a naming UI. Two is the smallest arrangement where the rule means
  anything: with one team there is nothing to beat.
- Teams are formed when the match starts, from the players who are **participating at
  that moment**, in join order, alternating: `Team 1` gets the first, third, fifth…
  Alternating keeps the sides within one player of each other and makes the split
  deterministic, so nobody can claim it was chosen to favour them.
- A **late joiner** is put on the **smaller** team, with ties going to `Team 1`. This is
  independent of the late-join policy: whoever is admitted under that policy is then
  balanced.
- A **rematch re-forms** the teams. A player who leaves is not replaced; the sides may
  be uneven, which is preferable to moving somebody mid-party.
- **Eliminated members stay on their team.** Their score is part of the team total, and
  removing them would silently change a total that has already been shown.

## Scoring

- A **team's score for a hole** is the **sum** of what its members actually scored on
  that hole. A member with no score (eliminated, or an ended hole) contributes nothing -
  the same rule as `par + 5` being a minimum rather than an addition, and the same rule
  that means an eliminated player is never charged.
- A **team's total** is the sum of those hole scores, which is also the sum of its
  members' totals.
- **Survival**: a team survives a hole if **any** member did, so a team's
  `holesSurvived` is the furthest any member reached.
- **Ranking** uses the same comparator as players - survival, then lower score, then
  faster time, then name - so ranks stay dense and the client's one-medal-per-rank
  indexing is safe. Equal team totals are separated by the faster time and then by
  name, exactly as two equal player scorecards are.
- In **elimination**, the party ends when **one team is left** (or none), not when one
  player is. A surviving team-mate must not be made to play on alone.

## Readiness

Team play does not change the countdown gate: every connected participant still has to
report its scene ready before the hole starts. A team is not "ready" as a unit, and
there is no team captain. This keeps readiness identical to ordinary play, which is
what makes the rule independent.

## Disconnect

- A disconnected member **keeps their score**; the team total does not change.
- A team is marked **away** only when **every** member is disconnected. While one
  member is still connected the team shows as present, even if the disconnected member
  appears first in the team.
- A team whose members are all disconnected **stays on the board** with its score and
  rank. It is not deleted, because a reconnect is possible and the score was earned.
- Reconnecting restores the same player to the same team: the assignment lives on the
  player for the match, not on the socket.

## What the client shows

- The **lobby** has a `Team play` control for the host, and guests see `Scoring: Two
teams` or `Individual`.
- The **final board and the in-game scoreboard** are the team standings, because
  `standings()` returns teams when team play is on. The podium therefore shows team
  names.
- The **scorecard** renders one row per team: each cell is the sum of its members on
  that hole, with the same named states as a player cell (`Skip`, `DNF`, `End`, and a
  clock marker when any member was charged). The time under a team cell is omitted,
  because a team has no single time.
- The **CSV export** uses the same team rows, so a shared file says what the screen
  said.

## Storage

Team assignment is **not persisted**. A restart recovers the room as a lobby (the
original client's physics state cannot be resumed), and the next match forms its teams
from the players then present. The checkpoint's `config.teams` flag is persisted, and a
checkpoint written before the rule existed loads with it off.

## What the tests pin

`tests/team-mode.test.js`:

- Off by default, and no team state anywhere when off.
- Alternating formation in join order, with the snapshot carrying the same assignment.
- A team score is the sum of its members, with dense ranks.
- Two members on one team add up on the same hole.
- A wiped team is eliminated and the party ends when one team is left.
- A late joiner goes to the smaller team.
- A disconnect keeps the team score; a team is away only when all members are.
- A team stays connected while any member is, even if the first is away.
- The flag is validated as a boolean and restores with a backward-compatible default.
- A rematch re-forms teams, and turning the rule off removes them.

`check-team-mode.mjs` drives two real browsers: the lobby control, two teams in the
running match, the final board, the scorecard and the CSV export.
