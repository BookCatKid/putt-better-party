function BpHostMenu({ settingsOpen, closeSettings }) {
  const active = useBetterPartyState(betterPartyStore, (partyState) => partyState.active);
  const host = useBetterPartyState(betterPartyStore, (partyState) => partyState.isHost);
  const phase = useBetterPartyState(betterPartyStore, (partyState) => partyState.phase);
  const hole = useBetterPartyState(betterPartyStore, (partyState) => partyState.holeIndex);
  const nextError = useBetterPartyState(betterPartyStore, (partyState) => partyState.nextError);
  const [open, setOpen] = BetterPartyReact.useState(false);
  const [confirm, setConfirm] = BetterPartyReact.useState(null);
  const [pending, setPending] = BetterPartyReact.useState(false);
  const [error, setError] = BetterPartyReact.useState('');
  BetterPartyReact.useEffect(() => {
    setOpen(false);
    setConfirm(null);
  }, [phase, hole]);
  BetterPartyReact.useEffect(() => {
    if (settingsOpen) {
      setOpen(false);
      setConfirm(null);
    }
  }, [settingsOpen]);
  BetterPartyReact.useEffect(() => {
    if (!open) {
      return;
    }
    const key = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setConfirm(null);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  if (!active || !host || !['playing', 'countdown', 'hole-results'].includes(phase)) {
    return null;
  }
  const createElement = BetterPartyReact.createElement;
  const live = phase === 'playing' || phase === 'countdown';
  const run = async (action, seconds) => {
    if (pending) {
      return;
    }
    setPending(true);
    setError('');
    try {
      await bpHostAction(action, seconds);
      setOpen(false);
      setConfirm(null);
    } catch (commandError) {
      setError(commandError.message);
    } finally {
      setPending(false);
    }
  };
  const btn = (label, fn, disabled = false, cls = '') =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: fn,
        disabled: disabled || pending,
        className: 'bp-host-item ' + cls,
      },
      label,
    );
  const confirmationMessages = {
    end: 'End the party now?',
    skip: 'Skip this hole for everyone?',
    restart: 'Restart this hole for everyone?',
    'skip-next': 'Skip the unloaded hole for everyone?',
  };
  return createElement('div', { className: 'relative bp-host-control' }, [
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': 'Party controls',
        'aria-expanded': open,
        title: 'Party controls',
        className:
          'pointer-events-auto rounded-xl bg-black/50 px-3 py-2 text-lg transition hover:bg-black/70',
        onClick: () => {
          closeSettings();
          setOpen((previousOpen) => !previousOpen);
          setConfirm(null);
        },
      },
      createElement(
        'svg',
        {
          width: 20,
          height: 20,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        [createElement('path', { d: 'M4 21V4m0 1c5-4 8 4 16 0v10c-8 4-11-4-16 0' })],
      ),
    ),
    open &&
      createElement(
        'div',
        {
          className:
            'bp-host-panel pointer-events-auto absolute right-0 top-12 rounded-2xl bg-[#11272b] p-4 shadow-2xl',
        },
        [
          createElement('h3', { className: 'mb-3 text-sm font-bold' }, 'Party controls'),
          nextError &&
            createElement(
              'p',
              { role: 'alert', className: 'mb-2 text-xs text-red-300' },
              nextError,
            ),
          error &&
            createElement('p', { role: 'alert', className: 'mb-2 text-xs text-red-300' }, error),
          pending && createElement('p', { role: 'status', className: 'text-xs' }, 'Applying…'),
          confirm
            ? createElement('div', { className: 'bp-host-confirm' }, [
                createElement('p', {}, confirmationMessages[confirm]),
                createElement('div', { className: 'bp-host-time' }, [
                  btn('Cancel', () => setConfirm(null)),
                  btn('Confirm', () => run(confirm), false, 'bp-danger'),
                ]),
              ])
            : [
                createElement('p', { className: 'text-xs text-white/70' }, 'Add time'),
                createElement(
                  'div',
                  { className: 'bp-host-time' },
                  [15, 30, 60].map((seconds) =>
                    btn('+' + seconds + 's', () => run('time', seconds), phase !== 'playing'),
                  ),
                ),
                btn('Skip level', () => setConfirm('skip'), !live),
                btn('Restart level', () => setConfirm('restart'), !live),
                nextError && btn('Retry next hole', () => run('retry-next')),
                nextError && btn('Skip unloaded hole', () => setConfirm('skip-next')),
                btn('End party', () => setConfirm('end'), false, 'bp-danger'),
              ],
        ],
      ),
  ]);
}

function BpConnectionNotice() {
  const active = useBetterPartyState(betterPartyStore, (partyState) => partyState.active);
  const connected = useBetterPartyState(betterPartyStore, (partyState) => partyState.bpConnected);
  const [show, setShow] = BetterPartyReact.useState(false);
  BetterPartyReact.useEffect(() => {
    if (!active || connected) {
      setShow(false);
      return;
    }
    const timeout = setTimeout(() => setShow(true), 2000);
    return () => clearTimeout(timeout);
  }, [active, connected]);
  return active && !connected && show
    ? BetterPartyReact.createElement('div', { className: 'bp-disconnected', role: 'alert' }, [
        'Party disconnected. Reconnecting… ',
        BetterPartyReact.createElement('a', { href: '/home' }, 'Return to party home'),
      ])
    : null;
}
