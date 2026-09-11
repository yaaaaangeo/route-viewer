// ══════════════════════════════════════════════════════════
//  accum-date-filter-test — 누적 지도 날짜 필터가 밀도 지도·통계·Coverage에
//  같은 범위로 적용되는지, 캐시·비동기 보호가 날짜와 맞물려 동작하는지.
//
//  테스트 데이터(판교 경계 안, 가운데 도로 위):
//    2026-09-01  서쪽 구간 10점 (lng 127.1125 → 127.1145)
//    2026-09-03  동쪽 구간 10점 (lng 127.1155 → 127.1175)
//    2026-09-05  서쪽 구간 10점 (09-01과 같은 칸 — 전체 기간이면 방문 2회)
//    날짜미상    1점 (lat 37.3860, 도로에서 떨어진 곳)
//
//  A. 실제 accum.js + storage.js + SQLite (tests/helpers/accum-harness.js)
//  B. SQLite ↔ IndexedDB 조회 결과 동등성 (fake IndexedDB)
//
//  실행:  node tests/accum-date-filter-test.js
// ══════════════════════════════════════════════════════════
'use strict';

const { createAccumHarness, ZONES } = require('./helpers/accum-harness');
const { freshDb, createDesktopApi, createStorageContext } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(title) { console.log(`\n\x1b[36m${title}\x1b[0m`); }

