import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { MENU_ITEMS, moveIndex, renderMenuBlock, selectOption } from '../src/cli/menu.js';
import { createInterrupt } from '../src/patcher/interrupt.js';

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
  assert.equal(lines[0], '> Install BetterZalo');
  assert.equal(lines[1], `  ${'-'.repeat('Install BetterZalo'.length)}`);
  assert.equal(lines[2], '  Repair BetterZalo');
});

test('down moves the selection and arrow+underline follow it', () => {
  let selected = 0;
  selected = moveIndex(selected, 'down', MENU_ITEMS.length);
  assert.equal(selected, 1);
  const lines = renderMenuBlock(MENU_ITEMS, selected);
  assert.equal(lines[0], '  Install BetterZalo');
  assert.equal(lines[1], '> Repair BetterZalo');
  assert.equal(lines[2], `  ${'-'.repeat('Repair BetterZalo'.length)}`);
  assert.equal(lines[3], '  Uninstall BetterZalo');
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
      assert.match(line, /^(>|  |  -+)/);
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
  assert.ok(screen.includes('> Repair BetterZalo'));
  assert.ok(screen.includes(`  ${'-'.repeat('Repair BetterZalo'.length)}`));
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