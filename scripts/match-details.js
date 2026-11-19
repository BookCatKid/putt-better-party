function BpGuestPlaylist() {
  const config = useBetterPartyState(betterPartyStore, (partyState) => partyState.config);
  const titles =
    useBetterPartyState(betterPartyStore, (partyState) => partyState.playlistTitles) ?? {};
  const createElement = BetterPartyReact.createElement;
  return createElement('div', { className: 'mb-4 rounded-xl bg-white/5 p-3 text-left' }, [
    createElement(
      'p',
      { className: 'mb-2 text-sm font-bold' },
      config.holes +
        ' holes · ' +
        (config.timerMs ? Math.round(config.timerMs / 1000) + 's' : 'Unlimited') +
        ' · ' +
        (config.elimination ? 'Elimination' : 'Stroke play'),
    ),
    config.mapSource === 'picked'
      ? createElement(
          'ol',
          { className: 'bp-guest-course-list' },
          (config.selectedHoleIds ?? []).map((id, index) =>
            createElement('li', { key: index + ':' + id }, [
              createElement('img', {
                src: '/api/preview/' + encodeURIComponent(id),
                alt: '',
                loading: 'lazy',
              }),
              createElement('span', {}, index + 1 + '. ' + (titles[id] ?? id)),
            ]),
          ),
        )
      : createElement(
          'p',
          { className: 'text-xs text-white/70' },
          config.courseVoting ? 'Random courses · vote before every hole' : 'Random holes',
        ),
    createElement(
      'p',
      { className: 'mt-2 text-xs text-white/60' },
      'Join during a match: ' +
        ({ never: 'Never', 'next-hole': 'After current hole', always: 'Always' }[
          config.lateJoin ?? 'always'
        ] ?? 'Always'),
    ),
  ]);
}
function BpScorecard() {
  const history = useBetterPartyState(betterPartyStore, (partyState) => partyState.roundHistory);
  const final = useBetterPartyState(betterPartyStore, (partyState) => partyState.final);
  const [open, setOpen] = BetterPartyReact.useState(false);
  if (!history?.length || !final?.standings?.length) {
    return null;
  }
  const createElement = BetterPartyReact.createElement;
  return createElement('section', { className: 'bp-scorecard' }, [
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setOpen(!open),
        'aria-expanded': open,
        className: 'rounded-full bg-white/10 px-4 py-2 text-xs font-semibold',
      },
      open ? 'Hide scorecard' : 'Scorecard',
    ),
    open &&
      createElement(
        'div',
        { className: 'bp-scorecard-scroll' },
        createElement('table', {}, [
          createElement('thead', {}, [
            createElement('tr', {}, [
              createElement('th', {}, 'Hole'),
              ...history.map((round) =>
                createElement('th', { key: round.index, title: round.title }, round.index + 1),
              ),
              createElement('th', {}, 'Total'),
            ]),
            createElement('tr', {}, [
              createElement('th', {}, 'Par'),
              ...history.map((round) =>
                createElement(
                  'td',
                  { key: round.index },
                  round.status === 'skipped' ? '—' : round.par,
                ),
              ),
              createElement('td', {}, ''),
            ]),
          ]),
          createElement(
            'tbody',
            {},
            final.standings.map((player) =>
              createElement('tr', { key: player.uid }, [
                createElement('th', {}, player.name),
                ...history.map((round) => {
                  const score = round.rows.find((entry) => entry.uid === player.uid);
                  return createElement(
                    'td',
                    {
                      key: round.index,
                      title: round.title + ' · ' + (score?.status ?? round.status),
                      className: score?.status === 'holed' ? 'bp-holed' : '',
                    },
                    [
                      round.status === 'skipped'
                        ? 'Skip'
                        : (score?.strokes ?? (score?.status === 'eliminated' ? 'DNF' : '—')),
                      score?.timeMs != null &&
                        createElement(
                          'small',
                          { key: 'time', className: 'bp-cell-time' },
                          bpFormatTime(score.timeMs),
                        ),
                    ],
                  );
                }),
                createElement('td', {}, [
                  player.totalStrokes,
                  createElement(
                    'small',
                    { key: 'time', className: 'bp-cell-time' },
                    bpFormatTime(player.totalTimeMs),
                  ),
                ]),
              ]),
            ),
          ),
        ]),
      ),
  ]);
}

