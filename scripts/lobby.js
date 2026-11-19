// Lobby-only overlay, rendered above the original procedural preview scene.
function BpLobbyDashboard() {
  const party = useBetterPartyState(betterPartyStore, (state) => state);
  const [copied, setCopied] = BetterPartyReact.useState(false);
  const [copyError, setCopyError] = BetterPartyReact.useState(false);
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
  const invitation = location.origin + '/party/' + party.code;

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(invitation);
      setCopyError(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError(true);
    }
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
    return createElement(
      'ul',
      { className: 'bp-dashboard-player-list flex flex-col gap-1.5 text-left' },
      party.roster.map((player) =>
        createElement(BpOriginalLobbyPlayer, {
          key: player.uid,
          player,
          isSelf: player.uid === self?.uid,
        }),
      ),
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
      ]
    : [
        readOnly(
          'Time per hole',
          config.timerMs ? Math.round(config.timerMs / 1000) + 's' : 'Unlimited',
        ),
        readOnly('Mode', config.elimination ? 'Elimination' : 'Stroke play'),
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
    (config.elimination ? 'Elimination' : 'Stroke play');
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
        createElement('header', { className: 'bp-dashboard-header' }, [
          createElement('p', { className: 'mb-1 text-3xl' }, '🎉'),
          createElement('h2', { className: 'mb-3 text-xl font-black' }, 'Party lobby'),
          party.bpHostNotice &&
            createElement(
              'p',
              { role: 'status', className: 'text-xs text-white/80' },
              party.bpHostNotice.message,
            ),
          createElement('div', { className: 'bp-dashboard-invite' }, [
            createElement(
              'p',
              { className: 'mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/45' },
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
            copyError &&
              createElement('input', {
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
              createElement(
                'button',
                {
                  type: 'button',
                  className:
                    'bp-dashboard-action rounded-full bg-emerald-500 px-5 py-3 text-sm font-bold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40',
                  disabled: disabled || empty,
                  onClick: () => bpStartMatch(),
                },
                startLabel,
              ),
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
