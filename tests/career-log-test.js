// ══════════════════════════════════════════════════════════
//  career-log-test — 개인용 Career Log / Project Impact
//
//   A. Coverage Depth(1·3·5·10x) · 여러 구역 합치기(칸 수 가중)
//   B. Project Scale — 날짜 요약에서만 센다
//   C. Collection Plan — 추천 설정 초안 · 버전(수정 = 새 버전) · 적용 Plan 고르기
//   D. Scenario Fulfillment — 달성/미달/측정 불가 · 우선순위 · Priority Zone 달성률
//   E. 운영 구역 측정값 = ConditionStats 집계 그대로(SQLite ↔ IndexedDB 같은 값)
//   F. KPI Snapshot · Deficit History · 같은 날짜 갱신
//   G. Contribution / Work Time Log — 직접 입력한 값만, 추정 없음
//   H. Resume Metrics · Export(JSON/CSV/MD) — 원본 GPS 좌표 없음
//   I. 저장소 — SQLite · IndexedDB 같은 동작, Plan 버전은 덮어쓰기/삭제 불가,
//      백업·서버 동기화 payload 에 들어가지 않음, 전체 데이터 삭제와 무관, 예전 DB 업그레이드
//   J. 이스터에그 — 3초 안에 5번, 일반 화면에 노출 없음, 부정적 표현 없음
//
//  실행: node tests/career-log-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CM = require('../src/js/career-metrics.js');
const CSt = require('../src/js/condition-stats.js');
const Recommendation = require('../src/js/recommendation.js');
const { freshDb, createDesktopApi, createStorageContext, ROOT } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n\x1b[36m${t}\x1b[0m`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 시험용 주행 기록 — 2대 × 3일, 10초 간격, 중간에 90° 좌회전 ──
function makeRecords() {
  const out = [];
  const days = ['2026-09-01', '2026-09-02', '2026-09-08'];
  const vehicles = ['토레스 1호', '토레스 2호'];
  days.forEach((date, di) => {
    vehicles.forEach((vehicle, vi) => {
      if (di === 2 && vi === 1) return; // 셋째 날은 1대만
      let lat = 37.5000 + vi * 0.001, lng = 127.0300;
      for (let i = 0; i < 60; i++) {
        const sec = 9 * 3600 + i * 10 + vi * 5;
        const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
        const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        if (i < 30) lat += 0.0002; else lng += 0.0002;
        out.push({ date, time: `${hh}:${mm}:${ss}`, vehicle, zone: '강남', lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), speed: '30', weather: '맑음' });
      }
    });
  });
  return out;
}

(async () => {
  // ══════════════════════════════════════════════════════
  section('A. Coverage Depth');
  const d = CM.depthFromVisits([0, 1, 2, 3, 5, 9, 10, 14]);
  check('A1. 유효 칸 수 = 입력 칸 수', d.total === 8, `total=${d.total}`);
  check('A2. N회 이상 칸 수(1·3·5·10x)', same(d.counts, { 1: 7, 3: 5, 5: 4, 10: 2 }), JSON.stringify(d.counts));
  check('A3. 퍼센트 = 칸 수 ÷ 유효 칸', d.percent[1] === 87.5 && d.percent[10] === 25, JSON.stringify(d.percent));
  check('A4. Depth 는 단조 감소(1x ≥ 3x ≥ 5x ≥ 10x)', d.percent[1] >= d.percent[3] && d.percent[3] >= d.percent[5] && d.percent[5] >= d.percent[10]);
  const e = CM.depthFromVisits([]);
  check('A5. 칸이 없으면 0% 가 아니라 null', e.total === 0 && e.percent[1] === null);
  const c = CM.combineDepth([CM.depthFromVisits([1, 1, 1, 1]), CM.depthFromVisits([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), null]);
  check('A6. 여러 구역 합계는 칸 수로 가중(평균의 평균 아님)', c.total === 16 && c.percent[1] === 25, `total=${c.total} 1x=${c.percent[1]}`);

  // ══════════════════════════════════════════════════════
  section('B. Project Scale');
  const db = freshDb();
  db.importRecords(makeRecords(), { filename: 'career-test.csv' });
  const summaries = db.listDateSummaries();
  const scale = CM.buildProjectScale({
    summaries, stats: db.getStats(), vehicles: db.listVehicles(), zones: db.listZones(),
    areas: [{ areaNo: 5, hasPolygon: true }, { areaNo: 1, hasPolygon: false }], today: '2026-09-10',
  });
  const r = scale.raw;
  check('B1. 운영 시작일 = 가장 이른 날짜', r.firstDate === '2026-09-01');
  check('B2. 수집 일수 = 기록 있는 날짜 수', r.collectionDays === 3);
  check('B3. 주행 일수(차량·일) = 날짜별 차량 수 합', r.vehicleDays === 5, `vehicleDays=${r.vehicleDays}`);
  check('B4. 차량 수 = 기록에 나온 차량', r.vehicleCount === 2);
  check('B5. GPS Records = 날짜 요약 합', r.recordCount === summaries.reduce((a, s) => a + s.count, 0) && r.recordCount === 300);
  const collSec = summaries.reduce((a, s) => a + s.collectionSec, 0);
  check('B6. 유효 수집시간 = 날짜 요약 collectionSec 합', r.collectionMinutes === Math.round(collSec / 60), `${r.collectionMinutes}분`);
  check('B7. 운영 기간 = 첫 날짜 ~ 오늘(양 끝 포함)', scale.items.find(i => i.key === 'operationPeriod').value === 10);
  check('B8. 모든 항목에 계산 근거(basis)가 있다', scale.items.every(i => i.basis && i.basis.length > 5));
  check('B9. Import 파일 수는 저장소 통계 그대로', r.importCount === 1);
  check('B10. HD Map 구역은 경계 있는 것만 관리 구역으로', r.areasWithPolygon === 1);

  // ══════════════════════════════════════════════════════
  section('C. Collection Plan');
  const recSettings = Recommendation.defaultRecommendationSettings();
  const draft = CM.defaultPlanDraft({ recommendationSettings: recSettings, operatingZones: ['강남'], priorityAreaNos: [5, 1, 2, 6, 9, 10] });
  check('C1. 초안 priorityZones = HD Map 우선 구역(⑤ 먼저)', same(draft.priorityZones, ['5', '1', '2', '6', '9', '10']));
  check('C2. 초안 Coverage 목표 = 추천 설정 기본 Coverage', draft.coverageTargets['5'] === recSettings.zoneCoverageTargets.default);
  check('C3. 초안 Maneuver 목표 = 추천 설정 값 복사', draft.maneuverTargets['강남'].LEFT_TURN.events === recSettings.maneuverTargets.LEFT_TURN.events);
  const expanded = CM.expandPlanTargets(draft);
  const roundTrip = CM.expandPlanTargets({ ...CM.collapseTargetRows(expanded), priorityZones: draft.priorityZones });
  check('C4. 평평한 목록 ↔ 묶음 필드 왕복이 같다', same(expanded, roundTrip), `${expanded.length}개`);

  const v1 = CM.createPlan({ ...draft, title: '2차년도 HD Map 우선수집', validFrom: '2026-10-01', validTo: '2026-10-31', reason: 'HD Map 우선 구축지역 데이터 확보' }, [], '2026-09-29T01:00:00.000Z');
  check('C5. 새 Plan id = PLAN-YYYY-MM-v1', v1.ok && v1.value.id === 'PLAN-2026-10-v1', v1.ok ? v1.value.id : v1.errors.join());
  const other = CM.createPlan({ title: '다른 계획', validFrom: '2026-10-05' }, [v1.value], '2026-09-29T02:00:00.000Z');
  check('C6. 같은 달 두 번째 계열은 다른 id', other.ok && other.value.id === 'PLAN-2026-10b-v1', other.ok && other.value.id);
  const noReason = CM.revisePlan(v1.value, { ...v1.value, title: '수정', changeReason: '' }, '2026-10-05T00:00:00.000Z');
  check('C7. 변경 사유 없이 수정 불가', !noReason.ok && noReason.errors.some(x => x.includes('변경 사유')));
  const v2 = CM.revisePlan(v1.value, { ...v1.value, timeTargets: { ...v1.value.timeTargets, 5: { ...v1.value.timeTargets['5'], lightCondition: { night: 120 } } }, changeReason: '⑤ 야간 목표 추가' }, '2026-10-05T00:00:00.000Z');
  check('C8. 수정 = 새 버전(v2, 이전 버전 id·사유·생성 시각)', v2.ok && v2.value.id === 'PLAN-2026-10-v2' && v2.value.previousVersionId === 'PLAN-2026-10-v1'
    && v2.value.changeReason === '⑤ 야간 목표 추가' && v2.value.createdAt === '2026-10-05T00:00:00.000Z');
  check('C9. 이전 버전 객체는 바뀌지 않는다', v1.value.version === 1 && !v1.value.timeTargets['5'].lightCondition);
  const plans = [v1.value, v2.value];
  check('C10. 적용 Plan = 계열의 최신 버전', CM.activePlanFor(plans, '2026-10-10').id === 'PLAN-2026-10-v2');
  check('C11. 기간 밖 날짜에는 Plan 없음', CM.activePlanFor(plans, '2026-11-02') === null);
  const diff = CM.diffPlanTargets(v1.value, v2.value);
  check('C12. 버전 차이 = 추가 1개', diff.added.length === 1 && diff.added[0].key === '5|lightCondition|night' && !diff.removed.length);
  const bad = CM.validatePlan({ title: 'x', validFrom: '2026-10-31', validTo: '2026-10-01', coverageTargets: { 5: 120 } });
  check('C13. 기간 역전·100% 초과 Coverage 목표 거절', !bad.ok && bad.errors.length >= 2, bad.errors.join(' / '));
  const hist = CM.planHistory([...plans, other.value]);
  check('C14. 버전 기록은 계열별로 묶이고 최신 버전 먼저', hist.length === 2 && hist.find(h => h.seriesId === 'PLAN-2026-10').versions[0].version === 2);

  // ══════════════════════════════════════════════════════
  section('D. Scenario Fulfillment');
  const plan = {
    id: 'P-v1', priorityZones: ['5', '1'],
    coverageTargets: { 5: 80, 1: 50 },
    coverageDepthTargets: { 5: { 5: 60 } },
    timeTargets: { 5: { lightCondition: { night: 120 }, trafficPeriod: { evening_peak: 100 } } },
    maneuverTargets: { 5: { LEFT_TURN: { events: 100 } }, 강남: { LEFT_TURN: { events: 100 }, MERGE: { events: 10 } } },
    roadContextTargets: { 강남: { INTERSECTION: { minutes: 300 }, SCHOOL_ZONE: { minutes: 60 } } },
  };
  const measurements = {
    5: { totalMinutes: 500, trafficPeriod: { evening_peak: 130 }, lightCondition: { night: 92 }, maneuver: null, roadContext: null, drivingState: null,
      depth: CM.depthFromVisits([0, 1, 5, 5, 6, 7, 9, 10, 11, 12]), notes: { maneuver: '구역 단위 없음' } },
    '강남': { totalMinutes: 900, trafficPeriod: {}, lightCondition: {}, maneuver: { LEFT_TURN: { events: 83, minutes: 20 } }, drivingState: {},
      roadContext: { INTERSECTION: { minutes: 244 } }, depth: null, notes: { depth: '데이터 없음' } },
  };
  const ev = CM.evaluatePlan(plan, measurements);
  const row = key => ev.rows.find(x => x.key === key);
  check('D1. 조도 목표 92/120분 → 76.7% 미달', row('5|lightCondition|night').percent === 76.7 && !row('5|lightCondition|night').achieved);
  check('D2. 시간대 목표 130/100분 → 달성', row('5|trafficPeriod|evening_peak').achieved);
  check('D3. 운영 구역 LEFT_TURN 83/100회 → 83%', row('강남|maneuver|LEFT_TURN').percent === 83 && row('강남|maneuver|LEFT_TURN').metric === 'events');
  check('D4. INTERSECTION 244/300분 → 81.3%', row('강남|roadContext|INTERSECTION').percent === 81.3);
  check('D5. ①~⑫ 의 Maneuver 목표는 측정 불가(0 으로 세지 않음)', !row('5|maneuver|LEFT_TURN').measurable && row('5|maneuver|LEFT_TURN').reason);
  check('D6. 확인된 적 없는 Road Context/MERGE 는 측정 불가(추천과 같은 규칙)', !row('강남|roadContext|SCHOOL_ZONE').measurable && !row('강남|maneuver|MERGE').measurable);
  check('D7. 측정값이 없는 구역(①)은 측정 불가', !row('1|coverageDepth|1').measurable);
  check('D8. 5x Coverage = 방문 5회 이상 칸 비율', row('5|coverageDepth|5').current === 80 && row('5|coverageDepth|5').achieved);
  const s = ev.summary;
  check('D9. 관리 Target = 측정 가능한 것만', s.total === ev.rows.filter(x => x.measurable).length && s.unmeasurable === 4, `total=${s.total} 불가=${s.unmeasurable}`);
  check('D10. 달성 + 미달 = 관리 Target, 달성률 계산', s.achieved + s.deficit === s.total && s.percent === Math.round((s.achieved / s.total) * 1000) / 10);
  check('D11. 우선순위 — priorityZones 첫 구역 High, 나머지 Medium, 그 밖 Low',
    row('5|lightCondition|night').priority === 'high' && row('1|coverageDepth|1').priority === 'medium' && row('강남|maneuver|LEFT_TURN').priority === 'low');
  check('D12. Priority Zone 달성률은 priorityZones 안의 Target 만', s.priorityZone.total === ev.rows.filter(x => x.measurable && ['5', '1'].includes(x.scope)).length);
  const recCounts = CM.recommendationDeficitCounts({ recommendations: [{ priority: 'very_high' }, { priority: 'high' }, { priority: 'medium' }, { priority: 'low' }, { priority: 'low' }] });
  check('D13. 추천 부족 조건 = 보통 이상(점수 40+)', recCounts.total === 3 && recCounts.low === 2 && recCounts.candidates === 5);

  // ══════════════════════════════════════════════════════
  section('E. 운영 구역 측정값 — 기존 집계 재사용 · SQLite ↔ IndexedDB');
  const mz = CM.measureZoneFromSummaries(summaries, '강남', 'clean');
  const direct = CSt.aggregate(summaries, { filter: { zone: '강남', issueFilter: 'clean' }, groupBy: [] }).totals;
  check('E1. 전체 수집 시간 = ConditionStats.aggregate 그대로', mz.totalMinutes === direct.collectionMinutes, `${mz.totalMinutes}분`);
  const directMan = CSt.aggregateAnalysis(summaries, { kind: 'maneuver', filter: { zone: '강남', issueFilter: 'clean' }, groupBy: ['egoManeuver'] }).rows;
  const left = directMan.find(x => x.egoManeuver === 'LEFT_TURN');
  check('E2. Maneuver 이벤트 = aggregateAnalysis(LOW 제외) 그대로', (mz.maneuver.LEFT_TURN ? mz.maneuver.LEFT_TURN.events : 0) === (left ? left.eventCount : 0));
  check('E3. UNKNOWN 은 측정값에서 뺀다', !mz.maneuver.UNKNOWN && !mz.roadContext.UNKNOWN);
  const fake = createFakeIndexedDB();
  const idbCtx = createStorageContext(fake);
  await idbCtx.RouteDB.init();
  await idbCtx.RouteDB.importRecords(makeRecords(), { filename: 'career-test.csv' });
  const idbSummaries = await idbCtx.RouteDB.listDateSummaries();
  const mzIdb = CM.measureZoneFromSummaries(idbSummaries, '강남', 'clean');
  check('E4. SQLite 와 IndexedDB 의 구역 측정값이 같다', same(mz, mzIdb));
  const area = CM.measureAreaFromSubZoneStat(5, { collectionSec: 1200, recordCount: 10, conditions: [
    { trafficPeriod: 'night', lightCondition: 'night', collectionSec: 600 }, { trafficPeriod: 'night', lightCondition: 'sunset', collectionSec: 600 }] });
  check('E5. ①~⑫ 측정값은 구역 집계(conditions)를 시간대·조도별로 합친 값', area.totalMinutes === 20 && area.trafficPeriod.night === 20 && area.lightCondition.night === 10 && area.maneuver === null);

  // ══════════════════════════════════════════════════════
  section('F. KPI Snapshot · Deficit History');
  const snap1 = CM.buildKpiSnapshot({ date: '2026-10-01', plan, scale: r, depth: CM.combineDepth([measurements[5].depth]), fulfillment: s, recDeficits: recCounts, source: 'manual', nowIso: '2026-10-01T09:00:00.000Z' });
  const need = ['date', 'planId', 'recordCount', 'collectionDays', 'vehicleCount', 'distanceKm', 'collectionMinutes', 'driveMinutes',
    'coverage1x', 'coverage3x', 'coverage5x', 'coverage10x', 'targetTotal', 'targetAchieved', 'targetDeficit', 'fulfillmentPercent', 'priorityZoneAchievementPercent'];
  check('F1. 요구 필드가 모두 있다', need.every(k => k in snap1), need.filter(k => !(k in snap1)).join(','));
  check('F2. id = 날짜(하루 한 줄), local-only', snap1.id === '2026-10-01' && snap1.localOnly === true);
  check('F3. Deficit 을 High/Medium/Low 로 따로 남긴다', snap1.deficitHigh === s.byPriority.high.deficit && snap1.deficitLow === s.byPriority.low.deficit);
  const snap1b = CM.buildKpiSnapshot({ date: '2026-10-01', plan, scale: r, fulfillment: s, previous: snap1, nowIso: '2026-10-01T18:00:00.000Z' });
  check('F4. 같은 날짜 다시 기록 = 최신 값으로 갱신(처음 기록 시각 유지)', snap1b.createdAt === snap1.createdAt && snap1b.updatedAt.startsWith('2026-10-01T18') && snap1b.updateCount === 2);
  const snaps = [
    { ...snap1, date: '2026-10-08', id: '2026-10-08', targetDeficit: 19, fulfillmentPercent: 48 },
    { ...snap1, date: '2026-10-01', id: '2026-10-01', targetDeficit: 24, fulfillmentPercent: 35 },
    { ...snap1, date: '2026-10-15', id: '2026-10-15', targetDeficit: 14, fulfillmentPercent: 61, coverage5x: null },
  ];
  const dh = CM.deficitHistory(snaps);
  check('F5. Deficit History 는 날짜순 과거 기록', same(dh.map(x => x.total), [24, 19, 14]));
  check('F6. 추이 그래프는 값 없는 날을 0 으로 그리지 않는다', CM.snapshotSeries(snaps, 'coverage5x').length === 2);

  // ══════════════════════════════════════════════════════
  section('G. Contribution / Work Time Log');
  const badC = CM.normalizeContribution({ date: '', problem: '' });
  check('G1. 날짜·문제 없으면 저장 안 함', !badC.ok && badC.errors.length === 2);
  const c1 = CM.normalizeContribution({ date: '2026-10-05', problem: '⑤ 구역 야간 데이터 부족', analysis: '야간 42분 / 목표 120분', decision: '18~21시 우선 주행', implementation: '추천 경로에 ⑤ 야간 우선순위 반영', result: '야간 +96분', zones: '5, 강남', features: 'Route Planning, Recommendation Logic', planId: 'PLAN-2026-10-v1', quantResult: '+96분' });
  check('G2. 필드가 그대로 저장되고 목록 필드는 배열로', c1.ok && same(c1.value.zones, ['5', '강남']) && c1.value.features.length === 2 && c1.value.localOnly);
  const c1e = CM.normalizeContribution({ ...c1.value, result: '목표 달성' }, c1.value, '2026-10-06T00:00:00.000Z');
  check('G3. 수정해도 id·작성 시각 유지', c1e.value.id === c1.value.id && c1e.value.createdAt === c1.value.createdAt && c1e.value.result === '목표 달성');
  const c2 = CM.normalizeContribution({ date: '2026-09-20', problem: '이전 기록' }).value;
  check('G4. 날짜순 보기(오름/내림)', CM.sortContributions([c1.value, c2], 'asc')[0].date === '2026-09-20' && CM.sortContributions([c1.value, c2], 'desc')[0].date === '2026-10-05');
  const w = (mode, minutes, date) => CM.normalizeWorkTime({ task: '일일 수집 현황 분석', mode, minutes, date }).value;
  const works = [w('manual', 70, '2026-10-01'), w('manual', 66.8, '2026-10-02'), w('route_viewer', 12, '2026-10-03'), w('route_viewer', 11.4, '2026-10-04')];
  const ws = CM.workTimeStats(works);
  check('G5. Manual/Route Viewer 평균과 감소율', ws[0].manual.n === 2 && ws[0].manual.avg === 68.4 && ws[0].routeViewer.avg === 11.7 && ws[0].reductionPercent === 82.9,
    `${ws[0].manual.avg} → ${ws[0].routeViewer.avg} (${ws[0].reductionPercent}%)`);
  const onlyManual = CM.workTimeStats([w('manual', 70, '2026-10-01')]);
  check('G6. 한쪽 측정만 있으면 감소율을 만들지 않는다(추정 없음)', onlyManual[0].reductionPercent === null && onlyManual[0].routeViewer.n === 0);
  check('G7. 잘못된 측정값 거절(0분·방식 없음)', !CM.normalizeWorkTime({ task: 'x', mode: 'auto', minutes: 0, date: '2026-10-01' }).ok);

  // ══════════════════════════════════════════════════════
  section('H. Resume Metrics · Export');
  const resume = CM.buildResumeMetrics({ scale, snapshots: snaps, workStats: ws, contributions: [c1.value, c2] });
  check('H1. PROJECT SCALE 은 숫자만', resume.scale.some(x => x.label === '차량' && x.value === '2대'));
  const ful = resume.coverage.find(x => x.label === 'Scenario Fulfillment');
  check('H2. 처음 → 지금 변화(Snapshot 기준)', ful && ful.value === '35% → 61%', ful && ful.value);
  check('H3. AUTOMATION 은 측정값 그대로', resume.automation[0].value === '68.4 min → 11.7 min (82.9% 감소)');
  check('H4. MY CONTRIBUTION 은 직접 적은 관련 기능만', same(resume.contribution.map(x => x.label).sort(), ['Recommendation Logic', 'Route Planning']));
  const payload = CM.buildExportPayload({ scale, snapshots: [{ ...snaps[0], lat: 37.5, lng: 127.0 }], plans, contributions: [{ ...c1.value, polygon: [[37.5, 127]] }], workTimes: works, workStats: ws, resume });
  const text = JSON.stringify(payload);
  check('H5. JSON Export 에 좌표 필드가 없다', !/"(lat|lng|latitude|longitude|polygon)"/.test(text));
  check('H6. JSON Export 는 local-only 표시와 형식 이름을 가진다', payload.type === 'route-viewer-career-log' && payload.localOnly === true);
  const csv = CM.toMetricsCsv(snaps);
  check('H7. CSV — BOM · 헤더 · 날짜순 행', csv.startsWith('﻿date,planId,') && csv.split('\r\n')[1].startsWith('2026-10-01'));
  check('H8. CSV 값 안의 쉼표·따옴표는 감싼다', CM.toMetricsCsv([{ ...snap1, planId: 'a,"b"' }]).includes('"a,""b"""'));
  const md = CM.toSummaryMarkdown({ resume, contributions: [c1.value], snapshots: snaps });
  check('H9. Markdown 요약 — 섹션과 Contribution 기록', md.includes('## PROJECT SCALE') && md.includes('## AUTOMATION') && md.includes('⑤ 구역 야간 데이터 부족'));
  check('H10. 파일 이름 규칙', same(CM.exportFileNames('2026-10-31'), { json: 'career-log-20261031.json', csv: 'career-metrics-20261031.csv', md: 'career-summary-20261031.md' }));
  const imp = CM.planCareerImport(payload, { collectionPlans: [v1.value], kpiSnapshots: [], contributions: [], workTimes: [] });
  check('H11. 가져오기 — 이미 있는 Plan 버전은 건드리지 않음', imp.collectionPlans.length === 1 && imp.collectionPlans[0].id === 'PLAN-2026-10-v2');
  let threw = false; try { CM.planCareerImport({ type: 'route-viewer-backup' }); } catch (_) { threw = true; }
  check('H12. 다른 파일(백업 등)은 가져오지 않음', threw);

  // ══════════════════════════════════════════════════════
  section('I. 저장소 — local-only · 백업/동기화 제외 · 버전 보존');
  const sqlite = createStorageContext({ api: createDesktopApi(db) }).RouteDB;
  await sqlite.init();
  const idb = idbCtx.RouteDB;
  for (const [label, store] of [['SQLite', sqlite], ['IndexedDB', idb]]) {
    await store.saveCareerItem('collectionPlans', v1.value);
    await store.saveCareerItem('collectionPlans', v2.value);
    await store.saveCareerItem('kpiSnapshots', snap1);
    await store.saveCareerItem('kpiSnapshots', snap1b);   // 같은 날짜 → 갱신
    await store.saveCareerItem('contributions', c1.value);
    await store.saveCareerItem('workTimes', works[0]);
    const listed = await store.listCareerItems('kpiSnapshots');
    check(`I1. [${label}] 같은 날짜 Snapshot 은 한 줄(최신)`, listed.length === 1 && listed[0].updateCount === 2);
    let overwrite = null;
    try { await store.saveCareerItem('collectionPlans', { ...v1.value, title: '덮어쓰기' }); } catch (err) { overwrite = err.message; }
    check(`I2. [${label}] 저장된 Plan 버전은 덮어쓸 수 없다`, overwrite && overwrite.includes('새 버전'));
    let del = null;
    try { await store.deleteCareerItem('collectionPlans', v1.value.id); } catch (err) { del = err.message; }
    check(`I3. [${label}] Plan 버전은 지울 수 없다`, del && (await store.listCareerItems('collectionPlans')).length === 2);
    await store.deleteCareerItem('workTimes', works[0].id);
    check(`I4. [${label}] 측정값·기록은 지울 수 있다`, (await store.listCareerItems('workTimes')).length === 0);
    let unknown = null;
    try { await store.listCareerItems('driving_records'); } catch (err) { unknown = err.message; }
    check(`I5. [${label}] 정해진 영역 밖은 읽지 않는다`, !!unknown);
    const backup = await store.buildBackupPayload();
    const bt = JSON.stringify(backup);
    check(`I6. [${label}] 백업/서버 동기화 payload 에 Career Log 가 없다`, !bt.includes('PLAN-2026-10') && !bt.includes('⑤ 구역 야간') && !Object.keys(backup).some(k => /career|kpi|contribution|workTime/i.test(k)));
    await store.saveCareerItem('contributions', { ...c1.value, lat: 37.5, points: [[1, 2]] });
    const stored = (await store.listCareerItems('contributions'))[0];
    check(`I7. [${label}] 저장 항목에서도 좌표 필드는 빠지고 local-only 표시`, !('lat' in stored) && !('points' in stored) && stored.localOnly === true);
  }
  check('I8. SQLite 와 IndexedDB 가 같은 목록을 돌려준다',
    same(await sqlite.listCareerItems('collectionPlans'), await idb.listCareerItems('collectionPlans'))
    && same(await sqlite.listCareerItems('kpiSnapshots'), await idb.listCareerItems('kpiSnapshots')));
  const pointsBefore = db.getStats().points;
  db.deleteAll();
  check('I9. 주행 데이터 전체 삭제는 Career Log 를 지우지 않는다', db.listCareerItems('contributions').length === 1 && pointsBefore > 0 && db.getStats().points === 0);
  // 예전 DB(테이블 없음) 업그레이드 — 기존 기록을 건드리지 않고 테이블만 생긴다
  const oldDb = freshDb();
  oldDb.importRecords(makeRecords().slice(0, 50), { filename: 'old.csv' });
  Object.values(CM.CAREER_KINDS).forEach(k => oldDb.db.run(`DROP TABLE ${k.table}`));
  const oldPath = oldDb.dbPath; oldDb.close();
  const { RouteDatabase } = require('../electron/database.js');
  const reopened = new RouteDatabase(oldPath);
  check('I10. 예전 SQLite DB 를 열면 기록은 그대로, Career 테이블만 새로 생긴다', reopened.getStats().points === 50 && reopened.listCareerItems('kpiSnapshots').length === 0);
  reopened.close();
  // 예전 IndexedDB(v5) → v6
  const fake5 = createFakeIndexedDB();
  await new Promise(res => {
    const req = fake5.indexedDB.open('route-viewer', 5);
    req.onupgradeneeded = () => { const d5 = req.result; d5.createObjectStore('meta', { keyPath: 'key' }); d5.createObjectStore('summaries', { keyPath: 'date' }); };
    req.onsuccess = () => res();
  });
  fake5.rawStore('route-viewer', 'meta').set('backupHistory', { key: 'backupHistory', value: [{ kind: '백업 저장', at: '2026-09-01T00:00:00Z', detail: 'x' }] });
  const up = createStorageContext(fake5).RouteDB;
  await up.init();
  await up.saveCareerItem('workTimes', works[1]);
  check('I11. 예전 IndexedDB(v5)를 열면 기존 값은 그대로, Career 저장소만 생긴다',
    (await up.getBackupHistory()).length === 1 && (await up.listCareerItems('workTimes')).length === 1);
  const syncSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const syncBlock = syncSrc.slice(syncSrc.indexOf("handle('sync:run'"), syncSrc.indexOf("handle('sync:run'") + 2000);
  check('I12. 서버 동기화는 buildBackupPayload 만 보낸다(Career Log 경로 없음)', syncBlock.includes('buildBackupPayload()') && !/career/i.test(syncBlock));

  // ══════════════════════════════════════════════════════
  section('J. 이스터에그 · 노출 · 표현');
  let clickHandler = null;
  let now = 1000000;
  const opened = [];
  const toasts = [];
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error: console.error },
    Date: { now: () => now },
    document: {
      querySelector: sel => (sel === 'header .brand-mark' ? { addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; } } : null),
      getElementById: () => null, addEventListener() {}, removeEventListener() {},
    },
    escapeHtml: s => String(s),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/js/career-log-view.js'), 'utf8'), ctx);
  ctx.openCareerLog = () => { opened.push('open'); ctx.careerOpenStub = true; };
  ctx.closeCareerLog = () => { opened.push('close'); };
  ctx.showToast = m => toasts.push(m);
  const click = (n, gap) => { for (let i = 0; i < n; i++) { clickHandler(); now += gap; } };
  check('J1. 양 아이콘에 클릭 리스너가 붙는다', typeof clickHandler === 'function');
  click(4, 200);
  check('J2. 4번으로는 열리지 않는다(1번 클릭 동작 그대로)', opened.length === 0);
  now += 5000;
  click(5, 900);   // 0, 0.9, 1.8, 2.7, 3.6초 → 3초 창 안에는 4번뿐
  check('J3. 3초 넘게 걸린 5번은 열지 않는다', opened.length === 0);
  now += 5000;
  click(5, 300);
  check('J4. 3초 안에 5번 → 열림 + "🐑 Career Log unlocked"', opened[0] === 'open' && toasts[0] === '🐑 Career Log unlocked');
  vm.runInContext('careerOpen=true', ctx);
  now += 5000;
  click(5, 300);
  check('J5. 다시 5번 → 닫힘', opened[1] === 'close');
  check('J6. 열림 상태를 저장하지 않는다(재실행 시 자동으로 열리지 않음)', !/localStorage\.setItem\([^)]*[Oo]pen/.test(fs.readFileSync(path.join(ROOT, 'src/js/career-log-view.js'), 'utf8')));

  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  const htmlNoTags = html.replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
  check('J7. 일반 화면(탭·메뉴·설정)에 Career Log / Project Impact 노출 없음', !/career|project impact|kpi-history/i.test(htmlNoTags));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  check('J8. README 일반 사용법에 노출 없음', !/career log|project impact/i.test(readme));
  const menuSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const menuBlock = menuSrc.slice(menuSrc.indexOf('Menu.buildFromTemplate') - 3000, menuSrc.indexOf('Menu.buildFromTemplate'));
  check('J9. 데스크톱 메뉴에도 노출 없음', !/career|impact/i.test(menuBlock));
  const newFiles = ['src/js/career-metrics.js', 'src/js/kpi-history.js', 'src/js/career-log-view.js', 'src/css/career-log.css'];
  const negative = newFiles.filter(f => /duplicate|waste|redundant/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('J10. 반복 주행에 부정적 표현(duplicate/waste/redundant)을 쓰지 않는다', negative.length === 0, negative.join(', '));
  const netCalls = newFiles.filter(f => /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('J11. Career Log 코드에 외부 전송(fetch·XHR·beacon·socket)이 없다', netCalls.length === 0, netCalls.join(', '));

  // ══════════════════════════════════════════════════════
  section('K. 기본 화면(notebook) — 이번 달 규모 · 월초 대비 · 한 줄 기록');
  const db2 = freshDb();
  db2.importRecords(makeRecords(), { filename: 'k.csv' });
  const ms = CM.buildMonthScale(db2.listDateSummaries(), '2026-09-05');
  check('K1. 이번 달 규모는 1일~오늘 날짜만(09-08 제외)', ms.from === '2026-09-01' && ms.collectionDays === 2 && ms.vehicleCount === 2 && ms.recordCount === 240, JSON.stringify(ms));
  const msAll = CM.buildMonthScale(db2.listDateSummaries(), '2026-09-30');
  check('K2. 월말 기준은 이번 달 전체', msAll.collectionDays === 3 && msAll.recordCount === 300);
  const kSnaps = [
    { id: '2026-08-28', date: '2026-08-28', coverage5x: 40, fulfillmentPercent: 30, targetDeficit: 20 },
    { id: '2026-09-03', date: '2026-09-03', coverage5x: 44.44, fulfillmentPercent: 35, targetDeficit: 18 },
    { id: '2026-09-20', date: '2026-09-20', coverage5x: 51.2, fulfillmentPercent: null, targetDeficit: 12 },
  ];
  const mi = CM.monthlyImpact(kSnaps, '2026-09-29');
  check('K3. 월초 = 이번 달 1일 전의 마지막 Snapshot, 현재 = 가장 최근', mi.coverage5x.from === 40 && mi.coverage5x.to === 51.2 && mi.coverage5x.delta === 11.2 && mi.coverage5x.fromDate === '2026-08-28');
  check('K4. 값이 없는 날은 건너뛰고(Fulfillment 현재 = 09-03 값) 0 으로 채우지 않음', mi.fulfillment.to === 35 && mi.fulfillment.toDate === '2026-09-03');
  check('K5. Deficit 변화는 개수', mi.deficit.from === 20 && mi.deficit.to === 12 && mi.deficit.delta === -8);
  const mi2 = CM.monthlyImpact(kSnaps.slice(1, 2), '2026-09-29');
  check('K6. 이번 달 첫 Snapshot 뿐이면 "기록 시작"(single)', mi2.coverage5x.single && mi2.coverage5x.delta === 0);
  check('K7. Snapshot 이 없으면 null', CM.monthlyImpact([], '2026-09-29').coverage5x === null);
  const snapK = { date: '2026-09-29', planId: 'PLAN-2026-09-v2', coverage1x: 55.4, coverage3x: 11.4, coverage5x: 3.3, coverage10x: 0.3, fulfillmentPercent: 5.1, targetDeficit: 56, recDeficitTotal: 66, collectionMinutes: 435, distanceKm: 100.6 };
  const qn = CM.buildQuickNote({ memo: '  ⑤ 구역 야간 데이터 부족으로\n18~21시 우선 경로로 변경  ', snapshot: snapK }, '2026-09-29T10:00:00.000Z');
  check('K8. 한 줄 기록 = 기존 Contribution 항목(problem=memo, 여러 줄 유지)', qn.ok && qn.value.problem === '⑤ 구역 야간 데이터 부족으로\n18~21시 우선 경로로 변경' && qn.value.memo === qn.value.problem && qn.value.entryType === 'quick' && qn.value.date === '2026-09-29');
  const ka = qn.value.kpiAtSave;
  check('K9. 저장 시점 KPI 자동 첨부(1/3/5/10x · Fulfillment · Deficit · 수집시간 · 주행거리 · Plan)',
    ka.coverage1x === 55.4 && ka.coverage10x === 0.3 && ka.fulfillmentPercent === 5.1 && ka.targetDeficit === 56 && ka.collectionMinutes === 435 && ka.distanceKm === 100.6 && ka.planId === 'PLAN-2026-09-v2' && qn.value.planId === 'PLAN-2026-09-v2');
  check('K10. 빈 메모는 저장 안 함', !CM.buildQuickNote({ memo: '   ', snapshot: snapK }).ok);
  const qe = CM.normalizeContribution({ ...qn.value, problem: '고친 메모', decision: '추가한 결정' }, qn.value, '2026-09-30T00:00:00.000Z');
  check('K11. 상세 편집 후에도 KPI 첨부·종류 유지, memo 는 새 내용', qe.ok && qe.value.kpiAtSave.coverage5x === 3.3 && qe.value.entryType === 'quick' && qe.value.memo === '고친 메모' && qe.value.decision === '추가한 결정');
  await sqlite.saveCareerItem('contributions', qn.value);
  const back = (await sqlite.listCareerItems('contributions')).find(c => c.id === qn.value.id);
  check('K12. 스키마 변경 없이 기존 contributions 영역에 저장·복원', back && back.kpiAtSave.targetDeficit === 56 && back.memo === qn.value.memo);
  const mdK = CM.toSummaryMarkdown({ contributions: [qn.value], snapshots: [] });
  check('K13. Markdown 에 저장 당시 KPI 한 줄', mdK.includes('저장 당시: 5x Coverage 3.3%'));
  const viewSrc = fs.readFileSync(path.join(ROOT, 'src/js/career-log-view.js'), 'utf8');
  check('K14. 화면 이름 Resume Metrics → Impact Summary', viewSrc.includes("'Impact Summary'") && !/clSection\('cl-resume','Resume Metrics'/.test(viewSrc));
  db2.close();

  db.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('실패: ' + failures.join(' | ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
