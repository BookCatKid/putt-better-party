/**
 * The operations dashboard.
 *
 * A standalone script, so it is ordinary strict TypeScript. It polls
 * `/api/admin/status` and renders rooms, players and a recent event tail. Two
 * invariants matter and are both encoded in types rather than comments:
 *
 *  - Nothing from the server is trusted to exist. Player names and event details
 *    are rendered with `textContent`, never markup, because both are
 *    user-controlled.
 *  - A `401` means the session is gone, so the page locks rather than retrying
 *    forever with a credential that will never work again.
 */

/** A player row inside a room card. */
interface AdminPlayer {
  name: string;
  role: string;
  connected: boolean;
  isHost: boolean;
  ready: boolean;
  alive: boolean;
  strokes: number;
  totalStrokes: number;
  totalTimeMs: number;
  holeTimeMs: number | null;
  holesSurvived: number;
}

/** One course in an open vote. */
interface AdminVoteChoice {
  title: string;
  votes: number;
}

/** One scored row of a completed round. */
interface AdminRoundScore {
  name: string;
  strokes: number | null;
  status: string;
  timeMs: number | null;
}

/** A completed round, which can have no scores at all. */
interface AdminRound {
  hole: number;
  title: string;
  par: number;
  status: string;
  completed: number;
  scores: AdminRoundScore[];
}

/** One room as the dashboard displays it. */
interface AdminRoomSummary {
  code: string;
  phase: string;
  preparing: boolean;
  connected: number;
  players: AdminPlayer[];
  currentHole: number | null;
  course: string | null;
  holes: number;
  timerEndsAt: number | null;
  elimination: boolean;
  locked: boolean;
  lateJoin: string;
  courseVoting: boolean;
  vote: AdminVoteChoice[] | null;
  lastActivity: number;
  rounds: AdminRound[];
}

/** A single log entry, already reduced to safe scalar fields by the server. */
interface AdminEvent {
  timestamp?: number;
  room?: string;
  event: string;
  [field: string]: unknown;
}

/** The whole dashboard payload. */
interface AdminStatus {
  now: number;
  rooms: AdminRoomSummary[];
  maps: number;
  loggingEnabled: boolean;
  events: AdminEvent[];
}

/** An error carrying the HTTP status, so a `401` can be told from a real failure. */
interface ApiFailure extends Error {
  status?: number;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`The admin page is missing its #${id} element.`);
  }
  return element as T;
}

let data: AdminStatus | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let fetching = false;
let generation = 0;
const expanded = new Set<string>();

const METRIC_IDS = ['metrics', 'rooms', 'activity'] as const;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) {
    element.className = className;
  }
  return element;
}

const time = (timestamp: number): string => new Date(timestamp).toLocaleString();
const label = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('-', ' ')
    .replaceAll('_', ' ');

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Something went wrong.';
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error as ApiFailure;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

async function api<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/admin/' + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw Object.assign(new Error(result.error ?? 'Request failed.'), {
      status: response.status,
    }) as ApiFailure;
  }
  return result;
}

/** Drop every trace of the previous session, including in-flight work. */
function lock(error = ''): void {
  generation++;
  if (poll !== null) {
    clearInterval(poll);
    poll = null;
  }
  data = null;
  expanded.clear();
  for (const id of METRIC_IDS) {
    required(id).replaceChildren();
  }
  required('dashboard').hidden = true;
  required('unlock').hidden = false;
  required('login-error').textContent = error;
  required<HTMLInputElement>('password').value = '';
}

function table(headings: string[], rows: Array<Array<string | number>>): HTMLElement {
  const wrapper = node('div', '', 'admin-table-wrap');
  const result = node('table');
  const head = node('thead');
  const header = node('tr');
  for (const heading of headings) {
    header.append(node('th', heading));
  }
  head.append(header);
  const body = node('tbody');
  for (const cells of rows) {
    const row = node('tr');
    for (const cell of cells) {
      row.append(node('td', String(cell ?? '—')));
    }
    body.append(row);
  }
  result.append(head, body);
  wrapper.append(result);
  return wrapper;
}

