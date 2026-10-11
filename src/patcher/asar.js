import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { packageInvalid } from './errors.js';

// Pure-Node asar reader/patcher (stdlib only), verified against Zalo
// 26.9.10's app.asar: 16-byte prelude, JSON header ({size, offset} per
// file, offsets from end of header), then concatenated file bytes.
// Appends blobs + rebuilds the header; old bytes copy verbatim so old
// offsets stay valid. Temp file + rename, never a half-written asar.

export const HOOK_MARKER = '<!-- BetterZalo -->';

function normalizeRel(p) {
  return String(p).replaceAll('\\', '/').replace(/^\/+/, '');
}

export async function readHeader(asarPath) {
  const fh = await fs.open(asarPath, 'r');
  try {
    const pre = Buffer.alloc(16);
    await fh.read(pre, 0, 16, 0);
    const headerSize = pre.readUInt32LE(12);
    if (!Number.isSafeInteger(headerSize) || headerSize <= 0 || headerSize > 64 * 1024 * 1024) {
      throw packageInvalid(`not an asar archive (bad header size): ${path.basename(asarPath)}`);
    }
    const hb = Buffer.alloc(headerSize);
    await fh.read(hb, 0, headerSize, 16);
    let header;
    try {
      header = JSON.parse(hb.toString('utf8'));
    } catch {
      throw packageInvalid(`not an asar archive (header is not JSON): ${path.basename(asarPath)}`);
    }
    if (!header || typeof header !== 'object' || !header.files) {
      throw packageInvalid(`not an asar archive (no file table): ${path.basename(asarPath)}`);
    }
    // Data starts after both pickles: 8 + inner total (u32@4). The JSON
    // itself is 4-byte aligned; never assume 16 + headerSize.
    return { header, headerSize, dataBase: 8 + pre.readUInt32LE(4) };
  } finally {
    await fh.close().catch(() => {});
  }
}

export function findEntry(header, asarRel) {  const parts = normalizeRel(asarRel).split('/').filter(Boolean);
  let node = header;
  for (const p of parts) {
    node = node.files ? node.files[p] : undefined;
    if (!node) return null;
  }
  return node.files ? null : node;
}

export async function extractFile(asarPath, asarRel, { header: known = null, dataBase: base = null } = {}) {
  const { header, dataBase } = known ? { header: known, dataBase: base } : await readHeader(asarPath);
  const entry = findEntry(header, asarRel);
  if (!entry) throw packageInvalid(`file not in asar archive: ${asarRel}`);
  const fh = await fs.open(asarPath, 'r');
  try {
    const buf = Buffer.alloc(entry.size);
    await fh.read(buf, 0, entry.size, dataBase + parseInt(entry.offset, 10));
    return buf;
  } finally {
    await fh.close().catch(() => {});
  }
}

export function listFiles(header) {
  const out = [];
  const walk = (node, prefix) => {    for (const [k, v] of Object.entries(node.files || {})) {
      const p = prefix + '/' + k;
      if (v.files) walk(v, p);
      else out.push(p.slice(1));
    }
  };
  walk(header, '');
  return out;
}

function setEntry(header, asarRel, entry) {
  const parts = normalizeRel(asarRel).split('/').filter(Boolean);
  let node = header;
  for (let i = 0; i < parts.length - 1; i++) {
    node.files = node.files || {};
    if (!node.files[parts[i]] || !node.files[parts[i]].files) {
      node.files[parts[i]] = { files: {} };
    }
    node = node.files[parts[i]];
  }
  node.files = node.files || {};
  node.files[parts[parts.length - 1]] = entry;
}

function headerByteSize(header) {
  return Buffer.byteLength(JSON.stringify(header), 'utf8');
}

// Canonical nested-pickle prelude: outer size 4, inner total, inner
// size, JSON size; JSON padded to 4 bytes; data at 8 + inner total.
// Byte-identical in structure to asars Electron ships.
export function preludeFor(headerSize) {
  const pad = (4 - (headerSize % 4)) % 4;
  const prelude = Buffer.alloc(16);
  prelude.writeUInt32LE(4, 0);
  prelude.writeUInt32LE(8 + headerSize + pad, 4);
  prelude.writeUInt32LE(4 + headerSize + pad, 8);
  prelude.writeUInt32LE(headerSize, 12);
  return { prelude, pad, dataBase: 8 + prelude.readUInt32LE(4) };
}

