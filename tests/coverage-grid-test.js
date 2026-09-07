// ══════════════════════════════════════════════════════════
//  coverage-grid-test.js — GPS 연속 좌표 사이 이동 segment를 Coverage
//  격자 칸으로 바꾸는 로직(src/js/coverage-grid.js) 검증.
//
//  Test 1~7은 CoverageGrid의 순수 함수(traverseCells/
//  accumulatePartitionVisits)를 직접 테스트한다(파티션 하나 = 같은
//  date+vehicle을 이미 전제한 상태).
//  Test 8~9는 실제 RouteDatabase(electron/database.js, 진짜 SQLite)를
//  통해 date/vehicle 경계에서 파티션이 실제로 분리되는지 end-to-end로
//  검증한다 — 파티션 나누기는 database.js/storage.js의 책임이라, 여기서만
//  진짜로 검증할 수 있다.
//
//  실행:  node tests/coverage-grid-test.js
// ══════════════════════════════════════════════════════════
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const CoverageGrid = require('../src/js/coverage-grid.js');
const { RouteDatabase } = require('../electron/database.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(title) { console.log(`\n\x1b[36m${title}\x1b[0m`); }

const REF_LAT = 37.5;
const GAP_CELL_SIZE_M = 20; // accum.js의 실제 커버리지 격자 크기와 동일
const mLat = 111320, mLng = 111320 * Math.cos(REF_LAT * Math.PI / 180);
const latDeg = GAP_CELL_SIZE_M / 111320;
const lngDeg = GAP_CELL_SIZE_M / (111320 * Math.cos(REF_LAT * Math.PI / 180));
const ORIGIN = [REF_LAT, 127.0];

// (eastM, northM) 오프셋 → [lat,lng]. accum.js 테스트들과 같은 근사.
function pt(eastM, northM) {
  return [ORIGIN[0] + northM / mLat, ORIGIN[1] + eastM / mLng];
}
function cellKey(eastM, northM) {
  const [lat, lng] = pt(eastM, northM);
  return Math.floor(lat / latDeg) + '_' + Math.floor(lng / lngDeg);
}
function ts(baseSec, offsetSec) {
  const t = baseSec + offsetSec;
  const h = String(Math.floor(t / 3600)).padStart(2, '0');
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(t % 60)).padStart(2, '0');
  return `2026-08-20T${h}:${m}:${s}`;
}
function gpsPoint(eastM, northM, tOffsetSec) {
  const [lat, lng] = pt(eastM, northM);
  return { lat, lng, timestamp: ts(9 * 3600, tOffsetSec) };
}

