// Lobby-only overlay, rendered above the original procedural preview scene.
/**
 * Completed matches, newest first.
 *
 * A compact summary rather than a replay: the time, how many holes, and the top
 * three scores. The server keeps at most ten and never stores a course spec, so this
 * is a history of results, not a way to replay a course.
 */
function BpMatchHistory({ history }) {
  const createElement = BetterPartyReact.createElement;
  if (!history.length) {
    return createElement(
      'p',
      { className: 'bp-match-history-empty text-xs text-white/45' },
      'No completed matches yet.',
    );
  }
  return createElement(
    'div',
    { className: 'bp-match-history-wrap' },
    createElement(
      'ul',
      { className: 'bp-match-history' },
      history.slice(0, 5).map((match) =>
        createElement('li', { key: match.matchId }, [
          createElement(
            'span',
            { key: 'meta', className: 'bp-match-history-meta' },
            new Date(match.endedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            }) +
              ' · ' +
              match.holes +
              (match.holes === 1 ? ' hole' : ' holes'),
          ),
          createElement(
            'span',
            { key: 'score', className: 'bp-match-history-score' },
            match.standings
              .slice(0, 3)
              .map((row) => row.name + ' ' + row.totalStrokes)
              .join(' · '),
          ),
        ]),
      ),
    ),
    // The whole history, not just the five shown: the panel is a glance, the file is
    // the record.
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => {
          const stamp = new Date().toISOString().slice(0, 10);
          bpDownloadResults(
            'better-party-history-' + stamp + '.json',
            bpHistoryJson(history),
            'application/json;charset=utf-8',
          );
        },
        className:
          'bp-export bp-export-history mt-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold',
      },
      'Export history (JSON)',
    ),
  );
}

