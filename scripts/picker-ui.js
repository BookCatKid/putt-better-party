/**
 * The dialog's small shared controls: the two button styles and the stat row
 * used by every section of the playlist picker.
 *
 * These are top-level functions rather than closures so the extracted catalog
 * card and generator panel build identical controls without re-declaring them.
 */
export const PILL_BUTTON =
  'rounded-full border border-[var(--line)] px-3.5 py-1.5 text-sm font-bold text-[var(--sea-ink-soft)] hover:border-emerald-500';
export const GREEN_BUTTON =
  'rounded-full bg-emerald-500 px-4 py-1.5 font-bold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50';

export function actionButton(
  label,
  onClick,
  disabled = false,
  classNames = PILL_BUTTON,
  extra = {},
) {
  return BetterPartyReact.createElement(
    'button',
    { type: 'button', onClick, disabled, className: classNames, ...extra },
    label,
  );
}

/** The official stats panel row: a small uppercase term over a bold value. */
export function statDetail(label, value) {
  const createElement = BetterPartyReact.createElement;
  return createElement('div', {}, [
    createElement(
      'dt',
      { className: 'text-[10px] uppercase tracking-wide text-[var(--sea-ink-soft)]' },
      label,
    ),
    createElement('dd', { className: 'font-bold text-[var(--sea-ink)]' }, value),
  ]);
}
