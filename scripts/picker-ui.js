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

/**
 * The host credentials every host-only request carries.
 *
 * `code` scopes the host key in `bp.host.<code>` and identifies the room, `uid`
 * + `session` prove the caller is the connected host, and `host` is the
 * capability the server compares with the one it issued. Shared by the picker's
 * import/generate calls and the management panel's ban list, which all live in
 * the same bundle scope - the entry screen in the other bundle builds its own,
 * because a snippet cannot share a helper across bundles.
 */
export function bpHostAuth(code, uid, session) {
  return {
    code,
    uid,
    session,
    host: sessionStorage.getItem('bp.host.' + code),
  };
}

/**
 * POST a host-only JSON request and return the decoded body.
 *
 * The server always answers `{error}` on failure, so a thrown message is the
 * server's own wording with the caller's fallback for the unexpected shape.
 */
export async function bpHostRequest(path, auth, body, fallbackMessage) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...auth, ...body }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw Error(result.error || fallbackMessage);
  }
  return result;
}
