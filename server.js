// Local desktop server: serves the app and stores bills in ./data so they survive browser clears.
// Uses the same files as earlier versions (data/invoices.json, data/settings.json), so existing bills are kept.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const publicDirectory = path.join(__dirname, 'public');
const dataDirectory = path.join(__dirname, 'data');
const files = { invoices: 'invoices.json', products: 'products.json', settings: 'settings.json' };
const fileFor = key => path.join(dataDirectory, files[key]);

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
// Write to a temp file then rename, so a crash mid-write never corrupts existing data.
function writeJson(file, value) {
  if (!fs.existsSync(dataDirectory)) fs.mkdirSync(dataDirectory, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
// settings.json holds both the settings and the per-year invoice counters (as in earlier versions).
function readKey(key) {
  if (key === 'counters') return readJson(fileFor('settings'), {}).counters || {};
  if (key === 'settings') { const { counters, ...rest } = readJson(fileFor('settings'), {}); return rest; }
  return readJson(fileFor(key), []);
}
function writeKey(key, value) {
  if (key === 'counters') { const s = readJson(fileFor('settings'), {}); s.counters = value; return writeJson(fileFor('settings'), s); }
  if (key === 'settings') { const s = readJson(fileFor('settings'), {}); return writeJson(fileFor('settings'), { ...value, counters: s.counters || {} }); }
  writeJson(fileFor(key), value);
}
const valid = { invoices: Array.isArray, products: Array.isArray, settings: v => v && typeof v === 'object' && !Array.isArray(v), counters: v => v && typeof v === 'object' && !Array.isArray(v) };

const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
function sendJson(response, status, payload) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders }); response.end(JSON.stringify(payload)); }
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const storeMatch = requestUrl.pathname.match(/^\/api\/store\/(invoices|products|settings|counters)$/);
  if (storeMatch) {
    const key = storeMatch[1];
    if (request.method === 'GET') return sendJson(response, 200, readKey(key));
    if (request.method === 'PUT') {
      // Only accept writes from this app's own page (blocks other websites from posting to localhost).
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return sendJson(response, 403, { error: 'Forbidden' });
      let body = '', tooBig = false;
      request.on('data', chunk => { body += chunk; if (body.length > 50_000_000) { tooBig = true; request.destroy(); } });
      request.on('end', () => {
        if (tooBig) return;
        try {
          const value = JSON.parse(body);
          if (!valid[key](value)) return sendJson(response, 400, { error: 'Invalid data.' });
          writeKey(key, value); sendJson(response, 200, { ok: true });
        } catch { sendJson(response, 400, { error: 'Could not save. Check the entered details and try again.' }); }
      });
      return;
    }
    return sendJson(response, 405, { error: 'Method not allowed' });
  }

  const requested = requestUrl.pathname === '/' ? '/index.html' : decodeURIComponent(requestUrl.pathname);
  const filePath = path.resolve(publicDirectory, `.${requested}`);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) { response.writeHead(403); return response.end(); }
  fs.readFile(filePath, (error, data) => {
    if (error) { response.writeHead(404); return response.end('Not found'); }
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...securityHeaders });
    response.end(data);
  });
});
server.listen(port, host, () => console.log(`MM GST Billing is running at http://localhost:${port}`));
