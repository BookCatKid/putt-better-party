/** The host and co-hosts share one administration role, not permission flags. */
export const HOST_ACTIONS = [
  'end',
  'skip',
  'time',
  'restart',
  'retry-next',
  'skip-next',
  'transfer-host',
  'rename',
  'color',
  'restart-player',
  'forfeit-player',
  'spectate-player',
  'return-player',
  'revive-player',
  'reset-strokes',
  'adjust-strokes',
  'lock-putting',
  'unlock-putting',
  'kick',
  'ban',
  'unban',
  'grant-cohost',
  'revoke-cohost',
  'pause',
  'resume',
  'restart-match',
  'lock-party',
  'unlock-party',
  'playlist',
  'add-course',
  'skip-vote',
  'remaining-time',
  'force-next',
  'disable-elimination',
  'admit-all',
] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];
export function isHostAction(value: unknown): value is HostAction {
  return typeof value === 'string' && HOST_ACTIONS.some((action) => action === value);
}

export function normalizedName(name: string) {
  return name.trim().normalize('NFKC').toLowerCase();
}
