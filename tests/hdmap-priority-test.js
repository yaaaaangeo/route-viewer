// ══════════════════════════════════════════════════════════
//  hdmap-priority-test — 2차년도 HD Map 우선 구축 구역 ①~⑫ 비교 통계
//
//   A. 우선순위 정의(⑤ 최우선 · ①②⑥⑨⑩ 우선 · 나머지 일반)
//   B. 일반지역 평균 · 차이 · 퍼센트 · 배수 · 0으로 나누기
//   C. 우선지역 비중 · 가장 부족한 우선지역
//   D. 수집 세션(같은 차량이 10분 이상 끊겼다 다시 들어오면 새 세션)
//   E. 경계(polygon) 밖 GPS 는 그 구역에 들어가지 않는다
//   F. 경계 겹침·경계선 위의 점 정책
//   G. 경계가 없으면 숫자를 만들지 않는다 · 직접 그려 저장하면 기존 기록이 바로 재분류된다
//      · 못 센 이유(경계 미설정 / 기록 0건 / 계산 실패 / Coverage 미계산) 구분
//   H. 구역 번호 안내 참고 이미지(경계·기록과 무관하게 항상 보임)
//   I. SQLite ↔ IndexedDB 결과 일치 · 기존 기능 회귀 없음
//
//  실행: node tests/hdmap-priority-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HP = require('../src/js/hdmap-priority.js');
const PP = require('../src/js/priority-policy.js');

