function D({ code }) {
  const [name, setName] = y.useState(sessionStorage.getItem('bp.name.' + code) ?? ''),
    [error, setError] = y.useState(''),
    [busy, setBusy] = y.useState(false),
    [resume, setResume] = y.useState(
      () =>
        !!(
          sessionStorage.getItem('bp.uid.' + code) &&
          sessionStorage.getItem('bp.session.' + code) &&
          sessionStorage.getItem('bp.name.' + code)
        ),
    ),
    joining = y.useRef(false);
  async function join() {
    if (!name.trim() || joining.current) return;
    joining.current = true;
    setBusy(true);
    setError('');
    try {
      const old = sessionStorage.getItem('bp.uid.' + code),
        host = sessionStorage.getItem('bp.host.' + code);
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          name: name.trim(),
          uid: old,
          session: sessionStorage.getItem('bp.session.' + code),
          host,
        }),
      });
      const identity = await res.json();
      if (!res.ok) {
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
      f(
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
  y.useEffect(() => {
    if (resume) join();
  }, [code]);
  return x.jsx('main', {
    className: 'bp-home',
    children: x.jsxs('section', {
      className: 'bp-entry',
      children: [
        x.jsxs('h1', {
          className: 'bp-wordmark',
          children: ['better', x.jsx('span', { children: '.party' })],
        }),
        x.jsxs('p', {
          className: 'bp-join-code',
          children: ['Party ', x.jsx('strong', { children: code })],
        }),
        resume
          ? x.jsxs('p', {
              role: 'status',
              className: 'bp-resume-status',
              children: [
                x.jsx('span', { className: 'bp-loading-spinner', 'aria-hidden': true }),
                'Rejoining party…',
              ],
            })
          : x.jsxs('form', {
              className: 'bp-join-form',
              onSubmit: (e) => {
                e.preventDefault();
                join();
              },
              children: [
                x.jsx('input', {
                  autoFocus: true,
                  placeholder: 'Your name',
                  'aria-label': 'Your name',
                  maxLength: 24,
                  value: name,
                  onChange: (e) => setName(e.target.value),
                  className: 'bp-name-input',
                  autoComplete: 'nickname',
                }),
                x.jsx('button', {
                  type: 'submit',
                  disabled: busy || !name.trim(),
                  className: 'bp-create',
                  children: busy ? 'Joining…' : 'Join',
                }),
              ],
            }),
        error && x.jsx('p', { className: 'bp-entry-error', role: 'alert', children: error }),
        x.jsx('a', { href: '/home', className: 'bp-resume bp-back', children: 'Back to home' }),
      ],
    }),
  });
}
