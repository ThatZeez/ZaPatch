import http from 'node:http';

// Minimal fixture HTTP server for release/download/updater tests.
// routes: Map path -> { status?, headers?, body: Buffer|string }.
// Redirects and byte-serving behave like a static file host.
export function startFixtureServer(routes) {
  const server = http.createServer((req, res) => {
    const route = routes.get(req.url);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (route.redirect) {
      res.writeHead(302, { Location: route.redirect });
      res.end();
      return;
    }
    const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(String(route.body ?? ''));
    res.writeHead(route.status || 200, {
      'Content-Type': route.contentType || 'application/octet-stream',
      'Content-Length': body.length,
      ...(route.headers || {}),
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

// Builds a minimal stored (uncompressed) .zip in memory.
// entries: [{ name, data: Buffer|string }].
export function buildStoredZip(entries) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = ~0;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  for (const c of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0, 14);
    head.writeUInt32LE(c.crc, 16);
    head.writeUInt32LE(c.size, 20);
    head.writeUInt32LE(c.size, 24);
    head.writeUInt16LE(c.name.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE(0, 38);
    head.writeUInt32LE(c.offset, 42);
    chunks.push(head, c.name);
    offset += head.length + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  chunks.push(end);
  return Buffer.concat(chunks);
}
