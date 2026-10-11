import fs from 'node:fs/promises';
import { configDir, configFile } from './constants.js';

// Persisted installation path so the user is not asked every launch.
export async function loadConfig() {
  try {
    const raw = await fs.readFile(configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.zaloPath === 'string' && parsed.zaloPath.trim()) {
      return { zaloPath: parsed.zaloPath.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveConfig(zaloPath) {
  await fs.mkdir(configDir(), { recursive: true });
  const tmp = `${configFile()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ zaloPath }, null, 2), 'utf8');
  await fs.rename(tmp, configFile());
}

export async function clearConfig() {
  try {
    await fs.rm(configFile(), { force: true });
  } catch {
    // noop
  }
}
