// Reuse the archived comparison renderer's approach: one course, coloured
// meshes and a shared camera. Unlike its two compressed-time loops, use one
// elapsed-round clock for every track.
export function BpPartyReplayScene({ level, tracks, clock, focus }) {
  const theme = D.useMemo(() => w(level), [level]);
  const [graphics] = D.useState(() =>
    v({ coarsePointer: y(), embedded: false, forcedSafeMode: x() }),
  );
  const [lost, setLost] = D.useState(false);
  const ratio = graphics.safe ? graphics.dpr : Math.min(Math.max(window.devicePixelRatio, 1), 1.75);
  const selected = tracks.find((track) => track.id === focus) ?? tracks[0];
  const component = D.createElement;
  return component(
    C,
    {},
    component(
      S,
      {
        surface: 'party-replay',
        title: 'The replay hit a snag',
        body: 'Try the map view if 3D graphics are unavailable.',
      },
      component(
        'div',
        { className: 'relative w-full overflow-hidden rounded-xl border border-[var(--line)]' },
        [
          component(
            u,
            {
              key: 'canvas',
              dpr: ratio,
              frameloop: 'demand',
              gl: { antialias: graphics.msaa, powerPreference: graphics.powerPreference },
              shadows: graphics.shadows && 'percentage',
              camera: { position: [0, 5, 8], fov: 45 },
              style: { height: 'min(62svh, 560px)', width: '100%' },
            },
            [
              component(m, {
                key: 'health',
                surface: 'party-replay',
                levelId: level.id,
                safeMode: graphics.safe,
                dpr: ratio,
                maxFps: graphics.maxFps,
                shadows: graphics.shadows,
                postprocessing: false,
                onLost: () => setLost(true),
                onRestored: () => setLost(false),
              }),
              component(d, { key: 'driver', maxFps: graphics.maxFps }),
              component('color', { key: 'sky', attach: 'background', args: [theme.skyHorizon] }),
              component('ambientLight', {
                key: 'light',
                color: theme.ambientColor,
                intensity: theme.ambientIntensity,
              }),
              component(p, { key: 'environment', level, theme, shadows: graphics.shadows }),
              component(D.Suspense, { key: 'course', fallback: null }, [
                component(i, { key: 'physics', paused: true }, [
                  component(f, { key: 'floor', level }),
                  component(r, { key: 'pieces', level, staticCourseMechanics: true }),
                  component(BpTimedDevices, { key: 'events', level, track: selected, clock }),
                ]),
                component(g, { key: 'decorations', level, theme }),
                component(BpTimedBalls, { key: 'players', tracks, clock, focus }),
                component(T, { key: 'effects', holeConfetti: false }),
              ]),
            ],
          ),
          lost &&
            component(
              'div',
              { key: 'lost', className: 'absolute inset-0 z-20' },
              component(b, {
                title: 'The replay hit a snag',
                body: 'Your graphics stopped responding. Switch to the map view.',
              }),
            ),
          component(z, { key: 'loading' }),
        ],
      ),
    ),
  );
}

function BpTimedDevices({ level, track, clock }) {
  const [active, setActive] = D.useState([]);
  const last = D.useRef('');
  c(() => {
    const nodes = bpActiveNodesAt(track?.states ?? [], clock.current).filter(
      (id) => Object.hasOwn(level.events?.nodes ?? {}, id) && a(level.events.nodes[id]),
    );
    const signature = JSON.stringify(nodes);
    if (signature !== last.current) {
      last.current = signature;
      setActive(nodes);
    }
  });
  return D.createElement(_, { events: level.events, activeNodeIds: active });
}

function BpTimedBalls({ tracks, clock, focus }) {
  const meshes = D.useRef(new Map());
  const { camera } = l();
  const center = D.useRef(new s());
  const desired = D.useRef(new s());
  const initialized = D.useRef(false);
  c((_state, delta) => {
    const positions = [];
    for (const track of tracks) {
      const position = bpSampleAt(track.samples, clock.current);
      const mesh = meshes.current.get(track.id);
      if (mesh) {
        mesh.visible = !!position;
        if (position) {
          mesh.position.set(position.x, position.y, position.z);
        }
      }
      if (position) {
        positions.push({ ...position, id: track.id });
      }
    }
    const primary = positions.find((position) => position.id === focus);
    const visible = primary ? [primary] : positions;
    if (!visible.length) {
      return;
    }
    center.current.set(0, 0, 0);
    for (const position of visible) {
      center.current.x += position.x;
      center.current.y += position.y;
      center.current.z += position.z;
    }
    center.current.multiplyScalar(1 / visible.length);
    // This generalizes the upstream two-ball midpoint and camera-distance
    // scaling to N players; zoom out enough to keep the field in view.
    const spread = Math.max(
      0,
      ...visible.map((position) =>
        Math.hypot(
          position.x - center.current.x,
          position.y - center.current.y,
          position.z - center.current.z,
        ),
      ),
    );
    const distance = 1 + spread * 0.3;
    desired.current.set(
      center.current.x + 3.9 * distance,
      center.current.y + 5 * distance,
      center.current.z + 5.5 * distance,
    );
    if (!initialized.current) {
      camera.position.copy(desired.current);
      initialized.current = true;
    } else {
      camera.position.lerp(desired.current, 1 - Math.exp(-4 * delta));
    }
    camera.lookAt(center.current.x, center.current.y + 0.3, center.current.z);
  }, -1);
  return tracks.map((track) =>
    D.createElement(
      'mesh',
      {
        key: track.id,
        ref: (mesh) => {
          if (mesh) {
            meshes.current.set(track.id, mesh);
          } else {
            meshes.current.delete(track.id);
          }
        },
        visible: false,
        castShadow: true,
      },
      [
        D.createElement('sphereGeometry', { key: 'mesh', args: [0.09, 24, 24] }),
        D.createElement('meshStandardMaterial', {
          key: 'material',
          color: track.color ?? 'hsl(' + track.hue + ',75%,62%)',
          roughness: 0.35,
          metalness: 0.05,
        }),
      ],
    ),
  );
}
