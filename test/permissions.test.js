import assert from 'node:assert/strict';
import test from 'node:test';
import { findZaloProcesses, parseTasklistCsv } from '../src/patcher/permissions.js';

test('parses tasklist CSV output', () => {
  const csv = '"Image Name","PID","Session Name","Session#","Mem Usage"\r\n'
    + '"Zalo.exe","884","Console","1","120,000 K"\r\n'
    + '"Code.exe","1234","Console","1","200,000 K"\r\n'
    + '"INFO: No tasks are running which match the specified criteria."\r\n';
  assert.deepEqual(parseTasklistCsv(csv), [{ name: 'Zalo.exe', pid: 884 }]);
});

test('empty or garbage tasklist output means no processes', () => {
  assert.deepEqual(parseTasklistCsv(''), []);
  assert.deepEqual(parseTasklistCsv('garbage\nlines\n'), []);
});

test('findZaloProcesses resolves to an array', async () => {
  const procs = await findZaloProcesses();
  assert.ok(Array.isArray(procs));
  for (const p of procs) assert.ok(typeof p.pid === 'number');
});
