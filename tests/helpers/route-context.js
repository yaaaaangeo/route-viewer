// ══════════════════════════════════════════════════════════
//  route-context — 화면 스크립트(src/js/*.js)를 Node vm 안에서 실제 파일 그대로
//  로드하기 위한 공용 준비물.
//
//   · createDesktopApi(db)  — electron/preload.js 가 노출하는 window.routeAPI 를
//     흉내 낸다. 메인 프로세스 대신 같은 프로세스의 RouteDatabase(SQLite)를 부른다.
//     호출 횟수(calls), 실패 주입(failNext), 호출 전 대기(before) 훅이 있다.
//   · createStorageContext({api|indexedDB}) — coverage-grid.js + storage.js 를
//     로드한 vm 컨텍스트. api를 주면 SQLite 백엔드, 안 주면 IndexedDB 백엔드.
// ══════════════════════════════════════════════════════════
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { RouteDatabase, buildDaySummary, dedupeHistory, haversine } = require('../../electron/database.js');

const ROOT = path.join(__dirname, '..', '..');

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-ctx-'));
  return new RouteDatabase(path.join(dir, 'route-viewer.db'));
}

// preload.js 의 이름 → RouteDatabase 메서드 (stats 만 이름이 다르다)
const API_METHODS = [
  'stats', 'importRecords', 'listDateSummaries', 'getRecordsByDate', 'getOverview', 'getDensityCells',
  'getBounds', 'getVisitedCellKeys', 'getDistribution', 'getTimeBucketDistribution', 'deleteDate',
  'deleteAll', 'getZonePolygons', 'saveZonePolygons', 'listImports', 'findImportByFileHash',
  'getImportConflicts', 'listVehicles', 'saveVehicle', 'setVehicleActive', 'listZones', 'saveZone',
  'setZoneActive', 'getZoneManualCells', 'saveZoneManualCells', 'getSettings', 'setSettings',
  'getCellVisitCounts', 'getBackupHistory', 'setBackupHistory', 'buildBackupPayload',
  'restoreBackupPayload', 'rebuildAllSummaries', 'getClassificationStatus', 'reclassifySummaries',
  'saveCoverageSnapshot', 'listCoverageSnapshots', 'listRecommendationStates', 'setRecommendationState',
];

function createDesktopApi(db) {
  const calls = {};
  const failNext = {};   // name -> {times, message}
  const before = {};     // name -> async (args) => void
  const api = { isDesktop: true, calls, failNext, before };
  API_METHODS.forEach(name => {
    api[name] = async (...args) => {
      calls[name] = (calls[name] || 0) + 1;
      if (before[name]) await before[name](args);
      const f = failNext[name];
      if (f && f.times > 0) {
        f.times--;
        throw new Error(f.message || `${name} 실패(테스트 주입)`);
      }
      // IPC 를 거친 것처럼 결과를 복사해서 넘긴다(참조 공유로 테스트가 우연히 통과하지 않게)
      const res = await db[name === 'stats' ? 'getStats' : name](...args);
      return res === undefined ? res : structuredClone(res);
    };
  });
  api.info = async () => ({ version: 'test', dbPath: db.dbPath });
  api.onMenu = () => {};
  return api;
}

function baseContext(extra) {
  const store = new Map();
  const ctx = {
    console: process.env.RV_TEST_VERBOSE ? console : { log() {}, info() {}, warn() {}, error: console.error },
    setTimeout, clearTimeout, setImmediate, AbortController, structuredClone,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    haversine,
    buildDaySummaryFromPoints: (rows, classification) => buildDaySummary(rows, classification),
    dedupeBackupHistory: dedupeHistory,
    ...extra,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  return ctx;
}

function load(ctx, rel) {
  vm.runInContext(readSource(rel), ctx, { filename: rel });
}

// storage.js(RouteDB)만 로드한 컨텍스트 — 저장소 동등성 테스트용
function createStorageContext({ api, indexedDB, IDBKeyRange }) {
  const extra = {};
  if (api) extra.routeAPI = api;
  if (indexedDB) { extra.indexedDB = indexedDB; extra.IDBKeyRange = IDBKeyRange; }
  const ctx = baseContext(extra);
  load(ctx, 'src/js/coverage-grid.js');
  load(ctx, 'src/js/collection-stats.js');
  load(ctx, 'src/js/time-conditions.js');
  load(ctx, 'src/js/condition-stats.js');
  load(ctx, 'src/js/recommendation.js');
  load(ctx, 'src/js/storage.js');
  return ctx;
}

module.exports = { ROOT, readSource, freshDb, createDesktopApi, baseContext, load, createStorageContext };
