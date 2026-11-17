function usePartyAdmission(code) {
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
  const [sessionExpired, setSessionExpired] = partyRouteReact.useState(false);
  const joining = partyRouteReact.useRef(false);
  async function join() {
    if (!name.trim() || joining.current) {
      return;
    }
    joining.current = true;
    setBusy(true);
    setError('');
    setSessionExpired(false);
    try {
      const savedUid = sessionStorage.getItem('bp.uid.' + code);
      const host = sessionStorage.getItem('bp.host.' + code);
      const response = await fetch('/api/join', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
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
          setSessionExpired(true);
        }
        throw new Error(identity.error || 'Could not join this party.');
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
    } catch (joinError) {
      if (joinError.name === 'TimeoutError') {
        setError('The party did not respond. Please try again.');
      } else {
        setError(joinError.message);
      }
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
  function enterName() {
    setResume(false);
    setError('');
  }

  return { name, setName, error, busy, resume, sessionExpired, join, enterName };
}

function PartyEntry({ code, admission }) {
  const { name, setName, error, busy, join } = admission;

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
        partyRouteJsx.jsxs('form', {
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
