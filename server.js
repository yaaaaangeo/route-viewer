const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const { RouteDatabase, dedupeHistory } = require('./electron/database.js');
const CoverageGrid = require('./src/js/coverage-grid.js');

const ROOT = __dirname;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = path.join(ROOT, 'route-viewer-shared-data.json');
const UPDATES_DIR = path.join(ROOT, 'release');
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const WRITE_TOKEN = process.env.ROUTE_VIEWER_WRITE_TOKEN || '';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.blockmap': 'application/octet-stream',
  '.exe': 'application/octet-stream',
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

// ══════════════════════════════════════════════════════════
//  공유 저장 병합 — 새로 올라온 기록을 기존 저장분과 합친다(교체 아님).
//  여러 데스크톱 앱이 각자 이 서버로 동기화해도, 먼저 올린 사람의
//  기록이 나중 사람 때문에 지워지지 않는다. 중복 판정은 데스크톱 SQLite와
//  똑같은 규칙(date|time|vehicle|lat|lng)을 쓴다(RouteDatabase.hashOf 재사용).
// ══════════════════════════════════════════════════════════
// 이름(name) 기준으로 병합하는 설정 목록(vehicles/zones) — 나중 값이 우선이되,
// 지역(zones)은 기존에 그려둔 경계가 있는데 새로 온 값엔 경계가 없으면
// 기존 경계를 지킨다(뒤처진 기기가 동기화한다고 남의 경계를 지우면 안 되므로).
// 수동 셀(manualCells: 제외/방문/미방문)도 같은 원칙 — 새로 온 값이 없으면(구버전
// 기기) 기존 것을 지키고, 둘 다 있으면 칸 단위로 병합(같은 칸은 새로 온 상태 우선).
function mergeConfigList(existing, incoming) {
  const map = new Map();
  (existing || []).forEach(item => { if (item && item.name) map.set(item.name, item); });
  (incoming || []).forEach(item => {
    if (!item || !item.name) return;
    const prev = map.get(item.name);
    const prevHasPolygon = prev && Array.isArray(prev.polygon) && prev.polygon.length >= 3;
    const incomingHasPolygon = Array.isArray(item.polygon) && item.polygon.length >= 3;
    const next = (prevHasPolygon && !incomingHasPolygon) ? { ...item, polygon: prev.polygon } : { ...item };
    if (prev && prev.manualCells) {
      next.manualCells = item.manualCells
        ? CoverageGrid.mergeManualCellsByPoint(prev.manualCells, item.manualCells)
        : CoverageGrid.normalizeManualCells(prev.manualCells);
    } else if (item.manualCells) {
      next.manualCells = CoverageGrid.normalizeManualCells(item.manualCells);
    }
    map.set(item.name, next);
  });
  return [...map.values()];
}

function mergeSharedPayload(existing, incoming) {
  const seen = new Set();
  const mergedData = {};
  let incomingTotal = 0;
  let incomingInserted = 0;

  const absorb = (data, isIncoming) => {
    for (const [date, rows] of Object.entries(data || {})) {
      if (!Array.isArray(rows)) continue;
      for (const raw of rows) {
        if (isIncoming) incomingTotal++;
        const withDate = raw && typeof raw === 'object' ? { ...raw, date: raw.date || date } : raw;
        const rec = RouteDatabase.normalize(withDate || {});
        if (!rec) continue;
        const hash = RouteDatabase.hashOf(rec);
        if (seen.has(hash)) continue;
        seen.add(hash);
        if (isIncoming) incomingInserted++;
        (mergedData[rec.date] || (mergedData[rec.date] = [])).push(withDate);
      }
    }
  };

  if (existing) absorb(existing.data, false);
  absorb(incoming.data, true);

  Object.keys(mergedData).forEach(date => {
    mergedData[date].sort((a, b) => String((a && a.time) || '').localeCompare(String((b && b.time) || '')));
  });

  const zonePolygons = { ...((existing && existing.zonePolygons) || {}), ...(incoming.zonePolygons || {}) };
  const vehicles = mergeConfigList(existing && existing.vehicles, incoming.vehicles);
  const zones = mergeConfigList(existing && existing.zones, incoming.zones);
  const settings = { ...((existing && existing.settings) || {}), ...(incoming.settings || {}) };

  const backupHistory = dedupeHistory([
    ...(incoming.backupHistory || []),
    ...((existing && existing.backupHistory) || []),
  ]);

  const importSeen = new Set();
  const imports = [
    ...((existing && existing.imports) || []),
    ...(incoming.imports || []),
  ].filter(im => {
    const key = `${im && im.filename}|${im && im.importedAt}|${im && im.total}`;
    if (importSeen.has(key)) return false;
    importSeen.add(key);
    return true;
  }).slice(-500);

  return {
    payload: {
      type: 'route-viewer-backup',
      version: 3,
      data: mergedData,
      zonePolygons,
      vehicles,
      zones,
      settings,
      backupHistory,
      imports,
    },
    stats: {
      total: incomingTotal,
      inserted: incomingInserted,
      duplicates: incomingTotal - incomingInserted,
    },
  };
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

    // 기존에 저장된 게 있으면 덮어쓰지 않고 병합한다.
    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const { payload: merged, stats } = mergeSharedPayload(existing, payload);
    merged.savedAt = new Date().toISOString();
    merged.dateCount = Object.keys(merged.data).length;
    merged.exportedAt = payload.exportedAt || (existing && existing.exportedAt) || merged.savedAt;

    const tmpFile = DATA_FILE + '.tmp';
    await fs.writeFile(tmpFile, JSON.stringify(merged), 'utf8');
    await fs.rename(tmpFile, DATA_FILE);
    sendJson(res, 200, {
      ok: true,
      dateCount: merged.dateCount,
      savedAt: merged.savedAt,
      total: stats.total,
      inserted: stats.inserted,
      duplicates: stats.duplicates,
    });
    return;
  }

  sendJson(res, 405, { error: 'method not allowed' });
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  // v3부터 화면은 src/index.html 이다. '/' 로 접속하면 새 화면을 준다.
  // (예전 단일 파일 화면은 /route-viewer.html 로 그대로 남겨둔다)
  const relativePath = pathname === '/' ? 'src/index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relativePath);

  if (!filePath.startsWith(ROOT + path.sep)) {
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

// ── 앱 자동 업데이트 배포 — npm run dist 로 만든 release/ 를 그대로 내려준다.
// electron-updater가 <서버주소>/updates 에서 latest.yml + 설치 파일을 찾는다.
async function handleUpdates(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname).replace(/^\/updates\/?/, '');
  if (!pathname) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  const filePath = path.resolve(UPDATES_DIR, pathname);
  if (!filePath.startsWith(UPDATES_DIR + path.sep)) {
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
    if (req.url === '/updates' || req.url.startsWith('/updates/')) {
      await handleUpdates(req, res);
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
