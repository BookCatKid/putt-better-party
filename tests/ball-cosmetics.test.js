import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BALL_COLORS, parseBallAppearance, replayBallColor } from '../src/ball-cosmetics.js';
import { Room } from '../src/room.js';
import { RoomStore } from '../src/room-store.js';

test('the accepted presets exactly match every ball in the pinned cosmetic registry', () => {
  const source = readFileSync(
    new URL('../private-client/assets/index-DFMxt6BL.js', import.meta.url),
    'utf8',
  );
  const definitions = [
    ...source.matchAll(/\{key:`(ball-[a-z]+)`,kind:`ball`,name:`[^`]+`,color:`(#[0-9a-f]{6})`/g),
  ];
  expect(definitions).toHaveLength(13);
  expect(BALL_COLORS).toEqual({
    classic: '#ffffff',
    ...Object.fromEntries(definitions.map(([, key, color]) => [key, color])),
  });
  expect(parseBallAppearance({ key: 'ball-fire', color: '#000000', effect: 'untrusted' })).toEqual({
    key: 'ball-fire',
    color: '#ff6a1a',
  });
});

test('custom colors are literal RGB values, not executable CSS or arbitrary effects', () => {
  expect(parseBallAppearance({ key: 'custom', color: '#Ab12F0' })).toEqual({
    key: 'custom',
    color: '#ab12f0',
  });
  for (const value of [
    null,
    {},
    { key: 'trail-sunset' },
    { key: '__proto__' },
    { key: 'custom', color: '#abc' },
    { key: 'custom', color: 'url(https://example.com)' },
  ]) {
    expect(() => parseBallAppearance(value)).toThrow();
  }
});

test('selection is persisted and server-authoritative; host hue overrides win', () => {
  const store = new RoomStore(':memory:');
  const room = new Room('ABCDE', new Map(), { onChange: (changedRoom) => store.save(changedRoom) });
  try {
    const identity = room.issue('Guest', undefined, undefined, { key: 'custom', color: '#123456' });
    const socket = {
      data: {},
      frames: [],
      send(frame) {
        this.frames.push(JSON.parse(frame));
      },
      close() {},
    };
    room.handle(socket, { t: 'join', protocol: 2, ...identity, ball: { key: 'ball-fire' } });
    expect(room.roster()[0].ball).toEqual({ key: 'custom', color: '#123456' });
    expect(room.issue('Guest', identity.uid, identity.session, { key: 'ball-fire' })).toEqual(
      identity,
    );
    const restored = store.load(new Map()).get('ABCDE');
    expect(restored.issued.get(identity.uid).ball).toEqual(identity.ball);
    restored.dispose();
    expect(replayBallColor({ ...identity, colorOverride: true, hue: 42 })).toEqual(
      'hsl(42,75%,62%)',
    );
    expect(replayBallColor(identity)).toEqual('#123456');
  } finally {
    room.dispose();
    store.close();
  }
});
