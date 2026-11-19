import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      'private-client/**',
      'web/**',
      'captures/**',
      'maps/**',
      'state/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        Bun: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        Response: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'prefer-const': 'error',
      curly: ['error', 'all'],
      'one-var': ['error', 'never'],
      'id-length': ['error', { min: 2, properties: 'never' }],
      'no-nested-ternary': 'error',
      'no-unneeded-ternary': 'error',
      'no-shadow': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    /*
     * Authored sources only: keep minifier-style and mechanically misnamed
     * identifiers out. These are the names the backlog called out - `btn` and
     * `cls` for a button and its classes, `prev` for any previous value, and the
     * short forms that make a reader stop and decode a name instead of reading it.
     *
     * Deliberately not applied to `tests/`, where `fn`, `res` and `btn` appear
     * legitimately in worker callbacks and in-page probe strings. `properties` is
     * ignored so a wire field or a third-party option with one of these names
     * stays legal; this is about what we choose to call our own values.
     */
    files: ['src/**/*.ts', 'scripts/**/*.js', 'scripts/**/*.ts'],
    rules: {
      'id-denylist': [
        'error',
        'btn',
        'cls',
        'prev',
        'tmp',
        'temp',
        'val',
        'obj',
        'arr',
        'ev',
        'idx',
        'resp',
        'fn',
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-undef': 'off', // The strict compiler checks unresolved names in TypeScript.
      'no-unused-vars': 'off',
      'no-shadow': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': true },
      ],
    },
  },
  {
    // These snippets are inserted into the pinned original client's lexical scope.
    files: [
      'scripts/picker.js',
      'scripts/match-details.js',
      'scripts/host-menu.js',
      'scripts/player-management.js',
      'scripts/lobby.js',
      'scripts/results-export.js',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        BetterPartyReact: 'readonly',
        useBetterPartyState: 'readonly',
        betterPartyStore: 'readonly',
        updateBetterPartyConfig: 'readonly',
        bpPickerBusy: 'readonly',
        bpHostAction: 'readonly',
        bpCastVote: 'readonly',
        bpSetReady: 'readonly',
        bpStartMatch: 'readonly',
        BpOriginalLobbyPlayer: 'readonly',
        bpLeaveParty: 'readonly',
        CommunityCoursePicker: 'readonly',
        BpNumericSettings: 'readonly',
        BpLobbyOptions: 'readonly',
        BpGuestPlaylist: 'readonly',
        BpGuestStarting: 'readonly',
        BpRecoveryNotice: 'readonly',
        BpManagementNotice: 'readonly',
        BpManageRoster: 'readonly',
        BpUpcomingEditor: 'readonly',
        bpResultsCsv: 'readonly',
        bpHistoryJson: 'readonly',
        bpDownloadResults: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^(CommunityCoursePicker|Bp[A-Z])',
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  {
    files: ['scripts/*.ts'],
    languageOptions: { parser: tsParser, globals: globals.browser },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-shadow': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': true },
      ],
    },
  },
  {
    files: ['scripts/party-replay-scene.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...Object.fromEntries(
          'D w v y x C S u m d p i f r g T b z c l s a _ bpSampleAt bpActiveNodesAt'
            .split(' ')
            .map((name) => [name, 'readonly']),
        ),
      },
    },
  },
  {
    files: ['scripts/replay-page.js', 'scripts/replay-timeline.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/client-bootstrap.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        Xn: 'readonly',
        Jn: 'readonly',
        k: 'readonly',
        or: 'readonly',
        M: 'readonly',
        dr: 'readonly',
        Hs: 'readonly',
        mr: 'readonly',
      },
    },
  },
  {
    files: ['scripts/party-loading.js'],
    languageOptions: {
      globals: { ...globals.browser, partyRouteJsx: 'readonly' },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { varsIgnorePattern: '^PartyLoadingScreen$', args: 'none', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['scripts/party-entry.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        partyBallRegistry: 'readonly',
        partyRouteReact: 'readonly',
        partyRouteJsx: 'readonly',
        joinPartyRuntime: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^(PartyEntry|usePartyAdmission)$',
          args: 'none',
          caughtErrors: 'none',
        },
      ],
    },
  },
  {
    files: ['scripts/party-route.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        partyRouteReact: 'readonly',
        partyRouteJsx: 'readonly',
        partyRouteStore: 'readonly',
        selectPartyRouteState: 'readonly',
        defaultPartyLevel: 'readonly',
        defaultPartySeed: 'readonly',
        loadPartyLevel: 'readonly',
        setPartyMapReady: 'readonly',
        sanitizePartyLevel: 'readonly',
        validatePartyLevel: 'readonly',
        resetPartyRuntime: 'readonly',
        PartyGameRoot: 'readonly',
        PartyEntry: 'readonly',
        usePartyAdmission: 'readonly',
        PartyLoadingScreen: 'readonly',
        usePartyOverlayGuard: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { varsIgnorePattern: '^PartyRoute$', args: 'none', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Inserted into the pinned party route's lexical scope, beside the loading
    // screen and the route itself.
    files: ['scripts/party-overlay.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        partyRouteReact: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern:
            '^(usePartyOverlayGuard|partyBlockingOverlay|partyElementsAround|PARTY_[A-Z_]+)$',
          args: 'none',
          caughtErrors: 'none',
        },
      ],
    },
  },
  {
    files: ['scripts/party-transport.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        transportPartyStore: 'readonly',
        transportGameStore: 'readonly',
        transportSettings: 'readonly',
        transportScene: 'readonly',
        registerTransportSender: 'readonly',
        setTransportIdentity: 'readonly',
        updateTransportParty: 'readonly',
        setTransportFlyCamera: 'readonly',
        setTransportRoster: 'readonly',
        setTransportBoard: 'readonly',
        setTransportFinal: 'readonly',
        removeTransportGhost: 'readonly',
        showTransportCompletion: 'readonly',
        transportGhostHue: 'readonly',
        setTransportError: 'readonly',
        updateTransportGhost: 'readonly',
        transportSceneReadyLevelId: 'readonly',
        receiveTransportHostToken: 'readonly',
        clearTransportHostToken: 'readonly',
        isTransportSpectator: 'readonly',
        bpConnection: 'readonly',
        bpAck: 'readonly',
        bpReceiveVote: 'readonly',
        bpHostNotice: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { varsIgnorePattern: '^connectBetterParty$', args: 'none', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['scripts/follow-camera.js', 'scripts/follow-controls.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        followUseFrame: 'readonly',
        followUseThree: 'readonly',
        followReact: 'readonly',
        FollowVector: 'readonly',
        followGhosts: 'readonly',
        followScene: 'readonly',
        followGameStore: 'readonly',
        liveGhost: 'readonly',
        bpWatchLive: 'readonly',
        useBetterPartyState: 'readonly',
        betterPartyStore: 'readonly',
        BetterPartyReact: 'readonly',
        canWatch: 'readonly',
        watchCandidates: 'readonly',
        watchChoice: 'readonly',
        followTarget: 'readonly',
        bpSelectWatchTarget: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^Bp[A-Z]', args: 'none' }],
    },
  },
  {
    files: ['scripts/party-runtime.js'],
    languageOptions: {
      globals: { ...globals.browser, partyRuntimeStore: 'readonly', u: 'readonly' },
    },
  },
];
