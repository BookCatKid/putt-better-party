import { isRecord } from './domain.js';

/** Pinned index-DFMxt6BL.js exports the cosmetic registry as A (map) and k
 * (list). Only the ball entries are admitted here, never arbitrary shaders. */
export const BALL_COLORS = {
  classic: '#ffffff',
  'ball-mint': '#9ff3cf',
  'ball-coral': '#ff8a7a',
  'ball-sky': '#8fd3ff',
  'ball-violet': '#c4a1ff',
  'ball-lemon': '#fff27a',
  'ball-slate': '#6b7a8f',
  'ball-fire': '#ff6a1a',
  'ball-ice': '#a8dcf5',
  'ball-galaxy': '#5a2a9e',
  'ball-lava': '#c43a0a',
  'ball-void': '#2a0f45',
  'ball-holo': '#9ee7ff',
  'ball-storm': '#1c3a7a',
} as const;

export type BallAppearance = { key: string; color: string };

/** Resolve canonical colors on the server. A client cannot supply a shader,
 * CSS expression, asset URL, or override the base color of a pinned cosmetic. */
export function parseBallAppearance(value: unknown): BallAppearance {
  if (value === undefined) {
    return { key: 'classic', color: BALL_COLORS.classic };
  }
  if (!isRecord(value) || typeof value.key !== 'string') {
    throw new Error('Invalid ball selection');
  }
  if (value.key === 'custom') {
    if (typeof value.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.color)) {
      throw new Error('Custom balls require a six-digit hex color');
    }
    return { key: 'custom', color: value.color.toLowerCase() };
  }
  if (!Object.hasOwn(BALL_COLORS, value.key)) {
    throw new Error('Unknown ball selection');
  }
  return { key: value.key, color: BALL_COLORS[value.key as keyof typeof BALL_COLORS] };
}

/** A host's existing hue override takes precedence over the player's selection. */
export function replayBallColor(player: {
  ball?: BallAppearance;
  colorOverride?: boolean;
  hue: number;
}) {
  return player.colorOverride || !player.ball
    ? 'hsl(' + player.hue + ',75%,62%)'
    : player.ball.color;
}
