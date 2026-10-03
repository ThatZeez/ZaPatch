import readline from 'node:readline';
import { EXIT, PATCHER_VERSION } from '../patcher/constants.js';
import * as out from './output.js';

export function ask(question, { signal = null } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        rl.close();
      } catch {
        // noop
      }
      resolve(value);
    };
    rl.on('SIGINT', () => {
      if (signal) signal.interrupt();
      finish(null);
    });
    rl.question(question, (answer) => finish(answer));
  });
}

export async function confirm(question, { signal = null } = {}) {
  const answer = await ask(`${question} (y/N): `, { signal });
  if (answer === null) return false;
  const t = answer.trim().toLowerCase();
  return t === 'y' || t === 'yes';
}

export async function pauseToClose() {
  if (!process.stdin.isTTY) return;
  await ask('\nPress Enter to close ZaPatch...');
}

export async function pauseToMenu() {
  if (!process.stdin.isTTY) return;
  await ask('\nPress Enter to return to menu...');
}

function printMainMenu() {
  console.log('');
  console.log(out.c.bold('ZaPatch'));
  console.log('');
  console.log('What would you like to do?');
  console.log('');
  console.log('[1] Install BetterZalo');
  console.log('[2] Repair BetterZalo');
  console.log('[3] Uninstall BetterZalo');
  console.log('[4] Update ZaPatch');
  console.log('[5] Exit');
}

// Interactive primary flow. Each action runs in-process and returns to
// the menu afterwards; the app only closes on [5]/Exit or Ctrl+C.
export async function runMenu({ flows, logger, signal }) {
  console.log(out.c.dim(`ZaPatch v${PATCHER_VERSION} — Windows CLI`));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.interrupted) return EXIT.INTERRUPTED;
    printMainMenu();
    const choice = await ask('\nSelect an option: ', { signal });
    if (choice === null || choice.trim() === '5') {
      console.log('\nGoodbye.');
      return EXIT.OK;
    }
    const action = { 1: 'install', 2: 'repair', 3: 'uninstall', 4: 'self-update' }[choice.trim()];
    if (!action) {
      out.warn('\nInvalid option. Please enter a number from 1 to 5.');
      continue;
    }
    try {
      const code = await flows[action]({ signal });
      await logger.info('menu action finished', { action, code });
      if (signal?.interrupted) {
        console.log('\nInterrupted. Returning to menu without finishing is safe; Repair can reconcile.');
        signal.reset();
      }
    } catch (err) {
      out.reportError(err && err.message ? err : new Error(String(err)));
      await logger.error('menu action failed', { action, message: String(err?.message || err) });
    }
    await pauseToMenu();
    if (signal?.interrupted) signal.reset();
  }
}
