import js from '@eslint/js';
import globals from 'globals';

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
    files: ['**/*.{js,mjs}'],
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
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // These snippets are inserted into the pinned original client's lexical scope.
    files: ['scripts/picker.js', 'scripts/match-details.js', 'scripts/host-menu.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        q: 'readonly',
        j: 'readonly',
        R: 'readonly',
        L: 'readonly',
        bpPickerBusy: 'readonly',
        bpHostAction: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^(At|Bp[A-Z])',
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
    },
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
    files: ['scripts/party-entry.js'],
    languageOptions: {
      globals: { ...globals.browser, y: 'readonly', x: 'readonly', f: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^D$', args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    files: ['scripts/party-runtime.js'],
    languageOptions: { globals: { ...globals.browser, i: 'readonly', u: 'readonly' } },
  },
];
