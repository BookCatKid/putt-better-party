// The native dialog top layer keeps controls visible above the scoreboard,
// even when the lobby roster is clipped by its internal scroll container.
function BpManagementDialog({ title, children, close }) {
  const React = BetterPartyReact;
  const dialog = React.useRef(null);
  React.useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  return React.createElement(
    'dialog',
    {
      ref: dialog,
      className: 'bp-management-dialog',
      'aria-label': title,
      'data-bp-blocking-overlay': '',
      onCancel: (event) => {
        event.preventDefault();
        close();
      },
      onClick: (event) => {
        if (event.target === dialog.current) {
          const bounds = dialog.current.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          ) {
            close();
          }
        }
      },
    },
    [
      React.createElement('header', { key: 'header' }, [
        React.createElement('h3', { key: 'title' }, title),
        React.createElement(
          'button',
          { key: 'close', type: 'button', onClick: close, 'aria-label': 'Close management' },
          '×',
        ),
      ]),
      children,
      React.createElement(BpManagementNotice, { dialog: true, key: 'management-notice' }),
    ],
  );
}

function BpPlayerMenu({ uid }) {
  const React = BetterPartyReact;
  const party = useBetterPartyState(betterPartyStore, (state) => state);
  const member = party.roster.find((player) => player.uid === uid);
  const [open, setOpen] = React.useState(false);
  if ((!party.isHost && !party.bpCoHost) || !member || uid === party.self?.uid || member.isHost) {
    return null;
  }
  return React.createElement(React.Fragment, {}, [
    React.createElement(
      'button',
      {
        key: 'menu',
        type: 'button',
        className: 'bp-player-menu-button',
        'aria-label': 'Manage ' + member.name,
        title: 'Manage ' + member.name,
        onClick: () => setOpen(true),
      },
      '⋯',
    ),
    open &&
      React.createElement(BpPlayerEditor, {
        key: 'dialog',
        uid,
        close: () => setOpen(false),
      }),
  ]);
}

