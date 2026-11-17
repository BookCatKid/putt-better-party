// Adapt the original _site.holes community card markup and class names.
// Party-specific actions replace Play/Fork and account-only controls.
function CommunityCoursePicker({ config }) {
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
  const [saved, setSaved] = BetterPartyReact.useState(() => {
    try {
      const item = JSON.parse(localStorage.getItem('bp.playlists.v1') || '[]');
      return Array.isArray(item)
        ? item
            .filter(
              (playlist) =>
                typeof playlist.name === 'string' &&
                Array.isArray(playlist.ids) &&
                playlist.ids.length > 0 &&
                playlist.ids.every((id) => typeof id === 'string'),
            )
            .slice(0, 30)
        : [];
    } catch {
      return [];
    }
  });
  const [savedId, setSavedId] = BetterPartyReact.useState('');
  const [saveName, setSaveName] = BetterPartyReact.useState('');
  const [drag, setDrag] = BetterPartyReact.useState(null);
  function store(next) {
    try {
      localStorage.setItem('bp.playlists.v1', JSON.stringify(next));
      setSaved(next);
    } catch (err) {
      setError('Could not save playlist: ' + err.message);
    }
  }
  function save() {
    const name = saveName.trim().slice(0, 60);
    if (!name || !picked.length) {
      return;
    }
    const id = crypto.randomUUID();
    store(
      [{ id, name, ids: [...picked] }, ...saved.filter((playlist) => playlist.name !== name)].slice(
        0,
        30,
      ),
    );
    setSavedId(id);
    setSaveName('');
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
      // Validate saved IDs individually instead of holding a huge HTTP request open.
      for (const id of new Set(selected.ids)) {
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
        const data = await response.json();
        if (!response.ok) {
          throw Error(data.error || 'Could not load playlist');
        }
        items.push(data);
        setProgress(
          'Loading ' + items.length + ' of ' + new Set(selected.ids).size + ' unique courses…',
        );
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
    'rounded-full bg-emerald-600 px-4 py-1.5 font-bold text-white hover:bg-emerald-500 disabled:opacity-50';
  const btn = (label, onClick, disabled = false, cls = pill, extra = {}) =>
    createElement('button', { type: 'button', onClick, disabled, className: cls, ...extra }, label);
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
    if (config.mapSource !== 'picked') {
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
          setNames((prev) => ({
            ...prev,
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
  }, [config.mapSource, search, sort, rating, daily, maker]);
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
            (item) => !old.holes.some((positionY) => positionY.id === item.id),
          ),
        ],
      }));
      setNames((prev) => ({
        ...prev,
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
    if (busy || preparing) {
      return;
    }
    setBusy(true);
    setError('');
    bpPickerBusy(true);
    try {
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: betterPartyStore.state.code,
          uid: betterPartyStore.state.self.uid,
          session: betterPartyStore.state.self.session,
          host: sessionStorage.getItem('bp.host.' + betterPartyStore.state.code),
          id: course.id,
        }),
      });
      const catalogPage = await response.json();
      if (!response.ok) {
        throw Error(catalogPage.error || 'Could not load map');
      }
      setNames((previousNames) => ({ ...previousNames, [course.id]: course.title }));
      if (
        betterPartyStore.state.phase === 'lobby' &&
        betterPartyStore.state.config.mapSource === 'picked'
      ) {
        update([...(betterPartyStore.state.config.selectedHoleIds ?? []), course.id]);
      }
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
    const [item] = source.splice(index, 1);
    source.splice(index + destination, 0, item);
    update(source);
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
  const image = (id, title, cls, eager = false) =>
    createElement('img', {
      src: '/api/preview/' + encodeURIComponent(id),
      alt: title,
      loading: eager ? 'eager' : 'lazy',
      decoding: 'async',
      className: cls,
      onError: (ev) => {
        ev.currentTarget.style.opacity = '.35';
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
          onChange: (item) => updateBetterPartyConfig({ mapSource: item.target.value }),
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
      createElement('label', { className: 'bp-number-row mt-3' }, [
        createElement('span', {}, 'Exclude holes played as dailies'),
        createElement('input', {
          type: 'checkbox',
          'aria-label': 'Exclude daily holes',
          checked: !!config.excludeDaily,
          disabled: busy || preparing,
          onChange: (item) => updateBetterPartyConfig({ excludeDaily: item.target.checked }),
        }),
      ]),
    ]);
  }
  function card(courseIndex, index) {
    const count = picked.filter((id) => id === courseIndex.id).length;
    return createElement(
      'li',
      {
        key: courseIndex.id,
        className:
          'overflow-hidden rounded-2xl border bg-white/40 transition ' +
          (count ? 'border-emerald-500/50 ring-1 ring-emerald-500/15' : 'border-[var(--line)]'),
      },
      [
        createElement(
          'a',
          {
            href: 'https://putt.day/h/' + encodeURIComponent(courseIndex.id),
            target: '_blank',
            rel: 'noopener noreferrer',
            className: 'relative block',
          },
          [
            image(
              courseIndex.id,
              courseIndex.title,
              'aspect-[1200/630] w-full object-cover',
              index < 4,
            ),
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
                href: 'https://putt.day/h/' + encodeURIComponent(courseIndex.id),
                target: '_blank',
                rel: 'noopener noreferrer',
                className: 'font-bold text-[var(--sea-ink)] no-underline hover:underline',
              },
              courseIndex.title,
            ),
            courseIndex.scheduledDay != null &&
              createElement(
                'a',
                {
                  href: 'https://putt.day/day/' + courseIndex.scheduledDay,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  className:
                    'shrink-0 rounded-full bg-emerald-600/10 px-2 py-0.5 text-[11px] font-bold text-emerald-700 no-underline',
                },
                'Daily #' + courseIndex.scheduledDay,
              ),
          ]),
          createElement('p', { className: 'mt-0.5 text-xs text-[var(--sea-ink-soft)]' }, [
            'by ',
            courseIndex.creatorId
              ? createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'underline',
                    onClick: () =>
                      setMaker({ id: courseIndex.creatorId, name: courseIndex.author }),
                  },
                  courseIndex.author,
                )
              : courseIndex.author,
            ' · ',
            createElement(
              'span',
              { title: new Date(courseIndex.createdAt).toLocaleString() },
              formatCourseAge(courseIndex.createdAt),
            ),
          ]),
          createElement(
            'div',
            { className: 'mt-2 flex items-center gap-3 text-xs text-[var(--sea-ink-soft)]' },
            [
              Number.isFinite(courseIndex.ratingAvg)
                ? createElement('span', {}, [
                    createElement('span', { className: 'text-amber-500' }, [
                      '★'.repeat(Math.max(0, Math.min(5, Math.round(courseIndex.ratingAvg)))),
                      createElement(
                        'span',
                        { className: 'text-[var(--line)]' },
                        '★'.repeat(Math.max(0, 5 - Math.round(courseIndex.ratingAvg))),
                      ),
                    ]),
                    ' ' +
                      courseIndex.ratingAvg.toFixed(1) +
                      ' (' +
                      (courseIndex.ratingCount ?? 0) +
                      ')',
                  ])
                : createElement('span', { className: 'opacity-70' }, 'unrated'),
              createElement(
                'span',
                { title: 'Number of completions' },
                '⛳ ' + (courseIndex.completionsBucket ?? '—'),
              ),
            ],
          ),
          createElement('div', { className: 'mt-3 flex gap-2 text-xs' }, [
            btn(
              count ? 'Add again' : 'Add to playlist',
              () => add(courseIndex),
              busy || preparing,
              green,
              {
                'aria-label': 'Add ' + courseIndex.title,
              },
            ),
          ]),
        ]),
      ],
    );
  }
  return createElement('div', { className: 'flex flex-col gap-3' }, [
    mode,
    createElement('section', { className: 'bp-community' }, [
      createElement(
        'h2',
        { className: 'text-3xl font-black tracking-tight text-[var(--sea-ink)]' },
        'Community holes',
      ),
      createElement(
        'p',
        { className: 'mb-4 mt-1 text-sm text-[var(--sea-ink-soft)]' },
        'Choose holes for your party.',
      ),
      createElement('div', { className: 'mb-4 flex flex-wrap items-center gap-2' }, [
        ...[
          ['new', 'New'],
          ['trending', 'Trending'],
          ['top', 'Top rated'],
        ].map(([value, label]) =>
          btn(
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
          onChange: (item) => setSearch(item.target.value),
          placeholder: 'Search title or maker…',
          'aria-label': 'Find party holes',
          className:
            'ml-auto w-48 rounded-full border border-[var(--line)] bg-white/60 px-3.5 py-1.5 text-sm',
        }),
      ]),
      createElement('div', { className: 'mb-4 flex flex-wrap items-center gap-2 text-sm' }, [
        createElement(
          'select',
          {
            value: rating,
            onChange: (item) => setRating(Number(item.target.value)),
            'aria-label': 'Minimum rating',
            className: 'rounded-full border border-[var(--line)] bg-white/60 px-3 py-1.5',
          },
          [
            [0, 'Any rating'],
            [3, '3★ and up'],
            [4, '4★ and up'],
          ].map(([value, label]) => createElement('option', { key: value, value: value }, label)),
        ),
        btn(
          'Ran as a daily',
          () => setDaily(!daily),
          false,
          daily ? 'rounded-full bg-emerald-600 px-3 py-1.5 font-semibold text-white' : pill,
          { 'aria-pressed': daily },
        ),
        maker &&
          btn(
            'by ' + maker.name + ' ✕',
            () => setMaker(null),
            false,
            'rounded-full bg-violet-600 px-3 py-1.5 font-semibold text-white',
          ),
      ]),
      createElement('div', { className: 'bp-catalog-layout' }, [
        createElement('section', { className: 'bp-catalog-scroll' }, [
          error &&
            createElement('p', { role: 'alert', className: 'mb-4 text-sm text-red-700' }, error),
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
              btn(
                loading ? 'Loading…' : 'Load more',
                more,
                loading,
                'mt-2 rounded-full bg-emerald-600 px-6 py-2.5 text-sm font-bold text-white disabled:opacity-50',
              ),
          ]),
        ]),
        createElement('aside', {}, [
          createElement('h3', { className: 'mb-2 font-bold' }, 'Playlist · ' + picked.length),
          ...picked.map((id, index) =>
            createElement(
              'div',
              {
                key: index + ':' + id,
                className: 'bp-playlist-item' + (drag === index ? ' bp-dragging' : ''),
                draggable: !busy && !preparing,
                onDragStart: (ev) => {
                  setDrag(index);
                  ev.dataTransfer.effectAllowed = 'move';
                  ev.dataTransfer.setData('text/plain', String(index));
                },
                onDragOver: (ev) => {
                  if (drag !== null) {
                    ev.preventDefault();
                    ev.dataTransfer.dropEffect = 'move';
                  }
                },
                onDragEnd: () => setDrag(null),
                onDrop: (ev) => {
                  ev.preventDefault();
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
                    btn('↑', () => move(index, -1), index === 0 || busy || preparing, '', {
                      'aria-label': 'Move hole up',
                    }),
                    btn(
                      '↓',
                      () => move(index, 1),
                      index === picked.length - 1 || busy || preparing,
                      '',
                      {
                        'aria-label': 'Move hole down',
                      },
                    ),
                    btn(
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
          picked.length > 0 && btn('Clear', () => update([]), busy || preparing, pill + ' mt-3'),
          createElement('div', { className: 'bp-saved-playlists' }, [
            createElement('input', {
              'aria-label': 'Playlist name',
              placeholder: 'Playlist name',
              value: saveName,
              maxLength: 60,
              onChange: (event) => setSaveName(event.target.value),
            }),
            btn('Save', save, !saveName.trim() || !picked.length || busy || preparing, pill, {
              'aria-label': 'Save playlist',
            }),
            createElement(
              'select',
              {
                'aria-label': 'Saved playlists',
                value: savedId,
                onChange: (event) => setSavedId(event.target.value),
              },
              [
                createElement('option', { value: '' }, 'Saved playlists…'),
                ...saved.map((playlist) =>
                  createElement(
                    'option',
                    { key: playlist.id, value: playlist.id },
                    playlist.name + ' (' + playlist.ids.length + ')',
                  ),
                ),
              ],
            ),
            btn('Load', loadSaved, !savedId || busy || preparing, pill, {
              'aria-label': 'Load saved playlist',
            }),
            btn(
              'Delete',
              () => {
                store(saved.filter((playlist) => playlist.id !== savedId));
                setSavedId('');
              },
              !savedId || busy || preparing,
              pill,
              { 'aria-label': 'Delete saved playlist' },
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
  ]);
}
