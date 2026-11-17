# Engineering requirements

All handwritten code must be maintainable and suitable for public review. Functionality alone is not a completion criterion.

- Format every supported source file with Prettier or Ruff.
- Use descriptive names for variables, functions, parameters and types. Do not imitate minified source. Wire field names and pinned upstream export names are compatibility contracts, not naming conventions for application code.
- Use one declaration or statement per line and braces around control flow. Avoid nested ternaries; extract clear decisions instead.
- Keep distinct responsibilities separate. Do not introduce unnecessary abstractions.
- Use strict TypeScript contracts for backend code; validate external JSON at its boundary. Never use explicit `any`, blanket assertions, or suppression comments to evade the type checker.
- Isolate original hashed modules behind the upstream adapter. Keep exact patch anchors separate from authored functions. Reverse-engineer the original bundles to establish behavior before changing protocol bindings or making test requests.
- Never format, lint, commit or distribute downloaded/generated client assets; do not commit recordings, credentials, databases or logs.
- Do not weaken lint rules, remove tests, or change expected behavior simply to obtain passing checks.
- Before committing run `bun run format` and `bun run check`. Run relevant browser/integration regressions for runtime changes.
- Install the repository pre-commit hook with `bun run hooks:install`. CI independently runs formatting, linting, strict type checking and tests on every push and pull request.

When changing behavior, document the reason and add regression coverage. If a check cannot run, report that limitation rather than claiming success.
