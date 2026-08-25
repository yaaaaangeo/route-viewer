const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const ROOT = __dirname;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = path.join(ROOT, 'route-viewer-shared-data.json');
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const WRITE_TOKEN = process.env.ROUTE_VIEWER_WRITE_TOKEN || '';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validateBackup(payload) {
  if (!payload || payload.type !== 'route-viewer-backup') return false;
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return false;
  return Object.values(payload.data).every(Array.isArray);
}

async function handleApi(req, res) {
  if (req.method === 'GET') {
    try {
      const json = await fs.readFile(DATA_FILE, 'utf8');
      send(res, 200, json, { 'Content-Type': 'application/json; charset=utf-8' });
    } catch (err) {
      if (err.code === 'ENOENT') {
        sendJson(res, 404, { error: 'shared data has not been saved yet' });
        return;
      }
      throw err;
    }
    return;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    if (WRITE_TOKEN && req.headers['x-route-viewer-token'] !== WRITE_TOKEN) {
      sendJson(res, 401, { error: 'write token required' });
      return;
    }

    const body = await readRequestBody(req);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (_) {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }

    if (!validateBackup(payload)) {
      sendJson(res, 400, { error: 'invalid route-viewer backup payload' });
      return;
    }

    payload.savedAt = new Date().toISOString();
    const tmpFile = DATA_FILE + '.tmp';
    await fs.writeFile(tmpFile, JSON.stringify(payload), 'utf8');
    await fs.rename(tmpFile, DATA_FILE);
    sendJson(res, 200, { ok: true, dateCount: Object.keys(payload.data).length, savedAt: payload.savedAt });
    return;
  }

  sendJson(res, 405, { error: 'method not allowed' });
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === '/' ? 'route-viewer.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relativePath);

  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'route-viewer.html')) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const type = TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    send(res, 200, content, { 'Content-Type': type });
  } catch (err) {
    if (err.code === 'ENOENT') {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/route-data' || req.url.startsWith('/api/route-data?')) {
      await handleApi(req, res);
      return;
    }
    await handleStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Route Viewer running at http://localhost:${PORT}`);
  console.log(`Shared data file: ${DATA_FILE}`);
});
