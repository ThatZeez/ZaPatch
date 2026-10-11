import fs from 'node:fs/promises';
import path from 'node:path';
import { logDir, PATCHER_VERSION } from './constants.js';

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// Minimal file logger for troubleshooting (console output lives in
// src/cli/output.js). Versions, paths, operations, errors only —
// never sensitive data.
export function createLogger() {
  let file = null;
  async function ensure() {
    if (file) return file;
    const dir = logDir();
    await fs.mkdir(dir, { recursive: true });
    file = path.join(dir, `patcher-${stamp()}.log`);
    return file;
  }

  async function write(level, msg, extra = {}) {
    try {      const f = await ensure();
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        patcher: PATCHER_VERSION,
        msg,
        ...extra,
      });
      await fs.appendFile(f, line + '\n', 'utf8');
    } catch {
    }
  }

  return {
    info: (msg, extra) => write('info', msg, extra),
    warn: (msg, extra) => write('warn', msg, extra),
    error: (msg, extra) => write('error', msg, extra),
    debug: (msg, extra) => write('debug', msg, extra),
    path: async () => ensure().catch(() => null),
  };
}
