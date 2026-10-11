import readline from 'node:readline';
import { EXIT, PATCHER_VERSION } from '../patcher/constants.js';
import { checkSelfUpdate, updateNotice } from '../patcher/updater.js';
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
  await ask('\nPress Enter to exit...');
}

export const MENU_ITEMS = [
  { label: 'Install BetterZalo', action: 'install' },
  { label: 'Repair BetterZalo', action: 'repair' },
  { label: 'Uninstall BetterZalo', action: 'uninstall' },
  { label: 'Update ZaPatch', action: 'self-update' },
  { label: 'Exit', action: null },
];

export function moveIndex(current, direction, count) {
  if (direction === 'up') return Math.max(0, current - 1);
  if (direction === 'down') return Math.min(count - 1, current + 1);
  return current;
}

// Pure rendering: fixed columns — col 0 scroll indicator (space/`↑`/`↓`),
// col 1 space, col 2 `>`/space marker, col 3 space, label at col 4.
// The selected label keeps real ANSI underlining; arrow and underline
// always move together with `selected`. Only the [start, end) slice is
// rendered so the caller can present a scrolling viewport.
// `↑` shows on the first visible row when options hide above, `↓` on the
// last visible row when options hide below (`↑` wins a 1-row window).
export function renderMenuBlock(items, selected, start = 0, end = items.length) {
  const stop = Math.min(end, items.length);
  return items.slice(start, stop).map((item, i) => {
    const idx = start + i;
    const first = i === 0;
    const last = i === stop - start - 1;
    const indicator = first && start > 0 ? '↑' : last && stop < items.length ? '↓' : ' ';
    const marker = idx === selected ? '>' : ' ';
    const label = idx === selected ? out.c.underline(item.label) : item.label;
    return `${indicator} ${marker} ${label}`;
  });
}

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

export function resolveViewportHeight(stdout, { reserved = 10, min = 3 } = {}) {
  const rows = typeof stdout?.rows === 'number' && stdout.rows > 0 ? stdout.rows : 24;
  return Math.max(min, rows - reserved);
}

export function menuHeader() {
  return [
    out.c.dim('Use the arrow keys to navigate: ↓ ↑ → ←'),
    `${out.c.blue('?')} ${out.c.boldWhite('What would you like to do? (Press Enter to confirm):')}`,
  ];
}

// Keyboard selection in a scrolling viewport (header pinned, only the
// option window redrawn). Raw keypresses need a TTY, so pipes/scripts
// get a numbered prompt; `input`/`output` injection is for tests.
// `footer` lines redraw with the block but are never selectable.
export async function selectOption({ prompt = '', header = null, items, initial = 0, signal = null, input = null, output = null, maxVisible = null, footer = [] }) {
  const stdin = input || process.stdin;
  const stdout = output || process.stdout;
  const headerLines = header || (prompt ? [prompt, ''] : []);
  if (!stdin.isTTY || !stdout.isTTY) {
    return fallbackNumbered(headerLines, items, signal);
  }
  if (signal?.interrupted) return null;

  const viewSize = maxVisible || Math.min(5, resolveViewportHeight(stdout));
  let selected = Math.min(Math.max(initial, 0), items.length - 1);
  let winStart = initialWindow(selected, items.length, viewSize);
  let blockLines = 0;
  let settled = false;

  for (const line of headerLines) console.log(line);

  const draw = () => {
    const winEnd = Math.min(winStart + viewSize, items.length);
    const lines = [...renderMenuBlock(items, selected, winStart, winEnd), ...footer];
    const body = lines.map((l) => `\x1b[0K${l}`).join('\r\n');
    if (blockLines === 0) {
      stdout.write(body);
    } else {
      // Cursor sits at the end of the last block row, so move up
      // blockLines - 1 to land on the first block row (never into the
      // pinned header above), then erase below and rewrite. Erasing from
      // any higher would delete header lines more with every keypress.
      stdout.write(`\r\x1b[${blockLines - 1}A\x1b[J${body}`);
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

async function updateFooter() {
  const { latest } = await checkSelfUpdate({ timeout: 5000 });
  const notice = updateNotice(PATCHER_VERSION, latest);
  return notice ? ['', out.c.yellow(notice)] : [];
}

// Interactive primary flow: pick one action, run it, then pause and exit.
export async function runMenu({ flows, logger, signal }) {
  if (signal?.interrupted) return EXIT.INTERRUPTED;
  const footer = await updateFooter().catch(() => []);
  const index = await selectOption({
    header: menuHeader(),
    items: MENU_ITEMS,
    initial: 0,
    signal,
    footer,
  });
  if (index === null || MENU_ITEMS[index].action === null) {
    console.log('\nGoodbye.');
    return EXIT.OK;
  }
  const action = MENU_ITEMS[index].action;
  let code = EXIT.OK;
  try {
    code = await flows[action]({ signal });
    await logger.info('menu action finished', { action, code });
    if (signal?.interrupted) {
      console.log('\nInterrupted. Partial changes were rolled back where possible.');
      signal.reset();
    }
  } catch (err) {
    out.reportError(err && err.message ? err : new Error(String(err)));
    await logger.error('menu action failed', { action, message: String(err?.message || err) });
    code = err && typeof err.exitCode === 'number' ? err.exitCode : EXIT.GENERIC;
  }
  await pauseToClose();
  return code ?? EXIT.OK;
}
