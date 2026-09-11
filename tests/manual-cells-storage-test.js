// ══════════════════════════════════════════════════════════
//  manual-cells-storage-test — 수동 셀(제외/방문/미방문) 저장 형식과
//  SQLite(데스크톱) ↔ IndexedDB(브라우저) 동등성.
//
//  두 백엔드 모두 실제 src/js/storage.js 의 RouteDB 를 통해 부른다.
//   · SQLite    : storage.js 데스크톱 백엔드 → routeAPI 흉내 → RouteDatabase
//   · IndexedDB : storage.js IndexedDB 백엔드 → tests/helpers/fake-indexeddb.js
//
//  실행:  node tests/manual-cells-storage-test.js
// ══════════════════════════════════════════════════════════
'use strict';

const { freshDb, createDesktopApi, createStorageContext } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');
const { RouteDatabase } = require('../electron/database.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(title) { console.log(`\n\x1b[36m${title}\x1b[0m`); }

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortedCells = c => ({
  excluded: [...c.excluded].map(String).sort(),
  visited: [...c.visited].map(String).sort(),
  unvisited: [...c.unvisited].map(String).sort(),
});
const EMPTY = { excluded: [], visited: [], unvisited: [] };

async function makeBackends() {
  const db = freshDb();
  const api = createDesktopApi(db);
  const sqlite = createStorageContext({ api }).RouteDB;
  const fake = createFakeIndexedDB();
  const idb = createStorageContext(fake).RouteDB;
  const k1 = await sqlite.init();
  const k2 = await idb.init();
  if (k1 !== 'sqlite' || k2 !== 'indexeddb') throw new Error(`backend kind: ${k1}/${k2}`);
  return { db, api, sqlite, idb, fake };
}

const P = {
  a: [37.5001, 127.0301], b: [37.5002, 127.0302], c: [37.5003, 127.0303],
  x: [37.51, 127.04], y: [37.52, 127.05], z: [37.53, 127.06],
};

async function main() {
  const { db, api, sqlite, idb, fake } = await makeBackends();

  section('저장 형식 {excluded, visited, unvisited}');
  check('두 저장소 모두 기본값은 세 빈 배열',
    same(await sqlite.getZoneManualCells('강남'), EMPTY) && same(await idb.getZoneManualCells('강남'), EMPTY));
  const sample = { excluded: [P.a], visited: [P.b], unvisited: [P.c] };
  await sqlite.saveZoneManualCells('강남', sample);
  await idb.saveZoneManualCells('강남', sample);
  const s1 = await sqlite.getZoneManualCells('강남');
  const i1 = await idb.getZoneManualCells('강남');
  check('SQLite 저장·조회 — unvisited 포함 세 목록이 그대로', same(s1, sample), JSON.stringify(s1));
  check('IndexedDB 저장·조회 — unvisited 포함 세 목록이 그대로', same(i1, sample), JSON.stringify(i1));
  check('SQLite와 IndexedDB 결과가 같다', same(s1, i1));
  const sz = (await sqlite.listZones()).find(z => z.name === '강남');
  const iz = (await idb.listZones()).find(z => z.name === '강남');
  check('listZones()에도 manualCells가 같은 형식으로 실린다(백업/동기화 payload용)',
    same(sz.manualCells, sample) && same(iz.manualCells, sample));
  check('판교(다른 구역)는 영향 없음',
    same(await sqlite.getZoneManualCells('판교'), EMPTY) && same(await idb.getZoneManualCells('판교'), EMPTY));

  section('구버전 데이터 호환(마이그레이션 없이)');
  db.db.run('UPDATE zones SET manual_cells=? WHERE name=?', [JSON.stringify({ excluded: [P.x], visited: [P.y] }), '판교']);
  const zoneRows = fake.rawStore('route-viewer', 'zones');
  zoneRows.set('판교', { ...zoneRows.get('판교'), manualCells: { excluded: [P.x], visited: [P.y] } });
  const legacyExpected = { excluded: [P.x], visited: [P.y], unvisited: [] };
  check('구버전 SQLite 행(excluded/visited만) → unvisited 빈 배열로 정상 로드',
    same(await sqlite.getZoneManualCells('판교'), legacyExpected));
  check('구버전 IndexedDB 행 → 같은 결과', same(await idb.getZoneManualCells('판교'), legacyExpected));
  db.db.run('UPDATE zones SET manual_cells=? WHERE name=?', ['{broken', '시흥']);
  zoneRows.set('시흥', { ...zoneRows.get('시흥'), manualCells: { excluded: 'oops', visited: [[1]] } });
  check('깨진 값은 빈 목록으로 안전하게(SQLite 깨진 JSON / IndexedDB 잘못된 모양)',
    same(await sqlite.getZoneManualCells('시흥'), EMPTY) && same(await idb.getZoneManualCells('시흥'), EMPTY));

  section('백업 생성 · 복원');
  const sp = await sqlite.buildBackupPayload();
  const ip = await idb.buildBackupPayload();
  const zoneCells = (p, name) => (p.zones.find(z => z.name === name) || {}).manualCells;
  check('SQLite 백업의 zones[]에 수동 셀(unvisited 포함)이 들어간다', same(zoneCells(sp, '강남'), sample));
  check('IndexedDB 백업에도 같은 형식으로 들어간다', same(zoneCells(ip, '강남'), sample));

  const fresh = await makeBackends();
  await fresh.sqlite.restoreBackupPayload(sp, 'merge');
  await fresh.idb.restoreBackupPayload(ip, 'merge');
  check('SQLite 백업 → 새 SQLite에 복원해도 그대로', same(await fresh.sqlite.getZoneManualCells('강남'), sample));
  check('IndexedDB 백업 → 새 IndexedDB에 복원해도 그대로', same(await fresh.idb.getZoneManualCells('강남'), sample));
  check('구버전 형식이던 구역(판교)도 복원 후 세 목록 형식',
    same(await fresh.sqlite.getZoneManualCells('판교'), legacyExpected) && same(await fresh.idb.getZoneManualCells('판교'), legacyExpected));
  const cross = await makeBackends();
  await cross.idb.restoreBackupPayload(sp, 'merge');
  await cross.sqlite.restoreBackupPayload(ip, 'merge');
  check('저장소를 바꿔 복원해도 같다(SQLite 백업→IndexedDB, IndexedDB 백업→SQLite)',
    same(await cross.idb.getZoneManualCells('강남'), sample) && same(await cross.sqlite.getZoneManualCells('강남'), sample));

  const m = await makeBackends();
  for (const r of [m.sqlite, m.idb]) await r.saveZoneManualCells('강남', { excluded: [P.z], visited: [P.x], unvisited: [] });
  const incoming = {
    type: 'route-viewer-backup', version: 3, data: {},
    zones: [{ name: '강남', color: '#ff7ab6', manualCells: { excluded: [P.y], visited: [], unvisited: [P.x] } }],
  };
  for (const r of [m.sqlite, m.idb]) await r.restoreBackupPayload(incoming, 'merge');
  const mergedExpected = sortedCells({ excluded: [P.z, P.y], visited: [], unvisited: [P.x] });
  const ms = sortedCells(await m.sqlite.getZoneManualCells('강남'));
  const mi = sortedCells(await m.idb.getZoneManualCells('강남'));
  check('병합 복원: 같은 칸은 백업 상태로 바뀌고(x: 방문→미방문) 지금만 있는 칸(z)은 유지',
    same(ms, mergedExpected), JSON.stringify(ms));
  check('… IndexedDB도 같은 결과', same(mi, mergedExpected), JSON.stringify(mi));

  const oldBackup = { type: 'route-viewer-backup', version: 3, data: {}, zones: [{ name: '강남', color: '#ff7ab6', polygon: [] }] };
  for (const r of [m.sqlite, m.idb]) await r.restoreBackupPayload(oldBackup, 'merge');
  check('manualCells가 없는 구버전 백업을 복원해도 지금 수동 셀은 그대로',
    same(sortedCells(await m.sqlite.getZoneManualCells('강남')), mergedExpected) &&
    same(sortedCells(await m.idb.getZoneManualCells('강남')), mergedExpected));
  const v2 = { type: 'route-viewer-backup', version: 2, data: { '2026-08-13': [{ date: '2026-08-13', time: '09:00:00', vehicle: '토레스 9호', lat: 37.4, lng: 127.1 }] } };
  const v2s = await m.sqlite.restoreBackupPayload(v2, 'merge');
  const v2i = await m.idb.restoreBackupPayload(v2, 'merge');
  check('zones 필드 자체가 없는 v2 백업도 두 저장소에서 정상 복원',
    v2s.inserted === 1 && v2i.inserted === 1 && same(sortedCells(await m.idb.getZoneManualCells('강남')), mergedExpected));
  const replaceIncoming = {
    type: 'route-viewer-backup', version: 3, data: {},
    zones: [{ name: '강남', color: '#ff7ab6', manualCells: { excluded: [], visited: [P.a], unvisited: [] } }],
  };
  for (const r of [m.sqlite, m.idb]) await r.restoreBackupPayload(replaceIncoming, 'replace');
  const replaced = sortedCells({ excluded: [P.z, P.y], visited: [P.a], unvisited: [P.x] });
  check('전체 교체 복원도 수동 셀은 지우지 않고 칸 단위 병합(주행 기록만 교체)',
    same(sortedCells(await m.sqlite.getZoneManualCells('강남')), replaced) &&
    same(sortedCells(await m.idb.getZoneManualCells('강남')), replaced) &&
    (await m.sqlite.stats()).points === 0 && (await m.idb.stats()).points === 0);

  section('Coverage Cell 크기 = 20m 단일 기준');
  check('설정의 coverageCellSizeM 기본값 20 (SQLite/IndexedDB)',
    (await sqlite.getSettings()).coverageCellSizeM === 20 && (await idb.getSettings()).coverageCellSizeM === 20);
  db.setMeta('app_settings', JSON.stringify({ coverageCellSizeM: 50 }));
  fake.rawStore('route-viewer', 'meta').set('app_settings', { key: 'app_settings', value: { coverageCellSizeM: 50 } });
  check('예전 버전이 저장해 둔 50이 있어도 20으로 읽힌다',
    (await sqlite.getSettings()).coverageCellSizeM === 20 && (await idb.getSettings()).coverageCellSizeM === 20);
  const tiers = [{ threshold: 0, label: '미수집', color: '#ff6b6b' }, { threshold: 3, label: '충분', color: '#5fd88a' }];
  await sqlite.setSettings({ coverageDepthTiers: tiers, coverageCellSizeM: 99 });
  await idb.setSettings({ coverageDepthTiers: tiers, coverageCellSizeM: 99 });
  const rawIdbSettings = fake.rawStore('route-viewer', 'meta').get('app_settings').value;
  check('setSettings는 Cell 크기를 저장하지 않는다(고정값) — 등급 기준은 저장',
    JSON.parse(db.getMeta('app_settings')).coverageCellSizeM === undefined && rawIdbSettings.coverageCellSizeM === undefined &&
    (await sqlite.getSettings()).coverageDepthTiers.length === 2 && (await idb.getSettings()).coverageDepthTiers.length === 2 &&
    (await idb.getSettings()).coverageCellSizeM === 20);

  const drive = [];
  for (let i = 0; i < 12; i++) {
    drive.push({ date: '2026-08-20', time: `09:00:${String(i * 5).padStart(2, '0')}`, vehicle: '토레스 1호', zone: '강남', lat: 37.5, lng: 127.03 + i * 0.00012 });
  }
  await sqlite.importRecords(drive, { filename: 'drive.xlsx' });
  await idb.importRecords(drive, { filename: 'drive.xlsx' });
  const box = { minLat: 37.49, maxLat: 37.51, minLng: 127.02, maxLng: 127.05, refLat: 37.5 };
  const sortVisits = rows => rows.map(r => `${r.gy}_${r.gx}:${r.visits}`).sort();
  const svDefault = sortVisits(await sqlite.getCellVisitCounts(box));
  const sv20 = sortVisits(await sqlite.getCellVisitCounts(box, 20));
  const ivDefault = sortVisits(await idb.getCellVisitCounts(box));
  check('getCellVisitCounts 기본 Cell 크기 = 20m', svDefault.length > 0 && same(svDefault, sv20), `${svDefault.length}칸`);
  check('같은 기록이면 SQLite와 IndexedDB 방문 횟수 결과가 같다', same(svDefault, ivDefault));

  const drive2 = drive.map(r => ({ ...r, date: '2026-08-25', lat: 37.501 }));
  await sqlite.importRecords(drive2, { filename: 'drive2.xlsx' });
  await idb.importRecords(drive2, { filename: 'drive2.xlsx' });
  const ranged = { ...box, fromDate: '2026-08-20', toDate: '2026-08-20' };
  const svRanged = sortVisits(await sqlite.getCellVisitCounts(ranged));
  const ivRanged = sortVisits(await idb.getCellVisitCounts(ranged));
  const ivAll = sortVisits(await idb.getCellVisitCounts(box));
  check('날짜 필터가 Coverage 방문 집계에 적용된다 — IndexedDB도 SQLite와 같은 결과',
    same(svRanged, ivRanged) && same(ivRanged, ivDefault) && ivAll.length > ivRanged.length,
    `기간 ${ivRanged.length}칸 / 전체 ${ivAll.length}칸`);
  const ov = f => Promise.all([sqlite.getOverview(f), idb.getOverview(f)]);
  const [so, io] = await ov({ fromDate: '2026-08-25', toDate: '2026-08-25' });
  check('날짜 범위 overview(누적 지도 통계)도 두 저장소가 같다',
    so.points === drive2.length && io.points === drive2.length && so.days === 1 && io.days === 1,
    `SQLite ${so.points} / IndexedDB ${io.points}`);

  section('RouteDB 변경 알림(onChange) — 누적 지도 캐시 무효화의 근거');
  for (const [label, r, apiRef] of [['SQLite', sqlite, api], ['IndexedDB', idb, null]]) {
    const events = [];
    const off = r.onChange(e => events.push(e.method + (e.method === 'saveZoneManualCells' ? ':' + e.args[0] : '')));
    await r.getOverview({});
    await r.importRecords([{ date: '2026-08-21', time: '10:00:00', vehicle: '토레스 2호', lat: 37.5, lng: 127.03 }], { filename: 'n.xlsx' });
    await r.saveZoneManualCells('판교', sample);
    await r.setBackupHistory([]);
    if (apiRef) {
      apiRef.failNext.deleteDate = { times: 1 };
      try { await r.deleteDate('2026-08-21'); } catch (_) { /* 실패 주입 */ }
    }
    off();
    await r.deleteAll();
    check(`${label}: 데이터를 바꾸는 호출만, 성공했을 때만 알린다`,
      events.join() === 'importRecords,saveZoneManualCells:판교', events.join());
  }

  section('기존 마이그레이션과의 호환');
  const dbS = freshDb();
  dbS.saveZone({ name: '서초', color: '#c084fc', centerLat: 37.4837, centerLng: 127.0324, active: true });
  dbS.saveZoneManualCells('서초', { unvisited: [P.a] });
  dbS.setMeta('seocho_default_removed', '');
  const seochoPath = dbS.dbPath;
  dbS.close();
  const dbS2 = new RouteDatabase(seochoPath);
  check('수동 미방문 셀만 있는 서초 구역도 "사용자 데이터 있음"으로 보고 지우지 않는다',
    !!dbS2.listZones().find(z => z.name === '서초'));
  dbS2.close();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failed) {
    console.log('\n  실패 항목:');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log(`${'─'.repeat(60)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