function BpPlayerEditor({ uid, close }) {
  const React = BetterPartyReact;
  const createElement = React.createElement;
  const party = useBetterPartyState(betterPartyStore, (state) => state);
  const member = party.roster.find((player) => player.uid === uid);
  const standing = party.board?.standings?.find((player) => player.uid === uid);
  const [name, setName] = React.useState(member?.name ?? '');
  const [hue, setHue] = React.useState(member?.hue ?? 0);
  const [strokes, setStrokes] = React.useState(1);
  const [confirm, setConfirm] = React.useState(null);
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState('');
  React.useEffect(() => {
    if (!member || (!party.isHost && !party.bpCoHost)) {
      close();
    }
  }, [member, party.isHost, party.bpCoHost, close]);
  if (!member || (!party.isHost && !party.bpCoHost)) {
    return null;
  }
  const live = ['playing', 'countdown'].includes(party.phase);
  const available = live || party.phase === 'lobby';
  const activePlayer = member.role === 'player' && member.alive;
  const canEditScore = live && activePlayer && !!standing;
  const button = (label, action, disabled = false, dangerous = false) =>
    createElement(
      'button',
      {
        type: 'button',
        className: 'bp-host-item' + (dangerous ? ' bp-danger' : ''),
        onClick: action,
        disabled: disabled || pending,
      },
      label,
    );
  async function run(action, value) {
    setPending(true);
    setFailure('');
    try {
      await bpHostAction(action, { uid, value });
      setConfirm(null);
      if (['kick', 'ban', 'transfer-host'].includes(action)) {
        close();
      }
    } catch (commandError) {
      setFailure(commandError.message);
    } finally {
      setPending(false);
    }
  }
  const request = (action, label) => setConfirm({ action, label });
  return createElement(BpManagementDialog, { title: member.name, close }, [
    createElement(
      'p',
      { className: 'bp-management-meta', key: 'status' },
      [
        member.role === 'spectator' ? 'Spectator' : 'Player',
        member.connected ? 'Connected' : 'Disconnected',
        ...(member.coHost ? ['Co-host'] : []),
        ...(standing ? [standing.strokes + ' strokes'] : []),
      ].join(' · '),
    ),
    failure &&
      createElement(
        'p',
        { key: 'failure', role: 'alert', className: 'bp-management-error' },
        failure,
      ),
    confirm
      ? createElement('section', { key: 'confirm', className: 'bp-management-group' }, [
          createElement('p', {}, confirm.label + '?'),
          createElement('div', { className: 'bp-management-buttons' }, [
            button('Cancel', () => setConfirm(null)),
            button('Confirm', () => run(confirm.action), false, true),
          ]),
        ])
      : createElement(React.Fragment, { key: 'settings' }, [
          createElement('section', { className: 'bp-management-group' }, [
            createElement('label', { className: 'bp-management-field' }, [
              'Name',
              createElement('input', {
                value: name,
                maxLength: 24,
                'aria-label': 'Player name',
                onChange: (event) => setName(event.target.value),
              }),
              button(
                'Save',
                () => run('rename', name),
                !name.trim() || name.trim() === member.name,
              ),
            ]),
            createElement('label', { className: 'bp-management-field' }, [
              'Ball color',
              createElement('input', {
                type: 'range',
                min: 0,
                max: 359,
                value: hue,
                'aria-label': 'Ball hue',
                onChange: (event) => setHue(Number(event.target.value)),
              }),
              createElement('span', {
                className: 'bp-management-color',
                style: { background: 'hsl(' + hue + ',75%,62%)' },
              }),
              button('Apply', () => run('color', hue)),
            ]),
          ]),
          live &&
            createElement('section', { className: 'bp-management-group' }, [
              createElement('h4', {}, 'Current hole'),
              button(
                'Restart player’s hole',
                () => request('restart-player', 'Restart this player’s hole'),
                !activePlayer || !member.connected,
              ),
              button(
                'Forfeit player’s hole',
                () => request('forfeit-player', 'Forfeit this player’s hole'),
                !activePlayer || !!standing?.finished,
              ),
              button(
                'Reset strokes',
                () => request('reset-strokes', 'Reset this player’s strokes'),
                !canEditScore,
              ),
              createElement('div', { className: 'bp-management-field' }, [
                createElement('input', {
                  type: 'number',
                  min: 1,
                  max: 200,
                  value: strokes,
                  'aria-label': 'Stroke adjustment amount',
                  onChange: (event) => setStrokes(Number(event.target.value)),
                }),
                button(
                  '− strokes',
                  () => run('adjust-strokes', -strokes),
                  !canEditScore || !Number.isInteger(strokes) || strokes < 1 || strokes > 200,
                ),
                button(
                  '+ strokes',
                  () => run('adjust-strokes', strokes),
                  !canEditScore || !Number.isInteger(strokes) || strokes < 1 || strokes > 200,
                ),
              ]),
            ]),
          createElement('section', { className: 'bp-management-group' }, [
            createElement('h4', {}, 'Participation'),
            button(
              member.puttingLocked ? 'Allow putting' : 'Prevent putting',
              () => run(member.puttingLocked ? 'unlock-putting' : 'lock-putting'),
              !available,
            ),
            activePlayer
              ? button(
                  'Move to spectators',
                  () => request('spectate-player', 'Move this player to spectators'),
                  !available,
                )
              : button(
                  member.spectatorReason === 'eliminated' ? 'Revive player' : 'Return to play',
                  () =>
                    run(
                      member.spectatorReason === 'eliminated' ? 'revive-player' : 'return-player',
                    ),
                  !available || !member.connected,
                ),
            party.isHost &&
              button(member.coHost ? 'Revoke co-host' : 'Make co-host', () =>
                request(
                  member.coHost ? 'revoke-cohost' : 'grant-cohost',
                  member.coHost ? 'Revoke co-host' : 'Make this player co-host',
                ),
              ),
            party.isHost &&
              button(
                'Transfer host',
                () => request('transfer-host', 'Transfer host to this player'),
                !member.connected,
              ),
          ]),
          createElement('section', { className: 'bp-management-group' }, [
            button('Kick player', () => request('kick', 'Kick this player'), false, true),
            button(
              'Ban from party',
              () => request('ban', 'Ban this identity and name from the party'),
              false,
              true,
            ),
            createElement(
              'p',
              { className: 'bp-management-meta' },
              'Bans block this session and name. Without accounts they cannot identify a new identity using a different name.',
            ),
          ]),
        ]),
  ]);
}

