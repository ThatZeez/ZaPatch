import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { downloadFailed } from './errors.js';
import { isInterruptError } from './interrupt.js';

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60000;

function clientFor(url) {
  return url.protocol === 'http:' ? http : https;
}

// Fetches a small text document (API JSON, .sha256 sidecars).
export function fetchText(rawUrl, { headers = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const req = clientFor(url).get(
      url,
      {
        headers: { 'User-Agent': 'ZaPatch', Accept: 'application/json, text/plain, */*', ...headers },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (headers._redirects >= MAX_REDIRECTS) {
            reject(downloadFailed(rawUrl, 'too many redirects'));
            return;
          }
          fetchText(new URL(res.headers.location, url).toString(), {
            headers: { ...headers, _redirects: (headers._redirects || 0) + 1 },
            timeout,
          }).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(downloadFailed(rawUrl, `HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 4 * 1024 * 1024) {
            res.destroy();
            reject(downloadFailed(rawUrl, 'response too large'));
          }
        });
        res.on('end', () => resolve(body));
        res.on('error', (e) => reject(downloadFailed(rawUrl, e.message)));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(downloadFailed(rawUrl, 'timed out'));
    });
    req.on('error', (e) => reject(downloadFailed(rawUrl, e.message)));
  });
}

// Downloads a file with optional progress, interruption, and SHA-256 check.
// Reports progress as { downloaded, total } bytes; total may be null.
export function downloadFile(rawUrl, destPath, { expectedSha256 = null, onProgress = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (urlStr, redirects) => {
      if (signal?.interrupted) {
        reject(Object.assign(new Error('Interrupted.'), { code: 'INTERRUPTED', exitCode: 130 }));
        return;
      }
      let url;
      try {
        url = new URL(urlStr);
      } catch (e) {
        reject(downloadFailed(urlStr, 'invalid URL'));
        return;
      }
      const req = clientFor(url).get(
        url,
        { headers: { 'User-Agent': 'ZaPatch', Accept: '*/*' }, timeout: TIMEOUT_MS },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects >= MAX_REDIRECTS) {
              reject(downloadFailed(rawUrl, 'too many redirects'));
              return;
            }
            attempt(new URL(res.headers.location, url).toString(), redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(downloadFailed(rawUrl, `HTTP ${res.statusCode}`));
            return;
          }
          const total = res.headers['content-length'] ? Number(res.headers['content-length']) : null;
          const hash = crypto.createHash('sha256');
          let downloaded = 0;
          const out = createWriteStream(destPath);
          const fail = (err) => {
            res.destroy();
            out.destroy();
            fs.rm(destPath, { force: true }).finally(() => reject(err));
          };
          res.on('data', (chunk) => {
            if (signal?.interrupted) {
              fail(Object.assign(new Error('Interrupted.'), { code: 'INTERRUPTED', exitCode: 130 }));
              return;
            }
            downloaded += chunk.length;
            hash.update(chunk);
            if (onProgress) {
              try {
                onProgress({ downloaded, total });
              } catch {
                // progress display must never break the download
              }
            }
          });
          res.on('error', (e) => fail(isInterruptError(e) ? e : downloadFailed(rawUrl, e.message)));
          out.on('error', (e) => fail(downloadFailed(rawUrl, e.message)));
          out.on('finish', () => {
            const actual = hash.digest('hex');
            if (expectedSha256 && actual.toLowerCase() !== expectedSha256.toLowerCase()) {
              fail(downloadFailed(rawUrl, 'SHA-256 mismatch (file rejected, deleted)'));
              return;
            }
            resolve({ path: destPath, sha256: actual, bytes: downloaded });
          });
          res.pipe(out);
        },
      );
      req.on('timeout', () => {
        req.destroy();
        reject(downloadFailed(rawUrl, 'timed out'));
      });
      req.on('error', (e) => reject(downloadFailed(rawUrl, e.message)));
    };
    attempt(rawUrl, 0);
  });
}

export function firstHexToken(text) {
  const m = /([0-9a-fA-F]{64})/.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}
