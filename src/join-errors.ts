/**
 * Why `/api/join` refused to issue an identity.
 *
 * These are the only ways a join can fail, and they need different responses
 * from the client: a stale session has a recovery path (forget the dead
 * credentials and ask for a name again), while a locked, full or banned party
 * does not, and a bad name is simply a validation error.
 *
 * The code is the contract. Before this existed the client recognised an expired
 * session by substring-matching the human message, so rewording "Session expired;
 * join again with a new identity." would have silently removed the only way out
 * of a dead session — the player would be stuck on a loading screen whose Retry
 * button could never succeed. The message stays for people; the code is what code
 * reads.
 */
export type JoinRefusalCode =
  'invalid-name' | 'banned' | 'locked' | 'session-expired' | 'full' | 'identity-limit';

/**
 * A refused join. Deliberately carries no HTTP status: the domain decides *why*,
 * and the transport decides what that is worth on the wire, so the room does not
 * grow an opinion about status codes.
 */
export class JoinRefused extends Error {
  constructor(
    readonly code: JoinRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'JoinRefused';
  }
}

/**
 * The status a refusal is worth. Kept next to the codes so the mapping is
 * reviewable in one place rather than buried in a route.
 *
 * - `401` a credential was presented and is no longer valid.
 * - `403` the party refuses this caller as a matter of policy.
 * - `409` the party cannot accept anyone right now, but nothing is wrong with the
 *   request itself.
 * - `400` the request was malformed.
 */
export function joinRefusalStatus(code: JoinRefusalCode): number {
  switch (code) {
    case 'session-expired':
      return 401;
    case 'banned':
    case 'locked':
      return 403;
    case 'full':
    case 'identity-limit':
      return 409;
    case 'invalid-name':
      return 400;
  }
}
