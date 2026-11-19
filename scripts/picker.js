// Adapt the original _site.holes community card markup and class names.
// Party-specific actions replace Play/Fork and account-only controls.

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

function serializePlaylist(name, ids, settings) {
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
function parsePlaylistDocument(text) {
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
function shareableSettings(config) {
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
function sanitizedSettings(settings) {
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

function parseCourseUrl(input) {
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

function readSavedPlaylists() {
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

function CommunityCoursePicker({ config, holeSettings }) {
  const [pickerOpen, setPickerOpen] = BetterPartyReact.useState(false);
  const dialog = BetterPartyReact.useRef(null);
  const [genMaximum, setGenMaximum] = BetterPartyReact.useState('');
  const [search, setSearch] = BetterPartyReact.useState('');
  const [sort, setSort] = BetterPartyReact.useState('new');
  const [rating, setRating] = BetterPartyReact.useState(0);
  const [daily, setDaily] = BetterPartyReact.useState(false);
  const [maker, setMaker] = BetterPartyReact.useState(null);
  const [page, setPage] = BetterPartyReact.useState({ holes: [] });
  const [names, setNames] = BetterPartyReact.useState({});
  const [loading, setLoading] = BetterPartyReact.useState(false);
  const [busy, setBusy] = BetterPartyReact.useState(false);
  const [progress, setProgress] = BetterPartyReact.useState('');
  const [error, setError] = BetterPartyReact.useState('');
  const [generatorOpen, setGeneratorOpen] = BetterPartyReact.useState(false);
  const [genSearch, setGenSearch] = BetterPartyReact.useState('');
  const [genDaily, setGenDaily] = BetterPartyReact.useState('any');
  const [genSort, setGenSort] = BetterPartyReact.useState('new');
  const [genMode, setGenMode] = BetterPartyReact.useState('replace');
  const [genRanges, setGenRanges] = BetterPartyReact.useState({});
  const [genJob, setGenJob] = BetterPartyReact.useState(null);
  const generatorActive = BetterPartyReact.useRef(false);
  const mounted = BetterPartyReact.useRef(true);
  BetterPartyReact.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [savedLoad, setSavedLoad] = BetterPartyReact.useState(() => readSavedPlaylists());
  const saved = savedLoad.playlists;
  const [savedId, setSavedId] = BetterPartyReact.useState('');
  const [confirming, setConfirming] = BetterPartyReact.useState('');
  const [saveName, setSaveName] = BetterPartyReact.useState('');
  const [transfer, setTransfer] = BetterPartyReact.useState('');
  const [courseUrl, setCourseUrl] = BetterPartyReact.useState('');
  const [drag, setDrag] = BetterPartyReact.useState(null);
  /**
   * Write the whole list, reporting rather than swallowing a failure.
   *
   * A failed write must leave the previous list intact, so state only advances once
   * `setItem` has actually succeeded. Quota is called out by name because "could not
   * save" is unhelpful when the fix is to delete something.
   */
  function store(next) {
    try {
      localStorage.setItem('bp.playlists.v1', JSON.stringify(next));
      setSavedLoad({ playlists: next, problem: '' });
      return true;
    } catch (err) {
      const quota = err && (err.name === 'QuotaExceededError' || err.code === 22);
      setError(
        quota
          ? 'This browser has no room left for another playlist. Delete one and try again.'
          : 'Could not save playlist: ' + err.message,
      );
      return false;
    }
  }
  function save() {
    const name = saveName.trim().slice(0, 60);
    if (!name || !picked.length) {
      return;
    }
    // Overwriting is explicit: an existing name asks first instead of quietly
    // replacing a playlist the player may not have meant to touch.
    if (saved.some((playlist) => playlist.name === name)) {
      setConfirming('overwrite');
      return;
    }
    commitSave(name);
  }
  function commitSave(name) {
    const id = crypto.randomUUID();
    const written = store(
      [{ id, name, ids: [...picked] }, ...saved.filter((playlist) => playlist.name !== name)].slice(
        0,
        30,
      ),
    );
    if (written) {
      setSavedId(id);
      setSaveName('');
      setConfirming('');
    }
  }
  function renameSaved() {
    const name = saveName.trim().slice(0, 60);
    if (!savedId || !name) {
      return;
    }
    if (saved.some((playlist) => playlist.id !== savedId && playlist.name === name)) {
      setError('Another saved playlist already has that name.');
      return;
    }
    const written = store(
      saved.map((playlist) => (playlist.id === savedId ? { ...playlist, name } : playlist)),
    );
    if (written) {
      setSaveName('');
    }
  }
  function duplicateSaved() {
    const source = saved.find((playlist) => playlist.id === savedId);
    if (!source) {
      return;
    }
    const base = (saveName.trim() || source.name + ' copy').slice(0, 60);
    let name = base;
    let suffix = 2;
    while (saved.some((playlist) => playlist.name === name)) {
      name = (base + ' ' + suffix).slice(0, 60);
      suffix += 1;
    }
    const id = crypto.randomUUID();
    const written = store([{ id, name, ids: [...source.ids] }, ...saved].slice(0, 30));
    if (written) {
      setSavedId(id);
      setSaveName('');
    }
  }
  function deleteSaved() {
    if (!savedId) {
      return;
    }
    // Deleting is irreversible, so it takes a second, deliberate click.
    if (confirming !== 'delete') {
      setConfirming('delete');
      return;
    }
    const written = store(saved.filter((playlist) => playlist.id !== savedId));
    if (written) {
      setSavedId('');
      setConfirming('');
    }
  }
  /**
   * Put the current selection into the transfer box as a shareable document.
   *
   * The box is the artefact: it is editable, selectable and can be pasted anywhere.
   * Copying to the clipboard is attempted as a convenience, but a blocked clipboard
   * is not a failure here because the text is already visible and selected.
   */
  function exportPlaylist() {
    if (!picked.length) {
      setError('Add at least one course before exporting.');
      return;
    }
    const text = serializePlaylist(
      saveName.trim() || 'Playlist',
      picked,
      shareableSettings(config),
    );
    setTransfer(text);
    setError('');
    void navigator.clipboard?.writeText(text).catch(() => {
      // The document is in the box either way.
    });
  }

  /**
   * Resolve a shared document against the live catalogue and apply it.
   *
   * The ids are re-validated one at a time exactly like a saved playlist, so an
   * entry that no longer exists upstream is reported instead of being dropped, and
   * order and intentional duplicates are preserved because the applied list is the
   * document's own `ids`.
   */
  async function importPlaylist() {
    if (busy || preparing) {
      return;
    }
    let document;
    try {
      document = parsePlaylistDocument(transfer);
    } catch (parseError) {
      setError(parseError.message);
      return;
    }
    setBusy(true);
    setError('');
    bpPickerBusy(true);
    try {
      const state = betterPartyStore.state;
      const code = state.code;
      const auth = {
        code,
        uid: state.self.uid,
        session: state.self.session,
        host: sessionStorage.getItem('bp.host.' + code),
      };
      const pending = [...new Set(document.ids)].filter((id) => !names[id]);
      for (const [index, id] of pending.entries()) {
        if (
          betterPartyStore.state.code !== code ||
          betterPartyStore.state.phase !== 'lobby' ||
          betterPartyStore.state.config.mapSource !== 'picked'
        ) {
          throw Error('The lobby changed while loading the playlist');
        }
        const response = await fetch('/api/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...auth, id, saved: true }),
        });
        const imported = await response.json();
        if (!response.ok) {
          throw Error(imported.error || 'Could not load playlist');
        }
        setNames((previousNames) => ({ ...previousNames, [id]: imported.title }));
        setProgress('Checking ' + (index + 1) + ' of ' + pending.length + ' courses…');
      }
      update(document.ids);
      const settings = sanitizedSettings(document.settings);
      if (Object.keys(settings).length) {
        updateBetterPartyConfig(settings);
      }
      setTransfer('');
    } catch (importError) {
      setError(importError.message);
    } finally {
      setBusy(false);
      bpPickerBusy(false);
      setProgress('');
    }
  }

  /**
   * Add the course named by a pasted link.
   *
   * The link is parsed for its id and then discarded; the request goes to our own
   * `/api/import`, so a pasted URL can never make the browser (or the server) fetch
   * an arbitrary address.
   */
  async function addFromUrl() {
    if (busy || preparing) {
      return;
    }
    let id;
    try {
      id = parseCourseUrl(courseUrl);
    } catch (parseError) {
      setError(parseError.message);
      return;
    }
    await addCourseById(id);
    setCourseUrl('');
  }

  async function loadSaved() {
    const selected = saved.find((playlist) => playlist.id === savedId);
    if (!selected || busy || preparing) {
      return;
    }
    setBusy(true);
    setError('');
    bpPickerBusy(true);
    try {
      const state = betterPartyStore.state;
      const code = state.code;
      const auth = {
        code,
        uid: state.self.uid,
        session: state.self.session,
        host: sessionStorage.getItem('bp.host.' + code),
      };
      const items = [];
      // A course already named in this session is one upstream has validated: the
      // catalog only lists public courses and an import only succeeds for one. So
      // re-fetching it on every saved-playlist load is redundant work - the thing
      // this avoids. It is not a permanent decision: the match start still retrieves
      // every course fresh, so a course deleted in the meantime fails there with an
      // explicit error rather than silently.
      const uniqueIds = [...new Set(selected.ids)];
      const pending = uniqueIds.filter((id) => !names[id]);
      for (const [index, id] of pending.entries()) {
        if (
          betterPartyStore.state.code !== code ||
          betterPartyStore.state.phase !== 'lobby' ||
          betterPartyStore.state.config.mapSource !== 'picked'
        ) {
          throw Error('The lobby changed while loading the playlist');
        }
        const response = await fetch('/api/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...auth, id, saved: true }),
        });
        const imported = await response.json();
        if (!response.ok) {
          throw Error(imported.error || 'Could not load playlist');
        }
        items.push(imported);
        setProgress('Loading ' + (index + 1) + ' of ' + pending.length + ' unique courses…');
      }
      setNames((previousNames) => ({
        ...previousNames,
        ...Object.fromEntries(items.map((course) => [course.id, course.title])),
      }));
      if (
        betterPartyStore.state.code !== code ||
        betterPartyStore.state.phase !== 'lobby' ||
        betterPartyStore.state.config.mapSource !== 'picked'
      ) {
        throw Error('The lobby changed while loading the playlist');
      }
      update([...selected.ids]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      bpPickerBusy(false);
      setProgress('');
    }
  }

  const titles =
    useBetterPartyState(betterPartyStore, (partyState) => partyState.playlistTitles) ?? {};
  const preparing = useBetterPartyState(betterPartyStore, (partyState) => partyState.preparing);
  BetterPartyReact.useEffect(() => {
    const element = dialog.current;
    if (pickerOpen && config.mapSource === 'picked' && element && !element.open) {
      element.showModal();
    }
    return () => {
      if (element?.open) {
        element.close();
      }
    };
  }, [pickerOpen, config.mapSource]);
  const picked = config.selectedHoleIds ?? [];
  const update = (ids) =>
    updateBetterPartyConfig({
      mapSource: 'picked',
      selectedHoleIds: ids,
      holes: Math.max(1, ids.length),
    });
  const createElement = BetterPartyReact.createElement;
  const pill =
    'rounded-full border border-[var(--line)] px-3.5 py-1.5 text-sm font-bold text-[var(--sea-ink-soft)] hover:border-emerald-500';
  const green =
    'rounded-full bg-emerald-500 px-4 py-1.5 font-bold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50';
  const actionButton = (label, onClick, disabled = false, classNames = pill, extra = {}) =>
    createElement(
      'button',
      { type: 'button', onClick, disabled, className: classNames, ...extra },
      label,
    );
  async function generatorRequest(action, filters) {
    const state = betterPartyStore.state;
    const response = await fetch('/api/generate-playlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        filters,
        code: state.code,
        uid: state.self.uid,
        session: state.self.session,
        host: sessionStorage.getItem('bp.host.' + state.code),
      }),
    });
    const job = await response.json();
    if (!response.ok) {
      throw Error(job.error || 'Could not generate playlist');
    }
    return job;
  }

  async function generate() {
    if (busy || preparing || generatorActive.current) {
      return;
    }
    const ranges = Object.fromEntries(
      Object.entries(genRanges).map(([metric, bounds]) => [
        metric,
        Object.fromEntries(
          Object.entries(bounds)
            .filter(([_bound, value]) => value !== '')
            .map(([bound, value]) => [bound, Number(value)]),
        ),
      ]),
    );
    if (
      genMaximum !== '' &&
      (!Number.isInteger(Number(genMaximum)) ||
        Number(genMaximum) < 1 ||
        Number(genMaximum) > 10000)
    ) {
      setError('Maximum courses must be a whole number from 1 to 10000');
      return;
    }
    generatorActive.current = true;
    setBusy(true);
    setError('');
    setGenJob(null);
    bpPickerBusy(true);
    try {
      let job = await generatorRequest('start', {
        search: genSearch,
        daily: genDaily,
        sort: genSort,
        mode: genMode,
        ranges,
        maxCourses: genMaximum === '' ? undefined : Number(genMaximum),
      });
      while (mounted.current) {
        setGenJob(job);
        if (job?.status !== 'running') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (!mounted.current) {
          break;
        }
        job = await generatorRequest('status');
      }
      if (mounted.current && job?.status === 'failed') {
        setError(job.error || 'Playlist generation failed');
      }
    } catch (err) {
      if (mounted.current) {
        setError(err.message);
      }
    } finally {
      generatorActive.current = false;
      if (mounted.current) {
        setBusy(false);
        bpPickerBusy(false);
        setProgress('');
      }
    }
  }

  async function cancelGeneration() {
    try {
      setGenJob(await generatorRequest('cancel'));
    } catch (err) {
      setError(err.message);
    }
  }

  function generatorPanel() {
    const fields = [
      ['rating', 'Average rating', 0, 5, 0.1],
      ['ratings', 'Rating count', 0, 1000000, 1],
      ['par', 'Par', 1, 200, 1],
      ['average', 'Average strokes', 0, 200, 0.1],
      ['overPar', 'Difficulty (avg strokes − par)', -200, 200, 0.1],
    ];
    const select = (label, value, change, options) =>
      createElement('label', { className: 'bp-gen-field' }, [
        createElement('span', {}, label),
        createElement(
          'select',
          {
            value,
            disabled: busy || preparing,
            onChange: (event) => change(event.target.value),
            'aria-label': label,
          },
          options.map(([key, title]) => createElement('option', { key, value: key }, title)),
        ),
      ]);
    const job = genJob;
    let message =
      'Blank bounds are unrestricted. All specified ranges must match. Courses without the requested statistics are excluded.';
    if (job?.status === 'running') {
      message =
        'Scanned ' +
        job.progress.scanned +
        ' of ' +
        (job.progress.total || '…') +
        ' · ' +
        job.progress.matched +
        ' matching';
    } else if (job?.status === 'complete') {
      message = job.selectedCount
        ? job.selectedCount +
          ' courses selected from ' +
          job.progress.matched +
          ' matching courses.'
        : 'No matching courses. Your playlist is unchanged.';
    } else if (job?.status === 'cancelled') {
      message = 'Generation cancelled. Your playlist is unchanged.';
    } else if (job?.status === 'failed') {
      message = job.error || 'Generation failed. Your playlist is unchanged.';
    }
    return createElement(
      'section',
      { className: 'bp-generator', 'aria-label': 'Playlist generator' },
      [
        createElement('h3', { className: 'font-bold' }, 'Generate playlist'),
        createElement('label', { className: 'bp-gen-field' }, [
          createElement('span', {}, 'Title or maker'),
          createElement('input', {
            value: genSearch,
            maxLength: 100,
            disabled: busy || preparing,
            onChange: (event) => setGenSearch(event.target.value),
            placeholder: 'Any',
            'aria-label': 'Playlist search',
          }),
        ]),
        createElement('div', { className: 'bp-gen-ranges' }, [
          createElement('span', {}, 'Filter'),
          createElement('span', {}, 'Min'),
          createElement('span', {}, 'Max'),
          ...fields.flatMap(([metric, label, lower, upper, step]) => [
            createElement('span', { key: metric }, label),
            ...['min', 'max'].map((bound) =>
              createElement('input', {
                key: metric + bound,
                type: 'number',
                min: lower,
                max: upper,
                step,
                value: genRanges[metric]?.[bound] ?? '',
                placeholder: 'Any',
                'aria-label': label + ' ' + bound,
                disabled: busy || preparing,
                onChange: (event) =>
                  setGenRanges((previous) => ({
                    ...previous,
                    [metric]: { ...previous[metric], [bound]: event.target.value },
                  })),
              }),
            ),
          ]),
        ]),
        createElement('div', { className: 'bp-gen-presets' }, [
          createElement('span', {}, 'Difficulty presets'),
          ...[
            ['Any', {}],
            ['At or below par', { max: '0' }],
            ['0–2 over par', { min: '0', max: '2' }],
            ['2+ over par', { min: '2' }],
          ].map(([label, bounds]) =>
            actionButton(
              label,
              () => setGenRanges((previous) => ({ ...previous, overPar: bounds })),
              busy || preparing,
              pill,
              { key: label },
            ),
          ),
        ]),
        createElement('div', { className: 'bp-gen-options' }, [
          createElement('label', { className: 'bp-gen-field' }, [
            createElement(
              'span',
              {},
              genMode === 'append' ? 'Maximum courses to add' : 'Maximum courses',
            ),
            createElement('input', {
              type: 'number',
              min: 1,
              max: 10000,
              step: 1,
              placeholder: 'Unlimited',
              'aria-label': 'Maximum courses',
              value: genMaximum,
              disabled: busy || preparing,
              onChange: (event) => setGenMaximum(event.target.value),
            }),
          ]),
          select('Daily holes', genDaily, setGenDaily, [
            ['any', 'Any'],
            ['exclude', 'Exclude past dailies'],
            ['only', 'Past dailies only'],
          ]),
          select('Order', genSort, setGenSort, [
            ['new', 'Newest first'],
            ['top', 'Top rated'],
            ['trending', 'Trending'],
            ['shuffle', 'Shuffle'],
          ]),
          select('Playlist action', genMode, setGenMode, [
            ['replace', 'Replace playlist'],
            ['append', 'Append unique courses'],
          ]),
        ]),
        createElement(
          'p',
          { className: 'text-xs text-[var(--sea-ink-soft)]', role: 'status' },
          message,
        ),
        error && createElement('p', { role: 'alert', className: 'text-xs text-red-300' }, error),
        createElement('div', { className: 'flex flex-wrap gap-2' }, [
          actionButton(
            genMode === 'append' ? 'Generate & append' : 'Generate & replace',
            generate,
            busy || preparing,
            green,
          ),
          job?.status === 'running'
            ? actionButton('Cancel generation', cancelGeneration, false, pill)
            : actionButton('Close', () => setGeneratorOpen(false), false, pill),
        ]),
        createElement(
          'p',
          { className: 'text-xs text-[var(--sea-ink-soft)]' },
          'All matching courses are scanned before ordering and applying the maximum. Nothing changes until the scan succeeds.',
        ),
      ],
    );
  }

  /**
   * The catalogue query.
   *
   * These are exactly the fields the recovered browse function accepts — `search`,
   * `sort`, `offset`, `minRating`, `daily` and `author` — and nothing else. `author`
   * is the creator's **id**, which is what the original client sends
   * (`author: <creator>.id`), not a display name.
   *
   * **Par is deliberately absent.** It is not in the catalogue payload at all; it
   * only exists inside a course specification, which costs one detail fetch per
   * course. A par filter would therefore either filter just the twenty-four rows
   * already loaded — presenting a page-local slice as if it were the catalogue — or
   * fetch every course to filter it, which is the aggressive upstream traffic this
   * client exists to avoid. Guessing a `par` query field would simply be ignored
   * upstream and silently return unfiltered results.
   */
  const params = (offset) =>
    new URLSearchParams({
      search,
      sort,
      offset: String(offset),
      minRating: String(rating),
      daily: String(daily),
      author: maker?.id ?? '',
    });
  async function fetchCatalogPage(offset, signal) {
    const response = await fetch('/api/catalog?' + params(offset), { signal });
    const catalogPage = await response.json();
    if (!response.ok) {
      throw Error(catalogPage.error || 'Could not load courses');
    }
    return catalogPage;
  }
  const generation = BetterPartyReact.useRef(0);
  BetterPartyReact.useEffect(() => {
    if (config.mapSource !== 'picked' || !pickerOpen) {
      return;
    }
    const abortController = new AbortController();
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError('');
    setPage({ holes: [] });
    const timer = setTimeout(async () => {
      try {
        const catalogPage = await fetchCatalogPage(0, abortController.signal);
        if (!abortController.signal.aborted && requestGeneration === generation.current) {
          setPage(catalogPage);
          setNames((previous) => ({
            ...previous,
            ...Object.fromEntries(catalogPage.holes.map((course) => [course.id, course.title])),
          }));
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          setError(err.message);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      abortController.abort();
      generation.current++;
    };
  }, [config.mapSource, pickerOpen, search, sort, rating, daily, maker]);
  async function more() {
    if (loading || page.nextOffset == null) {
      return;
    }
    const requestGeneration = generation.current;
    setLoading(true);
    setError('');
    try {
      const catalogPage = await fetchCatalogPage(page.nextOffset);
      if (requestGeneration !== generation.current) {
        return;
      }
      setPage((old) => ({
        ...catalogPage,
        holes: [
          ...old.holes,
          ...catalogPage.holes.filter(
            (candidate) => !old.holes.some((existing) => existing.id === candidate.id),
          ),
        ],
      }));
      setNames((previous) => ({
        ...previous,
        ...Object.fromEntries(catalogPage.holes.map((course) => [course.id, course.title])),
      }));
    } catch (err) {
      if (requestGeneration === generation.current) {
        setError(err.message);
      }
    } finally {
      if (requestGeneration === generation.current) {
        setLoading(false);
      }
    }
  }
  async function add(course) {
    await addCourseById(course.id, course.title);
  }

  /**
   * Import one course by id and append it to the playlist.
   *
   * Shared by the catalogue cards and the pasted-link path so both behave
   * identically: same request, same room guard, same append. The id is the only
   * thing a link contributes.
   */
  async function addCourseById(id, title) {
    if (busy || preparing) {
      return;
    }
    setBusy(true);
    setError('');
    bpPickerBusy(true);
    // Capture the room the request is for. The fetch below is awaited, and the
    // host may navigate to another party in the meantime; without this the
    // imported course would be appended to whichever room is current when the
    // response arrives, mixing one party's playlist into another's.
    const code = betterPartyStore.state.code;
    try {
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          uid: betterPartyStore.state.self.uid,
          session: betterPartyStore.state.self.session,
          host: sessionStorage.getItem('bp.host.' + code),
          id,
        }),
      });
      const catalogPage = await response.json();
      if (!response.ok) {
        throw Error(catalogPage.error || 'Could not load map');
      }
      const resolvedTitle = typeof catalogPage.title === 'string' ? catalogPage.title : title;
      setNames((previousNames) => ({ ...previousNames, [id]: resolvedTitle }));
      if (
        betterPartyStore.state.code !== code ||
        betterPartyStore.state.phase !== 'lobby' ||
        betterPartyStore.state.config.mapSource !== 'picked'
      ) {
        return;
      }
      update([...(betterPartyStore.state.config.selectedHoleIds ?? []), id]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      bpPickerBusy(false);
    }
  }
  function move(index, destination) {
    const source = [...picked];
    if (index + destination < 0 || index + destination >= source.length) {
      return;
    }
    const [moved] = source.splice(index, 1);
    source.splice(index + destination, 0, moved);
    update(source);
  }
  /**
   * Shuffle the picked order, keeping the same courses and the same duplicates.
   *
   * Fisher-Yates over the array itself, so a course added twice stays twice: this
   * reorders a playlist, it does not build a set out of one. A single course is left
   * untouched rather than sent as a pointless config change.
   */
  function shufflePicked() {
    if (picked.length < 2) {
      return;
    }
    const next = [...picked];
    for (let index = next.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [next[index], next[swap]] = [next[swap], next[index]];
    }
    update(next);
  }
  function formatCourseAge(timestamp) {
    if (!Number.isFinite(timestamp)) {
      return '';
    }
    const daysAgo = Math.floor((Date.now() - timestamp) / 86_400_000);
    if (daysAgo <= 0) {
      return 'today';
    }
    if (daysAgo === 1) {
      return 'yesterday';
    }
    if (daysAgo < 7) {
      return daysAgo + 'd ago';
    }
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  const image = (courseId, title, classNames, eager = false) =>
    createElement('img', {
      src: '/api/preview/' + encodeURIComponent(courseId),
      alt: title,
      loading: eager ? 'eager' : 'lazy',
      decoding: 'async',
      className: classNames,
      onError: (event) => {
        event.currentTarget.style.opacity = '.35';
      },
    });
  const mode = createElement(
    'label',
    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
    [
      'Maps',
      createElement(
        'select',
        {
          value: config.mapSource,
          onChange: (event) => updateBetterPartyConfig({ mapSource: event.target.value }),
          disabled: busy || preparing,
          style: { background: '#0a1c21', color: '#fff', padding: '8px', borderRadius: 6 },
          'aria-label': 'Party map selection',
        },
        [
          createElement('option', { value: 'random' }, 'Random holes'),
          createElement('option', { value: 'picked' }, 'Choose a playlist'),
        ],
      ),
    ],
  );
  if (config.mapSource === 'random') {
    return createElement('div', {}, [
      mode,
      holeSettings,
      createElement('label', { className: 'bp-number-row mt-3' }, [
        createElement('span', {}, 'Exclude holes played as dailies'),
        createElement('input', {
          type: 'checkbox',
          'aria-label': 'Exclude daily holes',
          checked: !!config.excludeDaily,
          disabled: busy || preparing,
          onChange: (event) => updateBetterPartyConfig({ excludeDaily: event.target.checked }),
        }),
      ]),
      createElement('label', { className: 'bp-number-row mt-3' }, [
        createElement('span', {}, 'Course voting'),
        createElement('input', {
          type: 'checkbox',
          'aria-label': 'Course voting',
          checked: !!config.courseVoting,
          disabled: busy || preparing,
          onChange: (event) => updateBetterPartyConfig({ courseVoting: event.target.checked }),
        }),
      ]),
    ]);
  }
  function card(course, index) {
    const count = picked.filter((id) => id === course.id).length;
    return createElement(
      'li',
      {
        key: course.id,
        className:
          'overflow-hidden rounded-2xl border bg-white/5 transition ' +
          (count ? 'border-emerald-500/50 ring-1 ring-emerald-500/15' : 'border-[var(--line)]'),
      },
      [
        createElement(
          'a',
          {
            href: 'https://putt.day/h/' + encodeURIComponent(course.id),
            target: '_blank',
            rel: 'noopener noreferrer',
            className: 'relative block',
          },
          [
            image(course.id, course.title, 'aspect-[1200/630] w-full object-cover', index < 4),
            count > 0 &&
              createElement(
                'span',
                {
                  className:
                    'absolute left-2 top-2 rounded-full border border-white/70 bg-emerald-600 px-2.5 py-1 text-[11px] font-black uppercase tracking-wide text-white shadow-md',
                },
                '✓ Added' + (count > 1 ? ' ×' + count : ''),
              ),
          ],
        ),
        createElement('div', { className: 'p-3' }, [
          createElement('div', { className: 'flex items-start justify-between gap-2' }, [
            createElement(
              'a',
              {
                href: 'https://putt.day/h/' + encodeURIComponent(course.id),
                target: '_blank',
                rel: 'noopener noreferrer',
                className: 'font-bold text-[var(--sea-ink)] no-underline hover:underline',
              },
              course.title,
            ),
            course.scheduledDay != null &&
              createElement(
                'a',
                {
                  href: 'https://putt.day/day/' + course.scheduledDay,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  className:
                    'shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-300 no-underline',
                },
                'Daily #' + course.scheduledDay,
              ),
          ]),
          createElement('p', { className: 'mt-0.5 text-xs text-[var(--sea-ink-soft)]' }, [
            'by ',
            course.creatorId
              ? createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'underline',
                    onClick: () => setMaker({ id: course.creatorId, name: course.author }),
                  },
                  course.author,
                )
              : course.author,
            ' · ',
            createElement(
              'span',
              { title: new Date(course.createdAt).toLocaleString() },
              formatCourseAge(course.createdAt),
            ),
          ]),
          createElement(
            'div',
            { className: 'mt-2 flex items-center gap-3 text-xs text-[var(--sea-ink-soft)]' },
            [
              Number.isFinite(course.ratingAvg)
                ? createElement('span', {}, [
                    createElement('span', { className: 'text-amber-500' }, [
                      '★'.repeat(Math.max(0, Math.min(5, Math.round(course.ratingAvg)))),
                      createElement(
                        'span',
                        { className: 'text-[var(--line)]' },
                        '★'.repeat(Math.max(0, 5 - Math.round(course.ratingAvg))),
                      ),
                    ]),
                    ' ' + course.ratingAvg.toFixed(1) + ' (' + (course.ratingCount ?? 0) + ')',
                  ])
                : createElement('span', { className: 'opacity-70' }, 'unrated'),
              createElement(
                'span',
                { title: 'Number of completions' },
                '⛳ ' + (course.completionsBucket ?? '—'),
              ),
            ],
          ),
          createElement('div', { className: 'mt-3 flex gap-2 text-xs' }, [
            actionButton(
              count ? 'Add again' : 'Add to playlist',
              () => add(course),
              busy || preparing,
              green,
              {
                'aria-label': 'Add ' + course.title,
              },
            ),
          ]),
        ]),
      ],
    );
  }
  return createElement('div', { className: 'flex flex-col gap-3' }, [
    mode,
    createElement('div', { className: 'bp-picker-summary' }, [
      createElement(
        'span',
        { className: 'text-xs text-white/70' },
        picked.length + (picked.length === 1 ? ' course selected' : ' courses selected'),
      ),
      actionButton(
        'Edit playlist',
        () => setPickerOpen(true),
        busy || preparing,
        'rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white/85 hover:bg-white/20',
      ),
    ]),
    pickerOpen &&
      createElement(
        'dialog',
        {
          ref: dialog,
          className: 'bp-playlist-dialog rounded-3xl bg-[#11272b] shadow-2xl',
          'aria-labelledby': 'bp-playlist-title',
          onCancel: (event) => {
            event.preventDefault();
            if (!busy && !preparing) {
              setPickerOpen(false);
            }
          },
        },
        [
          createElement('header', { className: 'bp-playlist-dialog-header' }, [
            createElement(
              'h2',
              { id: 'bp-playlist-title', className: 'text-xl font-black' },
              'Choose a playlist',
            ),
            actionButton(
              'Done',
              () => setPickerOpen(false),
              busy || preparing,
              'rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40',
            ),
          ]),
          createElement('section', { className: 'bp-community' }, [
            createElement('div', { className: 'mb-4 flex flex-wrap items-center gap-2' }, [
              ...[
                ['new', 'New'],
                ['trending', 'Trending'],
                ['top', 'Top rated'],
              ].map(([value, label]) =>
                actionButton(
                  label,
                  () => setSort(value),
                  false,
                  value === sort
                    ? 'rounded-full bg-emerald-600 px-3.5 py-1.5 text-sm font-bold text-white'
                    : pill,
                ),
              ),
              createElement('input', {
                value: search,
                onChange: (event) => setSearch(event.target.value),
                placeholder: 'Search title or maker…',
                'aria-label': 'Find party holes',
                className:
                  'ml-auto w-48 rounded-full border border-[var(--line)] bg-black/20 px-3.5 py-1.5 text-sm',
              }),
            ]),
            createElement('div', { className: 'mb-4 flex flex-wrap items-center gap-2 text-sm' }, [
              createElement(
                'select',
                {
                  value: rating,
                  onChange: (event) => setRating(Number(event.target.value)),
                  'aria-label': 'Minimum rating',
                  className: 'rounded-full border border-[var(--line)] bg-black/20 px-3 py-1.5',
                },
                [
                  [0, 'Any rating'],
                  [3, '3★ and up'],
                  [4, '4★ and up'],
                ].map(([value, label]) =>
                  createElement('option', { key: value, value: value }, label),
                ),
              ),
              actionButton(
                'Ran as a daily',
                () => setDaily(!daily),
                false,
                daily ? 'rounded-full bg-emerald-600 px-3 py-1.5 font-semibold text-white' : pill,
                { 'aria-pressed': daily },
              ),
              maker &&
                actionButton(
                  'by ' + maker.name + ' ✕',
                  () => setMaker(null),
                  false,
                  'rounded-full bg-violet-600 px-3 py-1.5 font-semibold text-white',
                ),
            ]),
            actionButton(
              'Auto-generate playlist',
              () => setGeneratorOpen(!generatorOpen),
              busy || preparing,
              green,
              { 'aria-expanded': generatorOpen },
            ),
            generatorOpen && generatorPanel(),
            createElement('div', { className: 'bp-catalog-layout' }, [
              createElement('section', { className: 'bp-catalog-scroll' }, [
                error &&
                  createElement(
                    'p',
                    { role: 'alert', className: 'mb-4 text-sm text-red-300' },
                    error,
                  ),
                page.holes.length
                  ? createElement(
                      'ul',
                      {
                        className:
                          'grid grid-cols-1 gap-4 sm:grid-cols-2 ' + (loading ? 'opacity-60' : ''),
                      },
                      page.holes.map(card),
                    )
                  : createElement(
                      'p',
                      { className: 'py-16 text-center text-sm text-[var(--sea-ink-soft)]' },
                      loading ? 'Loading…' : 'No holes match. Try clearing some filters.',
                    ),
                createElement('div', { className: 'mt-6 text-center' }, [
                  createElement(
                    'p',
                    { className: 'text-xs text-[var(--sea-ink-soft)]' },
                    (page.total ?? 0) + ' holes',
                  ),
                  page.nextOffset != null &&
                    actionButton(
                      loading ? 'Loading…' : 'Load more',
                      more,
                      loading,
                      'mt-2 rounded-full bg-emerald-600 px-6 py-2.5 text-sm font-bold text-white disabled:opacity-50',
                    ),
                ]),
              ]),
              createElement('aside', { className: 'bp-playlist-sidebar' }, [
                createElement('h3', { className: 'mb-2 font-bold' }, 'Playlist · ' + picked.length),
                createElement(
                  'div',
                  {
                    className: 'bp-playlist-scroll',
                    tabIndex: 0,
                    'aria-label': 'Selected courses',
                  },
                  [
                    ...picked.map((id, index) =>
                      createElement(
                        'div',
                        {
                          key: index + ':' + id,
                          className: 'bp-playlist-item' + (drag === index ? ' bp-dragging' : ''),
                          draggable: !busy && !preparing,
                          onDragStart: (event) => {
                            setDrag(index);
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', String(index));
                          },
                          onDragOver: (event) => {
                            if (drag !== null) {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = 'move';
                            }
                          },
                          onDragEnd: () => setDrag(null),
                          onDrop: (event) => {
                            event.preventDefault();
                            if (drag !== null && drag !== index) {
                              move(drag, index - drag);
                            }
                            setDrag(null);
                          },
                        },
                        [
                          image(id, names[id] ?? titles[id] ?? id, '', index < 4),
                          createElement('div', {}, [
                            createElement(
                              'p',
                              { className: 'text-xs font-bold' },
                              index + 1 + '. ' + (names[id] ?? titles[id] ?? id),
                            ),
                            createElement('div', { className: 'bp-playlist-actions' }, [
                              actionButton(
                                '↑',
                                () => move(index, -1),
                                index === 0 || busy || preparing,
                                '',
                                {
                                  'aria-label': 'Move hole up',
                                },
                              ),
                              actionButton(
                                '↓',
                                () => move(index, 1),
                                index === picked.length - 1 || busy || preparing,
                                '',
                                {
                                  'aria-label': 'Move hole down',
                                },
                              ),
                              actionButton(
                                '×',
                                () => update(picked.filter((unused, entry) => entry !== index)),
                                busy || preparing,
                                '',
                                { 'aria-label': 'Remove hole' },
                              ),
                            ]),
                          ]),
                        ],
                      ),
                    ),
                    !picked.length &&
                      createElement(
                        'p',
                        { className: 'text-xs text-[var(--sea-ink-soft)]' },
                        'Add holes in the order you want to play.',
                      ),
                  ],
                ),
                picked.length > 0 &&
                  actionButton('Clear', () => update([]), busy || preparing, pill + ' mt-3'),
                picked.length > 1 &&
                  actionButton('Shuffle', shufflePicked, busy || preparing, pill + ' mt-3', {
                    'aria-label': 'Shuffle playlist order',
                  }),
                createElement('div', { className: 'bp-saved-playlists' }, [
                  createElement('input', {
                    'aria-label': 'Playlist name',
                    placeholder: 'Playlist name',
                    value: saveName,
                    maxLength: 60,
                    onChange: (event) => setSaveName(event.target.value),
                  }),
                  actionButton(
                    'Save',
                    save,
                    !saveName.trim() || !picked.length || busy || preparing,
                    pill,
                    {
                      'aria-label': 'Save playlist',
                    },
                  ),
                  createElement(
                    'select',
                    {
                      'aria-label': 'Saved playlists',
                      value: savedId,
                      onChange: (event) => setSavedId(event.target.value),
                    },
                    [
                      createElement('option', { value: '' }, 'Saved playlists…'),
                      // Sorted by name: with more than a handful, insertion order is
                      // no help at all in finding one.
                      ...[...saved]
                        .sort((left, right) => left.name.localeCompare(right.name))
                        .map((playlist) =>
                          createElement(
                            'option',
                            { key: playlist.id, value: playlist.id },
                            playlist.name + ' (' + playlist.ids.length + ')',
                          ),
                        ),
                    ],
                  ),
                  actionButton('Load', loadSaved, !savedId || busy || preparing, pill, {
                    'aria-label': 'Load saved playlist',
                  }),
                  actionButton(
                    'Rename',
                    renameSaved,
                    !savedId || !saveName.trim() || busy || preparing,
                    pill,
                    {
                      'aria-label': 'Rename saved playlist',
                    },
                  ),
                  actionButton('Duplicate', duplicateSaved, !savedId || busy || preparing, pill, {
                    'aria-label': 'Duplicate saved playlist',
                  }),
                  actionButton('Delete', deleteSaved, !savedId || busy || preparing, pill, {
                    'aria-label': 'Delete saved playlist',
                  }),
                ]),
                savedLoad.problem &&
                  createElement(
                    'p',
                    { role: 'status', className: 'mt-2 text-xs text-amber-300' },
                    savedLoad.problem,
                  ),
                confirming &&
                  createElement('div', { className: 'bp-playlist-confirm mt-2', role: 'alert' }, [
                    createElement(
                      'p',
                      { key: 'message' },
                      confirming === 'delete'
                        ? 'Delete this saved playlist? This cannot be undone.'
                        : 'A playlist with that name already exists. Replace it?',
                    ),
                    actionButton(
                      confirming === 'delete' ? 'Confirm delete' : 'Replace',
                      () => {
                        if (confirming === 'delete') {
                          deleteSaved();
                        } else {
                          commitSave(saveName.trim().slice(0, 60));
                        }
                      },
                      busy || preparing,
                      pill,
                      { 'aria-label': 'Confirm playlist change' },
                    ),
                    actionButton('Cancel', () => setConfirming(''), busy || preparing, pill, {
                      'aria-label': 'Cancel playlist change',
                    }),
                  ]),
                createElement('div', { className: 'bp-course-url mt-3' }, [
                  createElement('input', {
                    key: 'course-url',
                    'aria-label': 'Course URL',
                    placeholder: 'Paste a putt.day course link',
                    value: courseUrl,
                    onChange: (event) => setCourseUrl(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void addFromUrl();
                      }
                    },
                  }),
                  actionButton(
                    'Add link',
                    () => void addFromUrl(),
                    !courseUrl.trim() || busy || preparing,
                    pill,
                    { 'aria-label': 'Add course from URL' },
                  ),
                ]),
                createElement('div', { className: 'bp-playlist-transfer mt-3' }, [
                  createElement('textarea', {
                    key: 'transfer',
                    'aria-label': 'Playlist JSON',
                    className: 'bp-playlist-transfer-text',
                    placeholder: 'Export a playlist, or paste a shared one here',
                    value: transfer,
                    rows: 3,
                    spellCheck: false,
                    onChange: (event) => setTransfer(event.target.value),
                  }),
                  actionButton(
                    'Export',
                    exportPlaylist,
                    !picked.length || busy || preparing,
                    pill,
                    { 'aria-label': 'Export playlist' },
                  ),
                  actionButton(
                    'Import',
                    importPlaylist,
                    !transfer.trim() || busy || preparing,
                    pill,
                    {
                      'aria-label': 'Import playlist',
                    },
                  ),
                ]),
                busy &&
                  createElement(
                    'p',
                    { role: 'status', className: 'mt-2 text-xs' },
                    progress || 'Loading course…',
                  ),
              ]),
            ]),
          ]),
        ],
      ),
  ]);
}
