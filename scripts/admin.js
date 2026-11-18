const byId = (id) => document.getElementById(id);
let data = null;
let poll = null;
let fetching = false;
let generation = 0;
const expanded = new Set();

const node = (tag, text = '', className = '') => {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) {
    element.className = className;
  }
  return element;
};
const time = (timestamp) => new Date(timestamp).toLocaleString();
const label = (value) =>
  String(value ?? '')
    .replaceAll('-', ' ')
    .replaceAll('_', ' ');
async function api(endpoint, body) {
  const response = await fetch('/api/admin/' + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(result.error), { status: response.status });
  }
  return result;
}
function lock(error = '') {
  generation++;
  clearInterval(poll);
  poll = null;
  data = null;
  expanded.clear();
  for (const id of ['metrics', 'rooms', 'activity']) {
    byId(id).replaceChildren();
  }
  byId('dashboard').hidden = true;
  byId('unlock').hidden = false;
  byId('login-error').textContent = error;
  byId('password').value = '';
}
function table(headings, rows) {
  const wrapper = node('div', '', 'admin-table-wrap');
  const result = node('table');
  const head = node('thead');
  const header = node('tr');
  headings.forEach((heading) => header.append(node('th', heading)));
  head.append(header);
  const body = node('tbody');
  rows.forEach((cells) => {
    const row = node('tr');
    cells.forEach((cell) => row.append(node('td', String(cell ?? '—'))));
    body.append(row);
  });
  result.append(head, body);
  wrapper.append(result);
  return wrapper;
}
function renderRooms() {
  if (!data) {
    return;
  }
  const rooms = byId('rooms');
  const visible = data.rooms.filter((room) => !byId('connected-only').checked || room.connected);
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
function renderActivity() {
  if (!data) {
    return;
  }
  const search = byId('filter').value.trim().toLowerCase();
  const kind = byId('event-kind').value;
  const body = byId('activity');
  body.replaceChildren();
  const events = data.events.filter((event) => {
    const matchingKind =
      !kind ||
      (kind === 'error'
        ? /error|failed|blocked|missing/.test(event.event)
        : event.event.startsWith(kind + '_'));
    return matchingKind && Object.values(event).join(' ').toLowerCase().includes(search);
  });
  byId('activity-note').textContent = data.loggingEnabled
    ? events.length + ' of ' + data.events.length + ' recent events (up to 500).'
    : 'Gameplay logging is not configured.';
  for (const event of events) {
    const row = node('tr');
    const details = Object.entries(event)
      .filter(([key]) => !['timestamp', 'room', 'event'].includes(key))
      .map(([key, value]) => label(key) + ': ' + value)
      .join(' · ');
    for (const value of [time(event.timestamp), event.room ?? '—', label(event.event), details]) {
      row.append(node('td', value));
    }
    body.append(row);
  }
}
function render() {
  byId('unlock').hidden = true;
  byId('dashboard').hidden = false;
  byId('updated').textContent = 'Updated ' + new Date(data.now).toLocaleTimeString();
  const connected = data.rooms.reduce((sum, room) => sum + room.connected, 0);
  const active = data.rooms.filter(
    (room) => room.connected && ['playing', 'countdown', 'hole-results'].includes(room.phase),
  ).length;
  byId('metrics').replaceChildren(
    ...[
      ['Connected players', connected],
      ['Active matches', active],
      ['Rooms', data.rooms.length],
      ['Loaded courses', data.maps],
    ].map(([title, value]) => {
      const metric = node('div', '', 'admin-metric');
      metric.append(node('strong', String(value)), node('span', title));
      return metric;
    }),
  );
  renderRooms();
  renderActivity();
}
async function refresh() {
  if (fetching) {
    return;
  }
  fetching = true;
  const started = generation;
  try {
    const next = await api('status');
    if (started !== generation) {
      return;
    }
    data = next;
    render();
    byId('dashboard-error').textContent = '';
    if (!poll) {
      poll = setInterval(() => {
        if (!document.hidden) {
          refresh();
        }
      }, 5000);
    }
  } catch (error) {
    if (started !== generation) {
      return;
    }
    if (error.status === 401 || !data) {
      lock(error.status === 401 ? '' : error.message);
    } else {
      byId('dashboard-error').textContent = error.message;
    }
  } finally {
    fetching = false;
  }
}
byId('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  byId('login-error').textContent = '';
  try {
    await api('login', { password: byId('password').value });
    byId('password').value = '';
    await refresh();
  } catch (error) {
    byId('login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
byId('logout').addEventListener('click', async () => {
  try {
    await api('logout', {});
    lock();
  } catch (error) {
    if (error.status === 401) {
      lock();
    } else {
      byId('dashboard-error').textContent = error.message;
    }
  }
});
byId('refresh').addEventListener('click', refresh);
byId('connected-only').addEventListener('change', renderRooms);
byId('filter').addEventListener('input', renderActivity);
byId('event-kind').addEventListener('change', renderActivity);
refresh();
