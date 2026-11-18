function BpHostMenu({ settingsOpen, closeSettings }) {
  const active = useBetterPartyState(betterPartyStore, (partyState) => partyState.active);
  const host = useBetterPartyState(betterPartyStore, (partyState) => partyState.isHost);
  const phase = useBetterPartyState(betterPartyStore, (partyState) => partyState.phase);
  const hole = useBetterPartyState(betterPartyStore, (partyState) => partyState.holeIndex);
  const nextError = useBetterPartyState(betterPartyStore, (partyState) => partyState.nextError);
  const awaitingPlayers = useBetterPartyState(
    betterPartyStore,
    (partyState) => partyState.awaitingPlayers,
  );
  const roster = useBetterPartyState(betterPartyStore, (partyState) => partyState.roster);
  const selfUid = useBetterPartyState(betterPartyStore, (partyState) => partyState.self?.uid);
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
  const run = async (action, argument) => {
    if (pending) {
      return;
    }
    setPending(true);
    setError('');
    try {
      await bpHostAction(action, argument);
      setOpen(false);
      setConfirm(null);
    } catch (commandError) {
      setError(commandError.message);
    } finally {
      setPending(false);
    }
  };
  const actionButton = (label, onClick, disabled = false, classNames = '') =>
    createElement(
      'button',
      {
        type: 'button',
        onClick,
        disabled: disabled || pending,
        className: 'bp-host-item ' + classNames,
      },
      label,
    );
  // Connected people who could host right now. A spectator is offered only when
  // nobody else is left, matching how the server picks an involuntary successor:
  // handing the party to a watcher beats leaving it without a host.
  const connectedOthers = (roster || []).filter(
    (member) => member.uid !== selfUid && member.connected,
  );
  const presentPlayers = connectedOthers.filter((member) => member.role !== 'spectator');
  const successors = presentPlayers.length > 0 ? presentPlayers : connectedOthers;
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
          awaitingPlayers > 0 &&
            createElement(
              'p',
              { role: 'status', className: 'mb-2 text-xs text-white/70' },
              awaitingPlayers === 1
                ? 'Waiting for 1 player to finish loading.'
                : `Waiting for ${awaitingPlayers} players to finish loading.`,
            ),
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
                  actionButton('Cancel', () => setConfirm(null)),
                  actionButton('Confirm', () => run(confirm), false, 'bp-danger'),
                ]),
              ])
            : [
                createElement('p', { className: 'text-xs text-white/70' }, 'Add time'),
                createElement(
                  'div',
                  { className: 'bp-host-time' },
                  [15, 30, 60].map((seconds) =>
                    actionButton(
                      '+' + seconds + 's',
                      () => run('time', seconds),
                      phase !== 'playing',
                    ),
                  ),
                ),
                actionButton('Skip level', () => setConfirm('skip'), !live),
                actionButton('Restart level', () => setConfirm('restart'), !live),
                nextError && actionButton('Retry next hole', () => run('retry-next')),
                nextError && actionButton('Skip unloaded hole', () => setConfirm('skip-next')),
                successors.length > 0 &&
                  createElement('div', { className: 'bp-host-transfer' }, [
                    createElement(
                      'p',
                      { className: 'text-xs text-white/70' },
                      'Make someone else host',
                    ),
                    successors.map((member) =>
                      actionButton(member.name + (member.ready ? ' ✅' : ''), () =>
                        run('transfer-host', member.uid),
                      ),
                    ),
                  ]),
                actionButton('End party', () => setConfirm('end'), false, 'bp-danger'),
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
