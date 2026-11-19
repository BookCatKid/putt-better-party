/**
 * Marks a player whose socket has dropped, in the in-game HUD and the final list.
 *
 * Eliminated, spectating and disconnected are three different things and the
 * original rows already distinguish the first two - eliminated players are struck
 * through, spectators get an eye. A dropped player is struck through too once
 * eliminated, so without this the two are indistinguishable at a glance.
 */
function BpLeftMark({ row }) {
  if (row.connected !== false) {
    return null;
  }
  return BetterPartyReact.createElement(
    'span',
    { className: 'bp-left-mark', key: 'left', title: 'Disconnected' },
    ' · left',
  );
}

// Uses the same React/store bindings as the original party HUD.
function BpWatchName({ row, isSelf }) {
  const party = useBetterPartyState(betterPartyStore, (state) => state);
  const phase = useBetterPartyState(followGameStore, (state) => state.phase);
  const createElement = BetterPartyReact.createElement;
  const enabled =
    canWatch(party, phase) && watchCandidates(party).some((player) => player.uid === row.uid);
  const selected = followTarget(party, phase)?.uid === row.uid;
  const className =
    'flex-1 truncate text-xs font-medium ' +
    (row.alive ? 'text-white/90' : 'text-white/50 line-through');
  const mark = createElement(BpLeftMark, { row, key: 'left' });
  if (!enabled) {
    return createElement('span', { className }, [row.name + (isSelf ? ' (you)' : ''), mark]);
  }
  return createElement(
    'button',
    {
      type: 'button',
      className: className + ' bp-watch-name',
      onClick: () => bpSelectWatchTarget(row.uid),
      'aria-pressed': selected,
      'aria-label': 'Follow ' + row.name,
      title: 'Follow ' + row.name,
    },
    [row.name, mark],
  );
}

function BpFollowControls() {
  const party = useBetterPartyState(betterPartyStore, (state) => state);
  const phase = useBetterPartyState(followGameStore, (state) => state.phase);
  if (!canWatch(party, phase)) {
    return null;
  }
  const choices = watchCandidates(party);
  const target = followTarget(party, phase);
  const mode = watchChoice(party);
  const createElement = BetterPartyReact.createElement;
  const current = mode === 'free' || choices.some((player) => player.uid === mode) ? mode : 'auto';
  let message = 'Free camera';
  if (target) {
    message = 'Following ' + target.name;
    if (!party.bpWatchLive) {
      message += ' · waiting for ball';
    }
  } else if (mode !== 'free') {
    message = 'Waiting for another player';
  }
  return createElement('div', { className: 'bp-follow-controls' }, [
    createElement('p', { key: 'status', className: 'bp-follow-status', role: 'status' }, message),
    !target &&
      createElement(
        'p',
        { key: 'hint', className: 'bp-watch-hint' },
        'Right-click + WASD · Q / E down / up',
      ),
    createElement(
      'select',
      {
        key: 'picker',
        'aria-label': 'Spectator camera',
        value: current,
        onChange: (event) => bpSelectWatchTarget(event.target.value),
      },
      [
        createElement('option', { key: 'auto', value: 'auto' }, 'Auto follow'),
        ...choices.map((player) =>
          createElement('option', { key: player.uid, value: player.uid }, player.name),
        ),
        createElement('option', { key: 'free', value: 'free' }, 'Free camera'),
      ],
    ),
  ]);
}
