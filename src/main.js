#!/usr/bin/env node
import { EXIT, PATCHER_VERSION } from './patcher/constants.js';
import { createInterrupt, isInterruptError } from './patcher/interrupt.js';
import { ensureWindows } from './patcher/permissions.js';
import { cleanupStaleBackup } from './patcher/updater.js';
import { pauseToClose, runMenu } from './cli/menu.js';
import { reportError } from './cli/output.js';
import { menuFlows, parseArgs, run } from './cli/program.js';

const signal = createInterrupt();

process.on('SIGINT', () => {
  signal.interrupt();
});

process.on('SIGTERM', () => {
  signal.interrupt();
});

function shouldPause(opts) {
  return process.stdin.isTTY && !opts?.noPause;
}

try {
  ensureWindows();
  await cleanupStaleBackup().catch(() => {});

  const early = parseArgs(process.argv);
  if (!early.command) {
    // Primary flow: interactive main menu.
    const { createLogger } = await import('./patcher/logger.js');
    const logger = createLogger();
    await logger.info('menu started', { version: PATCHER_VERSION });
    try {
      const code = await runMenu({ flows: menuFlows(logger), logger, signal });
      process.exit(code ?? EXIT.OK);
    } catch (err) {
      reportError(err && err.message ? err : new Error(String(err)));
      if (shouldPause(early)) await pauseToClose().catch(() => {});
      process.exit(err && typeof err.exitCode === 'number' ? err.exitCode : EXIT.GENERIC);
    }
  }

  const result = await run(process.argv, { signal });
  if (result && typeof result === 'object' && result.menu) {
    const code = await runMenu({ flows: menuFlows(result.logger), logger: result.logger, signal });
    process.exit(code ?? EXIT.OK);
  }
  if (shouldPause(early)) await pauseToClose().catch(() => {});
  process.exit(result ?? EXIT.OK);
} catch (err) {
  const code = err && typeof err.exitCode === 'number' ? err.exitCode : EXIT.GENERIC;
  if (isInterruptError(err)) {
    console.log('\nInterrupted. Partial changes were rolled back where possible.');
    console.log('Run Repair from the main menu to reconcile if needed.');
  } else {
    reportError(err && err.message ? err : new Error(String(err)));
  }
  try {
    const opts = parseArgs(process.argv);
    if (shouldPause(opts)) await pauseToClose().catch(() => {});
  } catch {
    // never fail while reporting
  }
  process.exit(code);
}
