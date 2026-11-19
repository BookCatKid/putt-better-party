function BpHostMenu({ settingsOpen, closeSettings }) {
  const active = useBetterPartyState(betterPartyStore, (partyState) => partyState.active);
  const manager = useBetterPartyState(
    betterPartyStore,
    (partyState) => partyState.isHost || partyState.bpCoHost,
  );
  const paused = useBetterPartyState(betterPartyStore, (partyState) => !!partyState.bpPausedAt);
  const config = useBetterPartyState(betterPartyStore, (partyState) => partyState.config);
  const vote = useBetterPartyState(betterPartyStore, (partyState) => partyState.vote);
  const [remainingTime, setRemainingTime] = BetterPartyReact.useState(null);
  const phase = useBetterPartyState(betterPartyStore, (partyState) => partyState.phase);
  const hole = useBetterPartyState(betterPartyStore, (partyState) => partyState.holeIndex);
  const match = useBetterPartyState(betterPartyStore, (partyState) => partyState.matchId);
  const nextError = useBetterPartyState(betterPartyStore, (partyState) => partyState.nextError);
  const awaitingPlayers = useBetterPartyState(
    betterPartyStore,
    (partyState) => partyState.awaitingPlayers,
  );
  const roster = useBetterPartyState(betterPartyStore, (partyState) => partyState.roster);
  const [open, setOpen] = BetterPartyReact.useState(false);
  const [confirm, setConfirm] = BetterPartyReact.useState(null);
  const [pending, setPending] = BetterPartyReact.useState(false);
  const [error, setError] = BetterPartyReact.useState('');
  BetterPartyReact.useEffect(() => {
    setConfirm(null);
    setError('');
  }, [phase, hole, match]);
  BetterPartyReact.useEffect(() => {
    if (!active || !manager || phase === 'final' || phase === 'lobby') {
      setOpen(false);
      setConfirm(null);
      setRemainingTime(null);
    }
  }, [active, manager, phase]);
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
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
        setOpen(false);
        setConfirm(null);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  if (!active || !manager || !['playing', 'countdown', 'hole-results'].includes(phase)) {
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
      setConfirm(null);
      if (action === 'remaining-time') {
        setRemainingTime(null);
      }
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
  const section = (title, children) =>
    createElement('section', { key: title, className: 'bp-host-section', 'aria-label': title }, [
      createElement('h4', { key: 'heading' }, title),
      ...children,
    ]);
  const futureSeconds = remainingTime ?? String(Math.round(config.timerMs / 1000));
  const validTime =
    futureSeconds.trim() !== '' &&
    Number.isInteger(Number(futureSeconds)) &&
    Number(futureSeconds) >= 0 &&
    Number(futureSeconds) <= 86400;
  const confirmationMessages = {
    end: 'End the party now?',
    skip: 'Skip this hole for everyone?',
    restart: 'Restart this hole for everyone?',
    'skip-next': 'Skip the unloaded hole for everyone?',
    'restart-match': 'Restart the entire match with these courses?',
    'force-next': 'End the current hole with normal scoring and penalties?',
    'disable-elimination': 'Disable elimination for this match?',
    'admit-all': 'Admit every connected spectator to the current hole?',
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
                section('Players', [
                  createElement(BpManageRoster, {}),
                  actionButton(
                    'Admit all spectators',
                    () => setConfirm('admit-all'),
                    !live ||
                      !roster.some((player) => player.role === 'spectator' && player.connected),
                  ),
                  actionButton(config.locked ? 'Unlock party' : 'Lock party', () =>
                    run(config.locked ? 'unlock-party' : 'lock-party'),
                  ),
                ]),
                section('Current hole', [
                  actionButton(
                    paused ? 'Resume match' : 'Pause match',
                    () => run(paused ? 'resume' : 'pause'),
                    phase !== 'playing',
                  ),
                  createElement('p', { className: 'bp-host-label' }, 'Add time'),
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
                  actionButton('Restart level', () => setConfirm('restart'), !live),
                  actionButton(
                    'Finish current hole',
                    () => setConfirm('force-next'),
                    phase !== 'playing',
                  ),
                  actionButton('Skip level', () => setConfirm('skip'), !live),
                ]),
                section('Upcoming holes', [
                  createElement(BpUpcomingEditor, {}),
                  vote &&
                    !vote.resolution &&
                    actionButton('End voting now', () => run('skip-vote')),
                  nextError && actionButton('Retry next hole', () => run('retry-next')),
                  nextError && actionButton('Skip unloaded hole', () => setConfirm('skip-next')),
                  createElement(
                    'label',
                    { className: 'bp-host-label', htmlFor: 'bp-future-hole-time' },
                    'Time per future hole (seconds)',
                  ),
                  createElement('div', { className: 'bp-host-timer-field' }, [
                    createElement('input', {
                      id: 'bp-future-hole-time',
                      type: 'number',
                      min: 0,
                      max: 86400,
                      step: 1,
                      inputMode: 'numeric',
                      value: futureSeconds,
                      'aria-label': 'Future hole time in seconds',
                      onChange: (event) => setRemainingTime(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && validTime && live && !pending) {
                          event.preventDefault();
                          run('remaining-time', { value: Number(futureSeconds) });
                        }
                      },
                      disabled: !live || pending,
                    }),
                    actionButton(
                      'Set',
                      () => run('remaining-time', { value: Number(futureSeconds) }),
                      !live || !validTime,
                    ),
                  ]),
                  createElement('p', { className: 'bp-host-hint' }, '0 = unlimited'),
                ]),
                section('Match', [
                  actionButton(
                    'Disable elimination',
                    () => setConfirm('disable-elimination'),
                    !live || !config.elimination,
                  ),
                  actionButton('Restart match', () => setConfirm('restart-match')),
                  actionButton('End party', () => setConfirm('end'), false, 'bp-danger'),
                ]),
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
