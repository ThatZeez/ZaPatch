import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { MENU_ITEMS, initialWindow, menuHeader, moveIndex, renderMenuBlock, resolveViewportHeight, selectOption, shiftWindow } from '../src/cli/menu.js';
import { createInterrupt } from '../src/patcher/interrupt.js';

// Force ANSI styling so underline codes are visible outside a TTY.
process.env.FORCE_COLOR = '1';

const UL = '\x1b[4m';
const RESET = '\x1b[0m';

function fakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = (v) => {
    s.isRaw = v;
  };
  s.resume = () => {};
  s.pause = () => {};
  return s;
}

function fakeStdout() {
  return {
    isTTY: true,
    chunks: [],
    write(c) {
      this.chunks.push(String(c));
      return true;
    },
    text() {
      return this.chunks.join('');
    },
  };
}

const key = (name, extra = {}) => ({ name, ...extra });

test('menu opens with the first option selected', () => {
  const lines = renderMenuBlock(MENU_ITEMS, 0);
  assert.equal(lines.length, MENU_ITEMS.length);
  assert.equal(lines[0], `  > ${UL}Install BetterZalo${RESET}`);
  assert.equal(lines[1], '    Repair BetterZalo');
});

test('down moves the selection and arrow+underline follow it', () => {
  let selected = 0;
  selected = moveIndex(selected, 'down', MENU_ITEMS.length);
  assert.equal(selected, 1);
  const lines = renderMenuBlock(MENU_ITEMS, selected);
  assert.equal(lines[0], '    Install BetterZalo');
  assert.equal(lines[1], `  > ${UL}Repair BetterZalo${RESET}`);
  assert.equal(lines[2], '    Uninstall BetterZalo');
});

test('up moves the selection back', () => {
  assert.equal(moveIndex(1, 'up', MENU_ITEMS.length), 0);
});

test('selection never moves past the first or last option', () => {
  assert.equal(moveIndex(0, 'up', MENU_ITEMS.length), 0);
  const last = MENU_ITEMS.length - 1;
  assert.equal(moveIndex(last, 'down', MENU_ITEMS.length), last);
  assert.equal(moveIndex(2, 'unknown-key', MENU_ITEMS.length), 2);
});

test('options map to the existing actions in order', () => {
  assert.deepEqual(
    MENU_ITEMS.map((m) => m.action),
    ['install', 'repair', 'uninstall', 'self-update', null],
  );
  assert.deepEqual(
    MENU_ITEMS.slice(0, 4).map((m) => m.label),
    ['Install BetterZalo', 'Repair BetterZalo', 'Uninstall BetterZalo', 'Update ZaPatch'],
  );
});

test('interactive rendering requires no numeric input', () => {
  for (let i = 0; i < MENU_ITEMS.length; i++) {
    for (const line of renderMenuBlock(MENU_ITEMS, i)) {
      assert.match(line, /^(↑|↓| ) [> ] /);
      assert.doesNotMatch(line, /\[\d\]/);
    }
  }
});

test('keypress down/down/up/enter selects the second option', async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const pending = selectOption({ items: MENU_ITEMS, input: stdin, output: stdout });
  stdin.emit('keypress', null, key('down'));
  stdin.emit('keypress', null, key('down'));
  stdin.emit('keypress', null, key('up'));
  stdin.emit('keypress', null, key('return'));
  assert.equal(await pending, 1);
  const screen = stdout.text();
  assert.ok(screen.includes(`  > ${UL}Repair BetterZalo${RESET}`));
});

test('selection clamps at the last option', async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const pending = selectOption({ items: MENU_ITEMS, input: stdin, output: stdout });
  for (let i = 0; i < 10; i++) stdin.emit('keypress', null, key('down'));
  stdin.emit('keypress', null, key('return'));
  assert.equal(await pending, MENU_ITEMS.length - 1);
});

test('escape cancels selection', async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const pending = selectOption({ items: MENU_ITEMS, input: stdin, output: stdout });
  stdin.emit('keypress', null, key('down'));
  stdin.emit('keypress', null, key('escape'));
  assert.equal(await pending, null);
});

