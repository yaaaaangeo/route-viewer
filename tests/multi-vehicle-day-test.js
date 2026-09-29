// ══════════════════════════════════════════════════════════
//  multi-vehicle-day-test — 하루에 차량 두 대가 달린 날의 회귀 테스트
//
//  하루치 기록은 시간순으로만 정렬돼 온다(getRecordsByDate). 두 대가 같이 달리면
//  강남에 있던 1호차와 판교에 있던 2호차의 좌표가 배열에서 번갈아 섞인다.
//  예전에는 그걸 그대로 앞뒤로 이어서 거리·GPS 공백·GPS 점프를 셌기 때문에,
//  차량이 바뀌는 자리마다 "0초 만에 14km 이동"이 되어
//    · 멀쩡한 기록 대부분이 '좌표 점프 의심'으로 빨갛게 찍히고(리플레이 지도)
//    · 총 이동거리에 두 차량 사이 직선거리가 계속 얹혔다.
//  이제는 SQLite·IndexedDB 양쪽 모두 차량별로 나눠서 센다.
//
//  실행:  node tests/multi-vehicle-day-test.js
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { RouteDatabase, buildDaySummary } = require('../electron/database.js');
const { baseContext, load } = require('./helpers/route-context');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(title) { console.log(`\n\x1b[36m${title}\x1b[0m`); }

// ── 테스트 데이터 ──────────────────────────────────────
const DATE = '2026-09-28';
const STEP_SEC = 30;
const N = 60;                 // 차량마다 60개 = 30분
// 한 걸음 약 56m — 30초에 56m 면 리플레이가 "이어진 주행"으로 보는 범위 안이다
// (replay.js REPLAY_MAX_DIRECT_SEGMENT_M=70m · 30초 · 150km/h 기준을 모두 통과)
const LAT_STEP = 0.0005;