function BpBannedNames() {
  const React = BetterPartyReact;
  const createElement = React.createElement;
  const party = useBetterPartyState(betterPartyStore, (state) => state);
  const [names, setNames] = React.useState([]);
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState('');
  const code = party.code;

  // Bans are moderation state, so they are fetched from a host-only route rather
  // than carried in the broadcast snapshot, which every player receives.
  const refresh = React.useCallback(async () => {
    try {
      const result = await bpHostRequest(
        '/api/bans',
        bpHostAuth(code, party.self?.uid, party.self?.session),
        {},
        'Could not load bans',
      );
      if (!Array.isArray(result.names)) {
        throw Error('Could not load bans');
      }
      setNames(result.names);
    } catch (loadError) {
      setFailure(loadError.message);
    }
  }, [code, party.self?.uid, party.self?.session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!names.length && !failure) {
    return null;
  }
  async function lift(name) {
    setPending(true);
    setFailure('');
    try {
      await bpHostAction('unban', { value: name });
      setNames((previous) => previous.filter((entry) => entry !== name));
    } catch (commandError) {
      setFailure(commandError.message);
    } finally {
      setPending(false);
    }
  }
  return createElement('section', { className: 'bp-management-group' }, [
    createElement('p', { className: 'bp-management-meta', key: 'heading' }, 'Banned names'),
    failure &&
      createElement(
        'p',
        { key: 'failure', role: 'alert', className: 'bp-management-error' },
        failure,
      ),
    ...names.map((name) =>
      createElement(
        'button',
        {
          type: 'button',
          key: name,
          className: 'bp-host-item',
          disabled: pending,
          onClick: () => void lift(name),
        },
        'Lift ban on ' + name,
      ),
    ),
  ]);
}

function BpManageRoster() {
  const party = useBetterPartyState(betterPartyStore, (state) => state);
  const React = BetterPartyReact;
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState(null);
  const createElement = React.createElement;
  if (!party.isHost && !party.bpCoHost) {
    return null;
  }
  const players = party.roster.filter((player) => player.uid !== party.self?.uid && !player.isHost);
  return createElement(React.Fragment, {}, [
    createElement(
      'button',
      { type: 'button', className: 'bp-host-item', onClick: () => setOpen(true) },
      'Manage players',
    ),
    open && selected
      ? createElement(BpPlayerEditor, {
          uid: selected,
          close: () => {
            setSelected(null);
            setOpen(false);
          },
        })
      : open &&
        createElement(
          BpManagementDialog,
          { title: 'Manage players', close: () => setOpen(false) },
          createElement(
            'section',
            { className: 'bp-management-group' },
            players.length
              ? players.map((player) =>
                  createElement(
                    'button',
                    {
                      type: 'button',
                      key: player.uid,
                      className: 'bp-host-item',
                      onClick: () => setSelected(player.uid),
                    },
                    player.name +
                      (player.role === 'spectator' ? ' · Spectator' : '') +
                      (player.connected ? '' : ' · Disconnected'),
                  ),
                )
              : createElement('p', {}, 'No other players'),
          ),
          createElement(BpBannedNames, { key: 'bans' }),
        ),
  ]);
}

function BpUpcomingEditor() {
  const React = BetterPartyReact;
  const createElement = React.createElement;
  const party = useBetterPartyState(betterPartyStore, (state) => state);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState([]);
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState('');
  const upcoming = party.holeIds.slice(party.holeIndex + 1);
  const live = ['playing', 'countdown'].includes(party.phase);
  // Pressing Enter in the search field submits the form even while the submit
  // button is disabled, so two searches can overlap. Without a generation check
  // the slower, older response would overwrite the newer results - the same stale
  // write the community picker already guards against.
  const searchGeneration = React.useRef(0);
  async function apply(action, argument) {
    setPending(true);
    setFailure('');
    try {
      await bpHostAction(action, { ...argument, revision: party.bpPlaylistRevision });
    } catch (commandError) {
      setFailure(commandError.message);
    } finally {
      setPending(false);
    }
  }
  async function search(event) {
    event.preventDefault();
    const generation = ++searchGeneration.current;
    setPending(true);
    setFailure('');
    try {
      const response = await fetch(
        '/api/catalog?' + new URLSearchParams({ search: query.trim() }),
        { signal: AbortSignal.timeout(15000) },
      );
      const result = await response.json();
      if (generation !== searchGeneration.current) {
        return;
      }
      if (!response.ok || !Array.isArray(result.holes)) {
        throw Error(result.error || 'Could not load courses');
      }
      setResults(result.holes);
    } catch (searchError) {
      if (generation === searchGeneration.current) {
        setFailure(searchError.message);
      }
    } finally {
      if (generation === searchGeneration.current) {
        setPending(false);
      }
    }
  }
  function move(index, offset) {
    const ids = upcoming.slice();
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    return apply('playlist', { ids });
  }
  const action = (label, handler, disabled = false) =>
    createElement(
      'button',
      {
        className: 'bp-host-item',
        type: 'button',
        onClick: handler,
        disabled: disabled || pending || !live,
      },
      label,
    );
  return createElement(React.Fragment, {}, [
    action('Edit upcoming holes', () => setOpen(true), !live),
    open &&
      createElement(BpManagementDialog, { title: 'Upcoming holes', close: () => setOpen(false) }, [
        createElement(
          'p',
          { className: 'bp-management-meta' },
          'Completed and current holes stay unchanged. Editing the playlist disables voting for remaining holes and leaderboard eligibility.',
        ),
        failure && createElement('p', { role: 'alert', className: 'bp-management-error' }, failure),
        createElement(
          'section',
          { className: 'bp-management-group' },
          upcoming.length
            ? upcoming.map((id, index) =>
                createElement('div', { key: index + ':' + id, className: 'bp-management-course' }, [
                  createElement(
                    'span',
                    {},
                    party.holeIndex + index + 2 + '. ' + (party.playlistTitles?.[id] ?? id),
                  ),
                  action('↑', () => move(index, -1), index === 0),
                  action('↓', () => move(index, 1), index + 1 === upcoming.length),
                  action('Remove', () =>
                    apply('playlist', { ids: upcoming.filter((_id, at) => at !== index) }),
                  ),
                ]),
              )
            : createElement('p', {}, 'No upcoming holes'),
        ),
        createElement('form', { className: 'bp-management-field', onSubmit: search }, [
          createElement('input', {
            placeholder: 'Search public courses',
            value: query,
            'aria-label': 'Search public courses',
            onChange: (event) => setQuery(event.target.value),
          }),
          createElement(
            'button',
            { type: 'submit', className: 'bp-host-item', disabled: pending || !live },
            'Search',
          ),
        ]),
        createElement(
          'section',
          { className: 'bp-management-group' },
          results.map((course) =>
            createElement('div', { key: course.id, className: 'bp-management-course' }, [
              createElement('span', {}, course.title ?? course.id),
              action('Add', () => apply('add-course', { value: course.id })),
            ]),
          ),
        ),
      ]),
  ]);
}

function BpManagementNotice({ lobby = false, dialog = false } = {}) {
  const state = useBetterPartyState(betterPartyStore, (partyState) => partyState);
  if (!state.active || (!dialog && (state.phase === 'lobby') !== lobby)) {
    return null;
  }
  const createElement = BetterPartyReact.createElement;
  let className = 'bp-management-notices';
  if (dialog) {
    className += ' bp-dialog-notices';
  } else if (lobby) {
    className += ' bp-lobby-notices';
  }
  return createElement(
    'div',
    {
      className,
      'aria-live': 'polite',
    },
    [
      state.bpPausedAt &&
        createElement(
          'p',
          { className: 'bp-management-pause', key: 'paused' },
          'Match paused by host',
        ),
      state.bpPuttingLocked &&
        createElement(
          'p',
          { className: 'bp-management-pause', key: 'putting' },
          'Putting disabled by host',
        ),
      state.bpHostNotice &&
        createElement(
          'p',
          { className: 'bp-management-toast', key: state.bpHostNotice.id },
          state.bpHostNotice.message,
        ),
    ],
  );
}
