// Adapt the original _site.holes community card markup and class names.
// Party-specific actions replace Play/Fork and account-only controls.

/**
 * The catalogue side of the picker: browsing state, thumbnails, and the
 * community card markup the dialog is required to preserve.
 *
 * `useCatalogBrowse` owns the whole fetch lifecycle - the debounced query, the
 * cursor "load more", the dedupe and the retry - so the component only renders
 * what it returns. `BpCatalogCard` is the presentational half.
 */

/**
 * A course thumbnail that can fail and recover.
 *
 * Previews come from upstream, so they can be slow, missing, or briefly refused. The
 * old handler dimmed the broken image and left it there, which reads as "this card
 * is disabled" rather than "this picture did not load". This retries once with a
 * cache-busting parameter - a failed preview is not cached server-side, so the retry
 * is a real second attempt rather than the same failure replayed - and then shows a
 * placeholder of the same size, so the grid does not reflow and the card keeps its
 * original dimensions either way.
 */
function BpCourseThumb({ courseId, title, className, eager }) {
  const React = BetterPartyReact;
  const [attempt, setAttempt] = React.useState(0);
  if (attempt >= 2) {
    return React.createElement(
      'div',
      {
        className: 'bp-thumb-fallback ' + (className ?? ''),
        role: 'img',
        'aria-label': title,
      },
      React.createElement(
        'span',
        { key: 'mark' },
        (String(title ?? '').trim()[0] ?? '?').toUpperCase(),
      ),
    );
  }
  return React.createElement('img', {
    src: '/api/preview/' + encodeURIComponent(courseId) + (attempt ? '?retry=' + attempt : ''),
    alt: title,
    loading: eager ? 'eager' : 'lazy',
    decoding: 'async',
    className,
    onError: () => setAttempt((value) => value + 1),
  });
}

export function courseThumb(courseId, title, classNames, eager = false) {
  return BetterPartyReact.createElement(BpCourseThumb, {
    key: courseId,
    courseId,
    title,
    className: classNames,
    eager,
  });
}

/** How long ago a course was published, phrased the way the community site does. */
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

/**
 * The catalogue query and its paging lifecycle.
 *
 * `open` is the caller's "the dialog is showing the community section" flag; a
 * closed picker never fetches. `onTitles` merges fetched course titles into the
 * picker's shared name map, and `clearError` resets the dialog's shared error
 * line when a fresh query begins - both stay with the component because they
 * are its state, while the page, cursor and retry are the browse's own.
 */
export function useCatalogBrowse({
  open,
  search,
  sort,
  rating,
  daily,
  maker,
  onTitles,
  clearError,
}) {
  const React = BetterPartyReact;
  const [page, setPage] = React.useState({ holes: [] });
  const [catalogError, setCatalogError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const generation = React.useRef(0);
  const [reload, setReload] = React.useState(0);
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
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const abortController = new AbortController();
    const requestGeneration = ++generation.current;
    setLoading(true);
    clearError();
    setCatalogError('');
    setPage({ holes: [] });
    const timer = setTimeout(async () => {
      try {
        const catalogPage = await fetchCatalogPage(0, abortController.signal);
        if (!abortController.signal.aborted && requestGeneration === generation.current) {
          setPage(catalogPage);
          onTitles(catalogPage.holes);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          setCatalogError(err.message);
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
  }, [open, search, sort, rating, daily, maker, reload]);
  async function more() {
    if (loading || page.nextOffset == null) {
      return;
    }
    const requestGeneration = generation.current;
    setLoading(true);
    setCatalogError('');
    try {
      const catalogPage = await fetchCatalogPage(page.nextOffset);
      if (requestGeneration !== generation.current) {
        return;
      }
      const existing = new Set(page.holes.map((course) => course.id));
      const fresh = catalogPage.holes.filter((course) => !existing.has(course.id));
      // The catalogue is a moving list, so a cursor can come back pointing at the
      // page already shown. Without this the button would fetch the same page for
      // ever while the dedupe hid the fact that nothing was arriving.
      const advanced = catalogPage.nextOffset != null && catalogPage.nextOffset !== page.nextOffset;
      if (fresh.length === 0 && !advanced) {
        setPage((old) => ({ ...old, nextOffset: null }));
        return;
      }
      setPage((old) => ({
        ...old,
        total: catalogPage.total,
        nextOffset: catalogPage.nextOffset,
        holes: [...old.holes, ...fresh],
      }));
      onTitles(catalogPage.holes);
    } catch (err) {
      if (requestGeneration === generation.current) {
        setCatalogError(err.message);
      }
    } finally {
      if (requestGeneration === generation.current) {
        setLoading(false);
      }
    }
  }
  /**
   * Re-run whichever catalogue request failed.
   *
   * A first page that failed has nothing to append to, so the effect is re-run; a
   * failed "load more" keeps the page it already has and retries the cursor.
   */
  function retryCatalog() {
    if (page.holes.length === 0) {
      setReload((value) => value + 1);
      return;
    }
    void more();
  }
  return { page, loading, catalogError, retryCatalog, more };
}

/**
 * One community course card: thumbnail, title, daily badge, maker, age, rating,
 * completions, the add action and the Stats expander.
 *
 * Everything that can differ per render arrives as a prop so the card is a pure
 * projection of the picker's state; the callbacks keep the room guard and the
 * stats fetch inside the component that owns them.
 */
export function BpCatalogCard({
  course,
  index,
  count,
  expanded,
  average,
  busy,
  preparing,
  onMaker,
  onAdd,
  onToggleStats,
}) {
  const createElement = BetterPartyReact.createElement;
  return createElement(
    'li',
    {
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
          courseThumb(course.id, course.title, 'aspect-[1200/630] w-full object-cover', index < 4),
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
                  onClick: () => onMaker({ id: course.creatorId, name: course.author }),
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
            () => onAdd(course),
            busy || preparing,
            GREEN_BUTTON,
            {
              'aria-label': 'Add ' + course.title,
            },
          ),
          actionButton(
            'Stats ' + (expanded ? '▴' : '▾'),
            () => onToggleStats(course),
            false,
            'rounded-full border border-[var(--line)] px-4 py-1.5 font-semibold text-[var(--sea-ink-soft)] hover:border-emerald-500',
            { 'aria-expanded': expanded },
          ),
        ]),
        expanded &&
          createElement(
            'dl',
            {
              className: 'mt-3 grid grid-cols-2 gap-2 rounded-lg bg-black/[0.03] p-3 text-xs',
            },
            [
              statDetail(
                'Completions',
                createElement(
                  'span',
                  { title: 'Number of completions' },
                  '⛳ ' + (course.completionsBucket ?? '—'),
                ),
              ),
              statDetail('Avg strokes', average),
            ],
          ),
      ]),
    ],
  );
}