function hms(sec) {
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec / 60) % 60)}:${p(sec % 60)}`;
}

// 한 차량의 정상 주행 한 편 — 30초 간격으로 곧게 이동한다(공백·점프 없음)
function drive(vehicle, zone, lat0, lng0, startSec) {
  const out = [];
  for (let i = 0; i < N; i++) {
    out.push({
      date: DATE, time: hms(startSec + i * STEP_SEC), vehicle, zone,
      lat: lat0 + i * LAT_STEP, lng: lng0,
    });
  }
  return out;
}

const T0 = 9 * 3600;                                   // 09:00:00
const CAR_A = drive('토레스 1호', '강남', 37.50, 127.03, T0);   // 강남
const CAR_B = drive('토레스 2호', '판교', 37.385, 127.115, T0); // 판교 — A 에서 약 14km 떨어져 있다

// 실제 저장소가 주는 모양: 시간순으로만 정렬 → 두 차량이 번갈아 섞인다
function interleavedDay() {
  return [...CAR_A, ...CAR_B].sort((a, b) =>
    a.time.localeCompare(b.time) || String(a.vehicle).localeCompare(String(b.vehicle)));
}

// 두 차량이 각자 달린 거리의 합(km) — 차량별로 재면 이 값이 나와야 한다
function expectedDistanceKm() {
  const R = 6371000, d2r = Math.PI / 180;
  const stepM = 2 * R * Math.asin(Math.sin(LAT_STEP * d2r / 2)); // 같은 경도 위를 위로만 이동
  return Math.round((stepM * (N - 1) * 2) / 10) / 100;
}

// ── 브라우저(화면 스크립트) 쪽 ─────────────────────────
// core.js(vehicleIndexPartitions) · quality.js(analyzeDayQuality) · replay.js(경로 잇기)를
// 실제 파일 그대로 vm 에 올린다.
// 화면 스크립트가 로드될 때 건드리는 DOM 만 흉내 낸다(그리기는 테스트하지 않는다)
function fakeDocument() {
  const els = new Map();
  const make = () => ({
    textContent: '', innerHTML: '', value: '', style: { setProperty() {} }, className: '',
    dataset: {}, children: [], appendChild(c) { this.children.push(c); }, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  });
  return {
    getElementById: id => { if (!els.has(id)) els.set(id, make()); return els.get(id); },
    createElement: make, querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {},
  };
}

function browserContext() {
  const ctx = baseContext({ document: fakeDocument(), setInterval: () => 0, clearInterval: () => {} });
  ['src/js/collection-stats.js', 'src/js/time-conditions.js', 'src/js/issue-filter.js',
    'src/js/condition-stats.js', 'src/js/core.js', 'src/js/coverage-grid.js',
    'src/js/quality.js', 'src/js/replay.js'].forEach(f => load(ctx, f));
  return ctx;
}

function freshDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-multiveh-')), 'route-viewer.db');
}

// ══════════════════════════════════════════════════════════
function main() {
  const day = interleavedDay();
  const expectedKm = expectedDistanceKm();
  const ctx = browserContext();

  section('A. 차량이 섞여 들어와도 차량별로 나눠서 센다');

  check('0. 테스트 전제 — 하루치가 두 차량이 번갈아 섞인 시간순 배열이다',
    day.length === N * 2 && day[0].vehicle !== day[1].vehicle && day[0].time === day[1].time,
    `${day.length}건 · ${day[0].vehicle}/${day[1].vehicle} 둘 다 ${day[0].time}`);

  const parts = ctx.vehicleIndexPartitions(day);
  check('1. vehicleIndexPartitions 가 차량별로 나누고, 차량 안에서는 시간순을 지킨다',
    parts.length === 2 && parts.every(p => p.length === N)
    && parts.every(p => p.every((idx, k) => k === 0 || day[p[k - 1]].time < day[idx].time)),
    `${parts.length}대 · ${parts.map(p => p.length).join('/')}건`);

  const q = ctx.analyzeDayQuality(day);
  check('2. 정상 주행 두 대를 섞어도 좌표 점프가 잡히지 않는다(이 버그의 본체)',
    q.teleports.length === 0, `좌표 점프 ${q.teleports.length}건 (기대 0건)`);
  check('3. GPS 공백도 잡히지 않는다',
    q.gaps.length === 0, `공백 ${q.gaps.length}건 (기대 0건)`);

  const segs = ctx.buildReplayRouteSegments(day);
  check('4. 리플레이 경로가 차량마다 하나씩 그려진다(두 차량 사이를 오가지 않는다)',
    segs.length === 2 && segs.every(s => s.length === N)
    && segs.every(s => new Set(s.map(p => p.vehicle)).size === 1),
    `구간 ${segs.length}개 · ${segs.map(s => s.length).join('/')}점`);

  const replayKm = Math.round(ctx.replayConnectedDistanceM(day) / 10) / 100;
  check('5. 총 이동거리가 차량별 주행거리의 합이다(차량 사이 직선거리가 얹히지 않는다)',
    Math.abs(replayKm - expectedKm) < 0.1, `${replayKm}km (기대 ${expectedKm}km)`);

  section('B. 진짜 이상치는 그대로 잡는다(전부 조용해진 게 아니다)');

  // 1호차 하나만 30초 만에 5km 튀게 만든다 → 600km/h
  const jumpDay = interleavedDay();
  const jumpAt = jumpDay.findIndex((p, i) => i > 10 && p.vehicle === '토레스 1호');
  jumpDay[jumpAt] = { ...jumpDay[jumpAt], lat: jumpDay[jumpAt].lat + 0.045 };
  const qJump = ctx.analyzeDayQuality(jumpDay);
  check('6. 같은 차량 안의 좌표 점프는 여전히 잡힌다',
    qJump.teleports.length >= 1 && qJump.teleports.every(t => jumpDay[t.i].vehicle === '토레스 1호'),
    `${qJump.teleports.length}건 · ${qJump.teleports.map(t => Math.round(t.speedKmh) + 'km/h').join(', ')}`);
  check('7. 점프의 prevI 는 같은 차량의 바로 앞 점을 가리킨다(지도 표시가 엉뚱한 점을 짚지 않게)',
    qJump.teleports.every(t => jumpDay[t.prevI].vehicle === jumpDay[t.i].vehicle && t.prevI < t.i),
    qJump.teleports.map(t => `${t.prevI}→${t.i}`).join(', '));

  // 2호차만 중간에 10분 쉰다 → 600초 공백
  const gapDay = interleavedDay()
    .filter(p => !(p.vehicle === '토레스 2호' && p.time > '09:10:00' && p.time < '09:20:00'));
  const qGap = ctx.analyzeDayQuality(gapDay);
  check('8. 한 차량만 기록이 끊긴 공백도 여전히 잡힌다',
    qGap.gaps.length === 1 && gapDay[qGap.gaps[0].i].vehicle === '토레스 2호',
    `${qGap.gaps.length}건 · ${qGap.gaps.map(g => g.gapSec + '초').join(', ')}`);
  check('9. 다른 차량(1호차)은 멀쩡하니 아무것도 잡히지 않는다',
    qGap.teleports.length === 0, `좌표 점프 ${qGap.teleports.length}건`);

  section('C. SQLite 요약과 브라우저 요약이 같은 값을 준다');

  const sql = buildDaySummary(day);
  check('10. SQLite buildDaySummary — 공백 0 · 점프 0',
    sql.quality.gaps === 0 && sql.quality.teleports === 0,
    `공백 ${sql.quality.gaps} · 점프 ${sql.quality.teleports}`);
  check('11. SQLite 요약 거리도 차량별 합이다',
    Math.abs(sql.distanceKm - expectedKm) < 0.1, `${sql.distanceKm}km (기대 ${expectedKm}km)`);

  const browser = ctx.buildDaySummaryFromPoints(day, ctx.TimeConditions.classificationConfig({}));
  check('12. 두 저장소의 거리·품질 값이 일치한다',
    browser.distanceKm === sql.distanceKm
    && browser.quality.gaps === sql.quality.gaps
    && browser.quality.teleports === sql.quality.teleports,
    `IndexedDB ${browser.distanceKm}km/${browser.quality.total}건 · SQLite ${sql.distanceKm}km/${sql.quality.total}건`);

  section('D. 실제 DB 를 거쳐도(import → 날짜 요약) 같다');

  const db = new RouteDatabase(freshDbPath());
  try {
    db.importRecords(day, { filename: 'multi-vehicle.xlsx', fileHash: 'multiveh-test-hash' });
    const summary = db.listDateSummaries().find(s => s.date === DATE);
    check('13. import 한 뒤 달력 요약에도 가짜 점프가 없다',
      summary && summary.quality.gaps === 0 && summary.quality.teleports === 0,
      summary ? `공백 ${summary.quality.gaps} · 점프 ${summary.quality.teleports}` : '요약 없음');
    check('14. 달력 요약 거리도 차량별 합이다',
      summary && Math.abs(summary.distanceKm - expectedKm) < 0.1,
      summary ? `${summary.distanceKm}km (기대 ${expectedKm}km)` : '요약 없음');

    const rows = db.getRecordsByDate(DATE);
    check('15. getRecordsByDate 로 다시 읽은 기록으로도 결과가 같다',
      ctx.analyzeDayQuality(rows).total === 0 && ctx.buildReplayRouteSegments(rows).length === 2,
      `${rows.length}건 · 의심 ${ctx.analyzeDayQuality(rows).total}건`);
  } finally {
    db.close();
  }

  console.log(`\n${'─'.repeat(60)}\n  통과 ${passed} / 실패 ${failed}\n${'─'.repeat(60)}`);
  if (failed) {
    console.log('\n실패한 항목:');
    failures.forEach(f => console.log(`  · ${f}`));
    process.exit(1);
  }
}

main();
