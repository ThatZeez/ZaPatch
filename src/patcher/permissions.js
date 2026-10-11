import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { Codes, notWindows, PatcherError } from './errors.js';
import { EXIT } from './constants.js';

export function ensureWindows() {
  if (process.platform !== 'win32') throw notWindows();
}

// Best-effort admin check: `net session` fails without elevation.
export function isElevated() {
  return new Promise((resolve) => {
    const child = execFile('net', ['session'], { timeout: 8000, windowsHide: true }, (err) => {
      resolve(err ? false : true);
    });
    child.on('error', () => resolve(null));
  });
}

export async function checkWritable(paths) {
  const denied = [];
  for (const p of paths) {
    try {
      await fs.access(p, fs.constants.W_OK);
    } catch {
      denied.push(p);
    }
  }
  return { ok: denied.length === 0, denied };
}

// Zalo memory-maps resources/app.asar while running: replacing the file
// fails with EPERM even for admins, so detect that upfront. Returns
// [{pid, name}].
export function findZaloProcesses() {
  return new Promise((resolve) => {
    const child = execFile(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq Zalo.exe'],
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(parseTasklistCsv(stdout));
      },
    );
    child.on('error', () => resolve([]));
  });
}

export function parseTasklistCsv(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && m[1].toLowerCase() === 'zalo.exe') out.push({ name: m[1], pid: Number(m[2]) });
  }
  return out;
}

export async function ensureZaloNotRunning() {
  const procs = await findZaloProcesses();
  if (procs.length === 0) return;
  const pids = procs.map((p) => p.pid).join(', ');
  throw new PatcherError(
    Codes.PERMISSION_DENIED,
    `Zalo is running (PID${procs.length > 1 ? 's' : ''}: ${pids}) and locks its installation files.`,
    'Close Zalo completely (check the system tray), then retry. The patch cannot replace app.asar while Zalo holds it open.',
    EXIT.PERMISSION,
  );
}
