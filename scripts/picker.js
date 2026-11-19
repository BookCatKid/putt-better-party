/**
 * The playlist picker dialog: the component that owns the picker's state.
 *
 * The responsibilities that stand alone are split into sibling modules that are
 * concatenated ahead of this file: `picker-playlist.js` (the shared-playlist
 * document and saved-playlist persistence), `picker-ui.js` (the shared button
 * and stat atoms), `picker-catalog.js` (the community browse hook and the
 * course card), and `picker-generator.js` (the generator panel). What remains
 * here is the state graph itself plus the playlist editing surface, which only
 * makes sense next to the state it mutates.
 */
/**
 * Whether the lobby the request was made for is still the one on screen.
 *
 * Every picker request is awaited, and the host may navigate to another party
 * or switch the map source in the meantime; applying the response then would
 * mix one party's playlist into another's. The three await sites check the
 * same triple — same room, still in the lobby, still on the picked source.
 */
function lobbyUnchanged(code) {
  const state = betterPartyStore.state;
  return state.code === code && state.phase === 'lobby' && state.config.mapSource === 'picked';
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
  const [names, setNames] = BetterPartyReact.useState({});
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
  const [loadAttempt, setLoadAttempt] = BetterPartyReact.useState(null);
  const [saveName, setSaveName] = BetterPartyReact.useState('');
  const [transfer, setTransfer] = BetterPartyReact.useState('');
  const [courseUrl, setCourseUrl] = BetterPartyReact.useState('');
  const [drag, setDrag] = BetterPartyReact.useState(null);
  /**
   * The official community card has a per-card Stats expander; port it rather
   * than drop it. The completions bucket already rides on the card, so the
   * only extra read is average strokes, fetched once per course on first
   * expand through the same public HoleStats call the original makes.
   */
  const [statsOpen, setStatsOpen] = BetterPartyReact.useState(() => new Set());
  const [stats, setStats] = BetterPartyReact.useState({});
  const statsInflight = BetterPartyReact.useRef(new Set());
  function toggleStats(course) {
    setStatsOpen((previous) => {
      const next = new Set(previous);
      if (next.has(course.id)) {
        next.delete(course.id);
      } else {
        next.add(course.id);
      }
      return next;
    });
    if (course.id in stats || statsInflight.current.has(course.id)) {
      return;
    }
    statsInflight.current.add(course.id);
    fetch('/api/hole-stats?id=' + encodeURIComponent(course.id))
      .then(async (response) => {
        const data = await response.json();
        setStats((previous) => ({ ...previous, [course.id]: response.ok ? data : null }));
      })
      .catch(() => setStats((previous) => ({ ...previous, [course.id]: null })))
      .finally(() => statsInflight.current.delete(course.id));
  }
  function averageStrokes(courseId) {
    const entry = stats[courseId];
    if (entry === undefined) {
      return '…';
    }
    if (entry == null || entry.avgStrokes == null) {
      return '—';
    }
    return entry.avgStrokes.toFixed(1);
  }
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
    const failed = await loadIds(document.ids);
    // A document with unavailable entries is not applied as settings either, so the
    // player sees exactly what did load before anything else changes.
    if (failed.length) {
      return;
    }
    const settings = sanitizedSettings(document.settings);
    if (Object.keys(settings).length) {
      updateBetterPartyConfig(settings);
    }
    setTransfer('');
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

  /**
   * Load a list of course ids, reporting failures per entry.
   *
   * A saved playlist is intact data even when one of its courses has been deleted or
   * made private upstream, so a single refusal must not abort the whole load - that
   * turned one dead course into "your playlist does not work". Every id is attempted,
   * the ones that resolve are applied in their original order, and the rest are
   * reported individually with retry and remove. The saved playlist in storage is
   * never modified by a load, so nothing is lost either way.
   */
  async function loadIds(ids) {
    setBusy(true);
    setError('');
    bpPickerBusy(true);
    setLoadAttempt(null);
    try {
      const state = betterPartyStore.state;
      const code = state.code;
      const auth = bpHostAuth(code, state.self.uid, state.self.session);
      // A course already named in this session is one upstream has validated, so it
      // is not re-fetched. Match start still retrieves every course fresh.
      const pending = [...new Set(ids)].filter((id) => !names[id]);
      const failed = [];
      for (const [index, id] of pending.entries()) {
        if (!lobbyUnchanged(code)) {
          throw Error('The lobby changed while loading the playlist');
        }
        try {
          const imported = await bpHostRequest(
            '/api/import',
            auth,
            { id, saved: true },
            'This course is unavailable.',
          );
          setNames((previousNames) => ({ ...previousNames, [id]: imported.title }));
        } catch (importError) {
          // Recorded and skipped, not fatal: the rest of the playlist still loads.
          failed.push({ id, message: importError.message });
        }
        setProgress('Checked ' + (index + 1) + ' of ' + pending.length + ' courses…');
      }
      if (!lobbyUnchanged(code)) {
        throw Error('The lobby changed while loading the playlist');
      }
      const failedIds = new Set(failed.map((entry) => entry.id));
      const usable = ids.filter((id) => !failedIds.has(id));
      // Applying an empty list would wipe whatever is selected now, so a playlist
      // that is entirely unavailable reports itself instead of clearing the board.
      if (usable.length) {
        update(usable);
      }
      setLoadAttempt({ ids: [...ids], failed });
      return failed;
    } catch (err) {
      setError(err.message);
      return [];
    } finally {
      setBusy(false);
      bpPickerBusy(false);
      setProgress('');
    }
  }

  /** Re-attempt one entry that failed, putting it back in its original position. */
  async function retryFailed(id) {
    if (busy || preparing || !loadAttempt) {
      return;
    }
    setBusy(true);
    setError('');
    bpPickerBusy(true);
    try {
      const state = betterPartyStore.state;
      const code = state.code;
      let imported;
      try {
        imported = await bpHostRequest(
          '/api/import',
          bpHostAuth(code, state.self.uid, state.self.session),
          { id, saved: true },
          'This course is unavailable.',
        );
      } catch (importError) {
        // Recorded on the entry rather than fatal: the dialog stays usable.
        setLoadAttempt({
          ...loadAttempt,
          failed: loadAttempt.failed.map((entry) =>
            entry.id === id ? { ...entry, message: importError.message } : entry,
          ),
        });
        return;
      }
      setNames((previousNames) => ({ ...previousNames, [id]: imported.title }));
      const failed = loadAttempt.failed.filter((entry) => entry.id !== id);
      const failedIds = new Set(failed.map((entry) => entry.id));
      setLoadAttempt({ ...loadAttempt, failed });
      update(loadAttempt.ids.filter((courseId) => !failedIds.has(courseId)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      bpPickerBusy(false);
    }
  }

  /** Forget a failure for this load. The saved playlist itself is untouched. */
  function dismissFailed(id) {
    if (!loadAttempt) {
      return;
    }
    setLoadAttempt({
      ...loadAttempt,
      failed: loadAttempt.failed.filter((entry) => entry.id !== id),
    });
  }

  async function loadSaved() {
    const selected = saved.find((playlist) => playlist.id === savedId);
    if (!selected || busy || preparing) {
      return;
    }
    await loadIds([...selected.ids]);
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
  async function generatorRequest(action, filters) {
    const state = betterPartyStore.state;
    return bpHostRequest(
      '/api/generate-playlist',
      bpHostAuth(state.code, state.self.uid, state.self.session),
      { action, filters },
      'Could not generate playlist',
    );
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

  /**
   * Catalogue browsing: state and paging live in `useCatalogBrowse`
   * (picker-catalog.js); fetched titles fold into the shared name map so the
   * playlist column can name courses that were never on a card.
   */
  const { page, loading, catalogError, retryCatalog, more } = useCatalogBrowse({
    open: config.mapSource === 'picked' && pickerOpen,
    search,
    sort,
    rating,
    daily,
    maker,
    onTitles: (holes) =>
      setNames((previous) => ({
        ...previous,
        ...Object.fromEntries(holes.map((course) => [course.id, course.title])),
      })),
    clearError: () => setError(''),
  });
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
      const catalogPage = await bpHostRequest(
        '/api/import',
        bpHostAuth(code, betterPartyStore.state.self.uid, betterPartyStore.state.self.session),
        { id },
        'Could not load map',
      );
      const resolvedTitle = typeof catalogPage.title === 'string' ? catalogPage.title : title;
      setNames((previousNames) => ({ ...previousNames, [id]: resolvedTitle }));
      if (!lobbyUnchanged(code)) {
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
                    : PILL_BUTTON,
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
                daily
                  ? 'rounded-full bg-emerald-600 px-3 py-1.5 font-semibold text-white'
                  : PILL_BUTTON,
                { 'aria-pressed': daily },
              ),
              maker &&
                actionButton(
                  'by ' + maker.name + ' ✕',
                  () => setMaker(null),
                  false,
                  'rounded-full bg-violet-600 px-3 py-1.5 font-semibold text-white',
                  { title: 'Clear maker filter' },
                ),
            ]),
            actionButton(
              'Auto-generate playlist',
              () => setGeneratorOpen(!generatorOpen),
              busy || preparing,
              GREEN_BUTTON,
              { 'aria-expanded': generatorOpen },
            ),
            generatorOpen &&
              createElement(BpGeneratorPanel, {
                busy,
                preparing,
                error,
                job: genJob,
                search: genSearch,
                onSearch: setGenSearch,
                ranges: genRanges,
                onRanges: setGenRanges,
                daily: genDaily,
                onDaily: setGenDaily,
                sort: genSort,
                onSort: setGenSort,
                mode: genMode,
                onMode: setGenMode,
                maximum: genMaximum,
                onMaximum: setGenMaximum,
                onGenerate: generate,
                onCancel: cancelGeneration,
                onClose: () => setGeneratorOpen(false),
              }),
            createElement('div', { className: 'bp-catalog-layout' }, [
              createElement('section', { className: 'bp-catalog-scroll' }, [
                error &&
                  createElement(
                    'p',
                    { role: 'alert', className: 'mb-4 text-sm text-red-300' },
                    error,
                  ),
                catalogError &&
                  createElement('div', { className: 'mb-4', role: 'alert' }, [
                    createElement(
                      'p',
                      { key: 'message', className: 'text-sm text-red-300' },
                      catalogError,
                    ),
                    actionButton('Try again', retryCatalog, loading, PILL_BUTTON, {
                      'aria-label': 'Retry catalogue',
                    }),
                  ]),
                page.holes.length
                  ? createElement(
                      'ul',
                      {
                        className:
                          'grid grid-cols-1 gap-4 sm:grid-cols-2 ' + (loading ? 'opacity-60' : ''),
                      },
                      page.holes.map((course, index) =>
                        createElement(BpCatalogCard, {
                          key: course.id,
                          course,
                          index,
                          count: picked.filter((id) => id === course.id).length,
                          expanded: statsOpen.has(course.id),
                          average: averageStrokes(course.id),
                          busy,
                          preparing,
                          onMaker: setMaker,
                          onAdd: add,
                          onToggleStats: toggleStats,
                        }),
                      ),
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
                    (page.total ?? 0) +
                      ' holes' +
                      // End-of-list is stated rather than implied by a missing button,
                      // so "there is nothing more" is distinguishable from "still
                      // loading" when a filter returns a short list.
                      (page.nextOffset == null && page.holes.length ? ' · end of list' : ''),
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
                          courseThumb(id, names[id] ?? titles[id] ?? id, '', index < 4),
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
                  actionButton('Clear', () => update([]), busy || preparing, PILL_BUTTON + ' mt-3'),
                picked.length > 1 &&
                  actionButton('Shuffle', shufflePicked, busy || preparing, PILL_BUTTON + ' mt-3', {
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
                    PILL_BUTTON,
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
                  actionButton('Load', loadSaved, !savedId || busy || preparing, PILL_BUTTON, {
                    'aria-label': 'Load saved playlist',
                  }),
                  actionButton(
                    'Rename',
                    renameSaved,
                    !savedId || !saveName.trim() || busy || preparing,
                    PILL_BUTTON,
                    {
                      'aria-label': 'Rename saved playlist',
                    },
                  ),
                  actionButton(
                    'Duplicate',
                    duplicateSaved,
                    !savedId || busy || preparing,
                    PILL_BUTTON,
                    {
                      'aria-label': 'Duplicate saved playlist',
                    },
                  ),
                  actionButton('Delete', deleteSaved, !savedId || busy || preparing, PILL_BUTTON, {
                    'aria-label': 'Delete saved playlist',
                  }),
                ]),
                savedLoad.problem &&
                  createElement(
                    'p',
                    { role: 'status', className: 'mt-2 text-xs text-amber-300' },
                    savedLoad.problem,
                  ),
                loadAttempt?.failed.length > 0 &&
                  createElement(
                    'section',
                    { className: 'bp-playlist-failures mt-2', role: 'status' },
                    [
                      createElement(
                        'p',
                        { key: 'summary', className: 'text-xs text-amber-300' },
                        loadAttempt.failed.length +
                          (loadAttempt.failed.length === 1
                            ? ' course could not be loaded.'
                            : ' courses could not be loaded.') +
                          ' The saved playlist is unchanged.',
                      ),
                      ...loadAttempt.failed.map((entry) =>
                        createElement('div', { key: entry.id, className: 'bp-playlist-failure' }, [
                          createElement(
                            'span',
                            { key: 'detail', className: 'text-xs' },
                            entry.message + ' (' + entry.id + ')',
                          ),
                          actionButton(
                            'Retry',
                            () => void retryFailed(entry.id),
                            busy || preparing,
                            PILL_BUTTON,
                            { 'aria-label': 'Retry ' + entry.id },
                          ),
                          actionButton(
                            'Remove',
                            () => dismissFailed(entry.id),
                            busy || preparing,
                            PILL_BUTTON,
                            { 'aria-label': 'Remove ' + entry.id },
                          ),
                        ]),
                      ),
                    ],
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
                      PILL_BUTTON,
                      { 'aria-label': 'Confirm playlist change' },
                    ),
                    actionButton(
                      'Cancel',
                      () => setConfirming(''),
                      busy || preparing,
                      PILL_BUTTON,
                      {
                        'aria-label': 'Cancel playlist change',
                      },
                    ),
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
                    PILL_BUTTON,
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
                    PILL_BUTTON,
                    { 'aria-label': 'Export playlist' },
                  ),
                  actionButton(
                    'Import',
                    importPlaylist,
                    !transfer.trim() || busy || preparing,
                    PILL_BUTTON,
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
