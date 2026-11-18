# Contributing

This project keeps the original game's client and replaces everything around it:
the room authority, the transport, the lobby and the persistence. That shape is
unusual, and most of the rules below exist because of it.

Read [AGENTS.md](../AGENTS.md) first — it is the binding statement of engineering
requirements. This guide explains _why_ those requirements are what they are and
what they look like in practice.

## The one rule that matters most

**Reverse-engineer before changing behaviour.** The client is a hash-pinned
original. Its field names, its frame shapes and its lexical bindings are not
style choices — they are what the archived JavaScript actually reads and writes.
Renaming `t` to `type` because it reads better breaks the game.

So: find out what the original does before deciding what to change. Read the
bundle. Trace the export. Write down the call. Then change the smallest thing
that makes the behaviour correct, and put a test on it.

## Baseline before you start

```sh
bun install --frozen-lockfile
bun run hooks:install
bun run prepare:client
bun run check
```

`bun run check` must be **green before you change anything**. If it is not, that
is the first thing to fix, not something to work around — a failing baseline
makes every later failure ambiguous. See the [installation guide](installation.md)
for version requirements and the prepared-client failure modes.

## What goes where

| Directory         | Holds                                                           |
| ----------------- | --------------------------------------------------------------- |
| `src/`            | The service: HTTP, rooms, catalog, persistence, safety limits   |
| `src/upstream/`   | The **only** code allowed to import the original bundles        |
| `scripts/*.ts`    | Standalone browser scripts, authored in strict TypeScript       |
| `scripts/*.js`    | Snippets spliced into the original client's lexical scope       |
| `scripts/*.py`    | Capture, verification and patching of the original client       |
| `private-client/` | Archived originals. **Never edit these bytes.**                 |
| `web/`            | Generated. Never edit, never commit.                            |
| `tests/`          | Unit tests (`bun test`) and `tests/integration/` browser suites |

Two boundaries are worth stating explicitly because crossing them silently is
easy:

**`src/upstream/client-adapter.ts` is the only module that may import original
bundles.** Everything else talks to `src/upstream.ts`, which speaks in domain
types. If you find yourself importing a hashed file from anywhere else, the
abstraction is in the wrong place.

**The patcher keeps exact match anchors; substantial new JavaScript lives in its
own file.** `scripts/patch-client.py` finds one exact string, asserts it appears
exactly once, and replaces it. If the upstream bundle changes, that assertion
fails loudly rather than silently patching the wrong place. Anything long enough
to deserve formatting, linting or review belongs in `scripts/*.js` and gets
spliced in by reading the file, not inlined into the patch.

Every patch is applied in a staging directory and every patched bundle is
syntax-checked before the build is published. `patch-client.py` **refuses to run**
without `BP_STAGE_WEB` set, so it cannot rewrite a live client by accident.

## Client snippets and type checking

Some JavaScript cannot be TypeScript, and this is deliberate rather than
unfinished. There are three tiers:

1. **Extracted standalone scripts** — `home`, `leaderboard`, `admin` — are real
   `.ts`, compiled through `tsconfig.scripts.json`, and served as ES modules.
2. **Spliced snippets** — the eleven files the patcher reads into the client's
   lexical scope — cannot be `.ts`, because the patcher splices raw text and
   there is no compilation step for them. The transport among them is checked in
   place with `checkJs` plus a hand-written `.d.ts`, which catches wrong argument
   shapes without pretending it is independently compilable.
3. **React-shaped snippets** — the remaining snippets that construct elements
   through the client's own React instance — remain deliberately untyped. The
   effort would go into describing an API that is not ours and can change
   upstream.

If you add a snippet, add the globals it needs to `eslint.config.js` in the
scoped block that documents them. Do not disable linting for a whole file.

## Naming

Wire field names and pinned upstream export names are **compatibility contracts**,
not naming conventions. `t`, `b`, `f`, `s`, `p` stay as they are, and the
TypeScript contract in `src/protocol.ts` describes them rather than renaming them.

Everything authored is named for what it holds. The lint config enforces this
with `id-length` (minimum 2) and an `id-denylist` for `btn`, `cls`, `prev`, `tmp`,
`temp`, `val`, `obj`, `arr`, `ev`, `idx`, `resp` and `fn`.

