#!/usr/bin/env node
import { EXIT } from './patcher/constants.js';
import { ensureWindows } from './patcher/permissions.js';
import { reportError } from './cli/output.js';
import { run } from './cli/program.js';

try {
  ensureWindows();
  const code = await run(process.argv);
  process.exit(code ?? EXIT.OK);
} catch (err) {
  reportError(err && err.message ? err : new Error(String(err)));
  process.exit(err && typeof err.exitCode === 'number' ? err.exitCode : EXIT.GENERIC);
}
