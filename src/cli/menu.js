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

export const MENU_ITEMS = [
  { label: 'Install BetterZalo', action: 'install' },
  { label: 'Repair BetterZalo', action: 'repair' },
  { label: 'Uninstall BetterZalo', action: 'uninstall' },
  { label: 'Update ZaPatch', action: 'self-update' },
  { label: 'Exit', action: null },
];

// Pure selection math (clamped to the available options).
export function moveIndex(current, direction, count) {
  if (direction === 'up') return Math.max(0, current - 1);
  if (direction === 'down') return Math.min(count - 1, current + 1);
  return current;
}

// Pure rendering: `>` arrow plus a true underline directly beneath the
// selected label text. The arrow and underline always move together
// with `selected`. Only the [start, end) slice is rendered so the caller
// can present a scrolling viewport of a longer list.
export function renderMenuBlock(items, selected, start = 0, end = items.length) {
  return items
    .slice(start, end)
    .map((item, i) => (start + i === selected ? `> ${out.c.underline(item.label)}` : `  ${item.label}`));
}

// Pure viewport math: shift the visible window just enough to keep the
// selection on screen. Scrolls both directions symmetrically.
export function shiftWindow(start, selected, count, size) {
  const windowSize = Math.max(1, Math.min(size, count));
  if (selected < start) return selected;
  if (selected > start + windowSize - 1) return selected - windowSize + 1;
  return start;
}

export function initialWindow(selected, count, size) {
  const windowSize = Math.max(1, Math.min(size, count));
  return Math.max(0, Math.min(selected, count - windowSize));
}

// Viewport height adapts to the terminal; falls back to 24 rows when the
// size is unknown (pipes, tests). `reserved` covers header/prompt/margin.
export function resolveViewportHeight(stdout, { reserved = 10, min = 3 } = {}) {
  const rows = typeof stdout?.rows === 'number' && stdout.rows > 0 ? stdout.rows : 24;
  return Math.max(min, rows - reserved);
}

export function menuHeader() {
  return [
    out.c.dim(`ZaPatch v${PATCHER_VERSION} — Windows CLI`),
    '',
    'What would you like to do?',
    'Use the arrow keys to navigate. Press Enter to confirm.',
    '',
  ];
}

// Keyboard selection inside a scrollable viewport: the header stays
// pinned while only the visible option window is redrawn. Up/Down move,
// Enter confirms, Esc/Ctrl+C cancels.
// Falls back to a numbered prompt when stdin is not an interactive TTY
// (pipes, scripts) since raw keypresses cannot be read there.
// `input`/`output` are injectable for tests; they default to the console.
// `maxVisible` caps the viewport height (defaults to terminal height).
export async function selectOption({ prompt = '', header = null, items, initial = 0, signal = null, input = null, output = null, maxVisible = null }) {
  const stdin = input || process.stdin;
  const stdout = output || process.stdout;
  const headerLines = header || (prompt ? [prompt, ''] : []);
  if (!stdin.isTTY || !stdout.isTTY) {
    return fallbackNumbered(headerLines, items, signal);
  }
  if (signal?.interrupted) return null;

  const viewSize = maxVisible || resolveViewportHeight(stdout);
  let selected = Math.min(Math.max(initial, 0), items.length - 1);
  let winStart = initialWindow(selected, items.length, viewSize);
  let blockLines = 0;
  let settled = false;

  for (const line of headerLines) console.log(line);

  const draw = () => {
    const winEnd = Math.min(winStart + viewSize, items.length);
    const lines = renderMenuBlock(items, selected, winStart, winEnd);
    const body = lines.map((l) => `\x1b[0K${l}`).join('\r\n');
    if (blockLines === 0) {
      stdout.write(body);
    } else {
      // Return to the viewport start and erase everything below it before
      // rewriting, so a previously misaligned frame can never leave
      // stale option copies accumulating on screen.
      stdout.write(`\r\x1b[${blockLines}A\x1b[J${body}`);
    }
    blockLines = lines.length;
  };

  return new Promise((resolve) => {
    const done = (value) => {
      if (settled) return;
      settled = true;
      try {
        stdout.write('\r\n');
        stdin.removeListener('keypress', onKey);
        if (typeof stdin.setRawMode === 'function' && stdin.isTTY) stdin.setRawMode(false);
        if (typeof stdin.pause === 'function') stdin.pause();
        stdout.write('\x1b[?25h');
      } catch {
        // cleanup must never break selection
      }
      resolve(value);
    };
    const onKey = (_ch, key) => {
      if (settled) return;
      if (signal?.interrupted) {
        done(null);
        return;
      }
      if (key?.ctrl && key.name === 'c') {
        signal?.interrupt?.();
        done(null);
        return;
      }
      switch (key?.name) {
        case 'up':
          selected = moveIndex(selected, 'up', items.length);
          winStart = shiftWindow(winStart, selected, items.length, viewSize);
          draw();
          break;
        case 'down':
          selected = moveIndex(selected, 'down', items.length);
          winStart = shiftWindow(winStart, selected, items.length, viewSize);
          draw();
          break;
        case 'return':
          done(selected);
          break;
        case 'escape':
          done(null);
          break;
        default:
          break;
      }
    };
    readline.emitKeypressEvents(stdin);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    if (typeof stdin.resume === 'function') stdin.resume();
    stdout.write('\x1b[?25l');
    stdin.on('keypress', onKey);
    draw();
  });
}

async function fallbackNumbered(headerLines, items, signal) {
  for (const line of headerLines) console.log(line);
  items.forEach((item, i) => console.log(`[${i + 1}] ${item.label}`));
  const raw = await ask('\nSelect an option: ', { signal });
  if (raw === null) return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > items.length) return null;
  return n - 1;
}

// Interactive primary flow. Each action runs in-process and returns to
// the menu afterwards; the app only closes on Exit or Ctrl+C.
export async function runMenu({ flows, logger, signal }) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.interrupted) return EXIT.INTERRUPTED;
    const index = await selectOption({
      header: menuHeader(),
      items: MENU_ITEMS,
      initial: 0,
      signal,
    });
    if (index === null || MENU_ITEMS[index].action === null) {
      console.log('\nGoodbye.');
      return EXIT.OK;
    }
    const action = MENU_ITEMS[index].action;
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
