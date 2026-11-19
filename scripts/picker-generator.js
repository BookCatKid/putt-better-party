/**
 * The playlist generator panel: filter form, operation status and controls.
 *
 * The status half is what the item calls "operation status": the job the server
 * is running is reduced to one status message here, from the same fields the
 * `/api/generate-playlist` job reports. All state stays with the picker; the
 * panel is a pure projection of it.
 */
export function BpGeneratorPanel({
  busy,
  preparing,
  error,
  job,
  search,
  onSearch,
  ranges,
  onRanges,
  daily,
  onDaily,
  sort,
  onSort,
  mode,
  onMode,
  maximum,
  onMaximum,
  onGenerate,
  onCancel,
  onClose,
}) {
  const createElement = BetterPartyReact.createElement;
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
      ? job.selectedCount + ' courses selected from ' + job.progress.matched + ' matching courses.'
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
          value: search,
          maxLength: 100,
          disabled: busy || preparing,
          onChange: (event) => onSearch(event.target.value),
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
              value: ranges[metric]?.[bound] ?? '',
              placeholder: 'Any',
              'aria-label': label + ' ' + bound,
              disabled: busy || preparing,
              onChange: (event) =>
                onRanges((previous) => ({
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
            () => onRanges((previous) => ({ ...previous, overPar: bounds })),
            busy || preparing,
            PILL_BUTTON,
            { key: label },
          ),
        ),
      ]),
      createElement('div', { className: 'bp-gen-options' }, [
        createElement('label', { className: 'bp-gen-field' }, [
          createElement(
            'span',
            {},
            mode === 'append' ? 'Maximum courses to add' : 'Maximum courses',
          ),
          createElement('input', {
            type: 'number',
            min: 1,
            max: 10000,
            step: 1,
            placeholder: 'Unlimited',
            'aria-label': 'Maximum courses',
            value: maximum,
            disabled: busy || preparing,
            onChange: (event) => onMaximum(event.target.value),
          }),
        ]),
        select('Daily holes', daily, onDaily, [
          ['any', 'Any'],
          ['exclude', 'Exclude past dailies'],
          ['only', 'Past dailies only'],
        ]),
        select('Order', sort, onSort, [
          ['new', 'Newest first'],
          ['top', 'Top rated'],
          ['trending', 'Trending'],
          ['shuffle', 'Shuffle'],
        ]),
        select('Playlist action', mode, onMode, [
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
          mode === 'append' ? 'Generate & append' : 'Generate & replace',
          onGenerate,
          busy || preparing,
          GREEN_BUTTON,
        ),
        job?.status === 'running'
          ? actionButton('Cancel generation', onCancel, false, PILL_BUTTON)
          : actionButton('Close', onClose, false, PILL_BUTTON),
      ]),
      createElement(
        'p',
        { className: 'text-xs text-[var(--sea-ink-soft)]' },
        'All matching courses are scanned before ordering and applying the maximum. Nothing changes until the scan succeeds.',
      ),
    ],
  );
}
