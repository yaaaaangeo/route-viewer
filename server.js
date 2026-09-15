const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const { RouteDatabase, dedupeHistory } = require('./electron/database.js');
const CoverageGrid = require('./src/js/coverage-grid.js');
const { osmTileUserAgent } = require('./electron/osm-tile-ua.js');
const APP_VERSION = require('./package.json').version;

const ROOT = __dirname;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
// 테스트는 ROUTE_VIEWER_DATA_FILE 로 임시 파일을 준다 — 실제 공유 저장 파일을 건드리지 않게
const DATA_FILE = process.env.ROUTE_VIEWER_DATA_FILE || path.join(ROOT, 'route-viewer-shared-data.json');
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

// ══════════════════════════════════════════════════════════
//  배경 지도 타일 프록시 — 브라우저 모드 화면은 OSM 에 직접 가지 않고 이 서버의
//  /tiles/z/x/y.png 로 타일을 받는다.
//
//  왜: 브라우저가 tile.openstreetmap.org 에 직접 요청하면, 그 브라우저의 Referer·프로필·
//  캐시 상태에 따라 OSM 이 "Access blocked" 403 이미지를 돌려주는 일이 실제로 있었다
//  (새 프로필 Edge 는 통과하는데 사용자 PC 의 Edge 는 막혔고, 밖에서는 원인을 볼 수 없었다).
//  서버가 대신 받으면 요청은 항상 앱을 식별하는 User-Agent(OSM 타일 정책이 요구하는 것)로
//  나가고, 받은 타일은 디스크에 캐시해서 OSM 에 같은 타일을 반복 요청하지 않는다(정책 권장).
//
//  OSM 이 거절하면(x-blocked 헤더 / 4xx·5xx / 이미지가 아닌 응답) 캐시하지 않고 서버 창에
//  로그를 남긴다 — 다시 막히면 추측하지 말고 이 로그부터 본다. 예전에 받아 둔 타일이 있으면
//  오래됐어도 그걸 준다.
// ══════════════════════════════════════════════════════════
const TILE_UPSTREAM = process.env.ROUTE_VIEWER_TILE_UPSTREAM || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_CACHE_DIR = process.env.ROUTE_VIEWER_TILE_CACHE || path.join(ROOT, 'tile-cache');
const TILE_MAX_ZOOM = 19;
const TILE_FRESH_MS = 7 * 24 * 60 * 60 * 1000; // 이보다 오래된 캐시는 다시 받아 본다
const TILE_FETCH_TIMEOUT_MS = 15000;
const tileInflight = new Map(); // 같은 타일 동시 요청 → OSM 에는 한 번만
let tileRefusalLog = { last: 0, suppressed: 0 };

function parseTilePath(pathname) {
  const m = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(pathname);
  if (!m) return null;
  const z = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  const n = 2 ** z;
  if (z > TILE_MAX_ZOOM || x >= n || y >= n) return null;
  return { z, x, y };
}

// 지도 한 화면이 타일 수십 장이라, 막히면 같은 로그가 쏟아지지 않게 10초에 한 줄로 묶는다
function logTileRefused(t, detail) {
  const now = Date.now();
  if (now - tileRefusalLog.last < 10000) { tileRefusalLog.suppressed++; return; }
  const more = tileRefusalLog.suppressed ? ` (그 사이 ${tileRefusalLog.suppressed}건 더)` : '';
  console.warn(`[tiles] OSM 이 타일 ${t.z}/${t.x}/${t.y} 를 거절: ${detail}${more}`);
  tileRefusalLog = { last: now, suppressed: 0 };
}

async function fetchTileUpstream(t) {
  const url = TILE_UPSTREAM
    .replace('{s}', 'abc'[(t.x + t.y) % 3])
    .replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
  const res = await fetch(url, {
    headers: { 'User-Agent': osmTileUserAgent(APP_VERSION) },
    signal: AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS),
  });
  const body = Buffer.from(await res.arrayBuffer());
  const blocked = res.headers.get('x-blocked');
  const type = res.headers.get('content-type') || '';
  // 차단 이미지는 HTTP 200 + image/png 로도 오므로 상태 코드만 보면 안 된다 — x-blocked 로 가린다
  if (!res.ok || blocked || !type.startsWith('image/')) {
    return { ok: false, detail: `HTTP ${res.status}${blocked ? ` · x-blocked: ${blocked}` : ''}${type.startsWith('image/') ? '' : ` · ${type || 'no content-type'}`}` };
  }
  return { ok: true, body };
}

async function writeTileCache(file, body) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
  } catch (err) {
    // 캐시 쓰기 실패는 화면에 영향 없음 — 타일은 이미 받았다
    console.warn(`[tiles] 캐시 저장 실패: ${err.message}`);
  }
}

function sendTile(res, body, cacheStatus) {
  send(res, 200, body, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
    'X-Tile-Cache': cacheStatus,
  });
}

async function handleTiles(req, res) {
  const t = parseTilePath(new URL(req.url, 'http://localhost').pathname);
  if (!t) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  const file = path.join(TILE_CACHE_DIR, String(t.z), String(t.x), `${t.y}.png`);

  let stale = false;
  try {
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs < TILE_FRESH_MS) {
      sendTile(res, await fs.readFile(file), 'HIT');
      return;
    }
    stale = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const key = `${t.z}/${t.x}/${t.y}`;
  let job = tileInflight.get(key);
  if (!job) {
    job = (async () => {
      const result = await fetchTileUpstream(t).catch(err => ({ ok: false, detail: err.message }));
      if (result.ok) await writeTileCache(file, result.body);
      return result;
    })().finally(() => tileInflight.delete(key));
    tileInflight.set(key, job);
  }
  const result = await job;

  if (result.ok) {
    sendTile(res, result.body, 'MISS');
    return;
  }
  logTileRefused(t, result.detail);
  if (stale) {
    sendTile(res, await fs.readFile(file), 'STALE');
    return;
  }
  send(res, 502, `tile unavailable: ${result.detail}`, { 'Content-Type': 'text/plain; charset=utf-8' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/tiles/')) {
      await handleTiles(req, res);
      return;
    }
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