// Minimal asar builder (test fixtures use it; patching is patchAsar).
export async function createAsar(destPath, filesMap) {
  const header = { files: {} };
  let offset = 0;
  const blobs = [];
  for (const [rel, data] of Object.entries(filesMap)) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    setEntry(header, rel, { size: buf.length, offset: String(offset) });
    blobs.push(buf);
    offset += buf.length;
  }
  const headerStr = JSON.stringify(header);
  const headerSize = Buffer.byteLength(headerStr);
  const { prelude, pad, dataBase } = preludeFor(headerSize);
  const fh = await fs.open(destPath, 'w');
  try {
    await fh.write(prelude, 0, 16, 0);
    await fh.write(Buffer.from(headerStr, 'utf8'), 0, headerSize, 16);
    if (pad) await fh.write(Buffer.alloc(pad), 0, pad, 16 + headerSize);
    let pos = dataBase;
    for (const b of blobs) {
      await fh.write(b, 0, b.length, pos);
      pos += b.length;
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return { headerSize, files: Object.keys(filesMap).length };
}

// <script> hook tag for an asar-internal JS path, relative to
// pc-dist/index.html (both live under pc-dist/).
export function hookTagFor(asarJsPath) {
  const rel = normalizeRel(asarJsPath).replace(/^pc-dist\//, '');
  return `${HOOK_MARKER}<script src="${rel}"></script>`;
}

// Inserts the hook before </body> (once only — idempotent).
export function insertHook(html, hookTag) {
  if (html.includes(HOOK_MARKER) || html.includes(hookTag)) return { html, inserted: false };
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) throw packageInvalid('index.html has no </body> to hook into');
  return { html: html.slice(0, idx) + hookTag + html.slice(idx), inserted: true };
}

// Appends new blobs, rewrites index.html with the hook. Old entries keep
// their offsets (old block copies verbatim after the new header); only
// appended blobs get fresh offsets. Atomic via temp + rename.
export async function patchAsar({ asarPath, addFiles = [], indexHtml = 'pc-dist/index.html', hookJs = null, signal = null }) {
  const { header, headerSize, dataBase } = await readHeader(asarPath);
  signal?.throwIfInterrupted?.('patch');

  // Deep-clone: the original header must survive a failed patch.
  const next = JSON.parse(JSON.stringify(header));

  const blobs = [];
  const added = [];
  for (const f of addFiles) {
    const buf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    blobs.push({ rel: normalizeRel(f.asarPath), buf });
    added.push({ asarPath: normalizeRel(f.asarPath), size: buf.length });
  }

  let htmlBuf = null;
  let hookInserted = false;
  if (hookJs) {
    const entry = findEntry(next, indexHtml);
    if (!entry) throw packageInvalid(`hook target not in asar archive: ${indexHtml}`);
    htmlBuf = await extractFile(asarPath, indexHtml, { header, dataBase });
    const { html, inserted } = insertHook(htmlBuf.toString('utf8'), hookTagFor(hookJs));
    hookInserted = inserted;
    if (inserted) htmlBuf = Buffer.from(html, 'utf8');
    else htmlBuf = null; // already hooked: leave bytes untouched
  }

  const oldDataSize = (await fs.stat(asarPath)).size - dataBase;
  const additions = [...blobs.map((b) => ({ rel: b.rel, buf: b.buf }))];
  if (htmlBuf) additions.push({ rel: normalizeRel(indexHtml), buf: htmlBuf, replace: true });

  const trial = JSON.parse(JSON.stringify(next));
  let off = oldDataSize;
  for (const a of additions) {
    if (a.replace) {
      const e = findEntry(trial, a.rel);
      e.size = a.buf.length;
      e.offset = String(off);
    } else {
      setEntry(trial, a.rel, { size: a.buf.length, offset: String(off) });
    }
    off += a.buf.length;
  }
  const finalHeader = JSON.stringify(trial);
  const newHeaderSize = headerByteSize(trial);
  await writeAsar(asarPath, finalHeader, newHeaderSize, oldDataSize, dataBase, additions.map((a) => a.buf), signal);
  return { added, hookInserted, headerSize: newHeaderSize, entryCount: listFiles(trial).length };
}

async function writeAsar(asarPath, finalHeader, newHeaderSize, oldDataSize, oldDataBase, newBlobs, signal) {
  const tmpPath = `${asarPath}.zapatch-new`;
  await fs.rm(tmpPath, { force: true }).catch(() => {});
  const { prelude, pad } = preludeFor(newHeaderSize);
  const out = createWriteStream(tmpPath);
  try {
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.on('finish', resolve);
      out.write(prelude);
      out.write(Buffer.from(finalHeader, 'utf8'));
      if (pad) out.write(Buffer.alloc(pad));
      const inp = createReadStream(asarPath, { start: oldDataBase, end: oldDataBase + oldDataSize - 1 });
      inp.on('error', reject);
      inp.pipe(out, { end: false });
      inp.on('end', () => {
        signal?.throwIfInterrupted?.('patch');
        for (const b of newBlobs) out.write(b);
        out.end();
      });
    });
  } catch (e) {
    out.destroy();
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw e.code === 'INTERRUPTED' ? e : packageInvalid(`asar rewrite failed: ${e.message}`);
  }
  try {
    await fs.rename(tmpPath, asarPath);
  } catch (e) {
    // The original asar is untouched at this point; the temp file is left
    // for inspection and removed on the next run. A lock (running Zalo)
    // is by far the most common cause on Windows.
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY') {
      const { permissionDenied } = await import('./errors.js');
      throw permissionDenied(asarPath, 'Close Zalo completely (check the system tray) and retry. The original app.asar was not modified.');
    }
    throw packageInvalid(`asar replace failed: ${e.message}`);
  }
}

export async function verifyPatchedAsar(asarPath, { expectFiles = [], hookMarker = HOOK_MARKER } = {}) {
  const crypto = await import('node:crypto');
  const { header, dataBase } = await readHeader(asarPath);
  const checks = [];
  for (const f of expectFiles) {
    const entry = findEntry(header, f.asarPath);
    if (!entry) {
      checks.push({ file: f.asarPath, ok: false, reason: 'missing from asar' });
      continue;
    }
    const buf = await extractFile(asarPath, f.asarPath, { header, dataBase });
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (f.sha256 && hash.toLowerCase() !== f.sha256.toLowerCase()) {
      checks.push({ file: f.asarPath, ok: false, reason: 'hash mismatch' });
    } else if (f.size !== undefined && buf.length !== f.size) {
      checks.push({ file: f.asarPath, ok: false, reason: 'size mismatch' });
    } else {
      checks.push({ file: f.asarPath, ok: true });
    }
  }
  let hookOk = true;
  try {
    const html = (await extractFile(asarPath, 'pc-dist/index.html', { header, dataBase })).toString('utf8');
    hookOk = html.includes(hookMarker);
  } catch {
    hookOk = false;
  }
  return { ok: checks.every((c) => c.ok) && hookOk, checks, hookOk };
}

export { normalizeRel };
