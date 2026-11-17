function PartyEntry({ code }) {
  const [name, setName] = partyRouteReact.useState(sessionStorage.getItem('bp.name.' + code) ?? '');
  const [error, setError] = partyRouteReact.useState('');
  const [busy, setBusy] = partyRouteReact.useState(false);
  const [resume, setResume] = partyRouteReact.useState(
    () =>
      !!(
        sessionStorage.getItem('bp.uid.' + code) &&
        sessionStorage.getItem('bp.session.' + code) &&
        sessionStorage.getItem('bp.name.' + code)
      ),
  );
  const joining = partyRouteReact.useRef(false);
  async function join() {
    if (!name.trim() || joining.current) {
      return;
    }
    joining.current = true;
    setBusy(true);
    setError('');
    try {
      const savedUid = sessionStorage.getItem('bp.uid.' + code);
      const host = sessionStorage.getItem('bp.host.' + code);
      const response = await fetch('/api/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          name: name.trim(),
          uid: savedUid,
          session: sessionStorage.getItem('bp.session.' + code),
          host,
        }),
      });
      const identity = await response.json();
      if (!response.ok) {
        if (identity.error?.includes('Session expired')) {
          sessionStorage.removeItem('bp.uid.' + code);
          sessionStorage.removeItem('bp.session.' + code);
        }
        throw Error(identity.error);
      }
      sessionStorage.setItem('bp.lastRoom', code);
      sessionStorage.setItem('bp.name.' + code, identity.name);
      sessionStorage.setItem('bp.uid.' + code, identity.uid);
      sessionStorage.setItem('bp.session.' + code, identity.session);
      joinPartyRuntime(
        code,
        {
          uid: identity.uid,
          name: identity.name,
          hue: identity.hue,
          session: identity.session,
          instance: crypto.randomUUID(),
        },
        host ?? undefined,
      );
    } catch (err) {
      setError(err.message);
      setResume(false);
    } finally {
      joining.current = false;
      setBusy(false);
    }
  }
  partyRouteReact.useEffect(() => {
    if (resume) {
      join();
    }
  }, [code]);
  return partyRouteJsx.jsx('main', {
    className: 'bp-home',
    children: partyRouteJsx.jsxs('section', {
      className: 'bp-entry',
      children: [
        partyRouteJsx.jsxs('h1', {
          className: 'bp-wordmark',
          children: ['better', partyRouteJsx.jsx('span', { children: '.party' })],
        }),
        partyRouteJsx.jsxs('p', {
          className: 'bp-join-code',
          children: ['Party ', partyRouteJsx.jsx('strong', { children: code })],
        }),
        resume
          ? partyRouteJsx.jsxs('p', {
              role: 'status',
              className: 'bp-resume-status',
              children: [
                partyRouteJsx.jsx('span', { className: 'bp-loading-spinner', 'aria-hidden': true }),
                'Rejoining party…',
              ],
            })
          : partyRouteJsx.jsxs('form', {
              className: 'bp-join-form',
              onSubmit: (event) => {
                event.preventDefault();
                join();
              },
              children: [
                partyRouteJsx.jsx('input', {
                  autoFocus: true,
                  placeholder: 'Your name',
                  'aria-label': 'Your name',
                  maxLength: 24,
                  value: name,
                  onChange: (event) => setName(event.target.value),
                  className: 'bp-name-input',
                  autoComplete: 'nickname',
                }),
                partyRouteJsx.jsx('button', {
                  type: 'submit',
                  disabled: busy || !name.trim(),
                  className: 'bp-create',
                  children: busy ? 'Joining…' : 'Join',
                }),
              ],
            }),
        error &&
          partyRouteJsx.jsx('p', { className: 'bp-entry-error', role: 'alert', children: error }),
        partyRouteJsx.jsx('a', {
          href: '/home',
          className: 'bp-resume bp-back',
          children: 'Back to home',
        }),
      ],
    }),
  });
}
