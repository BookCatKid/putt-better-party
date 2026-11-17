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
        Math.round(config.timerMs / 1000) +
        's · ' +
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
      : createElement('p', { className: 'text-xs text-white/70' }, 'Random holes'),
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
                    round.status === 'skipped'
                      ? 'Skip'
                      : (score?.strokes ?? (score?.status === 'eliminated' ? 'DNF' : '—')),
                  );
                }),
                createElement('td', {}, player.totalStrokes),
              ]),
            ),
          ),
        ]),
      ),
  ]);
}

function BpLobbyOptions() {
  const config = useBetterPartyState(betterPartyStore, (partyState) => partyState.config);
  const preparing = useBetterPartyState(betterPartyStore, (partyState) => partyState.preparing);
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

function BpNumericField({ label, value, min, max, apply, disabled, unit, sliderStep = 1 }) {
  const createElement = BetterPartyReact.createElement;
  const [draft, setDraft] = BetterPartyReact.useState(String(value));
  const [slider, setSlider] = BetterPartyReact.useState(value);
  const cancel = BetterPartyReact.useRef(false);
  BetterPartyReact.useEffect(() => {
    setDraft(String(value));
    setSlider(value);
  }, [value]);
  function commit() {
    if (cancel.current) {
      cancel.current = false;
      setDraft(String(value));
      return;
    }
    const number = Number(draft);
    if (draft.trim() && Number.isInteger(number) && number >= min && number <= max) {
      if (number !== value) {
        apply(number);
      }
      setDraft(String(number));
      setSlider(number);
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
          min,
          max,
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
function BpNumericSettings() {
  const configuration = useBetterPartyState(betterPartyStore, (partyState) => partyState.config);
  const disabled = useBetterPartyState(
    betterPartyStore,
    (partyState) => partyState.preparing || partyState.bpPickerBusy || !partyState.bpConnected,
  );
  const createElement = BetterPartyReact.createElement;
  return createElement(BetterPartyReact.Fragment, {}, [
    configuration.mapSource === 'random' &&
      createElement(BpNumericField, {
        label: 'Holes',
        value: configuration.holes,
        min: 1,
        max: 9,
        apply: (holes) => updateBetterPartyConfig({ holes }),
        disabled,
      }),
    createElement(BpNumericField, {
      label: 'Timer',
      value: Math.round(configuration.timerMs / 1000),
      min: 20,
      max: 300,
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
