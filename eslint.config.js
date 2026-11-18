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
    files: ['scripts/picker.js', 'scripts/match-details.js', 'scripts/host-menu.js'],
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
    files: ['scripts/home.js', 'scripts/admin.js', 'scripts/leaderboard.js'],
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
    files: ['scripts/party-runtime.js'],
    languageOptions: {
      globals: { ...globals.browser, partyRuntimeStore: 'readonly', u: 'readonly' },
    },
  },
];