test('ctrl+c interrupts and flags the signal', async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const signal = createInterrupt();
  const pending = selectOption({ items: MENU_ITEMS, input: stdin, output: stdout, signal });
  stdin.emit('keypress', null, { name: 'c', ctrl: true });
  assert.equal(await pending, null);
  assert.equal(signal.interrupted, true);
});

// Minimal terminal emulator: \r \n SGR \x1b[nA \x1b[0K \x1b[J, wrap at width.
// `headRows` seeds pinned header lines above the menu so a redraw that
// overshoots upward visibly destroys them instead of being clamped away.
function emulateScreen(writes, width, headRows = 0) {
  const rows = [];
  for (let h = 0; h < headRows; h++) rows.push(`header ${h + 1}`);
  rows.push('');
  let r = headRows;
  let c = 0;
  const put = (ch) => {
    if (c >= width) {
      r++;
      c = 0;
    }
    while (rows.length <= r) rows.push('');
    rows[r] = rows[r].slice(0, c) + ch + rows[r].slice(c + 1);
    c++;
  };
  const s = writes.join('');
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\r') {
      c = 0;
      i++;
    } else if (s[i] === '\n') {
      r++;
      c = 0;
      i++;
    } else if (s[i] === '\x1b' && s[i + 1] === '[') {
      const m = /^\x1b\[([?0-9;]*)([A-Za-z])/.exec(s.slice(i));
      if (!m) {
        i += 2;
        continue;
      }
      i += m[0].length;
      if (m[2] === 'A') r = Math.max(0, r - (parseInt(m[1]) || 1));
      else if (m[2] === 'K') {
        while (rows.length <= r) rows.push('');
        rows[r] = rows[r].slice(0, c);
      } else if (m[2] === 'J') {
        while (rows.length <= r) rows.push('');
        rows.length = r + 1;
        rows[r] = rows[r].slice(0, c);
      }
      // SGR (m) and cursor visibility are zero-width.
    } else {
      put(s[i]);
      i++;
    }
  }
  return rows
    .map((x) => x.replace(/\s+$/, ''))
    .filter((x, idx, arr) => !(x === '' && idx === arr.length - 1));
}

function expectScreenWithHeader(actual, options) {
  assert.deepEqual(actual.slice(0, 3), ['header 1', 'header 2', 'header 3']);
  assert.deepEqual(actual.slice(3), options);
}

test('long navigation leaves no stale option copies on screen', async () => {
  for (const width of [80, 40]) {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const pending = selectOption({ items: MENU_ITEMS, input: stdin, output: stdout });
    const seq = ['down', 'down', 'down', 'down', 'down', 'down', 'up', 'up', 'down', 'up', 'down', 'down'];
    for (const name of seq) stdin.emit('keypress', null, key(name));
    stdin.emit('keypress', null, key('return'));
    assert.equal(await pending, 4);
    const screen = emulateScreen(stdout.chunks, width, 3);
    expectScreenWithHeader(screen, [
      '    Install BetterZalo',
      '    Repair BetterZalo',
      '    Uninstall BetterZalo',
      '    Update ZaPatch',
      '  > Exit',
    ]);
  }
});

const MANY = Array.from({ length: 8 }, (_, i) => ({ label: `Option ${i + 1}` }));

test('viewport follows the selection down and back up symmetrically', () => {
  const size = 4;
  let start = initialWindow(0, MANY.length, size);
  assert.equal(start, 0);
  // ↓↓↓↓ : selection 4, window slides to [1..4].
  for (const sel of [1, 2, 3, 4]) start = shiftWindow(start, sel, MANY.length, size);
  assert.equal(start, 1);
  // ↑↑↑↑ : selection 0, window returns to [0..3].
  for (const sel of [3, 2, 1, 0]) start = shiftWindow(start, sel, MANY.length, size);
  assert.equal(start, 0);
});

test('window never exceeds the list and short lists show fully', () => {
  assert.equal(shiftWindow(0, 7, 8, 4), 4);
  assert.equal(shiftWindow(4, 7, 8, 4), 4);
  assert.equal(initialWindow(0, 3, 10), 0);
  assert.deepEqual(
    renderMenuBlock(MANY.slice(0, 3), 0, 0, 3),
    [`  > ${UL}Option 1${RESET}`, '    Option 2', '    Option 3'],
  );
});

