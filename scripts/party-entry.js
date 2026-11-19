// The original profile picker uses the registry's swatch (or solid color)
// and circular, selected-ring buttons. No account/unlock endpoint is needed
// on the independent party service.
function readBallPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem('bp.ball.v1') || 'null');
    if (saved?.key === 'custom' && /^#[0-9a-fA-F]{6}$/.test(saved.color)) {
      return saved;
    }
    if (partyBallRegistry.get(saved?.key)?.kind === 'ball') {
      return { key: saved.key };
    }
  } catch {
    // A disabled storage API must not prevent joining.
  }
  return { key: 'classic' };
}

function PartyBallPicker({ ball, setBall, disabled }) {
  const createElement = partyRouteReact.createElement;
  const [customColor, setCustomColor] = partyRouteReact.useState(
    ball.key === 'custom' ? ball.color : '#34d399',
  );
  const choices = [
    { key: 'classic', name: 'Classic', color: '#ffffff' },
    ...[...partyBallRegistry.values()].filter((cosmetic) => cosmetic.kind === 'ball'),
    { key: 'custom', name: 'Custom', color: customColor },
  ];
  const selected = choices.find((choice) => choice.key === ball.key) ?? choices[0];
  function select(choice) {
    if (choice.key === 'custom') {
      setBall({ key: choice.key, color: customColor });
    } else {
      setBall({ key: choice.key });
    }
  }
  return createElement('fieldset', { className: 'bp-ball-picker', disabled }, [
    createElement('legend', { key: 'label' }, 'Ball'),
    createElement(
      'div',
      { key: 'swatches', className: 'bp-ball-swatches' },
      choices.map((choice) =>
        createElement(
          'button',
          {
            key: choice.key,
            type: 'button',
            className:
              'bp-ball-swatch relative grid h-9 w-9 place-items-center rounded-full border transition hover:scale-105',
            title: choice.name,
            'aria-label': choice.name,
            'aria-pressed': ball.key === choice.key,
            style: { background: choice.swatch ?? choice.color },
            onClick: () => select(choice),
          },
          choice.key === 'custom' ? '+' : null,
        ),
      ),
    ),
    createElement('div', { key: 'selection', className: 'bp-ball-selection' }, [
      createElement('span', { key: 'name' }, selected.name),
      ball.key === 'custom' &&
        createElement('label', { key: 'custom', className: 'bp-custom-ball-color' }, [
          createElement('input', {
            type: 'color',
            'aria-label': 'Custom ball color',
            value: customColor,
            onChange: (event) => {
              setCustomColor(event.target.value);
              setBall({ key: 'custom', color: event.target.value });
            },
          }),
          createElement('span', {}, customColor.toUpperCase()),
        ]),
    ]),
  ]);
}

function usePartyAdmission(code) {
  const [name, setName] = partyRouteReact.useState(sessionStorage.getItem('bp.name.' + code) ?? '');
  const [ball, setBall] = partyRouteReact.useState(readBallPreference);
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
          ball,
          uid: savedUid,
          session: sessionStorage.getItem('bp.session.' + code),
          host,
        }),
      });
      const identity = await response.json();
      if (!response.ok) {
        // `code` is the contract. The message fallback keeps an older server
        // usable, but recovery must not depend on wording: if it did, rephrasing
        // the expiry message would leave the player stuck behind a Retry button
        // that can never succeed.
        if (identity.code === 'session-expired' || identity.error?.includes('Session expired')) {
          sessionStorage.removeItem('bp.uid.' + code);
          sessionStorage.removeItem('bp.session.' + code);
          setSessionExpired(true);
        }
        throw new Error(identity.error || 'Could not join this party.');
      }
      try {
        localStorage.setItem('bp.ball.v1', JSON.stringify(ball));
      } catch {}
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

  return { name, setName, ball, setBall, error, busy, resume, sessionExpired, join, enterName };
}

function PartyEntry({ code, admission }) {
  const { name, setName, ball, setBall, error, busy, join } = admission;

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
            partyRouteJsx.jsx(PartyBallPicker, { ball, setBall, disabled: busy }),
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