function timeOf(i) {
  const s = i * 10;
  return `09:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function drive(date, startLng) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    pts.push({ date, time: timeOf(i), vehicle: '토레스 1호', zone: '판교', lat: 37.3850, lng: startLng + i * 0.000226 });
  }
  return pts;
}
const RECORDS = [
  ...drive('2026-09-01', 127.1125),
  ...drive('2026-09-03', 127.1155),
  ...drive('2026-09-05', 127.1125),
  { date: '', time: '10:00:00', vehicle: '토레스 2호', zone: '판교', lat: 37.3860, lng: 127.1170 }, // 날짜미상
];
const WEST_MAX_LNG = 127.1150; // 서쪽 구간은 모두 이보다 서쪽, 동쪽 구간은 모두 동쪽
const UNDATED_LAT = 37.3857;   // 이보다 북쪽 칸은 날짜미상 기록뿐

async function createScene() {
  const h = await createAccumHarness();
  await h.eval(`RouteDB.saveZonePolygons(${JSON.stringify(ZONES)})`);
  await h.eval(`RouteDB.importRecords(${JSON.stringify(RECORDS)},{filename:'date-filter.xlsx'})`);
  await h.eval('loadZonePolygonsFromDb()');
  await h.eval('refreshZoneCache()');
  await h.eval('refreshSettingsCache()');
  h.eval("accumZoneFilter='판교'; showCoverageGaps=false;");
  await h.eval('enterAccumView()');
  return h;
}

const statNumber = (html, label) => Number((html.match(new RegExp(label + '</div><div class="v">(\\d+)')) || [])[1]);

function densityState(h) {
  const cells = h.eval('accumCells.map(c=>({lat:c.lat,lng:c.lng,n:c.n}))');
  const html = h.el('accum-stats').innerHTML;
  return {
    cells: cells.length,
    points: statNumber(html, '총 기록 지점'),
    days: statNumber(html, '누적 일수'),
    minLng: Math.min(...cells.map(c => c.lng)),
    maxLng: Math.max(...cells.map(c => c.lng)),
    maxLat: Math.max(...cells.map(c => c.lat)),
    cellPoints: cells.reduce((s, c) => s + c.n, 0),
    label: h.el('accum-date-label').textContent,
    bounds: h.stats.lastFitBounds && h.stats.lastFitBounds.ll,
  };
}

async function applyRange(h, from, to) {
  h.eval(`setAccumDateRange(${JSON.stringify(from)},${JSON.stringify(to)})`);
  const ok = await h.waitRendered();
  if (!ok) throw new Error('render did not settle for ' + from + '~' + to);
}

async function coverageState(h) {
  const r = await h.eval("calculateCoverage('판교')");
  const sum = h.eval('summarizeCoverage')(r, h.eval('depthTiers'));
  const { latDeg, lngDeg } = r.grid;
  const visited = r.cells.filter(c => c.state === 'valid' && c.visits > 0);
  return {
    r, sum,
    visitedKeys: visited.map(c => c.key).sort(),
    visitedLngs: visited.map(c => (c.lo + 0.5) * lngDeg),
    visitsByKey: new Map(r.cells.map(c => [c.key, c.visits])),
    latDeg,
  };
}

async function harnessTests() {
  const h = await createScene();

  section('A-1. 밀도 지도 모드 — 날짜 범위별 지도·통계');
  const all = densityState(h);
  check('전체 기간: 기록 31개(날짜미상 포함)·누적 일수 4', all.points === 31 && all.days === 4 && all.cellPoints === 31,
    `points=${all.points} days=${all.days} cells=${all.cells}`);
  check('전체 기간: 라벨 "표시 기간: 전체 기간"', all.label === '표시 기간: 전체 기간', all.label);

  await applyRange(h, '2026-09-01', '2026-09-01');
  const d1 = densityState(h);
  check('하루(2026-09-01) 선택 → 결과가 전체와 다르다', d1.points !== all.points && d1.cells !== all.cells,
    `전체 ${all.points}점/${all.cells}칸 → ${d1.points}점/${d1.cells}칸`);
  check('하루 선택 → 그 날짜 기록(10점)만, 누적 일수 1', d1.points === 10 && d1.days === 1 && d1.cellPoints === 10);
  check('하루 선택 → 지도 Cell이 모두 09-01 주행(서쪽 구간) 위에만 있다', d1.maxLng < WEST_MAX_LNG, `maxLng=${d1.maxLng.toFixed(5)}`);
  check('하루 선택 → 지도 화면 맞춤 범위도 그 날짜 기준', d1.bounds && d1.bounds[1][1] < WEST_MAX_LNG, JSON.stringify(d1.bounds));
  check('라벨 "표시 기간: 2026-09-01"', d1.label === '표시 기간: 2026-09-01', d1.label);

  await applyRange(h, '2026-09-01', '2026-09-03');
  const r13 = densityState(h);
  check('기간 선택 → 시작일·종료일 모두 포함(09-01 + 09-03 = 20점, 2일)', r13.points === 20 && r13.days === 2 && r13.minLng < WEST_MAX_LNG && r13.maxLng > WEST_MAX_LNG);
  check('라벨 "표시 기간: 2026-09-01 ~ 2026-09-03"', r13.label === '표시 기간: 2026-09-01 ~ 2026-09-03', r13.label);

  await applyRange(h, '2026-09-03', '');
  const from3 = densityState(h);
  check('시작일만 → 시작일부터 최신까지(09-03 + 09-05 = 20점)', from3.points === 20 && from3.days === 2);
  check('시작일만 → 날짜미상 기록은 끼지 않는다', from3.maxLat < UNDATED_LAT, `maxLat=${from3.maxLat.toFixed(5)}`);
  check('라벨 "표시 기간: 2026-09-03 ~ (최신)"', from3.label === '표시 기간: 2026-09-03 ~ (최신)', from3.label);

  await applyRange(h, '', '2026-09-03');
  const to3 = densityState(h);
  check('종료일만 → 처음부터 종료일까지(09-01 + 09-03 = 20점)', to3.points === 20 && to3.days === 2 && to3.maxLat < UNDATED_LAT);
  check('라벨 "표시 기간: (처음) ~ 2026-09-03"', to3.label === '표시 기간: (처음) ~ 2026-09-03', to3.label);

  h.eval('clearAccumDateFilter()');
  await h.waitRendered();
  const cleared = densityState(h);
  check('날짜 초기화 → 전체 기간 복원(31점·4일)', cleared.points === 31 && cleared.days === 4 && cleared.cells === all.cells && cleared.label === '표시 기간: 전체 기간');
  check('날짜 초기화 → 날짜칸도 비워진다', h.el('accum-date-from').value === '' && h.el('accum-date-to').value === '');

  section('A-2. 날짜 입력칸 · 정규화');
  // 날짜칸 change는 입력 도중에도 여러 번 온다(24일 → "2"를 친 순간 2일) — 마지막 값만 한 번 적용
  const rendersBeforeTyping = h.eval('coverageStats.renders');
  for (const d of ['2026-09-02', '2026-09-03']) {
    h.el('accum-date-from').value = d;
    h.el('accum-date-to').value = d;
    h.eval('onAccumDateInputChange()');
    await h.sleep(50);
    h.eval("onAccumDateInputKeydown({key:'1'})");
  }
  check('날짜칸 change가 연달아 와도 입력 도중에는 다시 계산하지 않는다(debounce)',
    h.eval('coverageStats.renders') === rendersBeforeTyping && h.eval('accumDateFrom') === '');
  await h.sleep(750);
  await h.waitRendered();
  check('… 입력이 멈추면 마지막 값으로 한 번만 적용', h.eval('coverageStats.renders') === rendersBeforeTyping + 1,
    `렌더 ${h.eval('coverageStats.renders') - rendersBeforeTyping}회`);
  h.el('accum-date-to').value = '2026-09-05';
  h.eval('onAccumDateInputChange()');
  h.eval("onAccumDateInputKeydown({key:'Enter'})");
  check('Enter는 기다리지 않고 바로 적용', h.eval('accumDateTo') === '2026-09-05');
  await h.waitRendered();
  h.el('accum-date-to').value = '2026-09-03';
  h.eval('applyAccumDateInputs()');
  await h.waitRendered();
  check('날짜칸 change → accumDateFrom/To에 저장되고 적용된다',
    h.eval('accumDateFrom') === '2026-09-03' && h.eval('accumDateTo') === '2026-09-03' && densityState(h).points === 10);
  check('accumFilter()/accumDateFilter()가 현재 날짜를 돌려준다',
    JSON.stringify(h.eval('accumFilter()')) === JSON.stringify({ zone: '판교', fromDate: '2026-09-03', toDate: '2026-09-03' }) &&
    JSON.stringify(h.eval('accumDateFilter()')) === JSON.stringify({ fromDate: '2026-09-03', toDate: '2026-09-03' }));
  h.el('accum-date-from').validity = { badInput: true }; // 연도만 치다 만 상태
  h.el('accum-date-from').value = '';
  h.el('accum-date-to').value = '2026-09-05';
  h.eval('applyAccumDateInputs()');
  await h.waitRendered();
  check('덜 입력된 날짜칸은 적용하지 않고(기존 시작일 유지) 나머지만 적용 + 안내',
    h.eval('accumDateFrom') === '2026-09-03' && h.eval('accumDateTo') === '2026-09-05' &&
    /끝까지 입력/.test(h.el('accum-date-notice').textContent), h.el('accum-date-notice').textContent);
  delete h.el('accum-date-from').validity;
  h.eval("setAccumDateRange('2026-09-05','2026-09-01')");
  await h.waitRendered();
  check('시작일 > 종료일이면 자동으로 바꿔 적용하고 안내한다',
    h.eval('accumDateFrom') === '2026-09-01' && h.eval('accumDateTo') === '2026-09-05' && /바꿔/.test(h.el('accum-date-notice').textContent));
  check('없는 날짜(2026-02-30)·6자리 연도는 무시(해당 끝 제한 없음)',
    h.eval("normalizeAccumDate('2026-02-30')") === '' && h.eval("normalizeAccumDate('202609-01-01')") === '' && h.eval("normalizeAccumDate('2026-09-01')") === '2026-09-01');

  section('A-3. Coverage Map 모드 — 방문 Cell · % · Depth');
  h.eval('clearAccumDateFilter()');
  await h.waitRendered();
  h.eval('showCoverageGaps=true');
  await h.eval('renderAccumView()');
  const cAll = await coverageState(h);
  await applyRange(h, '2026-09-01', '2026-09-01');
  const cD1 = await coverageState(h);
  await applyRange(h, '2026-09-03', '2026-09-03');
  const cD3 = await coverageState(h);
  await applyRange(h, '2026-09-01', '2026-09-03');
  const cR = await coverageState(h);
  check('전체 기간 방문 Cell과 하루 선택 방문 Cell이 다르다',
    cD1.visitedKeys.length > 0 && cD1.visitedKeys.length < cAll.visitedKeys.length,
    `전체 ${cAll.visitedKeys.length}칸 / 09-01 ${cD1.visitedKeys.length}칸 / 09-03 ${cD3.visitedKeys.length}칸`);
  check('09-01만 → 방문 Cell이 모두 서쪽 구간(그 날 주행)', cD1.visitedLngs.every(l => l < WEST_MAX_LNG));
  check('09-03만 → 방문 Cell이 모두 동쪽 구간(GPS 보간 칸 포함)', cD3.visitedLngs.every(l => l > WEST_MAX_LNG - 0.0003) && cD3.visitedKeys.length > 0);
  check('09-01~09-03 → 방문 Cell = 09-01 ∪ 09-03 (양 끝 포함)',
    JSON.stringify(cR.visitedKeys) === JSON.stringify([...new Set([...cD1.visitedKeys, ...cD3.visitedKeys])].sort()));
  check('Coverage %가 선택 기간 기준으로 바뀐다',
    cAll.sum.coveragePct > cD1.sum.coveragePct && cAll.sum.total === cD1.sum.total,
    `전체 ${cAll.sum.coveragePct.toFixed(1)}% → 09-01 ${cD1.sum.coveragePct.toFixed(1)}% (유효 Cell ${cAll.sum.total}칸 동일)`);
  const westKey = cD1.visitedKeys[Math.floor(cD1.visitedKeys.length / 2)];
  check('방문 횟수·Depth: 서쪽 칸은 전체 기간 2회(09-01+09-05) → 09-01만 1회',
    cAll.visitsByKey.get(westKey) === 2 && cD1.visitsByKey.get(westKey) === 1,
    `${cAll.visitsByKey.get(westKey)}회 → ${cD1.visitsByKey.get(westKey)}회`);
  check('Depth 등급 분포도 기간별로 다르다(보통 등급: 전체 >0, 09-01 0)',
    (cAll.sum.tierCounts['보통'] || 0) > 0 && !(cD1.sum.tierCounts['보통'] || 0), JSON.stringify([cAll.sum.tierCounts, cD1.sum.tierCounts]));
  await applyRange(h, '2026-09-01', '2026-09-01');
  check('빨간 미방문 칸 수 = 선택 기간의 미방문 Cell 수', h.eval('coverageCellLayers.size') === cD1.sum.unvisited, `${h.eval('coverageCellLayers.size')}칸`);
  check('상세 패널의 방문/미방문 Cell도 선택 기간 기준',
    h.el('coverage-detail').innerHTML.includes(`방문 Cell <b>${cD1.sum.visited}</b>`) &&
    h.el('coverage-detail').innerHTML.includes(`미방문 Cell <b>${cD1.sum.unvisited}</b>`));

  section('A-4. 캐시 키 · 무효화 · 재사용');
  const keyD1 = JSON.parse(h.eval("coverageCalcKey('판교')"));
  h.eval("accumDateFrom=''; accumDateTo='';");
  const keyAll = JSON.parse(h.eval("coverageCalcKey('판교')"));
  h.eval("accumDateFrom='2026-09-01'; accumDateTo='2026-09-01';");
  check('Coverage 캐시 키에 정규화된 날짜가 들어 있다', keyD1.dateFrom === '2026-09-01' && keyD1.dateTo === '2026-09-01' && keyAll.dateFrom === '' && keyAll.dateTo === '');
  check('"전체 기간"과 "09-01"은 다른 캐시 키', JSON.stringify(keyAll) !== JSON.stringify(keyD1));
  check('정적 Geometry 키에는 날짜가 없다',
    !/2026-09-01/.test(h.eval("coverageGeometryKey('판교')")));

  let calc = h.calcCount();
  let geoBuilds = h.eval('coverageStats.geometryBuilds');
  const geoHits = h.eval('coverageStats.geometryHits');
  await applyRange(h, '2026-09-05', '2026-09-05');
  check('새 날짜 → 동적 결과(방문 집계)만 다시 계산', h.calcCount() === calc + 1);
  check('… 정적 Geometry(도로·건물 제외·gap healing)는 재사용(다시 만들지 않음)',
    h.eval('coverageStats.geometryBuilds') === geoBuilds && h.eval('coverageStats.geometryHits') > geoHits);
  calc = h.calcCount();
  const renders = h.eval('coverageStats.renders');
  check('같은 날짜를 다시 적용하면 아무것도 다시 계산·렌더하지 않는다',
    h.eval("setAccumDateRange('2026-09-05','2026-09-05')") === false && h.calcCount() === calc && h.eval('coverageStats.renders') === renders);
  await h.sleep(90);
  const layersBefore = h.eval('coverageLayer.getLayers()');
  h.eval("switchTab('stats')");
  h.eval("switchTab('accum')");
  await h.sleep(90);
  check('날짜가 걸린 상태에서 탭 왕복 → 재계산·재렌더 없음',
    h.calcCount() === calc && h.eval('coverageStats.renders') === renders && h.eval('coverageLayer.getLayers()').every((l, i) => l === layersBefore[i]));
  await applyRange(h, '2026-09-01', '2026-09-01');
  check('이전에 본 날짜 범위로 돌아가면 캐시 재사용', h.calcCount() === calc);
  geoBuilds = h.eval('coverageStats.geometryBuilds');
  await h.eval(`RouteDB.importRecords(${JSON.stringify(drive('2026-09-01', 127.1160))},{filename:'more.xlsx'})`);
  h.eval("switchTab('stats')"); h.eval("switchTab('accum')");
  await h.waitRendered();
  check('기록 import → 날짜별 동적 캐시 무효화 후 재계산, Geometry는 그대로',
    h.calcCount() === calc + 1 && h.eval('coverageStats.geometryBuilds') === geoBuilds);

  section('A-5. 늦게 끝난 이전 계산이 새 날짜 결과를 덮지 않는다');
  // Coverage: 전체 기간 계산을 gate에 묶어 두고 그 사이 09-03을 선택
  h.eval("invalidateCoverage('test')");
  let release;
  let gate = new Promise(r => { release = r; });
  h.api.before.getCellVisitCounts = async ([box]) => { if (!box.fromDate && !box.toDate) await gate; };
  h.eval('clearAccumDateFilter()');           // 전체 기간 렌더 — 방문 집계에서 멈춤
  await h.sleep(40);
  await applyRange(h, '2026-09-03', '2026-09-03');
  release();
  await h.sleep(60);
  delete h.api.before.getCellVisitCounts;
  const latest = await coverageState(h);
  check('Coverage: 최종 화면은 09-03 결과(늦게 끝난 전체 기간 결과로 덮이지 않음)',
    h.eval('accumDateFrom') === '2026-09-03' && h.eval('coverageCacheKey===accumViewKey()') &&
    h.el('coverage-detail').innerHTML.includes(`방문 Cell <b>${latest.sum.visited}</b>`) &&
    latest.visitedLngs.every(l => l > WEST_MAX_LNG - 0.0003) && h.eval('coverageCellLayers.size') === latest.sum.unvisited,
    `방문 ${latest.sum.visited}칸`);
  // 밀도 지도: 전체 기간 밀도 조회를 gate에 묶어 두고 그 사이 09-01을 선택
  h.eval('showCoverageGaps=false');
  await applyRange(h, '2026-09-05', '2026-09-05');
  gate = new Promise(r => { release = r; });
  h.api.before.getDensityCells = async ([filter]) => { if (!filter.fromDate && !filter.toDate) await gate; };
  h.eval('clearAccumDateFilter()');
  await h.sleep(40);
  await applyRange(h, '2026-09-01', '2026-09-01');
  release();
  await h.sleep(60);
  delete h.api.before.getDensityCells;
  const dLatest = densityState(h);
  check('밀도 지도: 최종 화면은 09-01 결과(20점: 기존 10 + import 10)',
    h.eval('accumDateFrom') === '2026-09-01' && dLatest.points === 20 && dLatest.cellPoints === 20 && dLatest.label === '표시 기간: 2026-09-01',
    `points=${dLatest.points} cells=${dLatest.cells}`);
}

async function parityTests() {
  section('B. SQLite ↔ IndexedDB — 같은 날짜 조건이면 같은 결과');
  const sqlite = createStorageContext({ api: createDesktopApi(freshDb()) }).RouteDB;
  const idb = createStorageContext(createFakeIndexedDB()).RouteDB;
  await sqlite.init();
  await idb.init();
  await sqlite.importRecords(RECORDS, { filename: 'date-filter.xlsx' });
  await idb.importRecords(RECORDS, { filename: 'date-filter.xlsx' });
  const box = { minLat: 37.383, maxLat: 37.387, minLng: 127.112, maxLng: 127.118, refLat: 37.385 };
  const cases = [
    ['전체 기간', {}, 31],
    ['하루 09-01', { fromDate: '2026-09-01', toDate: '2026-09-01' }, 10],
    ['기간 09-01~09-03', { fromDate: '2026-09-01', toDate: '2026-09-03' }, 20],
    ['시작일만 09-03', { fromDate: '2026-09-03' }, 20],
    ['종료일만 09-03', { toDate: '2026-09-03' }, 20],
  ];
  const densityKey = cells => cells.map(c => `${c.lat.toFixed(6)},${c.lng.toFixed(6)},${c.n},${c.dateCount}`).sort().join('|');
  const visitKey = rows => rows.map(r => `${r.gy}_${r.gx}:${r.visits}`).sort().join('|');
  const boundsKey = b => (b ? [b.minLat, b.maxLat, b.minLng, b.maxLng].map(n => n.toFixed(6)).join(',') + ':' + b.count : 'null');
  for (const [label, filter, expected] of cases) {
    const [so, io] = await Promise.all([sqlite.getOverview(filter), idb.getOverview(filter)]);
    const [sd, id] = await Promise.all([sqlite.getDensityCells(filter, 0.0007), idb.getDensityCells(filter, 0.0007)]);
    const [sb, ib] = await Promise.all([sqlite.getBounds(filter), idb.getBounds(filter)]);
    const [sv, iv] = await Promise.all([sqlite.getCellVisitCounts({ ...box, ...filter }, 20), idb.getCellVisitCounts({ ...box, ...filter }, 20)]);
    check(`${label}: 기록 수 ${expected} — SQLite·IndexedDB 동일(overview/밀도/범위/방문 집계)`,
      so.points === expected && io.points === expected && so.days === io.days &&
      densityKey(sd) === densityKey(id) && boundsKey(sb) === boundsKey(ib) && visitKey(sv) === visitKey(iv) && sv.length > 0,
      `SQLite ${so.points}점·${sd.length}칸·방문 ${sv.length}칸 / IndexedDB ${io.points}점·${id.length}칸·방문 ${iv.length}칸`);
  }
  const fromOnly = { fromDate: '2026-09-03' };
  const [sdf, idf] = await Promise.all([sqlite.getDensityCells(fromOnly, 0.0007), idb.getDensityCells(fromOnly, 0.0007)]);
  check('시작일만 조건에 날짜미상 기록이 끼지 않는다(두 저장소 모두)',
    sdf.every(c => c.lat < UNDATED_LAT) && idf.every(c => c.lat < UNDATED_LAT) &&
    (await sqlite.getOverview({})).days === 4);
}

async function main() {
  await harnessTests();
  await parityTests();
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
