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

The quality check runs Prettier, ESLint, Ruff, ShellCheck, strict TypeScript checking and the offline unit tests. CI uses the same check. The installed pre-commit hook formats and lints staged source, runs the type checker and runs the unit tests. Generated assets and room data are excluded from source control and formatting. The private repository preserves only the original bundles listed in `scripts/client-lock.json`, with exact SHA-256 hashes. The quality check and pre-commit hook run `bun run prepare:bundles` to reconstruct the original validator and patched client offline. Catalog unit tests mock only public network answers and exercise the original pinned validator; neither media downloads nor a live public server are required.

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

The next-course failure regression (`check-next-failure.mjs`) starts its own service with `BP_TEST_FAIL_MAP_FETCH_CALL` set to a comma list of lazy course-load call numbers that must fail. The room's `loadNext` is the only caller of that loader, so call 1 is exactly the first next-course load; the regression drives the host retry through the real UI.

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

When adopting a new upstream build, update the lock and archive the corresponding exact files together. Explicitly stage only the lock-listed originals with `git add -f`; other downloaded and generated files stay ignored. Do not make the repository or archived bundles public without appropriate permission. Keep exact match anchors in the Python patcher. Write substantial new JavaScript in separately formatted and linted source files. Upstream lexical bindings are documented in the ESLint config; do not disable linting for the whole patch.