function BpLobbyOptions() {
  const config = useBetterPartyState(betterPartyStore, (partyState) => partyState.config);
  const preparing = useBetterPartyState(
    betterPartyStore,
    (partyState) => partyState.preparing || partyState.bpPickerBusy,
  );
  const connected = useBetterPartyState(betterPartyStore, (partyState) => partyState.bpConnected);
  const count = useBetterPartyState(betterPartyStore, (partyState) => partyState.count);
  const createElement = BetterPartyReact.createElement;
  return createElement('div', { className: 'bp-lobby-options' }, [
    createElement('label', {}, [
      createElement('span', {}, 'Maximum players'),
      createElement(
        'select',
        {
          'aria-label': 'Maximum players',
          disabled: preparing || !connected,
          value: config.maxPlayers,
          onChange: (event) => updateBetterPartyConfig({ maxPlayers: Number(event.target.value) }),
        },
        [...new Set([2, 4, 6, 8, 10, 12, 16, 20, 30, 50, config.maxPlayers])]
          .sort((score, right) => score - right)
          .map((number) =>
            createElement(
              'option',
              { key: number, value: number, disabled: number < count },
              number,
            ),
          ),
      ),
    ]),
    createElement('label', {}, [
      createElement('span', {}, 'Join during a match'),
      createElement(
        'select',
        {
          'aria-label': 'Join during a match',
          disabled: preparing || !connected,
          value: config.lateJoin ?? 'always',
          onChange: (event) => updateBetterPartyConfig({ lateJoin: event.target.value }),
        },
        [
          ['never', 'Never'],
          ['next-hole', 'After current hole'],
          ['always', 'Always'],
        ].map(([value, label]) => createElement('option', { key: value, value }, label)),
      ),
    ]),
    createElement('label', {}, [
      createElement('span', {}, 'Lock party'),
      createElement('input', {
        type: 'checkbox',
        'aria-label': 'Lock party',
        checked: !!config.locked,
        disabled: preparing || !connected,
        onChange: (event) => updateBetterPartyConfig({ locked: event.target.checked }),
      }),
    ]),
    config.locked &&
      createElement(
        'p',
        { className: 'text-xs text-white/60' },
        'Existing players can reconnect. New players cannot join.',
      ),
  ]);
}
function BpRecoveryNotice() {
  const recovered = useBetterPartyState(
    betterPartyStore,
    (partyState) => partyState.recoveryNotice,
  );
  return recovered
    ? BetterPartyReact.createElement(
        'p',
        { className: 'mb-3 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-200', role: 'status' },
        'The server restarted. Your party and settings were recovered; start a new match when ready.',
      )
    : null;
}
function BpUpcoming() {
  const ids = useBetterPartyState(betterPartyStore, (partyState) => partyState.holeIds);
  const index = useBetterPartyState(betterPartyStore, (partyState) => partyState.holeIndex);
  const titles = useBetterPartyState(betterPartyStore, (partyState) => partyState.playlistTitles);
  if (!ids[index + 1] || !titles?.[ids[index + 1]]) {
    return null;
  }
  return BetterPartyReact.createElement(
    'p',
    { className: 'bp-upcoming', title: titles[ids[index + 1]] },
    'Next: ' + titles[ids[index + 1]],
  );
}