That second rule applies to `tests/` as well, which surprises people. An unused
first callback argument must be named something like `_unused`, not `_` — `_` is
too short. This has caught real slips in otherwise good commits, so it is worth
knowing before you hit it.

## Testing expectations

Unit tests run with `bun test` and must not require the network or a prepared
client. Browser tests live in `tests/integration/` and drive a real Chromium over
the DevTools protocol against a running service.

```sh
bun run test:catalog     # live public catalog
bun run test:protocol    # room lifecycle end to end
bun run test:recovery    # restart and persistence
bun run test:browser     # the browser regressions
```

For one browser regression:

```sh
BROWSER_SCRIPT=tests/integration/check-party-loading.mjs bun run test:browser
```

**A test that passes for the wrong reason is worse than no test.** Before you
call something verified, falsify it: change the product code so the behaviour is
wrong, restart the service, and confirm the test fails. Then change it back.

**`bun` caches loaded modules.** This matters constantly. After editing
`src/*.ts`, restart the server or you are testing the previous build. After
editing anything under `scripts/`, re-run `python3 scripts/prepare-client.py`
first.

Some things genuinely cannot be tested in a browser here, and the
[development guide](development.md#known-limits-of-the-browser-suite) records
which and why. Report a limitation rather than claiming success — a documented
gap is useful, a false pass is not.

## Review expectations

A change is ready when all of these are true:

- `bun run format` and `bun run check` pass, locally and without a rule weakened
  to make them pass.
- Behaviour changes explain **why** in the commit message, and where the reason
  is not obvious, in a code comment. A comment that restates the code is noise; a
  comment that records why the obvious approach was wrong is valuable.
- New behaviour has regression coverage, and the coverage was seen to fail when
  the behaviour was broken.
- Any limitation or check that could not be run is stated plainly.
- The diff does not reformat unrelated files. The archive is excluded from
  formatting for exactly this reason.

There is no reviewer to appeal to beyond that. If you cannot explain a change in
its commit message, it probably should not be committed yet.

## What must never be committed

- `private-client/` contents that have been **modified or reformatted**. They are
  archived originals; changes are always errors. Restore from Git.
- `web/`, `captures/`, `maps/`, `state/` — all generated or runtime.
- Databases, `*.sqlite`, `-wal` and `-shm` files.
- Logs, recordings, HAR files, screenshots of private rooms.
- Credentials, tokens, `BP_ADMIN_PASSWORD_HASH` values, `.env` files.
- Anything from `captures/` that has not been reviewed and deliberately adopted.

`.gitignore` covers most of this. It does not cover carelessness.

## Updating the upstream client

Capture and preparation are deliberately separate steps:

```sh
bun run capture:client
```

This discovers the current public entry modules and stages them under
`captures/` with a hash manifest. It **never** touches the archive or the
generated build. Compare its manifest against `scripts/client-lock.json`, then:

1. Reverse-engineer the changed bundles before touching any patch anchor.
2. Update the whole asset lock and the corresponding originals **together**.
3. Remove superseded tracked paths.
4. Stage verified originals with `git add -f` — the directory is ignored, so a
   plain `git add` silently skips them.
5. Run the unit tests and the browser suites before adopting anything.

Never download a replacement for a missing original to "fix" a preparation
failure. A missing file is a signal that the archive is incomplete, and the fix
is to restore it from Git.

## Licensing and confidentiality

The original client and its assets belong to their rights holders. They are
archived here for private development and are **not** licensed by this project.

- Do not redistribute the client or the assets.
- Do not make this repository public without permission.
- Do not publish a public deployment without permission.
- Do not add a license file that purports to cover the archived material — only
  independently authored code is available for licensing, and that decision
  belongs to the owner.

## Publishing

GitHub `main` is authoritative. Commit and publish verified changes **before**
deploying them, and do not leave a production fix only on a server or a local
branch. When remote has moved, rebase rather than overwrite, and reconcile
concurrent work instead of discarding it — someone else's commit is not an
obstacle to your push.