function main() {
  section('Test 1 — 같은 셀 (P0→P1 둘 다 A 셀)');
  {
    const visits = new Map();
    const points = [gpsPoint(0, 0, 0), gpsPoint(3, 2, 10)]; // 20m 셀 안에서 살짝만 이동
    CoverageGrid.accumulatePartitionVisits(points, latDeg, lngDeg, visits);
    check('같은 셀 안 왕복은 방문 1회', visits.size === 1 && visits.get(cellKey(0, 0)) === 1,
      JSON.stringify([...visits]));
  }

  section('Test 2 — 직선으로 여러 셀 통과 (GPS는 시작/끝 2개뿐)');
  {
    // 동쪽으로 100m 직선 이동, 20m 셀이면 최소 5개 칸(A~E)을 지나가야 한다.
    // 10초 간격, 100m/10s*3.6=36km/h — 임계값 이내.
    const visits = new Map();
    const points = [gpsPoint(0, 0, 0), gpsPoint(100, 0, 10)];
    CoverageGrid.accumulatePartitionVisits(points, latDeg, lngDeg, visits);
    const expectedCells = [0, 20, 40, 60, 80, 100].map(e => cellKey(e, 0));
    const uniqueExpected = [...new Set(expectedCells)];
    check('중간 칸이 전부 방문 처리된다(GPS 2개뿐이어도)',
      uniqueExpected.every(k => visits.get(k) === 1) && visits.size === uniqueExpected.length,
      `기대 ${uniqueExpected.length}칸, 실제 ${visits.size}칸`);
  }

  section('Test 3 — 대각선 (grid traversal이 칸을 안 놓치는지)');
  {
    // 3a. 일반적인(격자 꼭짓점을 정확히 지나지 않는) 대각선 — 표준 DDA라면
    // 결과 순서상 이웃한 칸끼리 항상 변을 공유해야 한다(구멍 없음의 증거).
    const [a3lat, a3lng] = pt(0, 0), [b3lat, b3lng] = pt(53, 41); // 동53m·북41m, 여러 칸을 대각선으로 통과
    const cells = CoverageGrid.traverseCells(a3lat, a3lng, b3lat, b3lng, latDeg, lngDeg);
    let allAdjacent = true;
    for (let i = 1; i < cells.length; i++) {
      const dGy = Math.abs(cells[i].gy - cells[i - 1].gy);
      const dGx = Math.abs(cells[i].gx - cells[i - 1].gx);
      if (dGy + dGx !== 1) { allAdjacent = false; break; }
    }
    check('일반 대각선: 연속한 칸끼리 항상 변을 공유(구멍 없음)', allAdjacent && cells.length > 1,
      `${cells.length}칸`);

    // 3b. 격자 꼭짓점을 정확히 지나는 경우(공급) — supercover로 모서리만
    // 스치는 두 칸까지 포함해야 한다. (0,0)->(2,2) 정규화 좌표로 구성.
    const tieCells = CoverageGrid.traverseCells(0, 0, 2 * latDeg, 2 * lngDeg, latDeg, lngDeg);
    const tieKeys = new Set(tieCells.map(c => c.gy + '_' + c.gx));
    const expectedTie = ['0_0', '1_0', '0_1', '1_1', '2_1', '1_2', '2_2'];
    check('정확히 격자 꼭짓점을 지나가도 모서리로만 이어지는 칸까지 전부 포함(구멍 없음)',
      expectedTie.every(k => tieKeys.has(k)), `${[...tieKeys].join(',')}`);
  }

  section('Test 4 — 연속 segment 경계에서 중복 카운트 안 됨');
  {
    // P0→P1→P2, P0→P1의 마지막 칸과 P1→P2의 첫 칸이 같은 셀(P1 자신의 칸)
    const visits = new Map();
    const points = [gpsPoint(0, 0, 0), gpsPoint(50, 0, 5), gpsPoint(100, 0, 10)];
    CoverageGrid.accumulatePartitionVisits(points, latDeg, lngDeg, visits);
    const p1Cell = cellKey(50, 0);
    check('P1 자신의 칸이 segment 경계라는 이유만으로 2회로 안 잡힌다',
      visits.get(p1Cell) === 1, `visits=${visits.get(p1Cell)}`);
  }

  section('Test 5 — 재방문 (A→B→C→B)');
  {
    const visits = new Map();
    // 서로 다른 3개 칸을 왕복 — 같은 칸을 다시 들어오면 새 방문
    const points = [
      gpsPoint(0, 0, 0),     // A
      gpsPoint(25, 0, 5),    // B (다음 칸)
      gpsPoint(50, 0, 10),   // C (다음 칸)
      gpsPoint(25, 0, 15),   // B로 복귀
    ];
    CoverageGrid.accumulatePartitionVisits(points, latDeg, lngDeg, visits);
    const A = cellKey(0, 0), B = cellKey(25, 0), C = cellKey(50, 0);
    check('A=1, C=1, B=2(재방문)',
      visits.get(A) === 1 && visits.get(C) === 1 && visits.get(B) === 2,
      `A=${visits.get(A)} B=${visits.get(B)} C=${visits.get(C)}`);
  }

  section('Test 6 — 큰 시간 gap(기록 유실) — 사이를 잇지 않는다');
  {
    const visits = new Map();
    // 14:00:00 ~ 14:10:00, 600초 간격 — MAX_INTERPOLATION_GAP_SEC(30초) 초과.
    // 거리는 충분히 멀리(300m) 둬서, 이었으면 여러 칸이 새로 생겼을 상황을 만든다.
    const p0 = { lat: pt(0, 0)[0], lng: pt(0, 0)[1], timestamp: '2026-08-20T14:00:00' };
    const p1 = { lat: pt(300, 0)[0], lng: pt(300, 0)[1], timestamp: '2026-08-20T14:10:00' };
    CoverageGrid.accumulatePartitionVisits([p0, p1], latDeg, lngDeg, visits);
    check('두 점 자신의 칸(2개)만 방문 — 사이 수백 m는 방문 처리 안 함',
      visits.size === 2, `visits.size=${visits.size}`);
    check('시간 gap이 커도 P0/P1 자신의 칸은 사라지지 않는다',
      visits.get(cellKey(0, 0)) === 1 && visits.get(cellKey(300, 0)) === 1);
  }

  section('Test 7 — 비정상 GPS 점프(속도 초과) — interpolation 안 함');
  {
    const visits = new Map();
    // 5초 안에 500m 이동 = 360km/h > MAX_INTERPOLATION_SPEED_KMH(150km/h)
    const p0 = gpsPoint(0, 0, 0);
    const p1 = gpsPoint(500, 0, 5);
    CoverageGrid.accumulatePartitionVisits([p0, p1], latDeg, lngDeg, visits);
    check('속도 초과 시 두 점 사이를 잇지 않는다(자기 칸만 방문)',
      visits.size === 2, `visits.size=${visits.size}`);
  }

  // ── Test 8, 9 — 실제 RouteDatabase로 파티션(date/vehicle) 경계 검증 ──
  function freshDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-coverage-grid-test-'));
    return path.join(dir, 'route-viewer.db');
  }
  function rec(date, time, vehicle, eastM, northM) {
    const [lat, lng] = pt(eastM, northM);
    return { date, time, vehicle, lat, lng };
  }

  section('Test 8 — 날짜가 바뀌면 절대 연결하지 않는다');
  {
    const db = new RouteDatabase(freshDbPath());
    // 08-01 마지막 기록과 08-02 첫 기록이 시간상 몇 초 차이(자정 근처)이고
    // 거리도 멀지만(200m), 날짜가 다르므로 절대 이어지면 안 된다.
    db.importRecords([
      rec('2026-08-01', '23:59:55', '토레스 1호', 0, 0),
      rec('2026-08-02', '00:00:05', '토레스 1호', 200, 0),
    ], { filename: 'date-boundary-test.xlsx' });
    const box = { minLat: 37.49, maxLat: 37.51, minLng: 126.99, maxLng: 127.01, refLat: REF_LAT, lngDeg };
    const visits = db.getCellVisitCounts(box, GAP_CELL_SIZE_M);
    const totalVisitedCells = visits.length;
    check('날짜가 다르면(자정을 사이에 두고 시간차가 작아도) 중간 칸이 안 생긴다',
      totalVisitedCells === 2, `${totalVisitedCells}칸 방문 — ${JSON.stringify(visits)}`);
    db.close();
  }

  section('Test 9 — 차량이 바뀌면 절대 연결하지 않는다');
  {
    const db = new RouteDatabase(freshDbPath());
    // 같은 날짜, 같은 시각에 가까운데 차량이 다름 — 절대 이어지면 안 된다.
    db.importRecords([
      rec('2026-08-20', '09:00:00', '토레스 1호', 0, 0),
      rec('2026-08-20', '09:00:05', '토레스 2호', 200, 0),
    ], { filename: 'vehicle-boundary-test.xlsx' });
    const box = { minLat: 37.49, maxLat: 37.51, minLng: 126.99, maxLng: 127.01, refLat: REF_LAT, lngDeg };
    const visits = db.getCellVisitCounts(box, GAP_CELL_SIZE_M);
    check('차량이 다르면 중간 칸이 안 생긴다',
      visits.length === 2, `${visits.length}칸 방문 — ${JSON.stringify(visits)}`);
    db.close();
  }

  section('대표 예시 — 10초 간격 GPS 2개, 120m 이동, 20m grid');
  {
    const visits = new Map();
    const points = [gpsPoint(0, 0, 0), gpsPoint(120, 0, 10)];
    CoverageGrid.accumulatePartitionVisits(points, latDeg, lngDeg, visits);
    console.log(`  기존 방식이면 2개 셀만 방문 처리됐을 상황 → 실제로는 ${visits.size}개 셀 방문 처리됨`);
    check('120m/10s 이동이 시작/끝 2칸이 아니라 그 사이 전부를 방문 처리한다',
      visits.size >= 6, `${visits.size}칸`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failed) {
    console.log('\n  실패 항목:');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log(`${'─'.repeat(60)}\n`);
  process.exit(failed ? 1 : 0);
}

main();
