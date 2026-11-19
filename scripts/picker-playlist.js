/**
 * Saved and shared playlists: the document format, its validation and the
 * local persistence the playlist editor reads and writes.
 *
 * Everything here is a plain function of its inputs - no React, no party
 * state - so the format's rules live in one place and the picker component
 * only ever sees validated data.
 */
/**
 * A shared playlist is a small versioned document, not a stored object.
 *
 * It carries the public course ids in order - duplicates included, because a
 * playlist may deliberately play a hole twice - and an optional set of lobby
 * settings. It deliberately carries nothing else: no host capability, no session,
 * no course specification. A specification is the course itself, and copying one
 * into a shareable file would ship upstream geometry and pin a stale version of it;
 * the ids are re-resolved against the live API on import instead.
 */
const PLAYLIST_FORMAT = 'better-party.playlist';
const PLAYLIST_VERSION = 1;
/** The public course id alphabet the server accepts. */
const PLAYLIST_COURSE_ID = /^[A-Za-z0-9_-]{5,64}$/;
const PLAYLIST_MAX_IDS = 10000;

export function serializePlaylist(name, ids, settings) {
  return JSON.stringify(
    {
      format: PLAYLIST_FORMAT,
      version: PLAYLIST_VERSION,
      name,
      ids: [...ids],
      settings,
    },
    null,
    2,
  );
}

/**
 * Parse a shared playlist, refusing anything that is not one.
 *
 * Every refusal names what is wrong, because the input came from a person pasting
 * text rather than from our own storage. Unknown top-level keys and unknown setting
 * keys are ignored rather than rejected: a newer export from a future version that
 * still uses version 1 should degrade, not fail.
 */
export function parsePlaylistDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Error('That is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Error('A playlist must be a JSON object.');
  }
  if (parsed.format !== PLAYLIST_FORMAT) {
    throw Error('That is not a Better Party playlist.');
  }
  if (parsed.version !== PLAYLIST_VERSION) {
    throw Error('That playlist was made by a different version.');
  }
  if (!Array.isArray(parsed.ids) || parsed.ids.length === 0) {
    throw Error('A playlist needs at least one course.');
  }
  if (parsed.ids.length > PLAYLIST_MAX_IDS) {
    throw Error('That playlist has too many courses.');
  }
  const invalid = parsed.ids.find((id) => typeof id !== 'string' || !PLAYLIST_COURSE_ID.test(id));
  if (invalid !== undefined) {
    throw Error('That playlist contains an invalid course ID.');
  }
  const name =
    typeof parsed.name === 'string' && parsed.name.trim()
      ? parsed.name.trim().slice(0, 60)
      : 'Imported playlist';
  return { name, ids: parsed.ids.slice(), settings: parsed.settings };
}

/** The settings worth sharing, and only the ones this build can validate. */
export function shareableSettings(config) {
  return {
    timerMs: config.timerMs,
    elimination: config.elimination,
    maxPlayers: config.maxPlayers,
    lateJoin: config.lateJoin,
  };
}

/**
 * Keep only settings that are valid for this build.
 *
 * The document is untrusted input, so a setting is applied only when it passes the
 * same bounds the lobby enforces; anything else is dropped rather than sent to the
 * server to be refused.
 */
export function sanitizedSettings(settings) {
  const result = {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return result;
  }
  if (Number.isInteger(settings.timerMs) && settings.timerMs >= 0 && settings.timerMs <= 86400000) {
    result.timerMs = settings.timerMs;
  }
  if (typeof settings.elimination === 'boolean') {
    result.elimination = settings.elimination;
  }
  if (
    Number.isInteger(settings.maxPlayers) &&
    settings.maxPlayers >= 1 &&
    settings.maxPlayers <= 50
  ) {
    result.maxPlayers = settings.maxPlayers;
  }
  if (['never', 'next-hole', 'always'].includes(settings.lateJoin)) {
    result.lateJoin = settings.lateJoin;
  }
  return result;
}

/**
 * The official public hole link, recovered from the pinned client.
 *
 * The gallery builds share links as `${origin}/h/${id}` and the hole page uses the
 * route `/h/$id`, so that is the shape to accept. Only the **id** is ever taken from
 * the input; the pasted URL is never fetched. That is what makes host leniency safe
 * - `www.` is accepted because a copied link may carry it, not because we would ever
 * contact it.
 */
const COURSE_URL_HOSTS = ['putt.day', 'www.putt.day'];
/** The same alphabet `PUBLIC_COURSE_ID` enforces on the server. */
const COURSE_URL_ID = /^[a-zA-Z0-9_-]{5,64}$/;

export function parseCourseUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) {
    throw Error('Paste a course link first.');
  }
  // A bare id is what a player gets by copying from our own UI, and it cannot be
  // confused with a URL, so it is accepted as-is.
  if (COURSE_URL_ID.test(text)) {
    return text;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw Error('That does not look like a course link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Error('That does not look like a course link.');
  }
  if (!COURSE_URL_HOSTS.includes(url.hostname)) {
    throw Error('Only putt.day course links are supported.');
  }
  if (url.username || url.password) {
    throw Error('That does not look like a course link.');
  }
  const match = /^\/h\/([^/]+)\/?$/.exec(url.pathname);
  if (!match || !COURSE_URL_ID.test(match[1])) {
    throw Error('That link is not a public course link.');
  }
  return match[1];
}

/**
 * Saved playlists, read defensively.
 *
 * The store is a single JSON array under one key, so a corrupt value loses
 * everything at once. The rule here is that nothing is destroyed to recover: an
 * entry that cannot be understood is left in place and reported, so a later fix can
 * still find it, and an older entry with no `id` is given one rather than discarded.
 */
function normalizePlaylist(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  if (typeof entry.name !== 'string' || !entry.name.trim()) {
    return null;
  }
  if (!Array.isArray(entry.ids) || entry.ids.length === 0) {
    return null;
  }
  if (!entry.ids.every((id) => typeof id === 'string' && PLAYLIST_COURSE_ID.test(id))) {
    return null;
  }
  return {
    // Migration: an entry written before ids existed still belongs to its owner.
    id: typeof entry.id === 'string' && entry.id ? entry.id : crypto.randomUUID(),
    name: entry.name.trim().slice(0, 60),
    ids: entry.ids.slice(),
  };
}

export function readSavedPlaylists() {
  let raw;
  try {
    raw = localStorage.getItem('bp.playlists.v1');
  } catch {
    return {
      playlists: [],
      problem: 'This browser is blocking site storage, so saved playlists are unavailable.',
    };
  }
  if (!raw) {
    return { playlists: [], problem: '' };
  }
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return {
      playlists: [],
      problem: 'Saved playlists could not be read. The stored data was left untouched.',
    };
  }
  if (!Array.isArray(stored)) {
    return {
      playlists: [],
      problem: 'Saved playlists could not be read. The stored data was left untouched.',
    };
  }
  const playlists = [];
  let dropped = 0;
  for (const entry of stored) {
    const normalized = normalizePlaylist(entry);
    if (normalized) {
      playlists.push(normalized);
    } else {
      dropped += 1;
    }
  }
  return {
    playlists: playlists.slice(0, 30),
    problem: dropped
      ? dropped +
        (dropped === 1 ? ' saved playlist could not' : ' saved playlists could not') +
        ' be read and were left in place.'
      : '',
  };
}
