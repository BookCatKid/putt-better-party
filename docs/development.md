# Development

## Tooling

Install Bun, Node.js 22 or later (for lint-staged), Python 3, curl and ShellCheck. In a Python virtual environment, install the pinned Ruff version:

```sh
bun install --frozen-lockfile
python3 -m pip install -r requirements-dev.txt
bun run hooks:install
bun run format
bun run lint
bun run check
```

The quality check runs Prettier, ESLint, Ruff, ShellCheck, strict TypeScript checking and the offline unit tests. CI uses the same check. The installed pre-commit hook formats and lints staged source, runs the type checker and runs the unit tests. Generated assets and room data are excluded from source control and formatting.

## Integration tests

Prepare the client and start the service. Live integration tests exercise public read-only catalog endpoints and independent Better Party rooms:

```sh
bun run test:catalog
bun run test:protocol
bun run test:recovery
bun run test:browser
```

Browser integration uses Chromium via the DevTools protocol. Set `CHROME` to an executable if it is not detected automatically. Set `BASE` to the running test service URL if necessary. Select a particular regression using `BROWSER_SCRIPT`, for example:

```sh
BROWSER_SCRIPT=tests/integration/check-entry-style.mjs bun run test:browser
```

The loading regression (`check-party-loading.mjs`) delays the initial roster and scoreboard messages while the engine loads to verify that the incomplete HUD remains hidden.

Recovery tests start an isolated process with a temporary database. A browser debugging disconnection is a test failure, not a successful result.

## Updating the upstream client

```sh
bun run capture:client
```

The capture script discovers the current public entry modules, traverses literal imports, inspects stock asset registries and GLB texture references, and stages the downloaded artifacts and hash manifest in a timestamped capture directory. It does not collect account credentials, HAR files or private party traffic.

Compare the new capture against `scripts/client-lock.json`. If modules changed, reverse-engineer the changed bundles to establish the new protocol and patch bindings before updating the lock. Check both unit tests and browser integration before adopting a new build. For a byte-compatible capture:

```sh
bun run capture:client --apply-compatible
bun run prepare:client
```

Keep exact match anchors in the Python patcher. Write substantial new JavaScript in separately formatted and linted source files. Upstream lexical bindings are documented in the ESLint config; do not disable linting for the whole patch.
