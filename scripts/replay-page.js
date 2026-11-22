import { r as interop } from './chunk-QTnfLwEv.js';
import { t as react } from './react-sKtkuLrH.js';
import { sampleAt } from './replay-timeline.js';

const React = interop(react(), 1);
const createElement = React.createElement;
const Scene = React.lazy(() =>
  import('./Replay3D-Cz9axXph.js').then((module) => ({ default: module.BpPartyReplayScene })),
);
const OriginalReplay = React.lazy(() => import('./Replay3D-Cz9axXph.js'));
const color = (track) => track.color ?? 'hsl(' + track.hue + ',75%,62%)';
function duration(ms) {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  return (
    Math.floor(tenths / 600) +
    ':' +
    String(Math.floor(tenths / 10) % 60).padStart(2, '0') +
    '.' +
    (tenths % 10)
  );
}
async function getJson(url, signal) {
  const response = await fetch(url, { signal });
  const result = await response.json();
  if (!response.ok) {
    throw Error(result.error ?? 'Could not load replay');
  }
  return result;
}

function ReplayMap({ level, tracks, time }) {
  const pieces = level.pieces ?? [];
  const minX = Math.min(0, ...pieces.map((piece) => piece.x));
  const minZ = Math.min(0, ...pieces.map((piece) => piece.z));
  const maxX = Math.max(0, ...pieces.map((piece) => piece.x));
  const maxZ = Math.max(0, ...pieces.map((piece) => piece.z));
  const px = (value) => (value / 2 - minX) * 24 + 20;
  const pz = (value) => (value / 2 - minZ) * 24 + 20;
  const paths = React.useMemo(
    () =>
      tracks.flatMap((track) => {
        const segments = [];
        let points = [];
        const samples = track.samples;
        const stride = Math.max(1, Math.floor(samples.length / 5 / 1800));
        for (let offset = 0; offset < samples.length; offset += 5) {
          if (offset && (samples[offset + 4] || samples[offset] - samples[offset - 5] > 500)) {
            if (points.length > 1) {
              segments.push(points.join(' '));
            }
            points = [];
          }
          if ((offset / 5) % stride === 0 || offset === samples.length - 5) {
            points.push(
              px(samples[offset + 1] / 100).toFixed(1) +
                ',' +
                pz(samples[offset + 3] / 100).toFixed(1),
            );
          }
        }
        if (points.length > 1) {
          segments.push(points.join(' '));
        }
        return segments.map((segmentPoints, index) =>
          createElement('polyline', {
            key: track.id + ':' + index,
            points: segmentPoints,
            fill: 'none',
            stroke: color(track),
            strokeWidth: 1.7,
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
            opacity: 0.65,
          }),
        );
      }),
    [level, tracks],
  );
  return createElement(
    'svg',
    {
      className: 'bp-replay-map',
      viewBox: '0 0 ' + ((maxX - minX + 1) * 24 + 16) + ' ' + ((maxZ - minZ + 1) * 24 + 16),
      role: 'img',
      'aria-label': 'Course map with overlapping recorded player paths',
    },
    [
      ...pieces.map((piece, index) =>
        createElement('rect', {
          key: 'tile' + index,
          x: px(piece.x * 2) - 12,
          y: pz(piece.z * 2) - 12,
          width: 22,
          height: 22,
          rx: 3,
          fill: '#52a86b',
          opacity: piece.offPath ? 0.22 : 0.35,
        }),
      ),
      ...(level.pits ?? []).map((piece, index) =>
        createElement('rect', {
          key: 'pit' + index,
          x: px(piece.x * 2) - 12,
          y: pz(piece.z * 2) - 12,
          width: 22,
          height: 22,
          rx: 3,
          fill: '#0a0d14',
        }),
      ),
      level.cup &&
        createElement('circle', {
          key: 'cup',
          cx: px(level.cup.x * 2),
          cy: pz(level.cup.z * 2),
          r: 4,
          fill: '#0a0d14',
          stroke: '#ffd166',
        }),
      ...paths,
      ...tracks.map((track) => {
        const point = sampleAt(track.samples, time);
        return (
          point &&
          createElement('circle', {
            key: 'ball' + track.id,
            cx: px(point.x),
            cy: pz(point.z),
            r: 3.2,
            fill: color(track),
            stroke: '#fff',
            strokeWidth: 0.8,
          })
        );
      }),
    ],
  );
}