function BpNumericField({
  label,
  value,
  min,
  max,
  apply,
  disabled,
  unit,
  sliderStep = 1,
  inputMax = max,
  inputMin = min,
}) {
  const createElement = BetterPartyReact.createElement;
  const [draft, setDraft] = BetterPartyReact.useState(String(value));
  const [slider, setSlider] = BetterPartyReact.useState(Math.max(min, Math.min(value, max)));
  const cancel = BetterPartyReact.useRef(false);
  BetterPartyReact.useEffect(() => {
    setDraft(String(value));
    setSlider(Math.max(min, Math.min(value, max)));
  }, [value]);
  function commit() {
    if (cancel.current) {
      cancel.current = false;
      setDraft(String(value));
      return;
    }
    const number = Number(draft);
    if (draft.trim() && Number.isInteger(number) && number >= inputMin && number <= inputMax) {
      if (number !== value) {
        apply(number);
      }
      setDraft(String(number));
      setSlider(Math.max(min, Math.min(number, max)));
    } else {
      setDraft(String(value));
    }
  }
  function slide(event) {
    const number = Number(event.target.value);
    setSlider(number);
    setDraft(String(number));
    if (number !== value) {
      apply(number);
    }
  }
  return createElement('div', { className: 'bp-number-row' }, [
    createElement('span', {}, label),
    createElement('div', { className: 'bp-number-wrap' }, [
      createElement('input', {
        type: 'range',
        'aria-label': label + ' slider',
        min,
        max,
        step: sliderStep,
        value: slider,
        disabled,
        onChange: slide,
        className: 'bp-number-slider',
      }),
      createElement('div', { className: 'bp-number-box' }, [
        createElement('input', {
          type: 'number',
          'aria-label': label,
          min: inputMin,
          max: inputMax,
          step: 1,
          value: draft,
          disabled,
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              cancel.current = true;
              event.currentTarget.blur();
            }
          },
        }),
        unit && createElement('span', { className: 'bp-number-unit' }, unit),
      ]),
    ]),
  ]);
}
function BpNumericSettings({ section } = {}) {
  const configuration = useBetterPartyState(betterPartyStore, (partyState) => partyState.config);
  const disabled = useBetterPartyState(
    betterPartyStore,
    (partyState) => partyState.preparing || partyState.bpPickerBusy || !partyState.bpConnected,
  );
  const createElement = BetterPartyReact.createElement;
  return createElement(BetterPartyReact.Fragment, {}, [
    section !== 'timer' &&
      configuration.mapSource === 'random' &&
      createElement(BpNumericField, {
        label: 'Holes',
        value: configuration.holes,
        min: 1,
        max: 9,
        inputMax: 10000,
        apply: (holes) => updateBetterPartyConfig({ holes }),
        disabled,
      }),
    section !== 'holes' &&
      createElement(BpNumericField, {
        label: 'Timer',
        value: Math.round(configuration.timerMs / 1000),
        min: 20,
        max: 300,
        inputMin: 0,
        inputMax: 86400,
        apply: (number) => updateBetterPartyConfig({ timerMs: number * 1000 }),
        disabled,
        unit: 's',
      }),
  ]);
}

function BpGuestStarting() {
  const preparing = useBetterPartyState(betterPartyStore, (partyState) => partyState.preparing);
  const phase = useBetterPartyState(betterPartyStore, (partyState) => partyState.phase);
  if (!preparing || phase !== 'lobby') {
    return null;
  }
  const createElement = BetterPartyReact.createElement;
  return createElement(
    'div',
    { className: 'bp-guest-starting', role: 'status', 'aria-live': 'polite' },
    [
      createElement('span', { className: 'bp-loading-spinner', 'aria-hidden': true }),
      createElement('div', {}, [
        createElement('p', { className: 'bp-starting-title' }, 'The host has started the party'),
        createElement('p', { className: 'bp-starting-detail' }, 'Loading courses…'),
      ]),
    ],
  );
}

function BpSpectating() {
  const role = useBetterPartyState(betterPartyStore, (state) => state.selfRole);
  const phase = useBetterPartyState(betterPartyStore, (state) => state.phase);
  const roster = useBetterPartyState(betterPartyStore, (state) => state.roster);
  const uid = useBetterPartyState(betterPartyStore, (state) => state.self?.uid);
  if (role !== 'spectator' || !['countdown', 'playing'].includes(phase)) {
    return null;
  }
  const player = roster.find((entry) => entry.uid === uid);
  let detail = 'You can play when the next match starts.';
  if (player?.spectatorReason === 'next-hole') {
    detail = 'You’ll join at the next hole if the match continues.';
  } else if (player?.spectatorReason === 'eliminated') {
    detail = 'You’re out of this match. Watch the remaining players.';
  } else if (player?.spectatorReason === 'round-forfeit') {
    detail = 'You’re watching the rest of this hole.';
  }
  const createElement = BetterPartyReact.createElement;
  return createElement('div', { className: 'bp-spectating', role: 'status' }, [
    createElement('p', { className: 'bp-spectating-title' }, 'Spectating'),
    createElement('p', { className: 'bp-spectating-detail' }, detail),
  ]);
}

