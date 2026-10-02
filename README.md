# BetterZalo Patcher (ZaPatch)

Windows-only CLI to install, update, verify, and restore BetterZalo on Zalo PC.

## Scope

- This repo is the **patcher only**: detection, version checks, backup, patch, verification, restore, status.
- The modding framework, plugins, themes, and Settings UI live in the separate **BetterZalo** repo.
- The patcher consumes a BetterZalo **package directory** (`betterzalo-package.json` manifest + payload files). It never embeds the framework.

## Requirements

- Windows 10/11, Node.js >= 18 (zero runtime dependencies, stdlib only).

## Usage

```powershell
node src/main.js --help
node src/main.js status
node src/main.js install --package ./example-package
node src/main.js update --package ./example-package
node src/main.js restore
node src/main.js version
```

Common flags: `--zalo-path <dir>` (skip prompts), `--backup <id>`, `--json` (status).

First launch walks through installation selection:

```text
[1] Use default Zalo installation
[2] Enter a custom path
[3] Exit
```

The choice is persisted to `%APPDATA%\BetterZaloPatcher\config.json`.
Next launches offer Continue / Change / Exit. Invalid saved paths fall
back to selection. Nothing is modified until the install is verified.

## How it works

1. Resolve install dir (`--zalo-path`, saved config, or prompt).
2. Validate: must contain `Zalo.exe` or versioned `Zalo-x.y.z/` dirs with `Zalo.exe + resources/app.asar`.
3. Detect Zalo version (exe FileVersion → folder name → app-update.yml).
4. Check package `minZaloVersion/maxZaloVersion`; refuse incompatible.
5. Check writability (report elevation when needed).
6. Backup overwritten files to `<install>\.betterzalo\backups\<zaloVersion>_<stamp>\` + manifest; verify hashes.
7. Copy package files into the version dir; write `.betterzalo/receipt.json`.
8. Re-verify hashes. On failure, roll back from backup.
9. `status` verifies receipt hashes; `update` detects version drift.

Backups are never auto-deleted. No telemetry. No downloads; packages are local dirs for v1.

## Layout

```text
src/
  main.js            CLI entry (Windows guard, exit codes)
  cli/
    program.js       command dispatch (install/update/restore/status/version)
    selection.js     install-selection + persisted path flow
    output.js        terminal output helpers
  patcher/
    detection.js     default locations, install validation, active version dir
    version.js       parsing, exe/folder/yml detection, compat range
    package.js       BetterZalo package interface (manifest load/validate/hash)
    backup.js        backup create/verify/list
    patch.js         8-step patch pipeline + rollback
    verification.js  receipt-based verification
    restore.js       backup restore + verify
    update.js        Zalo-update drift detection
    status.js        verifiable status aggregation
    permissions.js   Windows/elevation/writability checks
    config.js        persisted install path
    logger.js        file logging (no sensitive data)
    constants.js     versions, paths, exit codes
example-package/     minimal valid package (placeholder payload, not the framework)
test/                node:test suites (stdlib only)
```

## Exit codes

0 ok · 2 usage · 3 zalo not found/invalid · 4 unsupported version · 5 permission ·
6 backup failed · 7 patch failed · 8 verify failed · 9 restore failed · 10 bad package.
