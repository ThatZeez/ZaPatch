# ZaPatch (BetterZalo-Patcher) — Agent Guidelines

Windows-only CLI patcher for BetterZalo. Zero dependencies (Node stdlib only).

## Separation

- This repo: install/update/restore/status, detection, backup, verification, logging.
- BetterZalo repo: framework, plugins, themes, Settings UI. Never reimplement those here.
- Consume BetterZalo via `betterzalo-package.json` manifest; never embed the framework.

## Rules

- Windows only: guard with `ensureWindows()`, use Win paths, report elevation clearly.
- CLI only: no GUI, no web UI, no background/auto patching, no telemetry, no downloads.
- Never patch unverified dirs; backup + verify backup before modifying anything.
- Version-gate every patch (`minZaloVersion/maxZaloVersion`); refuse unknown versions.
- Roll back from backup on mid-patch failure; never leave partial state silently.
- Never auto-delete backups; restore must verify hashes.
- Status reports only verifiable facts (receipt + hashes + live version).
- Non-zero exit codes per `src/patcher/constants.js:EXIT`.
- Keep modules small, no new abstraction layers, no external deps without request.
- Tests: `node --test test/` with temp dirs; never touch the real Zalo install.