test('viewport height adapts to terminal rows', () => {
  assert.equal(resolveViewportHeight({ rows: 30 }), 20);
  assert.equal(resolveViewportHeight({}), 14);
  assert.equal(resolveViewportHeight({ rows: 5 }), 3);
});

test('header shows the hint and prompt lines', () => {
  const header = menuHeader();
  assert.equal(header.length, 2);
  assert.ok(header[0].includes('Use the arrow keys to navigate: ↓ ↑ → ←'));
  assert.ok(header[1].includes('?'));
  assert.ok(header[1].includes('What would you like to do? (Press Enter to confirm):'));
  // Blue ? and bold-white prompt text (FORCE_COLOR=1 is set above).
  assert.ok(header[1].includes('\x1b[34m?'));
  assert.ok(header[1].includes('\x1b[1;37mWhat would you like to do?'));
});

test('down-down-down-down-up-up-up-up round trip restores the viewport', async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const pending = selectOption({ items: MANY, input: stdin, output: stdout, maxVisible: 4 });
  for (const name of ['down', 'down', 'down', 'down', 'up', 'up', 'up', 'up']) {
    stdin.emit('keypress', null, key(name));
  }
  stdin.emit('keypress', null, key('return'));
  assert.equal(await pending, 0);
  for (const width of [80, 40]) {
    // Emulator strips styling; underline verified on raw bytes below.
    // Last row keeps ↓ (options 5-8 still hidden below).
    expectScreenWithHeader(emulateScreen(stdout.chunks, width, 3), [
      '  > Option 1',
      '    Option 2',
      '    Option 3',
      '↓   Option 4',
    ]);
  }
  assert.ok(stdout.text().includes(`  > ${UL}Option 1${RESET}`));
});

test('scrolled viewport shows the underline on the visible selection', async () => {  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const pending = selectOption({ items: MANY, input: stdin, output: stdout, maxVisible: 4 });
  for (let i = 0; i < 5; i++) stdin.emit('keypress', null, key('down'));
  stdin.emit('keypress', null, key('return'));
  assert.equal(await pending, 5);
  expectScreenWithHeader(emulateScreen(stdout.chunks, 80, 3), [
    '↑   Option 3',
    '    Option 4',
    '    Option 5',
    '↓ > Option 6',
  ]);
  assert.ok(stdout.text().includes(`↓ > ${UL}Option 6${RESET}`));
});

test('one-row window shows ↑ when options hide on both sides', () => {
  // Window [3..4) of 8 items, selection 3: hidden above and below.
  assert.deepEqual(renderMenuBlock(MANY, 3, 3, 4), [`↑ > ${UL}Option 4${RESET}`]);
});

test('default viewport is 5 rows on tall terminals', async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout(); // no rows -> adapted 14 -> capped to 5
  const pending = selectOption({ items: MANY, input: stdin, output: stdout });
  for (let i = 0; i < 7; i++) stdin.emit('keypress', null, key('down'));
  stdin.emit('keypress', null, key('return'));
  assert.equal(await pending, 7);
  expectScreenWithHeader(emulateScreen(stdout.chunks, 80, 3), [
    '↑   Option 4',
    '    Option 5',
    '    Option 6',
    '    Option 7',
    '  > Option 8',
  ]);
});

test('no scroll indicators when the whole list fits', () => {
  const lines = renderMenuBlock(MENU_ITEMS, 2);
  assert.equal(lines.length, 5);
  for (const line of lines) assert.match(line, /^  [> ] /);
});

test('footer renders below options and is never selectable', async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const footer = ['', 'Update available!'];
  const pending = selectOption({ items: MENU_ITEMS, input: stdin, output: stdout, footer });
  stdin.emit('keypress', null, key('down'));
  stdin.emit('keypress', null, key('down'));
  stdin.emit('keypress', null, key('return'));
  assert.equal(await pending, 2);
  const screen = emulateScreen(stdout.chunks, 80, 0);
  assert.deepEqual(screen.slice(-2), ['', 'Update available!']);
  assert.equal(screen.filter((line) => line === 'Update available!').length, 1);
});

test('no footer means byte-identical output to before', async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const pending = selectOption({ items: MENU_ITEMS, input: stdin, output: stdout });
  stdin.emit('keypress', null, key('return'));
  assert.equal(await pending, 0);
  assert.ok(!stdout.text().includes('Update available!'));
});