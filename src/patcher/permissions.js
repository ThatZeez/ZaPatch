import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { notWindows } from './errors.js';

export function ensureWindows() {
  if (process.platform !== 'win32') throw notWindows();
}

// Best-effort admin check via `net session` (fails without elevation).
// Returns true/false, or null when it cannot be determined.
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
