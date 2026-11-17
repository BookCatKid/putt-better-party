# Architecture and operation

The HTTP service exposes room creation, session issuance, catalog browsing and course retrieval. The independent WebSocket room state machine owns admission, host permissions, round timing, progression, elimination and standings. The original client handles rendering and simulation.

## Course selection

Manual playlists contain public course IDs. Maps are fetched and validated from the public API as needed; no playable map is stored permanently. Random selection tracks per-room history and avoids repeats until the available pool is exhausted. The daily exclusion option refreshes the public featured-hole metadata at the beginning of each random match.

## Room lifecycle

SQLite retains room settings, public playlist metadata, random history and private session credentials. On restart, interrupted matches recover to their lobbies because browser-local physics state cannot be reconstructed. Unoccupied rooms expire after 30 minutes. A same-document reconnect retains progress; a full reload during an active unfinished round forfeits that hole. The server’s round timer continues during connection interruptions. The original server-side session replacement close reason is handled explicitly: when another tab claims the same identity, the displaced tab stops reconnecting and offers a return home or manual reload.

Admission capacity is checked both when a credential is issued and again when its socket joins, so a credential issued before the room filled is still rejected at admission. Spectators count toward the maximum-player limit. Returning connected players keep their slot when the host reduces the limit, and no one is evicted; the host token by itself does not grant a slot — it only matters when the joining identity actually claims or retains host authority.

## Scoring and host controls

Non-finishers are eliminated in elimination mode. Without elimination, unfinished holes incur a penalty of at least par plus five strokes. Exact upstream ranking and penalty parity is not established.

Hosts can extend the current round by 15, 30 or 60 seconds up to 15 minutes. Skipping voids the hole; restarting resets its attempt and preserves previous scores. Ending retains completed scores without penalizing unfinished players. All commands are checked by the backend.

## Deployment considerations

The service is intended to operate independently of putt.day's official party servers. Public course availability depends on the pinned upstream read protocol. Before exposing a service publicly, obtain any needed asset redistribution permission and review authentication, abuse prevention, rate limits and deployment security. Client-reported scores are not server-verified physics.

## Client initialization

The original game component must mount before its WebSocket connects. The party route keeps that component mounted but suppresses its incomplete HUD until the authoritative snapshot, local player roster entry, scoreboard, accepted map and original scene preparation callback are available. Final results also require the final standings message. The original scene preparation includes its upstream fallback timeout; this is not a guarantee that every GPU or asset has loaded successfully.

The party socket adapter lives in `scripts/party-transport.js`, with its original bundle bindings in the patcher. It waits for a synchronized snapshot, roster and board before enabling commands, retries interrupted connections with bounded exponential backoff, and cleans up its timers and subscriptions on exit.
