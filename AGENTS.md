# ZaPatch (BetterZalo-Patcher) — Agent Guidelines

Windows-only CLI patcher for BetterZalo, shipped as standalone `ZaPatch.exe`
(`bun run build:exe`). Zero dependencies (Node stdlib + Windows-native tools only).

## Separation

- This repo: menu/CLI, detection, release/download/verify, backup, install,
  repair, uninstall, self-update (`update`), status, logging.
- BetterZalo repo: framework, plugins, themes, Settings UI. Never reimplement those here.
- Consume BetterZalo via its release artifact (`manifest.json` package inside the
  zip; legacy `betterzalo-package.json` dirs still load for offline use). Never
  embed the framework, never copy its source here.

## Rules

- Windows only: guard with `ensureWindows()`, use Win paths, report elevation clearly.
- CLI only: no GUI, no web UI, no background/auto patching, no telemetry, no silent updates.
- Main menu first (`[1] Install [2] Repair [3] Uninstall [4] Update ZaPatch`); subcommands stay scriptable.
- `update` means ZaPatch self-update. BetterZalo repatching goes through install/repair.
- Never patch unverified dirs; backup + verify backup before modifying anything.
- Release artifacts require a verifiable SHA-256 (sidecar > API digest); refuse otherwise.
- Version-gate every patch (`supportedZaloVersions` list wins over min/max); refuse unknown versions.
- Repair is targeted (broken files only), preserves the original backup.
- Roll back from backup on mid-operation failure; honor the interrupt token in long loops.
- Never auto-delete backups; uninstall must verify after restore.
- Self-update swaps exe->.old (never brick); `.old` removed on next start.
- Status reports only verifiable facts (receipt + hashes + live version).
- Non-zero exit codes per `src/patcher/constants.js:EXIT`; pause-to-close in TTY unless `--no-pause`.
- Comments explain why, never what. Delete comments that restate the code, section banners, and dead code next to them; keep reverse-engineered notes, safety rationale, and non-obvious contracts.
- Keep modules small, no new abstraction layers, no external deps without request.
- Tests: `node --test test/*.test.js` with temp dirs + fixture HTTP server; never touch the real Zalo install.
