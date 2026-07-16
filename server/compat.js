// Node < 18 compatibility: minimal global fetch built on node:https.
// Supports what this project uses: method, headers, string body,
// res.ok/status, res.json(), res.text(), res.headers.get().
import https from 'node:https';
import http from 'node:http';

if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch = function fetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'http:' ? http : https;
      const req = mod.request(
        u,
        { method: opts.method || 'GET', headers: opts.headers || {} },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
              text: () => Promise.resolve(body),
              json: () => Promise.resolve(JSON.parse(body)),
            });
          });
        }
      );
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  };
}
