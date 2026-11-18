# Architecture and operation

The HTTP service exposes room creation, session issuance, catalog browsing and course retrieval. The independent WebSocket room state machine owns admission, host permissions, round timing, progression, elimination and standings. The original client handles rendering and simulation.

## Course selection

Manual playlists contain public course IDs. Maps are fetched and validated from the public API as needed; no playable map is stored permanently. Random selection tracks per-room history and avoids repeats until the available pool is exhausted. The daily exclusion option refreshes every page of public featured-hole metadata at the beginning of each random match. Random selection draws only as many positions as are still needed and overlaps independent page reads, then processes their results in draw order. Every randomly selected specification must still pass the original validator before the match starts; manual playlists still load later holes on demand. Public catalog reads share a FIFO queue with at most three in-flight requests and a minimum 350 ms interval between starts. The interval is a local protective pacing choice, not a documented upstream rate limit.

## Room lifecycle

SQLite retains room settings, public playlist metadata, random history and private session credentials. On restart, interrupted matches recover to their lobbies because browser-local physics state cannot be reconstructed. Unoccupied rooms expire after 30 minutes. A same-document reconnect retains progress; a full reload during an active unfinished round forfeits that hole. The server’s round timer continues during connection interruptions. The original server-side session replacement close reason is handled explicitly: when another tab claims the same identity, the displaced tab stops reconnecting and offers a return home or manual reload.

The host chooses a late-join policy in the lobby. Never permits watching but not playing until the next match. After current hole puts first-time arrivals into the next hole that begins, provided the match continues; restarting the same hole does not admit them. Always (the default for new rooms) admits first-time arrivals during countdown or play using the existing round deadline, or at the next hole if they arrive on results. Missed holes have no score rows and no penalty, with the existing holes-survived-first ranking retained. Eliminated identities and identities that deliberately leave cannot use late admission to restart their attempt. Regular reconnect and reload/forfeit rules are unchanged. Spectating removes the local rigid body and aim/shadow meshes, preserves other players and uses the original free camera.

Admission capacity is checked both when a credential is issued and again when its socket joins, so a credential issued before the room filled is still rejected at admission. Spectators count toward the maximum-player limit. Returning connected players keep their slot when the host reduces the limit, and no one is evicted; the host token by itself does not grant a slot — it only matters when the joining identity actually claims or retains host authority.

## Scoring and host controls

Non-finishers are eliminated in elimination mode. Without elimination, unfinished holes incur a penalty of at least par plus five strokes. Exact upstream ranking and penalty parity is not established.

Hosts can extend the current round by 15, 30 or 60 seconds up to 15 minutes. Skipping voids the hole; restarting resets its attempt and preserves previous scores. Ending retains completed scores without penalizing unfinished players. All commands are checked by the backend.

## Deployment considerations

The service is intended to operate independently of putt.day's official party servers. Public course availability depends on the pinned upstream read protocol. Before exposing a service publicly, obtain any needed asset redistribution permission and review authentication, abuse prevention, rate limits and deployment security. Client-reported scores are not server-verified physics.

## Client initialization

The original game component must mount before its WebSocket connects. The party route keeps that component mounted but suppresses its incomplete HUD until the authoritative snapshot, local player roster entry, scoreboard, accepted map and original scene preparation callback are available. Final results also require the final standings message. The original scene preparation includes its upstream fallback timeout; this is not a guarantee that every GPU or asset has loaded successfully.

The party socket adapter lives in `scripts/party-transport.js`, with its original bundle bindings in the patcher. It waits for a synchronized snapshot, roster and board before enabling commands, retries interrupted connections with bounded exponential backoff, and cleans up its timers and subscriptions on exit.

## Administration

The read-only `/admin` dashboard provides live room and player status, current and completed holes, scores, and the most recent 500 gameplay events (bounded log tails, not an all-time history). It refreshes every five seconds while visible. Enable it by configuring a Bun-compatible Argon2id hash in `BP_ADMIN_PASSWORD_HASH` in the server's private environment. Without a hash the admin API is disabled. The password is never sent to the gameplay log or included in the client bundles. The admin API uses expiring in-memory sessions in HttpOnly, SameSite=Strict cookies (Secure on HTTPS), validates POST origins, and throttles failed logins globally. Sessions are invalidated by a restart. No administrator write operations or access to upstream administration are exposed.