function ReplayViewer({ round }) {
  const available = React.useMemo(
    () => round.tracks.filter((track) => track.samples.length),
    [round],
  );
  const [selected, setSelected] = React.useState(() => available.map((track) => track.id));
  const [focus, setFocus] = React.useState(null);
  const [view, setView] = React.useState('3d');
  const [playing, setPlaying] = React.useState(true);
  const [speed, setSpeed] = React.useState(1);
  const [time, setTime] = React.useState(0);
  const clock = React.useRef(0);
  const tracks = React.useMemo(
    () => available.filter((track) => selected.includes(track.id)),
    [available, selected],
  );
  const single = tracks.length === 1 ? tracks[0] : null;
  function seek(value) {
    clock.current = value;
    setTime(value);
  }
  React.useEffect(() => {
    if (!playing || view === 'native') {
      return;
    }
    let frame;
    let previous;
    let lastUpdate = 0;
    const tick = (now) => {
      if (previous !== undefined) {
        clock.current = Math.min(round.durationMs, clock.current + (now - previous) * speed);
      }
      previous = now;
      if (now - lastUpdate >= 80 || clock.current === round.durationMs) {
        setTime(clock.current);
        lastUpdate = now;
      }
      if (clock.current < round.durationMs) {
        frame = requestAnimationFrame(tick);
      } else {
        setPlaying(false);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, round.durationMs, view]);

  function show(ids) {
    setSelected(ids);
    setFocus(null);
    if (view === 'native') {
      setView('3d');
    }
  }
  function toggle(id) {
    const next = selected.includes(id)
      ? selected.filter((value) => value !== id)
      : [...selected, id];
    show(next);
  }
  const button = (label, action, active = false, extra = {}) =>
    createElement(
      'button',
      {
        type: 'button',
        className: 'bp-replay-button',
        onClick: action,
        'aria-pressed': active,
        ...extra,
      },
      label,
    );
  const waiting = createElement(
    'div',
    { className: 'bp-replay-placeholder' },
    'Loading 3D replay…',
  );
  if (!round.level || !available.length) {
    return createElement(
      'p',
      { className: 'bp-replay-placeholder' },
      'There is no recorded ball trajectory for this hole.',
    );
  }
  let content = createElement(
    'div',
    { className: 'bp-replay-placeholder' },
    'Select players to watch.',
  );
  if (tracks.length && view === 'map') {
    content = createElement(ReplayMap, { level: round.level, tracks, time });
  } else if (tracks.length && view === '3d') {
    content = createElement(
      React.Suspense,
      { fallback: waiting },
      createElement(Scene, { level: round.level, tracks, clock, focus }),
    );
  } else if (view === 'native' && single?.native?.trajectory.length) {
    const native = single.native;
    const trajectory = [];
    const points = [];
    for (let index = 0; index < native.trajectory.length; index += 3) {
      trajectory.push({
        x: native.trajectory[index] / 100,
        y: native.trajectory[index + 1] / 100,
        z: native.trajectory[index + 2] / 100,
      });
    }
    for (let index = 0; index < native.path.length; index += 2) {
      points.push({ x: native.path[index], z: native.path[index + 1] });
    }
    content = createElement(
      React.Suspense,
      { fallback: waiting },
      createElement(OriginalReplay, {
        level: round.level,
        points,
        traj: trajectory,
        eventTimeline: native.events,
      }),
    );
  }
  return createElement('div', { className: 'bp-replay-layout' }, [
    createElement('section', { key: 'viewer', className: 'bp-replay-viewport' }, [
      createElement('div', { key: 'views', className: 'bp-replay-toolbar' }, [
        button('3D', () => setView('3d'), view === '3d'),
        button('Map', () => setView('map'), view === 'map'),
        single?.native?.trajectory.length >= 6 &&
          button('Original replay', () => setView('native'), view === 'native'),
        createElement('label', { className: 'bp-replay-focus' }, [
          'Camera ',
          createElement(
            'select',
            {
              value: focus ?? '',
              onChange: (event) =>
                setFocus(event.target.value === '' ? null : Number(event.target.value)),
              disabled: view !== '3d',
            },
            [
              createElement('option', { value: '' }, 'All selected players'),
              ...tracks.map((track) =>
                createElement('option', { key: track.id, value: track.id }, track.name),
              ),
            ],
          ),
        ]),
      ]),
      createElement('div', { key: 'content' }, content),
      view !== 'native' &&
        createElement('div', { key: 'playback', className: 'bp-replay-controls' }, [
          button(playing ? 'Pause' : 'Play', () => {
            if (clock.current >= round.durationMs) {
              seek(0);
            }
            setPlaying(!playing);
          }),
          button('Restart', () => {
            seek(0);
            setPlaying(true);
          }),
          createElement('input', {
            type: 'range',
            min: 0,
            max: Math.max(1, round.durationMs),
            step: 10,
            value: time,
            'aria-label': 'Replay time',
            onChange: (event) => seek(Number(event.target.value)),
          }),
          createElement(
            'span',
            { className: 'bp-replay-time' },
            duration(time) + ' / ' + duration(round.durationMs),
          ),
          createElement(
            'select',
            {
              value: speed,
              'aria-label': 'Playback speed',
              onChange: (event) => setSpeed(Number(event.target.value)),
            },
            [0.5, 1, 2, 4].map((value) =>
              createElement('option', { key: value, value }, value + '×'),
            ),
          ),
        ]),
      createElement(
        'p',
        { key: 'note', className: 'bp-replay-note' },
        view === 'native'
          ? 'Original putt.day replay: removes time between shots and may omit failed shots.'
          : 'Recorded elapsed-round playback. Moving course devices reflect the camera player (or first selected player); other players may have encountered different device states.',
      ),
    ]),
    createElement('aside', { key: 'players', className: 'bp-replay-players' }, [
      createElement('h3', { key: 'title' }, 'Players'),
      createElement('div', { key: 'actions', className: 'bp-replay-toolbar' }, [
        button('All', () => show(available.map((track) => track.id))),
        button('None', () => show([])),
      ]),
      createElement(
        'ul',
        { key: 'list' },
        round.tracks.map((track) =>
          createElement('li', { key: track.id }, [
            createElement('label', {}, [
              createElement('input', {
                type: 'checkbox',
                checked: selected.includes(track.id),
                disabled: !track.samples.length,
                onChange: () => toggle(track.id),
              }),
              createElement('span', {
                className: 'bp-replay-dot',
                style: { background: color(track) },
              }),
              createElement('span', { className: 'bp-replay-player-name' }, track.name),
              createElement(
                'span',
                { className: 'bp-replay-player-score' },
                track.strokes == null ? track.status : track.strokes + ' strokes',
              ),
            ]),
            createElement('div', { className: 'bp-replay-player-meta' }, [
              createElement(
                'span',
                {},
                track.samples.length
                  ? (track.timeMs != null ? duration(track.timeMs) + ' · ' : '') +
                      (track.truncated ? 'Partial recording' : track.status)
                  : 'No recording',
              ),
              !!track.samples.length &&
                button(
                  'Solo',
                  () => show([track.id]),
                  selected.length === 1 && selected[0] === track.id,
                ),
            ]),
          ]),
        ),
      ),
    ]),
  ]);
}

export function component() {
  const id = location.pathname.split('/').at(-1);
  const api = '/api/replays/' + encodeURIComponent(id);
  const [summary, setSummary] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [round, setRound] = React.useState(null);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    const controller = new AbortController();
    getJson(api, controller.signal)
      .then((result) => {
        setSummary(result);
        const requested = new URLSearchParams(location.search).get('hole');
        const choice = result.rounds.find((item) => String(item.index) === requested);
        setSelected(choice?.index ?? result.rounds[0]?.index ?? null);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err.message);
        }
      });
    return () => controller.abort();
  }, [api]);
  React.useEffect(() => {
    if (selected === null) {
      return;
    }
    const controller = new AbortController();
    setRound(null);
    setError('');
    getJson(api + '/' + selected, controller.signal)
      .then(setRound)
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err.message);
        }
      });
    return () => controller.abort();
  }, [api, selected]);
  return createElement('main', { className: 'bp-replay-page' }, [
    createElement('header', { key: 'title', className: 'bp-replay-header' }, [
      createElement(
        'a',
        { href: '/home' },
        'better',
        createElement('span', { className: 'text-emerald-400' }, '.party'),
      ),
      createElement('h1', {}, 'Party replays'),
      summary &&
        createElement(
          'p',
          {},
          summary.rounds.length +
            (summary.rounds.length === 1 ? ' recorded hole' : ' recorded holes'),
        ),
    ]),
    summary &&
      createElement(
        'nav',
        { key: 'holes', className: 'bp-replay-holes', 'aria-label': 'Played holes' },
        summary.rounds.map((hole) =>
          createElement(
            'button',
            {
              key: hole.index,
              type: 'button',
              'aria-pressed': selected === hole.index,
              onClick: () => setSelected(hole.index),
            },
            [
              createElement('small', {}, 'Hole ' + (hole.index + 1)),
              createElement('strong', {}, hole.title),
              createElement(
                'span',
                {},
                hole.players.filter((track) => track.recorded).length + ' recordings',
              ),
            ],
          ),
        ),
      ),
    error &&
      createElement(
        'p',
        { key: 'error', role: 'alert', className: 'bp-replay-placeholder' },
        error,
      ),
    !error &&
      !round &&
      createElement(
        'p',
        { key: 'loading', className: 'bp-replay-placeholder' },
        'Loading replays…',
      ),
    round && createElement(ReplayViewer, { key: round.index, round }),
    createElement(
      'p',
      { key: 'privacy', className: 'bp-replay-note' },
      'Anyone with this private-link URL can view the recorded match. Recordings are kept until the archive reaches its storage budget.',
    ),
  ]);
}