// 우선순위는 코드에 없다 — 테스트도 정책 데이터로 준다.
//   P5  : 예전 사업 정의와 같은 정책(⑤ 100 · ①②⑥⑨⑩ 70) — 아래 수치 검증(B~)은 이 정책 기준
//   P10 : ⑩ 중심으로 바뀐 정책(⑩ 100 · ⑨ 80 · ⑥ 50 · ⑤ 10)
const P5 = { policyId: 'p5', policyName: '⑤ 중심', areaPriorities: { 5: 100, 1: 70, 2: 70, 6: 70, 9: 70, 10: 70 } };
const P10 = { policyId: 'p10', policyName: '⑩ 중심', areaPriorities: { 10: 100, 9: 80, 6: 50, 5: 10 } };
// 데이터 파일 fixture 에 적는 옛 우선순위(초기 정책 변환 검증용 데이터)
const FIXTURE_DECLARED = { 5: 'primary', 1: 'priority', 2: 'priority', 6: 'priority', 9: 'priority', 10: 'priority' };
const compare = o => HP.buildComparison({ policy: P5, ...o });
const SZ = require('../src/js/subzones.js');
const CS = require('../src/js/collection-stats.js');
const { RouteDatabase } = require('../electron/database.js');
const { baseContext, load } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n\x1b[36m${t}\x1b[0m`);
const freshPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-hp-')), 'route-viewer.db');

// ── 시험용 경계 ───────────────────────────────────────
// 실제 ①~⑫ 경계는 저장소에 없다(그래서 src/data/hdmap-priority-areas.json 의 geometry 가 전부 null 이다).
// 테스트는 "계산 규칙"을 검증하는 것이므로, 겹치지 않는 네모 12개를 만들어 쓴다.
// 이 좌표는 시험용이고 실제 ①~⑫ 경계가 아니다 — 앱 데이터로 쓰지 않는다.
const BASE_LAT = 37.500, BASE_LNG = 127.020;
const SPACING = 0.004, SIZE = 0.003;
function squareRing(areaNo) {
  const w = BASE_LNG + (areaNo - 1) * SPACING;
  const e = w + SIZE;
  const s = BASE_LAT, n = BASE_LAT + SIZE;
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];   // GeoJSON 은 [경도, 위도]
}
function centerOf(areaNo) {
  return { lat: BASE_LAT + SIZE / 2, lng: BASE_LNG + (areaNo - 1) * SPACING + SIZE / 2 };
}
// 경계가 하나도 없는 정의 — "그리기 전" 상태를 저장소 파일과 무관하게 재현한다
const NO_POLYGON_FC = { type: 'FeatureCollection', features: [] };
function fixtureCollection(areaNos) {
  return {
    type: 'FeatureCollection',
    features: HP.ALL_AREA_NOS.map(areaNo => ({
      type: 'Feature',
      id: `hdmap_${String(areaNo).padStart(2, '0')}`,
      geometry: (areaNos || HP.ALL_AREA_NOS).includes(areaNo)
        ? { type: 'Polygon', coordinates: [squareRing(areaNo)] } : null,
      properties: { areaNo, name: `${areaNo}`, parentZone: '강남', priority: FIXTURE_DECLARED[areaNo] || 'normal' },
    })),
  };
}

const hhmmss = sec => [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60]
  .map(n => String(n).padStart(2, '0')).join(':');

// 1초 간격 점 count 개 → 유효 수집 시간 (count-1) 초
function runRecords(areaNo, { date, vehicle, startSec, count, lat, lng }) {
  const c = centerOf(areaNo);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      date, time: hhmmss(startSec + i), vehicle, zone: '강남', place: '', road: '', weather: '맑음',
      timeOfDay: '주간', traffic: '', speed: '20',
      lat: lat != null ? lat : c.lat, lng: lng != null ? lng : c.lng,
    });
  }
  return out;
}

// 구역별 수집 시간을 딱 떨어지게 만든 시나리오
//   일반 ③④⑦⑧⑪⑫ : 각 120초(2분)  → 평균 2분
//   우선 ①②⑥⑩     : 각 180초(3분)
//   우선 ⑨          : 60초(1분)      → 가장 부족한 우선지역
//   최우선 ⑤        : 오전 150초 + 오후 150초 = 300초(5분), 같은 날 같은 차 → 방문 1 · 세션 2
const PLAN = {
  1: 181, 2: 181, 3: 121, 4: 121, 6: 181, 7: 121, 8: 121, 9: 61, 10: 181, 11: 121, 12: 121,
};
function scenarioRecords() {
  const recs = [];
  Object.keys(PLAN).forEach(no => {
    const areaNo = Number(no);
    recs.push(...runRecords(areaNo, {
      date: `2026-09-${String(areaNo).padStart(2, '0')}`, vehicle: '토레스 1호차',
      startSec: 10 * 3600, count: PLAN[areaNo],
    }));
  });
  // ⑤ — 09:00~09:02:30 과 17:00~17:02:30 두 번 (같은 날 · 같은 차량)
  recs.push(...runRecords(5, { date: '2026-09-05', vehicle: '토레스 1호차', startSec: 9 * 3600, count: 151 }));
  recs.push(...runRecords(5, { date: '2026-09-05', vehicle: '토레스 1호차', startSec: 17 * 3600, count: 151 }));
  return recs;
}

function seededDb(records) {
  const db = new RouteDatabase(freshPath());
  db.importRecords(records, { filename: 'hdmap-priority-test.xlsx', fileHash: `h${Math.random()}` });
  return db;
}

function statsFor(db, areas, options) {
  return db.getSubZoneStats(HP.toSubZoneInputs(areas), options || { withRoads: false });
}

async function idbContext() {
  const fake = createFakeIndexedDB();
  const ctx = baseContext({ indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange });
  // index.html 과 같은 순서 — storage.js 가 global.HDMapPriority 로 경계를 검증한다
  ['src/js/coverage-grid.js', 'src/js/collection-stats.js', 'src/js/time-conditions.js', 'src/js/issue-filter.js',
    'src/js/subzones.js', 'src/js/hdmap-priority.js', 'src/js/condition-stats.js', 'src/js/recommendation.js',
    'src/js/storage.js']
    .forEach(f => load(ctx, f));
  await ctx.RouteDB.init();
  return ctx;
}

async function main() {
  // ══════════════════════════════════════════════════════
  section('A. 우선순위 — 코드가 아니라 활성 Priority Policy 에서');
  // ══════════════════════════════════════════════════════
  const tiersOf = (policy, fc) => HP.listAreas(fc || fixtureCollection(), {}, policy).map(a => `${a.areaNo}:${a.priorityLabel}`).join(' ');
  check('1. ⑤ 중심 정책이면 ⑤ 최우선 · ①②⑥⑨⑩ 우선 · 나머지 비우선',
    tiersOf(P5) === '1:우선 2:우선 3:비우선 4:비우선 5:최우선 6:우선 7:비우선 8:비우선 9:우선 10:우선 11:비우선 12:비우선', tiersOf(P5));
  check('   ⑩ 중심 정책으로 바꾸면 코드 수정 없이 ⑩ 최우선 · ⑨ 우선 · ⑥ 보조 · ⑤ 일반',
    tiersOf(P10) === '1:비우선 2:비우선 3:비우선 4:비우선 5:일반 6:보조 7:비우선 8:비우선 9:우선 10:최우선 11:비우선 12:비우선', tiersOf(P10));
  check('   정책이 없으면 모든 구역 비우선',
    HP.listAreas(fixtureCollection(), {}, null).every(a => a.priority === 'none' && a.priorityValue === 0 && a.priorityGroup === 'normal'));
  check('   단계 경계: 100 최우선 · 70~99 우선 · 40~69 보조 · 1~39 일반 · 0 비우선',
    [[100, '최우선'], [99, '우선'], [70, '우선'], [69, '보조'], [40, '보조'], [39, '일반'], [1, '일반'], [0, '비우선']]
      .every(([v, label]) => PP.tierOf(v).label === label));
  check('   코드에 고정 우선 목록이 없다(PRIMARY/PRIORITY/NORMAL 상수·priorityOf 제거)',
    HP.PRIMARY_AREA_NO === undefined && HP.PRIORITY_AREA_NOS === undefined && HP.NORMAL_AREA_NOS === undefined && HP.priorityOf === undefined);

  const seed = PP.seedFromAreas(HP.parseAreas(fixtureCollection()));
  check('2. 초기 정책은 데이터 파일의 priority 에서 만든다(primary 100 · priority 70 · normal 0) — 출처를 남긴다',
    seed.policyName === '초기 정책' && PP.sourceText(seed) === '출처: 기존 HD Map 우선구역 설정'
      && tiersOf(seed) === tiersOf(P5),
    `${seed.policyName} · ${PP.sourceText(seed)} · ${PP.summarize(seed)}`);
  check('   데이터 파일 값과 정책이 달라도 오류가 아니다 — 정책이 정한다',
    HP.validateAreas(HP.listAreas(fixtureCollection(), {}, P10)).errors.length === 0);

  // ══════════════════════════════════════════════════════
  section('B. 수집량 집계 — 대표 지표는 유효 수집 시간');
  // ══════════════════════════════════════════════════════
  const areas = HP.parseAreas(fixtureCollection());
  const db = seededDb(scenarioRecords());
  const stats = statsFor(db, areas);
  const result = compare({ areas, stats });
  const row = n => result.rows.find(r => r.areaNo === n);

  check('3. ⑤ 최우선 지역의 수집 시간이 계산된다(질문 1)',
    row(5).collectionSec === 300 && row(5).collectionMinutes === 5,
    `${row(5).collectionSec}초 = ${row(5).collectionMinutes}분 · 기록 ${row(5).recordCount}개`);
  check('   GPS 점 개수와 수집 시간은 다른 값이다(점 개수로 "몇 번 수집"이라고 말하지 않는다)',
    row(5).recordCount === 302 && row(5).collectionMinutes === 5);
  check('4. 우선지역 ①②⑤⑥⑨⑩ 이 각각 집계된다(질문 2)',
    row(1).collectionMinutes === 3 && row(2).collectionMinutes === 3 && row(6).collectionMinutes === 3
    && row(10).collectionMinutes === 3 && row(9).collectionMinutes === 1 && row(5).collectionMinutes === 5,
    result.summary.priorityGroupAreaNos.map(n => `${n}:${row(n).collectionMinutes}분`).join(" · "));

  // ══════════════════════════════════════════════════════
  section('C. 일반지역 평균과 대비 — 분 · % · 배');
  // ══════════════════════════════════════════════════════
  check('5. 일반지역 평균 = ③④⑦⑧⑪⑫ 의 수집 분 평균',
    result.summary.normalAvgMinutes === 2 && result.summary.normalAvgBasis.areaCount === 6,
    `평균 ${result.summary.normalAvgMinutes}분 (기준 구역 ${result.summary.normalAvgBasis.areaNos.join(',')})`);
  check('6. 차이 · 배수 · 퍼센트 (질문 4)',
    row(5).diffVsNormalAvgMinutes === 3 && row(5).ratioVsNormalAvg === 2.5 && row(5).percentVsNormalAvg === 150,
    `⑤ ${row(5).diffVsNormalAvgMinutes}분 · ${row(5).ratioVsNormalAvg}배 · ${row(5).percentVsNormalAvg}%`);
  check('   덜 수집된 구역은 음수로 나온다',
    row(9).diffVsNormalAvgMinutes === -1 && row(9).percentVsNormalAvg === -50 && row(9).ratioVsNormalAvg === 0.5,
    `⑨ ${row(9).diffVsNormalAvgMinutes}분 · ${row(9).percentVsNormalAvg}%`);
  check('   일반지역 자신도 같은 기준으로 비교된다', row(3).percentVsNormalAvg === 0 && row(3).ratioVsNormalAvg === 1);

  const zeroAreas = HP.parseAreas(fixtureCollection());
  const zeroResult = compare({
    areas: zeroAreas,
    // 일반지역에 기록이 하나도 없는 상태 — 평균 0분
    stats: HP.toSubZoneInputs(zeroAreas).map(z => ({
      id: z.id, recordCount: 0, collectionSec: 0, collectionMinutes: 0, visitCount: 0, sessionCount: 0, uniqueDays: 0,
    })).map(s => (s.id === 'hdmap_05' ? { ...s, collectionSec: 300, collectionMinutes: 5, recordCount: 302 } : s)),
  });
  const zeroPrimary = zeroResult.rows.find(r => r.areaNo === 5);
  check('7. 일반지역 평균이 0분이면 배수·퍼센트를 내지 않는다(0으로 나누지 않는다)',
    zeroResult.summary.normalAvgMinutes === 0
    && zeroPrimary.ratioVsNormalAvg === null && zeroPrimary.percentVsNormalAvg === null
    && zeroPrimary.comparable === false && zeroPrimary.diffVsNormalAvgMinutes === 5
    && !/Infinity|NaN/.test(JSON.stringify(zeroResult)),
    zeroPrimary.note);

  // ══════════════════════════════════════════════════════
  section('D. 우선지역 비중 · 가장 부족한 구역');
  // ══════════════════════════════════════════════════════
  check('8. 우선지역이 일반지역보다 많이 수집됐는지 답한다(질문 3)',
    result.summary.priorityAvgMinutes === 3 && result.summary.normalAvgMinutes === 2
    && result.summary.priorityVsNormal.percentVsNormalAvg === 50
    && result.summary.priorityVsNormal.ratioVsNormalAvg === 1.5,
    `우선 평균 ${result.summary.priorityAvgMinutes}분 vs 일반 평균 ${result.summary.normalAvgMinutes}분 (+${result.summary.priorityVsNormal.percentVsNormalAvg}%)`);
  check('9. 우선지역 수집 비중 (질문 6)',
    result.summary.priorityTotalMinutes === 18 && result.summary.allAreaMinutes === 30
    && result.summary.prioritySharePercent === 60,
    `${result.summary.priorityTotalMinutes}분 / ${result.summary.allAreaMinutes}분 = ${result.summary.prioritySharePercent}%`);
  check('   전체 수집이 0분이면 비중을 만들어내지 않는다',
    compare({ areas, stats: [] }).summary.prioritySharePercent === null);
  check('10. 가장 부족한 우선지역 (질문 5)',
    result.summary.weakestPriority.areaNo === 9 && result.summary.weakestPriority.percentVsNormalAvg === -50,
    `⑨ ${result.summary.weakestPriority.collectionMinutes}분 · 일반 평균 대비 ${result.summary.weakestPriority.percentVsNormalAvg}%`);

  // ══════════════════════════════════════════════════════
  section('E. 수집 세션 — 방문 횟수와 따로 센다');
  // ══════════════════════════════════════════════════════
  check('11. 같은 날 같은 차량이라도 10분 이상 끊기면 세션이 늘어난다',
    row(5).visitCount === 1 && row(5).uniqueDays === 1 && row(5).sessionCount === 2,
    `방문 ${row(5).visitCount}회 · 수집일 ${row(5).uniqueDays}일 · 세션 ${row(5).sessionCount}회`);
  check('   이어서 수집한 구역은 1 세션', row(1).sessionCount === 1 && row(1).visitCount === 1);

  const szBox = { id: 'unit', polygon: [[37.50, 127.02], [37.50, 127.03], [37.51, 127.03], [37.51, 127.02]] };
  const unitRow = (time, vehicle) => ({ date: '2026-09-01', time, vehicle: vehicle || 'A', lat: 37.505, lng: 127.025, weather: '맑음', speed: '10' });
  const gapCase = gapSec => SZ.aggregateSubZone(szBox, [unitRow('09:00:00'), unitRow(hhmmss(9 * 3600 + gapSec))]).sessionCount;
  check('12. 세션 경계는 10분(600초)이다',
    SZ.SESSION_GAP_SEC === 600 && gapCase(599) === 1 && gapCase(600) === 2 && gapCase(601) === 2,
    `599초 → ${gapCase(599)}세션 · 600초 → ${gapCase(600)}세션`);
  check('   차량이 다르면 각각 따로 센다',
    SZ.aggregateSubZone(szBox, [unitRow('09:00:00', 'A'), unitRow('09:00:01', 'A'), unitRow('09:00:00', 'B'), unitRow('09:00:01', 'B')]).sessionCount === 2);
  check('   날짜가 바뀌면 새 세션이다',
    SZ.aggregateSubZone(szBox, [unitRow('09:00:00'), { ...unitRow('09:00:01'), date: '2026-09-02' }]).sessionCount === 2);
  check('13. 기존 방문 횟수(날짜 × 차량) 정의는 그대로다',
    SZ.aggregateSubZone(szBox, [unitRow('09:00:00'), unitRow('17:00:00')]).visitCount === 1);

  // ══════════════════════════════════════════════════════
  section('F. 경계 판정 — 밖 · 겹침 · 경계선 위');
  // ══════════════════════════════════════════════════════
  const outside = centerOf(5);
  const outsideDb = seededDb([
    ...runRecords(5, { date: '2026-09-05', vehicle: '토레스 1호차', startSec: 9 * 3600, count: 61 }),
    // ⑤ 경계에서 한참 벗어난(다른 구역 쪽) 같은 차량 기록 120개
    ...runRecords(5, {
      date: '2026-09-05', vehicle: '토레스 1호차', startSec: 11 * 3600, count: 121,
      lat: outside.lat, lng: outside.lng + SPACING * 3,
    }),
  ]);
  const outsideStats = statsFor(outsideDb, areas);
  const outsideRow = compare({ areas, stats: outsideStats }).rows.find(r => r.areaNo === 5);
  check('14. 경계 밖 GPS 는 그 구역 통계에 들어가지 않는다',
    outsideRow.recordCount === 61 && outsideRow.collectionSec === 60 && outsideRow.sessionCount === 1,
    `⑤ 안 ${outsideRow.recordCount}건만 집계(밖 121건 제외) · ${outsideRow.collectionSec}초`);
  outsideDb.close();

  // 겹치는 경계 정책 — 구역마다 따로 판정하므로 겹친 자리의 기록은 양쪽에 모두 들어간다.
  // 숫자를 감추지 않고 그대로 세되, 합계가 부풀 수 있다는 걸 validateAreas 가 알린다.
  const overlapFc = fixtureCollection();
  const ring5 = squareRing(5);
  overlapFc.features.find(f => f.properties.areaNo === 6).geometry = { type: 'Polygon', coordinates: [ring5] };
  const overlapAreas = HP.parseAreas(overlapFc);
  const overlapCheck = HP.validateAreas(overlapAreas);
  const overlapStats = statsFor(db, overlapAreas);
  const o5 = overlapStats.find(s => s.id === 'hdmap_05');
  const o6 = overlapStats.find(s => s.id === 'hdmap_06');
  check('15. 경계가 겹치면 그 자리의 기록이 두 구역에 모두 들어간다(정책)',
    o5.recordCount === o6.recordCount && o5.collectionSec === o6.collectionSec && o5.recordCount > 0,
    `⑤ ${o5.recordCount}건 = ⑥ ${o6.recordCount}건`);
  check('   겹침을 찾아내서 "합계·비중이 커질 수 있다"고 알린다',
    overlapCheck.overlaps.some(o => o.confirmed && ((o.a === 5 && o.b === 6) || (o.a === 6 && o.b === 5)))
    && overlapCheck.warnings.some(w => w.includes('겹치는')),
    overlapCheck.warnings.find(w => w.includes('겹치는')));
  check('   겹치지 않는 정상 경계에서는 겹침 경고가 없다', HP.validateAreas(areas).warnings.length === 0);

  // 경계선을 맞댄 두 구역 — ray casting 규칙상 경계 위의 점은 정확히 한쪽에만 들어간다(이중 계산 없음)
  const westRing = [[127.020, 37.500], [127.030, 37.500], [127.030, 37.510], [127.020, 37.510], [127.020, 37.500]];
  const eastRing = [[127.030, 37.500], [127.040, 37.500], [127.040, 37.510], [127.030, 37.510], [127.030, 37.500]];
  const west = HP.ringToPolygon(westRing), east = HP.ringToPolygon(eastRing);
  const onEdge = [37.505, 127.030];
  const inWest = SZ.pointInPolygon(onEdge[0], onEdge[1], west);
  const inEast = SZ.pointInPolygon(onEdge[0], onEdge[1], east);
  check('16. 맞댄 경계선 위의 점은 한 구역에만 들어간다(두 번 세지 않는다)',
    (inWest ? 1 : 0) + (inEast ? 1 : 0) === 1, `서쪽 ${inWest} · 동쪽 ${inEast} — 서쪽 경계는 포함, 동쪽 경계는 제외`);
  check('   안쪽 점은 자기 구역에만 들어간다',
    SZ.pointInPolygon(37.505, 127.025, west) && !SZ.pointInPolygon(37.505, 127.025, east));

  // ══════════════════════════════════════════════════════
  section('G. 경계가 없으면 숫자를 만들지 않는다');
  // ══════════════════════════════════════════════════════
  const realAreas = HP.listAreas();   // src/data/hdmap-priority-areas.json (현재 저장소 상태)
  const realCheck = HP.validateAreas(realAreas);
  check('17. 저장소의 ①~⑫ 정의는 열두 칸 모두 있다',
    realAreas.length === 12 && realAreas.every(a => a.priority) && realAreas.map(a => a.areaNo).join(',') === HP.ALL_AREA_NOS.join(','));
  // 저장소 경계는 협의체 도로 shapefile 의 간선도로 중앙선으로 만든 블록이다(tools/derive-hdmap-priority-areas.js).
  // 이웃 블록은 같은 중앙선을 나눠 쓰므로 겹침 경고가 나오면 안 된다.
  check('18. 저장소 경계는 도로 데이터에서 만든 ①~⑫ 열두 개이고 서로 겹치지 않는다',
    realAreas.every(a => a.hasPolygon && a.polygonSource === 'file') && realCheck.allReady
    && realCheck.overlaps.every(o => !o.confirmed) && realCheck.warnings.length === 0,
    `경계 ${realCheck.readyCount}개 · 겹침 확인 ${realCheck.overlaps.filter(o => o.confirmed).length}쌍`);
  // 아래부터 "경계가 없을 때"는 저장소 파일과 무관하게 경계 없는 정의로 확인한다
  const realResult = compare({ areas: HP.listAreas(NO_POLYGON_FC), stats: [] });
  check('   경계 없는 구역은 0분이 아니라 "잴 수 없음"으로 구분된다',
    realResult.rows.every(r => r.hasPolygon === false && r.measured === false
      && r.diffVsNormalAvgMinutes === null && r.ratioVsNormalAvg === null && r.comparable === false)
    && realResult.summary.ready === false && realResult.summary.prioritySharePercent === null);

  // 일부만 채워도 동작한다 — 채운 구역만 집계하고, 뺀 구역을 평균에서 제외했다고 밝힌다
  const partialAreas = HP.parseAreas(fixtureCollection([1, 2, 3, 5]));
  const partial = compare({ areas: partialAreas, stats: statsFor(db, partialAreas) });
  check('19. 일부 구역만 경계가 있으면 그 구역만 집계하고 평균 기준을 밝힌다',
    partial.summary.normalAvgBasis.areaCount === 1 && partial.summary.normalAvgBasis.areaNos[0] === 3
    && partial.summary.normalAvgBasis.excludedAreaNos.join(',') === '4,7,8,11,12'
    && partial.summary.missingPolygonAreaNos.length === 8 && partial.summary.ready === true,
    `평균 기준 ${partial.summary.normalAvgBasis.areaCount}개 · 경계 미설정 ${partial.summary.missingPolygonAreaNos.length}개`);
  check('   기록이 0인 구역(경계 있음)과 경계 미설정 구역을 따로 센다',
    compare({ areas, stats: statsFor(seededDb([]), areas) }).summary.noDataAreaNos.length === 12);

  // ══════════════════════════════════════════════════════
  section('G2. 직접 그린 경계 — 저장하면 기존 기록이 그 자리에서 다시 분류된다');
  // ══════════════════════════════════════════════════════
  const drawDb = seededDb(scenarioRecords());
  const beforeAreas = HP.listAreas(NO_POLYGON_FC, drawDb.getHDMapPriorityPolygons());
  const before = compare({ areas: beforeAreas, stats: statsFor(drawDb, beforeAreas) });
  check('G1. 경계를 그리기 전에는 모든 구역이 "경계 미설정"이다',
    before.rows.every(r => r.state === 'no_polygon') && before.summary.prioritySharePercent === null);

  // 화면에서 지도를 눌러 찍는 것과 같은 입력 — WGS84 [위도, 경도]
  const drawRing5 = squareRing(5).map(([lng, lat]) => [lat, lng]);
  drawDb.saveHDMapPriorityPolygon(5, drawRing5);
  const afterAreas = HP.listAreas(NO_POLYGON_FC, drawDb.getHDMapPriorityPolygons());
  const after = compare({ areas: afterAreas, stats: statsFor(drawDb, afterAreas) });
  const a5 = after.rows.find(r => r.areaNo === 5);
  check('G2. 저장하면 이미 들어와 있는 기록이 그대로 다시 분류된다(재 import 불필요)',
    a5.state === 'ok' && a5.recordCount === 302 && a5.collectionMinutes === 5 && a5.sessionCount === 2,
    `⑤ 기록 ${a5.recordCount}건 · ${a5.collectionMinutes}분 · 세션 ${a5.sessionCount}회 (DB 에 새로 넣은 기록 없음)`);
  check('   직접 그린 경계임을 구분해서 들고 다닌다',
    a5.polygonSource === 'drawn' && a5.polygonPoints === 4 && !!afterAreas.find(x => x.areaNo === 5).polygonUpdatedAt);
  check('   닫는 점(첫 점과 같은 끝 점)은 정리해서 저장한다',
    drawDb.getHDMapPriorityPolygons()[5].polygon.length === 4);

  // 앱을 껐다 켜도 남아야 한다
  const drawPath = drawDb.dbPath;
  drawDb.close();
  const reopened = new RouteDatabase(drawPath);
  check('G3. 앱을 다시 켜도 그린 경계가 남는다',
    JSON.stringify(reopened.getHDMapPriorityPolygons()[5].polygon) === JSON.stringify(drawRing5.slice(0, 4)));

  // 백업/복원으로도 보존
  const payload = reopened.buildBackupPayload();
  const restoreDb = new RouteDatabase(freshPath());
  restoreDb.restoreBackupPayload(payload, 'merge');
  check('   백업에 담기고 복원된다(직접 그린 경계를 잃지 않는다)',
    !!payload.hdmapPriorityPolygons && !!restoreDb.getHDMapPriorityPolygons()[5]
    && restoreDb.getHDMapPriorityPolygons()[5].polygon.length === 4);
  restoreDb.close();

  check('G4. 경계를 지우면 다시 "경계 미설정"이 된다(주행 기록은 그대로)',
    (() => {
      const recordsBefore = reopened.getOverview({}).points;
      reopened.saveHDMapPriorityPolygon(5, null);
      const areasNow = HP.listAreas(NO_POLYGON_FC, reopened.getHDMapPriorityPolygons());
      return !areasNow.find(a => a.areaNo === 5).hasPolygon
        && reopened.getOverview({}).points === recordsBefore;
    })());

  const bad = [[37.5, 127.0], [37.5, 127.0]];
  let rejected = null;
  try { reopened.saveHDMapPriorityPolygon(5, bad); } catch (e) { rejected = e.message; }
  check('   꼭짓점이 3개가 안 되면 저장을 거부한다(잘못된 경계로 숫자를 만들지 않는다)',
    !!rejected && !reopened.getHDMapPriorityPolygons()[5], rejected);
  let rejectedNo = null;
  try { reopened.saveHDMapPriorityPolygon(13, drawRing5); } catch (e) { rejectedNo = e.message; }
  check('   ①~⑫ 밖의 번호도 거부한다', !!rejectedNo, rejectedNo);
  reopened.close();

  // ── 원인 구분(질문 7) ───────────────────────────────
  const stateDb = seededDb(scenarioRecords());
  stateDb.saveHDMapPriorityPolygon(5, drawRing5);
  stateDb.saveHDMapPriorityPolygon(3, squareRing(3).map(([lng, lat]) => [lat, lng]));
  // ⑦ 은 경계는 있지만 기록이 전혀 없는 바다 한가운데 — "잴 수 없다"가 아니라 진짜 0건이다
  stateDb.saveHDMapPriorityPolygon(7, [[35.0, 125.0], [35.0, 125.01], [35.01, 125.01], [35.01, 125.0]]);
  const stAreas = HP.listAreas(NO_POLYGON_FC, stateDb.getHDMapPriorityPolygons());
  const st = compare({ areas: stAreas, stats: statsFor(stateDb, stAreas) });
  const stateOf = n => st.rows.find(r => r.areaNo === n).state;
  check('G5. 못 센 이유를 "—" 하나로 합치지 않고 구분한다',
    stateOf(5) === 'ok' && stateOf(7) === 'no_data' && stateOf(1) === 'no_polygon'
    && st.summary.noDataAreaNos.join() === '7' && st.summary.missingPolygonAreaNos.length === 9,
    `⑤ ${st.rows.find(r => r.areaNo === 5).stateLabel} · ⑦ ${st.rows.find(r => r.areaNo === 7).stateLabel} · ① ${st.rows.find(r => r.areaNo === 1).stateLabel}`);
  check('   경계 안 기록 0건은 "잴 수 없음"이 아니라 진짜 0분 / 0회 / 0일이다',
    (() => { const r = st.rows.find(x => x.areaNo === 7);
      return r.collectionMinutes === 0 && r.visitCount === 0 && r.uniqueDays === 0 && r.comparable === true; })());
  check('   Coverage 를 재지 못한 구역은 0% 가 아니라 "미계산"으로 따로 센다',
    st.rows.find(r => r.areaNo === 5).coveragePct === null && st.summary.noCoverageAreaNos.includes(5),
    `Coverage 미계산 ${st.summary.noCoverageAreaNos.join(', ')}`);
  const failedRun = compare({ areas: stAreas, stats: [], error: true });
  check('G6. 집계가 실패하면 0분이 아니라 "계산 실패"로 두고 평균에서도 뺀다',
    failedRun.rows.find(r => r.areaNo === 5).state === 'error'
    && failedRun.summary.errorAreaNos.length === 3 && failedRun.summary.normalAvgBasis.areaCount === 0,
    `계산 실패 ${failedRun.summary.errorAreaNos.join(', ')}`);
  stateDb.close();

  // ══════════════════════════════════════════════════════
  section('H. 구역 번호 안내 이미지 — 경계·기록과 무관하게 항상 보인다');
  // ══════════════════════════════════════════════════════
  const REF_REL = 'src/assets/hdmap-priority-reference.png';
  const refPath = path.join(__dirname, '..', REF_REL);
  const refBytes = fs.existsSync(refPath) ? fs.readFileSync(refPath) : null;
  check('23. 참고 이미지가 앱 자산으로 들어 있다(앱 밖 링크가 아니다)',
    !!refBytes && refBytes.slice(1, 4).toString() === 'PNG' && refBytes.length > 10000,
    refBytes ? `${REF_REL} · ${refBytes.readUInt32BE(16)}×${refBytes.readUInt32BE(20)} · ${(refBytes.length / 1024 / 1024).toFixed(1)}MB` : '파일 없음');

  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  // HD Map 탭 패널만 잘라서 본다(다른 탭 내용과 섞이지 않게)
  const panelStart = indexHtml.indexOf('<div id="hdmap-stats-panel">');
  const panel = panelStart < 0 ? '' : indexHtml.slice(panelStart, indexHtml.indexOf('<div id="recommend-view">', panelStart));
  check('   HD Map 탭 안에서 상대 경로로 불러온다(Electron file:// · 브라우저 /src/ 양쪽에서 열린다)',
    panel.includes('src="assets/hdmap-priority-reference.png"') && panel.includes('구역 번호 안내'));
  check('   화면 코드가 아니라 index.html 에 고정이라 경계·기록이 없어도 남는다',
    !/hdmap-priority-reference/.test(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'statistics.js'), 'utf8'))
    && panel.indexOf('hdmap-priority-reference') < panel.indexOf('id="hdmap-priority-section"'));
  check('   대체 텍스트와 캡션이 있고, 위치 안내 전용(우선순위와 무관 · 통계용 경계 아님)이라고 밝힌다',
    /alt="[^"]*①~⑫[^"]*"/.test(panel) && panel.includes('위치 안내용 이미지') && panel.includes('우선순위와 무관')
      && panel.includes('경계(polygon)도 아니') && panel.includes('class="hp-ref-img"'));

  // ══════════════════════════════════════════════════════
  section('I. Coverage · 두 저장소 일치 · 회귀 없음');
  // ══════════════════════════════════════════════════════
  const noRoads = SZ.aggregateSubZone(szBox, [unitRow('09:00:00'), unitRow('09:00:01')]);
  const line = { name: '시험로', points: [[37.5049, 127.0250], [37.5051, 127.0250]] };
  const segs = SZ.roadSegmentsIn(szBox.polygon, [line], { subZoneId: 'unit' });
  const withRoads = SZ.aggregateSubZone(szBox, [unitRow('09:00:00'), unitRow('09:00:01')], { roadSegments: segs });
  check('20. 도로 데이터가 없으면 Coverage 는 0% 가 아니라 null 이다("안 달렸다"와 "잴 수 없다"는 다르다)',
    noRoads.coverage === null && withRoads.coverage !== null && withRoads.coverage.cellSizeM === 20,
    `도로 없음 → null · 도로 ${segs.length}개 → ${withRoads.coverage.percent}%`);

  const ctx = await idbContext();
  await ctx.RouteDB.importRecords(scenarioRecords(), { filename: 'hdmap-priority-test.xlsx', fileHash: 'idb-hash' });

  // 경계 저장도 두 저장소가 같은 규칙을 쓴다
  const idbRing = squareRing(5).map(([lng, lat]) => [lat, lng]);
  await ctx.RouteDB.saveHDMapPriorityPolygon(5, idbRing);
  const sqlRingDb = seededDb([]);
  sqlRingDb.saveHDMapPriorityPolygon(5, idbRing);
  check('   SQLite 와 IndexedDB 가 경계를 같은 모양으로 저장한다',
    JSON.stringify((await ctx.RouteDB.getHDMapPriorityPolygons())[5].polygon)
    === JSON.stringify(sqlRingDb.getHDMapPriorityPolygons()[5].polygon));
  let idbRejected = null;
  try { await ctx.RouteDB.saveHDMapPriorityPolygon(5, [[37.5, 127.0]]); } catch (e) { idbRejected = e.message; }
  check('   잘못된 경계는 두 저장소 모두 거부한다', !!idbRejected, idbRejected);
  await ctx.RouteDB.saveHDMapPriorityPolygon(5, null);
  sqlRingDb.close();

  const idbStats = await ctx.RouteDB.getSubZoneStats(HP.toSubZoneInputs(areas), { withRoads: false });
  const idbResult = compare({ areas, stats: idbStats });
  const strip = r => r.rows.map(x => `${x.areaNo}|${x.collectionSec}|${x.visitCount}|${x.sessionCount}|${x.uniqueDays}|${x.recordCount}|${x.percentVsNormalAvg}`);
  check('21. SQLite 와 IndexedDB 가 같은 결과를 낸다',
    JSON.stringify(strip(idbResult)) === JSON.stringify(strip(result))
    && idbResult.summary.prioritySharePercent === result.summary.prioritySharePercent,
    `비중 SQLite ${result.summary.prioritySharePercent}% / IndexedDB ${idbResult.summary.prioritySharePercent}%`);

  const summariesBefore = db.listDateSummaries().length;
  const overviewBefore = db.getOverview({}).points;
  statsFor(db, areas);
  check('22. ①~⑫ 집계는 기존 데이터를 건드리지 않는다(달력·누적 지도·통계 회귀 없음)',
    db.listDateSummaries().length === summariesBefore && db.getOverview({}).points === overviewBefore
    && db.getStatsBundle({}, {}).points === overviewBefore
    && db.listSubZones().length === 0,
    `①~⑫ 는 sub_zones 테이블에 저장되지 않는다(등록 구역 ${db.listSubZones().length}개)`);
  check('   기존 세부 구역 집계에도 세션·Coverage 가 더해졌을 뿐 기존 값은 그대로다',
    typeof result.rows[0].sessionCount === 'number'
    && stats.every(s => Number.isFinite(s.recordCount) && Number.isFinite(s.collectionSec) && Array.isArray(s.conditions) && Array.isArray(s.roads)));
  db.close();

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
