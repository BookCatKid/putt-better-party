# Engineering requirements

All handwritten code must be maintainable and suitable for public review. Functionality alone is not a completion criterion.

- Format every supported source file with Prettier or Ruff.
- Use descriptive names for variables, functions, parameters and types. Do not imitate minified source. Wire field names and pinned upstream export names are compatibility contracts, not naming conventions for application code.
- Use one declaration or statement per line and braces around control flow. Avoid nested ternaries; extract clear decisions instead.
- Keep distinct responsibilities separate. Do not introduce unnecessary abstractions.
- Use strict TypeScript contracts for backend code; validate external JSON at its boundary. Never use explicit `any`, blanket assertions, or suppression comments to evade the type checker.
- Isolate original hashed modules behind the upstream adapter. Keep exact patch anchors separate from authored functions. Reverse-engineer the original bundles to establish behavior before changing protocol bindings or making test requests.
- Preserve all original client assets in the private repository under `private-client/`. Archive the full reviewed snapshot (bundles, models, textures, sounds and icons) listed in `scripts/client-lock.json`; never format, lint or edit their bytes. Client preparation must be offline and validate the entire lock before building. Keep generated assets, recordings, credentials, databases and logs out of Git. Do not redistribute the original client or make this repository public without appropriate permission.
- Do not weaken lint rules, remove tests, or change expected behavior simply to obtain passing checks.
- Before committing run `bun run format` and `bun run check`. Run relevant browser/integration regressions for runtime changes.
- Install the repository pre-commit hook with `bun run hooks:install`. CI independently runs formatting, linting, strict type checking and tests on every push and pull request.

When changing behavior, document the reason and add regression coverage. If a check cannot run, report that limitation rather than claiming success.

Keep GitHub main authoritative: commit and publish verified project changes before deploying them. Do not leave production fixes only on the server or isolated local branches. Reconcile concurrent development without overwriting unrelated work.