function BpLobbyDashboard() {
  const party = useBetterPartyState(betterPartyStore, (state) => state);
  const [copied, setCopied] = BetterPartyReact.useState(false);
  const [copyError, setCopyError] = BetterPartyReact.useState(false);
  const copyReset = BetterPartyReact.useRef(null);
  // Hooks must run on every render, so these come before the early return below.
  // Declaring them after it changes the hook count the moment the lobby unmounts -
  // which is exactly when a match starts - and React throws rather than rendering.
  BetterPartyReact.useEffect(() => () => clearTimeout(copyReset.current), []);
  const createElement = BetterPartyReact.createElement;
  if (!party.active || party.phase !== 'lobby') {
    return null;
  }
  const config = party.config;
  const host = party.isHost;
  const spectator = party.selfRole === 'spectator';
  const self = party.roster.find((player) => player.uid === party.self?.uid);
  const participants = party.roster.filter((player) => player.role !== 'spectator');
  const readyCount = participants.filter((player) => player.ready).length;
  const busy = party.preparing || party.bpPickerBusy;
  const disabled = busy || !party.bpConnected;
  const empty = config.mapSource === 'picked' && !config.selectedHoleIds?.length;
  const privateLobby = config.locked;
  const history = Array.isArray(party.matchHistory) ? party.matchHistory : [];
  const invitation = location.origin + '/party/' + party.code;

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(invitation);
      setCopyError(false);
      setCopied(true);
      clearTimeout(copyReset.current);
      copyReset.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // A later refusal must not leave the previous success showing: the label and
      // the live region would both still claim the link was copied.
      clearTimeout(copyReset.current);
      setCopied(false);
      setCopyError(true);
    }
  }

  /**
   * Focus and select the fallback link the moment it appears.
   *
   * Clipboard access is refused in more places than it is granted: a non-secure
   * origin, a permission the player declined, an older browser with no
   * `navigator.clipboard` at all. Showing the URL is only a fallback if the player
   * can then copy it, and asking them to find, focus and select it is the part that
   * goes wrong. Selecting it here means Cmd/Ctrl+C works immediately.
   */
  function selectFallback(element) {
    if (element) {
      element.focus();
      element.select();
    }
  }

  let copyStatus = '';
  if (copied) {
    copyStatus = 'Invite link copied to the clipboard.';
  } else if (copyError) {
    copyStatus =
      'Copying is blocked in this browser. The link below is selected; press Ctrl or Cmd and C.';
  }

  function panel(title, children, extra, className = '') {
    return createElement(
      'section',
      { className: 'bp-dashboard-panel rounded-xl bg-white/5 p-3 text-left ' + className },
      [
        createElement('div', { className: 'bp-dashboard-heading' }, [
          createElement('h3', { className: 'text-xs font-semibold text-white/70' }, title),
          extra,
        ]),
        createElement('div', { className: 'bp-dashboard-panel-content' }, children),
      ],
    );
  }

  function readOnly(label, value) {
    return createElement('div', { className: 'bp-dashboard-readonly' }, [
      createElement('span', {}, label),
      createElement('strong', {}, value),
    ]);
  }

  function playerRows() {
    // The original row component renders its own `<li>`, so wrapping it would
    // produce a nested list and rewriting it would drift from the original lobby
    // layout this project is required to preserve. A dropped player therefore gets
    // a sibling note row instead, which keeps the original markup untouched.
    return createElement(
      'ul',
      { className: 'bp-dashboard-player-list flex flex-col gap-1.5 text-left' },
      party.roster.flatMap((player) => {
        const row = createElement(BpOriginalLobbyPlayer, {
          key: player.uid,
          player,
          isSelf: player.uid === self?.uid,
        });
        if (player.connected !== false) {
          return [row];
        }
        return [
          row,
          createElement(
            'li',
            { key: player.uid + ':away', className: 'bp-lobby-away', role: 'status' },
            player.name + ' is disconnected',
          ),
        ];
      }),
    );
  }

  const matchRules = host
    ? [
        createElement(BpNumericSettings, { section: 'timer' }),
        createElement('label', { className: 'bp-number-row bp-dashboard-rule' }, [
          createElement('span', {}, 'Elimination'),
          createElement('input', {
            type: 'checkbox',
            'aria-label': 'Elimination',
            checked: config.elimination,
            disabled,
            onChange: (event) => updateBetterPartyConfig({ elimination: event.target.checked }),
          }),
        ]),
        // Team play is an independent optional rule: it changes what the party is
        // scored by, not how a hole is played, so it composes with either mode.
        createElement('label', { className: 'bp-number-row bp-dashboard-rule' }, [
          createElement('span', {}, 'Team play'),
          createElement('input', {
            type: 'checkbox',
            'aria-label': 'Team play',
            checked: !!config.teams,
            disabled,
            onChange: (event) => updateBetterPartyConfig({ teams: event.target.checked }),
          }),
        ]),
        // A tournament is a run of matches ranked by accumulated points. The round
        // count is fixed for the run, so it is chosen here rather than mid-way.
        createElement('label', { className: 'bp-number-row bp-dashboard-rule' }, [
          createElement('span', {}, 'Tournament'),
          createElement('input', {
            type: 'checkbox',
            'aria-label': 'Tournament',
            checked: !!config.tournament,
            disabled,
            onChange: (event) => updateBetterPartyConfig({ tournament: event.target.checked }),
          }),
        ]),
        config.tournament
          ? createElement('label', { className: 'bp-number-row bp-dashboard-rule' }, [
              createElement('span', {}, 'Rounds'),
              createElement(
                'select',
                {
                  'aria-label': 'Tournament rounds',
                  value: config.tournamentRounds ?? 3,
                  disabled,
                  onChange: (event) =>
                    updateBetterPartyConfig({ tournamentRounds: Number(event.target.value) }),
                },
                [2, 3, 4, 5, 6, 8, 10].map((count) =>
                  createElement('option', { key: count, value: count }, count + ' matches'),
                ),
              ),
            ])
          : null,
      ]
    : [
        readOnly(
          'Time per hole',
          config.timerMs ? Math.round(config.timerMs / 1000) + 's' : 'Unlimited',
        ),
        readOnly('Mode', config.elimination ? 'Elimination' : 'Stroke play'),
        readOnly('Scoring', config.teams ? 'Two teams' : 'Individual'),
        readOnly(
          'Format',
          config.tournament
            ? 'Tournament · ' + (config.tournamentRounds ?? 3) + ' matches'
            : 'Single match',
        ),
      ];

  const partySettings = host
    ? createElement(BpLobbyOptions, {})
    : [
        readOnly('Maximum players', config.maxPlayers),
        readOnly(
          'Join during a match',
          { never: 'Never', 'next-hole': 'After current hole', always: 'Always' }[
            config.lateJoin
          ] ?? 'Always',
        ),
        readOnly('Party access', privateLobby ? 'Locked' : 'Open'),
      ];

  const courses = host
    ? createElement(CommunityCoursePicker, {
        config,
        holeSettings: createElement(
          'div',
          { className: 'bp-dashboard-hole-count' },
          createElement(BpNumericSettings, { section: 'holes' }),
        ),
      })
    : createElement(BpGuestPlaylist, {});

  const summary =
    config.holes +
    (config.holes === 1 ? ' hole' : ' holes') +
    ' · ' +
    (config.timerMs ? Math.round(config.timerMs / 1000) + 's' : 'Unlimited') +
    ' · ' +
    (config.elimination ? 'Elimination' : 'Stroke play') +
    (config.teams ? ' · Teams' : '');
  const startLabel = busy ? 'Loading courses…' : 'Start party';

  return createElement(
    'div',
    {
      className:
        'bp-dashboard-overlay pointer-events-auto absolute inset-0 z-10 flex items-center justify-center bg-black/55',
      // While the lobby is up it is the only thing that may take input; the scene
      // behind it must not hear the keyboard. See scripts/party-overlay.js.
      'data-bp-blocking-overlay': '',
    },
    createElement(
      'section',
      {
        className: 'bp-dashboard rounded-3xl bg-[#11272b] p-7 text-center shadow-2xl',
        'aria-label': 'Party lobby',
      },
      [
        createElement(BpManagementNotice, { lobby: true, key: 'management-notice' }),
        createElement('header', { className: 'bp-dashboard-header' }, [
          createElement('p', { className: 'mb-1 text-3xl' }, '🎉'),
          createElement('h2', { className: 'mb-3 text-xl font-black' }, 'Party lobby'),
          createElement('div', { className: 'bp-dashboard-invite' }, [
            createElement(
              'p',
              {
                className: 'mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/45',
              },
              'Join code',
            ),
            createElement(
              'p',
              {
                className:
                  'bp-dashboard-code text-4xl font-black tracking-[0.3em] tabular-nums text-emerald-300',
              },
              party.code,
            ),
            createElement(
              'button',
              {
                type: 'button',
                className:
                  'mt-2 rounded-full bg-white/10 px-4 py-1.5 text-xs font-semibold text-white/85 transition hover:bg-white/20',
                onClick: copyInvite,
              },
              copied ? '✅ Link copied' : '🔗 Copy invite link',
            ),
            // A live region, always mounted so the announcement is reliable: a
            // region added at the same moment as its text is often not read out.
            createElement(
              'p',
              {
                key: 'copy-status',
                role: 'status',
                className: 'mt-1 text-[11px] text-white/60',
              },
              copyStatus,
            ),
            copyError &&
              createElement('input', {
                key: 'copy-fallback',
                ref: selectFallback,
                className: 'bp-dashboard-invite-fallback',
                'aria-label': 'Invite link',
                value: invitation,
                readOnly: true,
                onFocus: (event) => event.target.select(),
              }),
          ]),
        ]),
        createElement('div', { className: 'bp-dashboard-body' }, [
          createElement(BpRecoveryNotice, {}),
          !host && createElement(BpGuestStarting, {}),
          createElement('div', { className: 'bp-dashboard-grid' }, [
            panel('Courses', courses, null, 'bp-dashboard-courses'),
            panel(
              'Players',
              playerRows(),
              createElement(
                'span',
                { className: 'text-xs text-white/60' },
                party.roster.length + ' / ' + config.maxPlayers,
              ),
              'bp-dashboard-players',
            ),
            panel('Match rules', matchRules, null, 'bp-dashboard-rules'),
            panel('Party settings', partySettings, null, 'bp-dashboard-settings'),
            party.tournament
              ? panel(
                  'Tournament',
                  createElement(BpTournament, { compact: true }),
                  null,
                  'bp-dashboard-tournament',
                )
              : null,
            history.length
              ? panel(
                  'Recent matches',
                  createElement(BpMatchHistory, { history }),
                  null,
                  'bp-dashboard-history',
                )
              : null,
          ]),
        ]),
        createElement('footer', { className: 'bp-dashboard-footer' }, [
          createElement(
            'div',
            { className: 'bp-dashboard-summary text-xs text-white/60', role: 'status' },
            [
              createElement('strong', {}, summary),
              createElement(
                'span',
                {},
                readyCount + ' of ' + participants.length + ' players ready',
              ),
              empty && host && createElement('span', {}, 'Choose at least one course'),
              spectator && createElement('span', {}, "You're spectating"),
            ],
          ),
          createElement('div', { className: 'bp-dashboard-actions' }, [
            !spectator &&
              createElement(
                'button',
                {
                  type: 'button',
                  className:
                    'bp-dashboard-action rounded-full px-5 py-3 text-sm font-bold transition ' +
                    (self?.ready
                      ? 'bg-white/15 text-white hover:bg-white/25'
                      : 'bg-emerald-500 text-emerald-950 hover:bg-emerald-400'),
                  disabled: !party.bpConnected,
                  onClick: () => bpSetReady(!self?.ready),
                },
                self?.ready ? 'Not ready' : "I'm ready",
              ),
            host &&
              !spectator &&
              (party.preparing
                ? createElement(
                    'button',
                    {
                      type: 'button',
                      className:
                        'bp-dashboard-action rounded-full bg-white/15 px-5 py-3 text-sm font-bold text-white transition hover:bg-white/25',
                      // Course loading can stall on an upstream fetch that has no
                      // bound of its own, and while it runs the lobby is locked.
                      // Without this the only way out was to wait or reload.
                      // A rejected cancel leaves the lobby exactly as it was and the
                      // button still available, so there is nothing to report here.
                      onClick: () => {
                        void bpHostAction('cancel-preparation').catch(() => {});
                      },
                    },
                    'Cancel loading',
                  )
                : createElement(
                    'button',
                    {
                      type: 'button',
                      className:
                        'bp-dashboard-action rounded-full bg-emerald-500 px-5 py-3 text-sm font-bold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40',
                      disabled: disabled || empty,
                      onClick: () => bpStartMatch(),
                    },
                    startLabel,
                  )),
          ]),
          !host &&
            !party.preparing &&
            createElement(
              'p',
              { className: 'bp-dashboard-waiting text-xs text-white/50', role: 'status' },
              'Waiting for the host to start…',
            ),
        ]),
        createElement(
          'a',
          {
            href: '/home',
            className:
              'mt-3 block text-xs font-semibold text-white/40 no-underline hover:text-white/70',
            onClick: () => bpLeaveParty(),
          },
          'Leave party',
        ),
      ],
    ),
  );
}