// The original party runtime already presents server-relative start and end times.
function bpFormatTime(ms) {
  if (!Number.isFinite(ms)) {
    return '—';
  }
  const milliseconds = Math.floor(Math.max(0, ms));
  return (
    Math.floor(milliseconds / 60000) +
    ':' +
    String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0') +
    '.' +
    String(milliseconds % 1000).padStart(3, '0')
  );
}

function BpPlayerTime({ row, total }) {
  return BetterPartyReact.createElement(
    'span',
    {
      className: 'bp-player-time',
      title: total ? 'Total scored time' : 'Hole time',
    },
    bpFormatTime(total ? row.totalTimeMs : row.holeTimeMs),
  );
}

function BpHoleClock() {
  const phase = useBetterPartyState(betterPartyStore, (state) => state.phase);
  const start = useBetterPartyState(betterPartyStore, (state) => state.startAt);
  const end = useBetterPartyState(betterPartyStore, (state) => state.timerEndsAt);
  const role = useBetterPartyState(betterPartyStore, (state) => state.selfRole);
  const board = useBetterPartyState(betterPartyStore, (state) => state.board);
  const uid = useBetterPartyState(betterPartyStore, (state) => state.self?.uid);
  const [now, setNow] = BetterPartyReact.useState(Date.now);
  BetterPartyReact.useEffect(() => {
    if (phase !== 'playing') {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [phase, start]);
  if (phase !== 'playing' || role === 'spectator' || !start) {
    return null;
  }
  const player = board?.standings?.find((entry) => entry.uid === uid);
  const elapsed = player?.holeTimeMs ?? Math.max(0, Math.min(now, end || now) - start);
  return BetterPartyReact.createElement(
    'p',
    { className: 'bp-hole-clock' },
    'Time ' + bpFormatTime(elapsed),
  );
}

// The server has already made the weighted draw. This reel only presents it;
// the deadline (translated by the runtime adapter) also supports rejoining mid-spin.
function BpVoteReel({ vote, now }) {
  const { winnerId, durationMs } = vote.resolution;
  const winnerIndex = vote.choices.findIndex((choice) => choice.id === winnerId);
  const winner = vote.choices[winnerIndex];
  const spinMs = Math.max(1, durationMs - 700);
  const startsAt = vote.endsAt - durationMs;
  const landed = now >= startsAt + spinMs;
  const [elapsedOnMount] = BetterPartyReact.useState(() => Math.max(0, Date.now() - startsAt));
  const stopIndex = vote.choices.length * 5 + winnerIndex;
  const reel = Array.from(
    { length: vote.choices.length * 7 },
    (_unused, index) => vote.choices[index % vote.choices.length],
  );
  const createElement = BetterPartyReact.createElement;
  return createElement('div', { className: 'bp-vote-reveal' }, [
    createElement(
      'div',
      {
        key: 'window',
        className: 'bp-vote-reel' + (landed ? ' bp-vote-reel-landed' : ''),
        'aria-hidden': true,
      },
      [
        createElement(
          'div',
          {
            key: 'track',
            className: 'bp-vote-reel-track',
            style: {
              '--bp-reel-stop': 'calc(var(--bp-reel-step) * -' + (stopIndex + 0.5) + ')',
              animationDuration: spinMs + 'ms',
              animationDelay: -Math.min(spinMs, elapsedOnMount) + 'ms',
            },
          },
          reel.map((choice, index) =>
            createElement('div', { key: index, className: 'bp-vote-reel-item' }, [
              createElement('img', {
                key: 'preview',
                src: '/api/preview/' + encodeURIComponent(choice.id),
                alt: '',
              }),
              createElement('strong', { key: 'title' }, choice.title),
            ]),
          ),
        ),
        createElement('div', { key: 'pointer', className: 'bp-vote-reel-pointer' }),
      ],
    ),
    createElement(
      'p',
      { key: 'result', className: 'bp-vote-reel-result', role: 'status' },
      landed ? winner.title : 'Choosing the next course…',
    ),
  ]);
}

function BpCourseVote() {
  const vote = useBetterPartyState(betterPartyStore, (state) => state.vote);
  const uid = useBetterPartyState(betterPartyStore, (state) => state.self?.uid);
  const connected = useBetterPartyState(betterPartyStore, (state) => state.bpConnected);
  const [now, setNow] = BetterPartyReact.useState(Date.now);
  BetterPartyReact.useEffect(() => {
    if (!vote?.id) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [vote?.id]);
  if (!vote) {
    return null;
  }
  if (vote.resolution) {
    return BetterPartyReact.createElement('section', { className: 'bp-course-vote' }, [
      BetterPartyReact.createElement(
        'h3',
        { key: 'title', className: 'text-lg font-black' },
        'Hole ' + (vote.target + 1),
      ),
      BetterPartyReact.createElement(BpVoteReel, { key: vote.id, vote, now }),
    ]);
  }
  const seconds = Math.max(0, Math.ceil((vote.endsAt - now) / 1000));
  const selected = vote.ballots?.[uid];
  const createElement = BetterPartyReact.createElement;
  return createElement('section', { className: 'bp-course-vote' }, [
    createElement(
      'h3',
      { key: 'title', className: 'text-lg font-black' },
      'Vote for hole ' + (vote.target + 1),
    ),
    createElement(
      'p',
      { key: 'remaining', className: 'text-xs text-white/65' },
      seconds
        ? seconds + 's remaining · Random selection weighted by votes'
        : 'Choosing the next course…',
    ),
    createElement(
      'div',
      { key: 'choices', className: 'bp-vote-grid' },
      vote.choices.map((choice) =>
        createElement(
          'button',
          {
            key: choice.id,
            type: 'button',
            className: 'bp-vote-course',
            'aria-pressed': selected === choice.id,
            disabled: !connected || seconds === 0,
            onClick: () => bpCastVote(choice.id),
          },
          [
            createElement('img', {
              key: 'preview',
              src: '/api/preview/' + encodeURIComponent(choice.id),
              alt: '',
              loading: 'eager',
            }),
            createElement('strong', { key: 'title' }, choice.title),
            createElement(
              'span',
              { key: 'author', className: 'bp-vote-meta' },
              choice.author || 'Community course',
            ),
            createElement(
              'span',
              { key: 'meta', className: 'bp-vote-meta' },
              'Par ' +
                choice.par +
                (Number.isFinite(choice.ratingAvg)
                  ? ' · ★ ' + choice.ratingAvg.toFixed(1)
                  : ' · Unrated'),
            ),
            createElement(
              'span',
              { key: 'tally', className: 'bp-vote-tally' },
              choice.votes +
                (choice.votes === 1 ? ' vote' : ' votes') +
                (selected === choice.id ? ' · Your vote' : ''),
            ),
          ],
        ),
      ),
    ),
  ]);
}

function BpReplayLink() {
  const replayId = useBetterPartyState(betterPartyStore, (partyState) => partyState.replayId);
  const phase = useBetterPartyState(betterPartyStore, (partyState) => partyState.phase);
  const hole = useBetterPartyState(betterPartyStore, (partyState) => partyState.holeIndex);
  if (!replayId) {
    return null;
  }
  return BetterPartyReact.createElement(
    'a',
    {
      href:
        '/replays/' +
        encodeURIComponent(replayId) +
        (phase === 'hole-results' ? '?hole=' + hole : ''),
      target: '_blank',
      rel: 'noopener noreferrer',
      className:
        'mb-3 block rounded-full bg-white/10 px-4 py-2 text-sm font-bold text-white/85 no-underline transition hover:bg-white/20',
    },
    'View party replays',
  );
}
