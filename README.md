# ZaPatch — BetterZalo Windows CLI Patcher

Windows-only CLI to install, repair, update, and uninstall BetterZalo on Zalo PC.
Ships as a standalone **`ZaPatch.exe`** (no Node.js required for end users).

## Scope

- This repo is the **patcher only**: menu/CLI, Zalo detection, release retrieval,
  download + verification, backup, install, repair, uninstall, self-update, logging.
- The modding framework, plugins, themes, and Settings UI live in the separate
  **BetterZalo** repo. ZaPatch consumes its **release artifact**, never its source.

## For users (ZaPatch.exe)

```text
ZaPatch v0.1.0 — Windows CLI

What would you like to do?
Use the arrow keys to navigate. Press Enter to confirm.

> Install BetterZalo   <- underlined
  Repair BetterZalo
  Uninstall BetterZalo
  Update ZaPatch
```

Navigate with `↑`/`↓`, confirm with `Enter` (`Esc` cancels). Piped/non-TTY
input falls back to a numbered prompt automatically.

- `Install` picks the Zalo install (default detection or custom dir), downloads the
  official BetterZalo release, verifies SHA-256, checks Zalo compatibility, backs up,
  patches, and verifies. `--package <dir>` uses a local package instead (offline).
- `Repair` fixes only missing/corrupted files, preserves the original backup.
- `Uninstall` restores original Zalo files from the verified backup (backup kept).
- `Update ZaPatch` replaces `ZaPatch.exe` itself after checksum verification.
  Never automatic; never touches BetterZalo.

Scripting subcommands: `install`, `repair`, `uninstall` (alias `restore`), `update`
(self-update), `status`, `version`, `menu`. Useful flags: `--zalo-path`,
`--package`, `--backup`, `--json`, `--yes`, `--no-pause`.

## For developers

Requirements: Windows 10/11, Node.js >= 18 for dev/tests, Bun for `build:exe`.
Zero runtime dependencies (Node stdlib + Windows-native `tar.exe`/`Expand-Archive`).

```powershell
node src/main.js --help
node src/main.js status --zalo-path "$env:LOCALAPPDATA\Programs\Zalo" --no-pause
npm test
bun run build:exe   # -> dist/ZaPatch.exe
```

First launch walks through Zalo installation selection; the verified path is
persisted to `%APPDATA%\BetterZaloPatcher\config.json`. Nothing is modified
until the install is verified.

## Release consumption

Official source: `https://api.github.com/repos/ThatZeez/BetterZalo/releases/latest`
(provisional patterns in `src/patcher/constants.js` — no BetterZalo release exists
yet, so the first real artifact decides the final naming).

- Asset pick: first match of `BETTERZALO_ASSET_PATTERNS` (prefers `*windows*.zip`).
- Checksum: `<asset>.sha256` sidecar wins, release API `digest` field is fallback.
  Artifacts without any verifiable SHA-256 are refused.
- Format: `.zip` containing `manifest.json` (+ `checksums.txt` + `files/`), extracted
  with Windows-native tools, then loaded through the same verified package path as
  local dirs. Nothing from the archive is ever executed.

Downloads cache under `%APPDATA%\BetterZaloPatcher\cache\` and are reused when the
tag still matches and the package stays compatible.

## How install works

1. Resolve + validate install dir; detect Zalo version (exe FileVersion → folder → yml).
2. Obtain package (`--package` or release download → verify → extract).
3. Compatibility check (explicit `supportedZaloVersions` list wins over min/max range).
4. Writability check (clear elevation guidance on denial).
5. Backup overwritten files to `<install>\.betterzalo\backups\<zalo>_<stamp>\` + manifest; verify hashes.
6. Copy package files; write `.betterzalo/receipt.json` in the version dir.
7. Re-verify hashes. Any failure rolls back from the backup.

Backups are never auto-deleted. No telemetry. No background work.

## Layout

```text
src/
  main.js            entry: menu dispatch, pause-to-close, SIGINT, .old cleanup
  cli/
    menu.js          main menu loop, confirm, pause helpers, ask()
    program.js       subcommands + flows shared with the menu
    selection.js     install-selection + persisted path flow
    output.js        terminal output helpers
  patcher/
    detection.js     default locations, validation, active version dir
    version.js       parsing, detection, list/range compatibility
    release.js       GitHub release query + artifact/checksum resolution
    download.js      https download with progress, hash, redirects, interrupt
    artifact.js      zip extraction (tar/Expand-Archive) -> verified package
    backup.js        backup create/verify/list
    patch.js         install pipeline + rollback (interrupt-aware)
    repair.js        targeted repair, keeps original backup
    restore.js       backup restore + verify (uninstall backend)
    updater.js       ZaPatch self-update swap (.old kept until next start)
    update.js        Zalo-update drift detection
    status.js        verifiable status aggregation
    verification.js  receipt-based verification
    permissions.js   Windows/elevation/writability checks
    interrupt.js     cooperative Ctrl+C token
    config.js        persisted install path
    logger.js        file logging (no sensitive data)
    constants.js     versions, paths, release APIs, exit codes
BetterZalo-v0.1.0/   local BetterZalo build for offline --package use
test/                node:test suites, temp dirs + fixture HTTP server
```

## Exit codes

0 ok · 2 usage · 3 zalo not found/invalid · 4 unsupported version · 5 permission ·
6 backup failed · 7 patch failed · 8 verify failed · 9 restore failed ·
10 bad package · 11 download/release failed · 12 self-update failed · 130 interrupted.
