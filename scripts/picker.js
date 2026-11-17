// Adapt the original _site.holes community card markup and class names.
// Party-specific actions replace Play/Fork and account-only controls.
function At({ config: e }) {
  const [search, setSearch] = q.useState(''),
    [sort, setSort] = q.useState('new'),
    [rating, setRating] = q.useState(0),
    [daily, setDaily] = q.useState(false),
    [maker, setMaker] = q.useState(null),
    [page, setPage] = q.useState({ holes: [] }),
    [names, setNames] = q.useState({}),
    [loading, setLoading] = q.useState(false),
    [busy, setBusy] = q.useState(false),
    [progress, setProgress] = q.useState(''),
    [error, setError] = q.useState('');
  const [saved, setSaved] = q.useState(() => {
      try {
        const x = JSON.parse(localStorage.getItem('bp.playlists.v1') || '[]');
        return Array.isArray(x)
          ? x
              .filter(
                (p) =>
                  typeof p.name === 'string' &&
                  Array.isArray(p.ids) &&
                  p.ids.length > 0 &&
                  p.ids.every((id) => typeof id === 'string'),
              )
              .slice(0, 30)
          : [];
      } catch {
        return [];
      }
    }),
    [savedId, setSavedId] = q.useState(''),
    [saveName, setSaveName] = q.useState(''),
    [drag, setDrag] = q.useState(null);
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
    if (!name || !picked.length) return;
    const id = crypto.randomUUID();
    store([{ id, name, ids: [...picked] }, ...saved.filter((p) => p.name !== name)].slice(0, 30));
    setSavedId(id);
    setSaveName('');
  }
  async function loadSaved() {
    const selected = saved.find((p) => p.id === savedId);
    if (!selected || busy || preparing) return;
    setBusy(true);
    setError('');
    bpPickerBusy(true);
    try {
      const state = R.state,
        code = state.code,
        auth = {
          code,
          uid: state.self.uid,
          session: state.self.session,
          host: sessionStorage.getItem('bp.host.' + code),
        },
        items = [];
      // Validate saved IDs individually instead of holding a huge HTTP request open.
      for (const id of new Set(selected.ids)) {
        if (
          R.state.code !== code ||
          R.state.phase !== 'lobby' ||
          R.state.config.mapSource !== 'picked'
        )
          throw Error('The lobby changed while loading the playlist');
        const r = await fetch('/api/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...auth, id, saved: true }),
          }),
          data = await r.json();
        if (!r.ok) throw Error(data.error || 'Could not load playlist');
        items.push(data);
        setProgress(
          'Loading ' + items.length + ' of ' + new Set(selected.ids).size + ' unique courses…',
        );
      }
      setNames((n) => ({ ...n, ...Object.fromEntries(items.map((h) => [h.id, h.title])) }));
      if (
        R.state.code !== code ||
        R.state.phase !== 'lobby' ||
        R.state.config.mapSource !== 'picked'
      )
        throw Error('The lobby changed while loading the playlist');
      update([...selected.ids]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      bpPickerBusy(false);
      setProgress('');
    }
  }

  const titles = j(R, (s) => s.playlistTitles) ?? {},
    preparing = j(R, (s) => s.preparing),
    picked = e.selectedHoleIds ?? [],
    update = (ids) =>
      L({ mapSource: 'picked', selectedHoleIds: ids, holes: Math.max(1, ids.length) });
  const h = q.createElement,
    pill =
      'rounded-full border border-[var(--line)] px-3.5 py-1.5 text-sm font-bold text-[var(--sea-ink-soft)] hover:border-emerald-500',
    green =
      'rounded-full bg-emerald-600 px-4 py-1.5 font-bold text-white hover:bg-emerald-500 disabled:opacity-50';
  const btn = (label, onClick, disabled = false, cls = pill, extra = {}) =>
    h('button', { type: 'button', onClick, disabled, className: cls, ...extra }, label);
  const params = (offset) =>
    new URLSearchParams({
      search,
      sort,
      offset: String(offset),
      minRating: String(rating),
      daily: String(daily),
      author: maker?.id ?? '',
    });
  async function fetchPage(offset, signal) {
    const r = await fetch('/api/catalog?' + params(offset), { signal }),
      p = await r.json();
    if (!r.ok) throw Error(p.error || 'Could not load courses');
    return p;
  }
  const generation = q.useRef(0);
  q.useEffect(() => {
    if (e.mapSource !== 'picked') return;
    const ac = new AbortController();
    const seq = ++generation.current;
    setLoading(true);
    setError('');
    setPage({ holes: [] });
    const timer = setTimeout(async () => {
      try {
        const p = await fetchPage(0, ac.signal);
        if (!ac.signal.aborted && seq === generation.current) {
          setPage(p);
          setNames((prev) => ({
            ...prev,
            ...Object.fromEntries(p.holes.map((h) => [h.id, h.title])),
          }));
        }
      } catch (err) {
        if (!ac.signal.aborted) setError(err.message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ac.abort();
      generation.current++;
    };
  }, [e.mapSource, search, sort, rating, daily, maker]);
  async function more() {
    if (loading || page.nextOffset == null) return;
    const seq = generation.current;
    setLoading(true);
    setError('');
    try {
      const p = await fetchPage(page.nextOffset);
      if (seq !== generation.current) return;
      setPage((old) => ({
        ...p,
        holes: [...old.holes, ...p.holes.filter((x) => !old.holes.some((y) => y.id === x.id))],
      }));
      setNames((prev) => ({ ...prev, ...Object.fromEntries(p.holes.map((h) => [h.id, h.title])) }));
    } catch (err) {
      if (seq === generation.current) setError(err.message);
    } finally {
      if (seq === generation.current) setLoading(false);
    }
  }
  async function add(course) {
    if (busy || preparing) return;
    setBusy(true);
    setError('');
    bpPickerBusy(true);
    try {
      const r = await fetch('/api/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            code: R.state.code,
            uid: R.state.self.uid,
            session: R.state.self.session,
            host: sessionStorage.getItem('bp.host.' + R.state.code),
            id: course.id,
          }),
        }),
        p = await r.json();
      if (!r.ok) throw Error(p.error || 'Could not load map');
      setNames((n) => ({ ...n, [course.id]: course.title }));
      if (R.state.phase === 'lobby' && R.state.config.mapSource === 'picked')
        update([...(R.state.config.selectedHoleIds ?? []), course.id]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      bpPickerBusy(false);
    }
  }
  function move(i, d) {
    const a = [...picked];
    if (i + d < 0 || i + d >= a.length) return;
    const [item] = a.splice(i, 1);
    a.splice(i + d, 0, item);
    update(a);
  }
  const age = (ts) => {
    if (!Number.isFinite(ts)) return '';
    const d = Math.floor((Date.now() - ts) / 864e5);
    return d <= 0
      ? 'today'
      : d === 1
        ? 'yesterday'
        : d < 7
          ? d + 'd ago'
          : new Date(ts).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
  };
  const image = (id, title, cls, eager = false) =>
    h('img', {
      src: '/api/preview/' + encodeURIComponent(id),
      alt: title,
      loading: eager ? 'eager' : 'lazy',
      decoding: 'async',
      className: cls,
      onError: (ev) => {
        ev.currentTarget.style.opacity = '.35';
      },
    });
  const mode = h(
    'label',
    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
    [
      'Maps',
      h(
        'select',
        {
          value: e.mapSource,
          onChange: (x) => L({ mapSource: x.target.value }),
          disabled: busy || preparing,
          style: { background: '#0a1c21', color: '#fff', padding: '8px', borderRadius: 6 },
          'aria-label': 'Party map selection',
        },
        [
          h('option', { value: 'random' }, 'Random holes'),
          h('option', { value: 'picked' }, 'Choose a playlist'),
        ],
      ),
    ],
  );
  if (e.mapSource === 'random')
    return h('div', {}, [
      mode,
      h('label', { className: 'bp-number-row mt-3' }, [
        h('span', {}, 'Exclude holes played as dailies'),
        h('input', {
          type: 'checkbox',
          'aria-label': 'Exclude daily holes',
          checked: !!e.excludeDaily,
          disabled: busy || preparing,
          onChange: (x) => L({ excludeDaily: x.target.checked }),
        }),
      ]),
    ]);
  function card(c, index) {
    const count = picked.filter((id) => id === c.id).length;
    return h(
      'li',
      {
        key: c.id,
        className:
          'overflow-hidden rounded-2xl border bg-white/40 transition ' +
          (count ? 'border-emerald-500/50 ring-1 ring-emerald-500/15' : 'border-[var(--line)]'),
      },
      [
        h(
          'a',
          {
            href: 'https://putt.day/h/' + encodeURIComponent(c.id),
            target: '_blank',
            rel: 'noopener noreferrer',
            className: 'relative block',
          },
          [
            image(c.id, c.title, 'aspect-[1200/630] w-full object-cover', index < 4),
            count > 0 &&
              h(
                'span',
                {
                  className:
                    'absolute left-2 top-2 rounded-full border border-white/70 bg-emerald-600 px-2.5 py-1 text-[11px] font-black uppercase tracking-wide text-white shadow-md',
                },
                '✓ Added' + (count > 1 ? ' ×' + count : ''),
              ),
          ],
        ),
        h('div', { className: 'p-3' }, [
          h('div', { className: 'flex items-start justify-between gap-2' }, [
            h(
              'a',
              {
                href: 'https://putt.day/h/' + encodeURIComponent(c.id),
                target: '_blank',
                rel: 'noopener noreferrer',
                className: 'font-bold text-[var(--sea-ink)] no-underline hover:underline',
              },
              c.title,
            ),
            c.scheduledDay != null &&
              h(
                'a',
                {
                  href: 'https://putt.day/day/' + c.scheduledDay,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  className:
                    'shrink-0 rounded-full bg-emerald-600/10 px-2 py-0.5 text-[11px] font-bold text-emerald-700 no-underline',
                },
                'Daily #' + c.scheduledDay,
              ),
          ]),
          h('p', { className: 'mt-0.5 text-xs text-[var(--sea-ink-soft)]' }, [
            'by ',
            c.creatorId
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'underline',
                    onClick: () => setMaker({ id: c.creatorId, name: c.author }),
                  },
                  c.author,
                )
              : c.author,
            ' · ',
            h('span', { title: new Date(c.createdAt).toLocaleString() }, age(c.createdAt)),
          ]),
          h(
            'div',
            { className: 'mt-2 flex items-center gap-3 text-xs text-[var(--sea-ink-soft)]' },
            [
              Number.isFinite(c.ratingAvg)
                ? h('span', {}, [
                    h('span', { className: 'text-amber-500' }, [
                      '★'.repeat(Math.max(0, Math.min(5, Math.round(c.ratingAvg)))),
                      h(
                        'span',
                        { className: 'text-[var(--line)]' },
                        '★'.repeat(Math.max(0, 5 - Math.round(c.ratingAvg))),
                      ),
                    ]),
                    ' ' + c.ratingAvg.toFixed(1) + ' (' + (c.ratingCount ?? 0) + ')',
                  ])
                : h('span', { className: 'opacity-70' }, 'unrated'),
              h('span', { title: 'Number of completions' }, '⛳ ' + (c.completionsBucket ?? '—')),
            ],
          ),
          h('div', { className: 'mt-3 flex gap-2 text-xs' }, [
            btn(count ? 'Add again' : 'Add to playlist', () => add(c), busy || preparing, green, {
              'aria-label': 'Add ' + c.title,
            }),
          ]),
        ]),
      ],
    );
  }
  return h('div', { className: 'flex flex-col gap-3' }, [
    mode,
    h('section', { className: 'bp-community' }, [
      h(
        'h2',
        { className: 'text-3xl font-black tracking-tight text-[var(--sea-ink)]' },
        'Community holes',
      ),
      h(
        'p',
        { className: 'mb-4 mt-1 text-sm text-[var(--sea-ink-soft)]' },
        'Choose holes for your party.',
      ),
      h('div', { className: 'mb-4 flex flex-wrap items-center gap-2' }, [
        ...[
          ['new', 'New'],
          ['trending', 'Trending'],
          ['top', 'Top rated'],
        ].map(([v, label]) =>
          btn(
            label,
            () => setSort(v),
            false,
            v === sort
              ? 'rounded-full bg-emerald-600 px-3.5 py-1.5 text-sm font-bold text-white'
              : pill,
          ),
        ),
        h('input', {
          value: search,
          onChange: (x) => setSearch(x.target.value),
          placeholder: 'Search title or maker…',
          'aria-label': 'Find party holes',
          className:
            'ml-auto w-48 rounded-full border border-[var(--line)] bg-white/60 px-3.5 py-1.5 text-sm',
        }),
      ]),
      h('div', { className: 'mb-4 flex flex-wrap items-center gap-2 text-sm' }, [
        h(
          'select',
          {
            value: rating,
            onChange: (x) => setRating(Number(x.target.value)),
            'aria-label': 'Minimum rating',
            className: 'rounded-full border border-[var(--line)] bg-white/60 px-3 py-1.5',
          },
          [
            [0, 'Any rating'],
            [3, '3★ and up'],
            [4, '4★ and up'],
          ].map(([v, label]) => h('option', { key: v, value: v }, label)),
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
      h('div', { className: 'bp-catalog-layout' }, [
        h('section', { className: 'bp-catalog-scroll' }, [
          error && h('p', { role: 'alert', className: 'mb-4 text-sm text-red-700' }, error),
          page.holes.length
            ? h(
                'ul',
                {
                  className:
                    'grid grid-cols-1 gap-4 sm:grid-cols-2 ' + (loading ? 'opacity-60' : ''),
                },
                page.holes.map(card),
              )
            : h(
                'p',
                { className: 'py-16 text-center text-sm text-[var(--sea-ink-soft)]' },
                loading ? 'Loading…' : 'No holes match. Try clearing some filters.',
              ),
          h('div', { className: 'mt-6 text-center' }, [
            h(
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
        h('aside', {}, [
          h('h3', { className: 'mb-2 font-bold' }, 'Playlist · ' + picked.length),
          ...picked.map((id, i) =>
            h(
              'div',
              {
                key: i + ':' + id,
                className: 'bp-playlist-item' + (drag === i ? ' bp-dragging' : ''),
                draggable: !busy && !preparing,
                onDragStart: (ev) => {
                  setDrag(i);
                  ev.dataTransfer.effectAllowed = 'move';
                  ev.dataTransfer.setData('text/plain', String(i));
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
                  if (drag !== null && drag !== i) move(drag, i - drag);
                  setDrag(null);
                },
              },
              [
                image(id, names[id] ?? titles[id] ?? id, '', i < 4),
                h('div', {}, [
                  h(
                    'p',
                    { className: 'text-xs font-bold' },
                    i + 1 + '. ' + (names[id] ?? titles[id] ?? id),
                  ),
                  h('div', { className: 'bp-playlist-actions' }, [
                    btn('↑', () => move(i, -1), i === 0 || busy || preparing, '', {
                      'aria-label': 'Move hole up',
                    }),
                    btn('↓', () => move(i, 1), i === picked.length - 1 || busy || preparing, '', {
                      'aria-label': 'Move hole down',
                    }),
                    btn(
                      '×',
                      () => update(picked.filter((_, j) => j !== i)),
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
            h(
              'p',
              { className: 'text-xs text-[var(--sea-ink-soft)]' },
              'Add holes in the order you want to play.',
            ),
          picked.length > 0 && btn('Clear', () => update([]), busy || preparing, pill + ' mt-3'),
          h('div', { className: 'bp-saved-playlists' }, [
            h('input', {
              'aria-label': 'Playlist name',
              placeholder: 'Playlist name',
              value: saveName,
              maxLength: 60,
              onChange: (e) => setSaveName(e.target.value),
            }),
            btn('Save', save, !saveName.trim() || !picked.length || busy || preparing, pill, {
              'aria-label': 'Save playlist',
            }),
            h(
              'select',
              {
                'aria-label': 'Saved playlists',
                value: savedId,
                onChange: (e) => setSavedId(e.target.value),
              },
              [
                h('option', { value: '' }, 'Saved playlists…'),
                ...saved.map((p) =>
                  h('option', { key: p.id, value: p.id }, p.name + ' (' + p.ids.length + ')'),
                ),
              ],
            ),
            btn('Load', loadSaved, !savedId || busy || preparing, pill, {
              'aria-label': 'Load saved playlist',
            }),
            btn(
              'Delete',
              () => {
                store(saved.filter((p) => p.id !== savedId));
                setSavedId('');
              },
              !savedId || busy || preparing,
              pill,
              { 'aria-label': 'Delete saved playlist' },
            ),
          ]),
          busy &&
            h('p', { role: 'status', className: 'mt-2 text-xs' }, progress || 'Loading course…'),
        ]),
      ]),
    ]),
  ]);
}
