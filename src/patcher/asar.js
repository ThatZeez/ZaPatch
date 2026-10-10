import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { packageInvalid } from './errors.js';

// Pure-Node asar reader/patcher (stdlib only).
//
// Verified against Zalo 26.9.10's app.asar: 16-byte prelude, JSON header
// (UTF-8) describing every file as {size, offset} where offset counts
// from the end of the header, then concatenated file bytes.
//
// Patch strategy: appended blobs + rebuilt header. Existing bytes are
// copied verbatim; every old offset stays valid (see patchAsar).
// The file is written to a temp path and renamed over the original so a
// crash never leaves a half-written asar.

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
    return { header, headerSize, dataBase: 16 + headerSize };
  } finally {
    await fh.close().catch(() => {});
  }
}

export function findEntry(header, asarRel) {
  const parts = normalizeRel(asarRel).split('/').filter(Boolean);
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
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node.files || {})) {
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

// Builds a minimal asar from a {asarRelPath: Buffer|string} map.
// Used by tests; the real patch path is patchAsar() below.
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
  const prelude = Buffer.alloc(16);
  prelude.writeUInt32LE(8 + headerSize, 0);
  prelude.writeUInt32LE(8 + headerSize, 4);
  prelude.writeUInt32LE(headerSize, 8);
  prelude.writeUInt32LE(headerSize, 12);
  const fh = await fs.open(destPath, 'w');
  try {
    await fh.write(prelude, 0, 16, 0);
    await fh.write(Buffer.from(headerStr, 'utf8'), 0, headerSize, 16);
    let pos = 16 + headerSize;
    for (const b of blobs) {
      await fh.write(b, 0, b.length, pos);
      pos += b.length;
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return { headerSize, files: Object.keys(filesMap).length };
}

// Renders the <script> hook tag for an asar-internal JS path, relative to
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

// Patches an asar: appends new blobs, rewrites index.html with the hook,
// rebuilds the header. Old entries keep their offsets: offsets count
// from the end of the header, and the old data block is copied verbatim
// right after the new header, so old relative offsets stay valid. Only
// the appended blobs get fresh offsets. Atomic via temp + rename.
export async function patchAsar({ asarPath, addFiles = [], indexHtml = 'pc-dist/index.html', hookJs = null, signal = null }) {
  const { header, headerSize, dataBase } = await readHeader(asarPath);
  signal?.throwIfInterrupted?.('patch');

  // Deep-clone the header so the original stays intact on failure.
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

  // New data layout: old block verbatim, then additions, then index.html.
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
  const prelude = Buffer.alloc(16);
  prelude.writeUInt32LE(8 + newHeaderSize, 0);
  prelude.writeUInt32LE(8 + newHeaderSize, 4);
  prelude.writeUInt32LE(newHeaderSize, 8);
  prelude.writeUInt32LE(newHeaderSize, 12);
  const out = createWriteStream(tmpPath);
  try {
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.on('finish', resolve);
      out.write(prelude);
      out.write(Buffer.from(finalHeader, 'utf8'));
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
  await fs.rename(tmpPath, asarPath);
}

// Verifies a patched asar: entries exist with expected sizes/hashes and
// the index.html hook is present.
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