function renderRooms(): void {
  if (!data) {
    return;
  }
  const rooms = required('rooms');
  const connectedOnly = required<HTMLInputElement>('connected-only').checked;
  const visible = data.rooms.filter((room) => !connectedOnly || room.connected > 0);
  rooms.replaceChildren();
  if (!visible.length) {
    rooms.append(node('p', 'No rooms to display.', 'admin-muted'));
  }
  for (const room of visible) {
    const card = node('details', '', 'admin-room');
    card.open = expanded.has(room.code);
    card.addEventListener('toggle', () => {
      if (card.open) {
        expanded.add(room.code);
      } else {
        expanded.delete(room.code);
      }
    });
    const summary = node('summary');
    const title = node('span', '', 'admin-room-title');
    title.append(
      node('strong', room.code),
      node('span', room.preparing ? 'Loading courses' : label(room.phase), 'admin-phase'),
    );
    if (room.course && room.currentHole) {
      title.append(
        node('span', 'Hole ' + room.currentHole + '/' + room.holes + ' · ' + room.course),
      );
    }
    summary.append(title, node('span', room.connected + ' connected', 'admin-muted'));
    card.append(summary);
    const info = [
      room.elimination ? 'Elimination' : 'Stroke play',
      room.locked ? 'Locked' : 'Open',
      'Late join: ' + label(room.lateJoin),
      room.courseVoting ? 'Course voting' : 'No voting',
      'Last active: ' + time(room.lastActivity),
    ];
    if (room.timerEndsAt) {
      info.push('Round ends: ' + time(room.timerEndsAt));
    }
    card.append(node('p', info.join(' · '), 'admin-room-info'));
    if (room.vote) {
      card.append(
        node('h3', 'Course vote'),
        table(
          ['Course', 'Votes'],
          room.vote.map((choice) => [choice.title, choice.votes]),
        ),
      );
    }
    card.append(node('h3', 'Players'));
    if (room.players.length) {
      card.append(
        table(
          [
            'Name',
            'Role',
            'Connection',
            'Current strokes',
            'Hole time',
            'Total',
            'Total time',
            'Holes',
          ],
          room.players.map((player) => [
            player.name + (player.isHost ? ' (host)' : ''),
            player.role,
            player.connected ? 'Connected' : 'Disconnected',
            player.strokes,
            player.holeTimeMs == null ? '—' : (player.holeTimeMs / 1000).toFixed(3) + 's',
            player.totalStrokes,
            (player.totalTimeMs / 1000).toFixed(3) + 's',
            player.holesSurvived,
          ]),
        ),
      );
    } else {
      card.append(node('p', 'No players.', 'admin-muted'));
    }
    if (room.rounds.length) {
      card.append(
        node('h3', 'Completed rounds'),
        table(
          ['Hole', 'Course', 'Player', 'Strokes', 'Time', 'Status'],
          room.rounds.flatMap((round) =>
            round.scores.length
              ? round.scores.map((score) => [
                  round.hole,
                  round.title,
                  score.name,
                  score.strokes ?? '—',
                  score.timeMs == null ? '—' : (score.timeMs / 1000).toFixed(3) + 's',
                  score.status,
                ])
              : [[round.hole, round.title, '—', '—', '—', round.status]],
          ),
        ),
      );
    }
    rooms.append(card);
  }
}

function renderActivity(): void {
  if (!data) {
    return;
  }
  const search = required<HTMLInputElement>('filter').value.trim().toLowerCase();
  const kind = required<HTMLSelectElement>('event-kind').value;
  const body = required('activity');
  body.replaceChildren();
  const events = data.events.filter((event) => {
    const matchingKind =
      !kind ||
      (kind === 'error'
        ? /error|failed|blocked|missing/.test(event.event)
        : event.event.startsWith(kind + '_'));
    return matchingKind && Object.values(event).join(' ').toLowerCase().includes(search);
  });
  required('activity-note').textContent = data.loggingEnabled
    ? events.length + ' of ' + data.events.length + ' recent events (up to 500).'
    : 'Gameplay logging is not configured.';
  for (const event of events) {
    const row = node('tr');
    const details = Object.entries(event)
      .filter(([key]) => !['timestamp', 'room', 'event'].includes(key))
      .map(([key, value]) => label(key) + ': ' + String(value))
      .join(' · ');
    const cells = [time(event.timestamp ?? 0), event.room ?? '—', label(event.event), details];
    for (const cell of cells) {
      row.append(node('td', String(cell)));
    }
    body.append(row);
  }
}

function render(): void {
  if (!data) {
    return;
  }
  required('unlock').hidden = true;
  required('dashboard').hidden = false;
  required('updated').textContent = 'Updated ' + new Date(data.now).toLocaleTimeString();
  const connected = data.rooms.reduce((sum, room) => sum + room.connected, 0);
  const active = data.rooms.filter((room) =>
    ['playing', 'countdown', 'hole-results'].includes(room.phase),
  ).length;
  const metrics: Array<[string, number]> = [
    ['Connected players', connected],
    ['Active matches', active],
    ['Rooms', data.rooms.length],
    ['Loaded courses', data.maps],
  ];
  required('metrics').replaceChildren(
    ...metrics.map(([title, value]) => {
      const metric = node('div', '', 'admin-metric');
      metric.append(node('strong', String(value)), node('span', title));
      return metric;
    }),
  );
  renderRooms();
  renderActivity();
}

async function refresh(): Promise<void> {
  if (fetching) {
    return;
  }
  fetching = true;
  const started = generation;
  try {
    const next = await api<AdminStatus>('status');
    // A lock or logout happened while this request was in flight.
    if (started !== generation) {
      return;
    }
    data = next;
    render();
    required('dashboard-error').textContent = '';
    if (poll === null) {
      poll = setInterval(() => {
        if (!document.hidden) {
          void refresh();
        }
      }, 5000);
    }
  } catch (error) {
    if (started !== generation) {
      return;
    }
    const status = statusOf(error);
    if (status === 401 || !data) {
      lock(status === 401 ? '' : describe(error));
    } else {
      required('dashboard-error').textContent = describe(error);
    }
  } finally {
    fetching = false;
  }
}

async function submitLogin(form: HTMLFormElement): Promise<void> {
  const button = form.querySelector('button');
  if (button) {
    button.disabled = true;
  }
  required('login-error').textContent = '';
  try {
    await api('login', { password: required<HTMLInputElement>('password').value });
    required<HTMLInputElement>('password').value = '';
    await refresh();
  } catch (error) {
    required('login-error').textContent = describe(error);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

required<HTMLFormElement>('login').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form instanceof HTMLFormElement) {
    void submitLogin(form);
  }
});

required('logout').addEventListener('click', async () => {
  try {
    await api('logout', {});
    lock();
  } catch (error) {
    if (statusOf(error) === 401) {
      lock();
    } else {
      required('dashboard-error').textContent = describe(error);
    }
  }
});

required('refresh').addEventListener('click', () => void refresh());
required('connected-only').addEventListener('change', renderRooms);
required('filter').addEventListener('input', renderActivity);
required('event-kind').addEventListener('change', renderActivity);
void refresh();

export {};
