// ══════════════════════════════════════════════════════════
//  recommendation-ops-test — 추천 주행을 실제 수집 운영에 맞게 고친 부분
//
//   A. 지도 POI → 자동 분류 연결 · POI 없을 때 fallback · poiDataRevision(캐시 기록)
//   B. 도로 Segment 추천의 평일/주말 후보(부족한 쪽만)
//   C. 사업 우선도(HD Map 우선 구축구역 ⑤ / ①②⑥⑨⑩) — 보조 점수 · 충분하면 올리지 않음
//   D. 주행 계획 — Road Graph 최단 거리 · 직선 거리 fallback · 구역 변경 비용(A→B→A 억제)
//   E. 오늘 추천 Top 3 — 요일·운행 시간·숨김/완료 상태 · 이유
//   F. Edge Case 점수 — "예상 상황 개수"가 아니라 가능성 × 부족
//   G. 저장소 — 설정 검증 · 원본 기록 불변 · SQLite/IndexedDB 같은 POI 지문
//
//  실행: node tests/recommendation-ops-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SZ = require('../src/js/subzones.js');
const RG = require('../src/js/road-graph.js');
const AZ = require('../src/js/auto-subzones.js');
const R = require('../src/js/recommendation.js');
const TC = require('../src/js/time-conditions.js');
const PD = require('../src/js/poi-data.js');
const HP = require('../src/js/hdmap-priority.js');
const RouteParser = require('../src/js/parser.js');
const { RouteDatabase } = require('../electron/database.js');
const { baseContext, load } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

const HDMAP_GANGNAM = require('../src/data/hdmap_gangnam_roads.json');
const HDMAP_SEOCHO = require('../src/data/hdmap_seocho_roads.json');
const NOW = '2026-09-17T01:00:00Z';     // 목요일 10:00 KST
const TODAY = '2026-09-17';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n\x1b[36m${t}\x1b[0m`);
const freshPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-ops-')), 'route-viewer.db');

// 강남역~역삼 일대 작은 범위 — ⑤(최우선) · ⑥⑨⑩(인근 우선) · ⑦⑪(일반) 일부를 포함한다
const POLYGON = [[37.5000, 127.0250], [37.5120, 127.0250], [37.5120, 127.0420], [37.5000, 127.0420]];
const AREAS = HP.listAreas();

function realSegments() {
  const lines = HDMAP_GANGNAM.lines.concat(HDMAP_SEOCHO.lines);
  return RG.labelSegments(RG.buildSegments(RG.buildGraph(lines), { parentZone: '강남', polygon: POLYGON }));
}

// 구간 집계를 손으로 만든다 — cells 는 aggregateSegments 결과와 같은 모양
function stat(cells) {
  const list = cells.map(c => ({ direction: 'forward', lightCondition: null, weather: '맑음', recordCount: 60, visitCount: 2, lastVisitedAt: '2026-09-10T08:00:00+09:00', ...c, collectionSec: c.collectionMinutes * 60 }));
  const minutes = list.reduce((a, c) => a + c.collectionMinutes, 0);
  return {
    recordCount: list.reduce((a, c) => a + c.recordCount, 0), collectionMinutes: minutes, collectionSec: minutes * 60,
    cells: list, directions: { forward: 3, backward: 3, unknown: 0 },
    coverage: { percent: 50, coveredCells: 5, totalCells: 10 }, vehicleCounts: [['1호차', 10]],
    periods: {}, speed: null, lastVisitedAt: '2026-09-10T08:00:00+09:00',
  };
}
// 한 구간을 자동 구역 하나로 감싼 분석(유형은 교차로 밀집 — 후보 시간대 출근·점심·퇴근)
function oneSegmentAnalysis(seg, type) {
  const t = type || 'junction_cluster';
  const s = { ...seg, semanticTypes: [{ type: t, confidence: 'medium', basis: '테스트', source: 'graph' }], primaryType: t };
  const T = AZ.SEMANTIC_TYPES[t];
  return {
    segments: [s],
    zones: [{ id: `z:${seg.id}`, parentZone: '강남', name: seg.label, semanticType: t, semanticLabel: T.label, segmentIds: [seg.id], candidateTimes: T.candidateTimes.slice(), expects: T.expects.slice(), active: true, basis: ['테스트'] }],
    dataLevels: {}, notes: [],
  };
}
// 모든 요일 유형 × 시간대 × 조도 × 방향을 목표(60분) 이상 채운 구간 — 실제 집계처럼 조도·방향이 칸마다 따로 있다
// 사업 우선 정책(설정 데이터) — 9월은 ⑤ 중심, 10월은 ⑩ 중심. 코드에는 어느 구역이 우선인지 없다.
const SEPT = { policyId: 'p-2026-09', policyName: '2026년 9월 HD Map 우선수집 정책', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30',
  areaPriorities: { 5: 100, 1: 70, 2: 70, 6: 70, 9: 70, 10: 70 }, updatedAt: '2026-09-01T00:00:00Z' };
const OCT = { policyId: 'p-2026-10', policyName: '2026-10 우선 수집 요청', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31',
  areaPriorities: { 10: 100, 9: 80, 6: 50, 5: 10 }, updatedAt: '2026-09-25T00:00:00Z' };
const OCT_NOW = '2026-10-15T01:00:00Z';   // 목요일
const FULL = TC.TRAFFIC_PERIOD_IDS.flatMap(p => ['weekday', 'weekend'].flatMap(w => TC.LIGHT_CONDITION_IDS.flatMap(l => ['forward', 'backward'].map(d => ({ weekdayType: w, trafficPeriod: p, lightCondition: l, direction: d, collectionMinutes: 90 })))));

async function main() {
  const segments = realSegments();
  const inArea = no => segments.filter(s => s.lengthM >= 80 && R.projectPriorityOf(s, AREAS, SEPT).areaNo === no);

  // ══════════════════════════════════════════════════════
  section('A. 지도 POI → 자동 분류');
  // ══════════════════════════════════════════════════════
  const seg0 = segments.find(s => s.lengthM >= 150) || segments[0];
  const c = seg0.center;
  const overpass = { elements: [
    { type: 'node', id: 1, lat: c.lat, lon: c.lng, tags: { amenity: 'school', name: '테스트초' } },
    { type: 'node', id: 2, lat: c.lat + 0.0002, lon: c.lng, tags: { office: 'company' } },
    { type: 'node', id: 3, lat: c.lat - 0.0002, lon: c.lng, tags: { office: 'company' } },
    { type: 'way', id: 4, center: { lat: c.lat, lon: c.lng + 0.0002 }, tags: { building: 'office' } },
    { type: 'node', id: 5, lat: c.lat, lon: c.lng, tags: { highway: 'bus_stop' } },
    { type: 'node', id: 6, lat: c.lat + 0.0001, lon: c.lng, tags: { railway: 'subway_entrance' } },
    { type: 'node', id: 7, lat: 37.60, lon: 127.20, tags: { amenity: 'hospital' } },   // 멀리 있는 병원
    { type: 'node', id: 8, lat: c.lat, lon: c.lng, tags: { amenity: 'bench' } },       // 분류하지 않는 태그
  ] };
  const poi = PD.parseOverpassPoi(overpass, { fetchedAt: NOW, bboxKey: 'k' });
  check('1. Overpass 응답을 학교·업무·역/정류장·병원으로 나누고, 모르는 태그는 버린다',
    poi.schools.length === 1 && poi.offices.length === 3 && poi.transit.length === 2 && poi.hospitals.length === 1
      && poi.commercial.length === 0 && poi.coveredCategories.includes('schools') && !poi.coveredCategories.includes('officialSchoolZones'),
    `학교 ${poi.schools.length} · 업무 ${poi.offices.length} · 역/정류장 ${poi.transit.length} · 병원 ${poi.hospitals.length}`);

  const classified = AZ.classifySegments([{ ...seg0 }], {}, { poi, today: TODAY })[0];
  const types = classified.semanticTypes.map(t => t.type);
  check('2. POI 가 실제로 classifySegments 에 들어가 학교 인접·업무 밀집·역 인접으로 판정된다',
    types.includes('school_adjacent') && types.includes('office_district') && types.includes('transit_hub') && !types.includes('hospital_zone'),
    types.join(', '));
  check('   판정마다 근거와 confidence 를 남긴다',
    classified.semanticTypes.filter(t => t.source === 'poi').every(t => t.basis && t.confidence),
    classified.semanticTypes.filter(t => t.source === 'poi').map(t => `${t.type}:${t.confidence}`).join(' '));
  check('   학교 POI 만으로 공식 어린이보호구역이라 하지 않는다', !types.includes('official_school_zone'));

  const noPoi = AZ.buildAnalysis({ parentZone: '강남', segments: [{ ...seg0 }], segmentStats: {}, today: TODAY, poi: null });
  check('3. POI 가 없으면 시설 기반 분류 없이 GPS/HD Map 만으로 판정하고 "지도 POI 데이터 없음"을 남긴다',
    noPoi.segments.every(s => !s.semanticTypes.some(t => t.source === 'poi')) && noPoi.notes.some(n => n.startsWith('지도 POI 데이터 없음'))
      && noPoi.dataLevels.poi === false && noPoi.dataLevels.poiRevision === 'none',
    noPoi.notes[0].slice(0, 40));

  const withPoi = AZ.buildAnalysis({ parentZone: '강남', segments: [{ ...seg0 }], segmentStats: {}, today: TODAY, poi });
  check('   POI 가 있으면 받은 종류·개수와 받지 않은 종류를 따로 적는다',
    withPoi.dataLevels.poi && withPoi.notes.some(n => /지도 POI 사용: 학교 1곳/.test(n)) && withPoi.dataLevels.poiSummary.counts.schools === 1,
    withPoi.notes.find(n => /지도 POI 사용/.test(n)));

  // 아파트 단지는 경계로 판정 — 중심이 멀어도 경계가 도로에 붙어 있으면 인접
  // 구간 바로 남쪽(약 55m)에 윗변이 붙은 큰 단지 — 중심은 도로에서 수백 m 떨어져 있다
  const bb = SZ.polygonBounds(seg0.geometry.concat([seg0.geometry[0]]));
  const topLat = bb.minLat - 0.0005, bottomLat = bb.minLat - 0.008;
  const bigComplex = [[topLat, bb.minLng - 0.001], [topLat, bb.maxLng + 0.001], [bottomLat, bb.maxLng + 0.001], [bottomLat, bb.minLng - 0.001]];
  const cache = { fetchedAt: Date.parse(NOW), buildings: { explicitComplexPolygons: [bigComplex], apartmentPolygons: [], buildingPolygons: [], parkingPolygons: [] } };
  const aptPoi = PD.fromBuildingCache(cache);
  const centerDist = SZ.distanceM(aptPoi.residential[0].lat, aptPoi.residential[0].lng, seg0.center.lat, seg0.center.lng);
  check('4. 누적 지도가 받아 둔 아파트 단지 경계를 POI 로 쓰고, 중심이 멀어도 경계로 인접을 판정한다',
    aptPoi.coveredCategories.join() === 'residential' && centerDist > 120
      && AZ.nearSegment(seg0, aptPoi.residential[0], 120) === true
      && AZ.nearSegment(seg0, { lat: aptPoi.residential[0].lat, lng: aptPoi.residential[0].lng }, 120) === false,
    `단지 중심까지 ${Math.round(centerDist)}m — 중심점만으로는 인접 아님, 경계로는 인접`);
  check('   멀리 떨어진 단지 경계는 인접으로 보지 않는다',
    AZ.nearSegment(seg0, { polygon: bigComplex.map(([la, lo]) => [la + 0.05, lo]) }, 120) === false);
  const merged = PD.mergePoi([poi, aptPoi, null]);
  check('   출처를 합쳐도 같은 요소를 두 번 세지 않는다',
    merged.schools.length === 1 && merged.residential.length === 1 && merged.sources.length === 2
      && PD.mergePoi([poi, poi]).offices.length === 3 && PD.mergePoi([]) === null);

  check('5. poiDataRevision 은 실제 데이터 지문이다 — 없으면 none, 바뀌면 달라지고 같으면 같다',
    AZ.poiRevision(null) === 'none' && AZ.poiRevision(poi) === AZ.poiRevision(PD.parseOverpassPoi(overpass, { fetchedAt: '다른 시각' }))
      && AZ.poiRevision(poi) !== AZ.poiRevision(merged),
    `${AZ.poiRevision(poi)} / ${AZ.poiRevision(merged)}`);

  const db = new RouteDatabase(freshPath());
  db.saveZonePolygons({ ...db.getZonePolygons(), 강남: POLYGON });
  // 실제 주행 기록 파일 하나 — 원본 불변 확인(G)에 쓴다
  const XLSX_DIR = path.join(__dirname, '..', '주행기록');
  const firstFile = fs.readdirSync(XLSX_DIR).filter(f => /\.xlsx?$/i.test(f)).sort()[0];
  const buf = fs.readFileSync(path.join(XLSX_DIR, firstFile));
  db.importRecords(RouteParser.parseBuffer(buf), { filename: firstFile, fileHash: RouteDatabase.hashFile(buf) });
  const a1st = db.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  const a2nd = db.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY, poi });
  const a3rd = db.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY, poi });
  check('6. 저장소(SQLite) 자동 분석이 넘겨받은 POI 로 분류하고 revision 에 POI 지문을 남긴다',
    a1st.revisions.poiDataRevision === 'none' && a2nd.revisions.poiDataRevision === AZ.poiRevision(poi)
      && a2nd.segments.some(s => s.semanticTypes.some(t => t.source === 'poi')) && !a1st.segments.some(s => s.semanticTypes.some(t => t.source === 'poi')),
    `none → ${a2nd.revisions.poiDataRevision}`);
  check('   POI 만 바뀌면 도로망·GPS 집계는 다시 하지 않는다(무거운 단계 캐시 재사용)',
    a2nd.stages.join() === '도로망 재사용,GPS 집계 재사용' && a3rd.cached === true, a2nd.stages.join(' / '));

  // ══════════════════════════════════════════════════════
  section('B. 도로 Segment 추천 — 평일/주말 후보');
  // ══════════════════════════════════════════════════════
  const segW = segments.find(s => s.lengthM >= 120);
  const recsFor = cells => R.buildSegmentRecommendations({
    analysis: oneSegmentAnalysis(segW), segmentStats: cells ? { [segW.id]: stat(cells) } : {}, now: NOW,
    segmentSettings: { maxCandidatesPerSegment: 50, resultCount: 50 },
  }).allRecommendations;
  const wdOf = list => [...new Set(list.map(r => r.condition.weekdayType))].sort().join(',');
  const periods = AZ.SEMANTIC_TYPES.junction_cluster.candidateTimes;
  const weekdayFull = periods.map(p => ({ weekdayType: 'weekday', trafficPeriod: p, collectionMinutes: 90 }));
  const weekendFull = periods.map(p => ({ weekdayType: 'weekend', trafficPeriod: p, collectionMinutes: 90 }));
  const onlyWeekend = recsFor(weekdayFull);
  const onlyWeekday = recsFor(weekendFull);
  const none = recsFor(null);
  check('7. 평일은 충분하고 주말이 부족하면 주말 후보만 만든다', wdOf(onlyWeekend) === 'weekend', wdOf(onlyWeekend));
  check('   주말은 충분하고 평일이 부족하면 평일 후보만 만든다', wdOf(onlyWeekday) === 'weekday', wdOf(onlyWeekday));
  check('   기록이 전혀 없는 구간은 평일·주말 둘 다 후보가 된다', wdOf(none) === 'weekday,weekend', wdOf(none));
  check('   둘 다 부족하면 둘 다 만든다', wdOf(recsFor([{ weekdayType: 'weekday', trafficPeriod: periods[0], collectionMinutes: 10 }])) === 'weekday,weekend');
  check('8. 추천 카드에 평일/주말이 구분돼 표시되고, 후보로 고른 근거가 남는다',
    onlyWeekend.every(r => r.weekdayLabel === '주말' && /주말/.test(r.conditionLabel) && /목표 60분 미달/.test(r.weekdayBasis))
      && none.some(r => r.weekdayLabel === '평일'),
    onlyWeekend[0] && onlyWeekend[0].weekdayBasis);

  // ══════════════════════════════════════════════════════
  section('C. 사업 우선도 — Priority Policy(설정 데이터)');
  // ══════════════════════════════════════════════════════
  const PP = require('../src/js/priority-policy.js');
  const in5 = inArea(5), in10 = inArea(10);
  const in7 = inArea(7);
  const pp = (seg, policy) => R.projectPriorityOf(seg, AREAS, policy);
  check('9. 구간이 속한 구역을 경계로 찾고, 우선도는 정책의 areaPriorities 에서 읽는다',
    in5.length > 0 && in10.length > 0 && in7.length > 0
      && pp(in5[0], SEPT).value === 100 && pp(in10[0], SEPT).value === 70
      && pp(in5[0], OCT).value === 10 && pp(in10[0], OCT).value === 100
      && pp(in7[0], SEPT).value === 0,
    `9월 ⑤ ${pp(in5[0], SEPT).value} · ⑩ ${pp(in10[0], SEPT).value} → 10월 ⑤ ${pp(in5[0], OCT).value} · ⑩ ${pp(in10[0], OCT).value}`);
  check('   단계 이름은 값에서 나온다(100 최우선 · 80 우선 · 50 보조 · 10 일반 · 0 비우선) — 구역 번호와 무관',
    pp(in10[0], OCT).label === '사업 우선 구축지역 ⑩' && pp(inArea(9)[0], OCT).label === '우선 수집 구역 ⑨'
      && pp(inArea(6)[0], OCT).label === '보조 수집 구역 ⑥' && pp(in7[0], OCT).label === '비우선 구역 ⑦' && pp(in5[0], OCT).label === '일반 구역 ⑤'
      && /정책 "2026-10 우선 수집 요청"/.test(pp(in10[0], OCT).basis),
    [in10, inArea(9), inArea(6), in5, in7].map(list => pp(list[0], OCT).label).join(' · '));

  const twoSeg = (a, b, statsA, statsB, extra, opts) => {
    const A = oneSegmentAnalysis(a), B = oneSegmentAnalysis(b);
    const o2 = opts || {};
    return R.buildSegmentRecommendations({
      analysis: { segments: A.segments.concat(B.segments), zones: A.zones.concat(B.zones), dataLevels: {}, notes: [] },
      segmentStats: { ...(statsA ? { [a.id]: stat(statsA) } : {}), ...(statsB ? { [b.id]: stat(statsB) } : {}) },
      priorityAreas: AREAS, priorityPolicies: 'priorityPolicies' in o2 ? o2.priorityPolicies : [SEPT, OCT],
      now: o2.now || NOW, segmentSettings: { maxCandidatesPerSegment: 50, resultCount: 100, ...(extra || {}) },
    });
  };
  const other = in7[0];
  const partial = periods.map(p => ({ weekdayType: 'weekday', trafficPeriod: p, collectionMinutes: 20 })).concat(weekendFull);
  const same = twoSeg(in5[0], other, partial, partial);
  const top = same.allRecommendations[0];
  check('10. 추천 엔진이 오늘 날짜의 활성 정책(9월)을 쓰고, 부족도가 같으면 그 정책의 최우선 구역이 위에 온다',
    same.policy.policyName === SEPT.policyName && top.segmentId === in5[0].id && top.projectPriority.applied && top.scoreComposition.project.value === 100,
    `${same.policy.policyName} · ${top.segmentLabel} ${top.score}`);
  const c5 = top.scoreComposition;
  check('    Data Need Score 와 Project Priority 를 따로 계산하고 Final 을 만든다 — 적용 정책을 결과에 남긴다',
    c5.dataNeedScore === top.dataNeedScore && c5.projectPriorityScore === 100
      && Math.abs(c5.final - Math.round((c5.dataNeedScore * 0.8 + 100 * 0.2) * 10) / 10) < 0.051
      && /^Final [\d.]+ = Data Need [\d.]+ × 80% \+ Project Priority 100 × 20%$/.test(c5.formula)
      && top.policy.policyName === SEPT.policyName && top.projectPriority.policyName === SEPT.policyName,
    `${c5.formula} · 정책 ${top.policy.policyName}`);

  const oct = twoSeg(in5[0], in10[0], partial, partial, null, { now: OCT_NOW });
  const octTop = oct.allRecommendations[0];
  check('11. 코드 수정 없이 정책만 바뀌면(10월: ⑩ 100 · ⑤ 10) 같은 데이터에서 ⑩ 이 위로 올라온다',
    oct.policy.policyName === OCT.policyName && octTop.segmentId === in10[0].id
      && oct.allRecommendations.find(r => r.segmentId === in5[0].id).projectPriority.value === 10,
    `${oct.policy.policyName} → 1위 ${octTop.segmentLabel}(${octTop.projectPriority.label})`);
  const sept2 = twoSeg(in5[0], in10[0], partial, partial);
  check('    같은 두 구간을 9월 정책으로 보면 ⑤ 가 위다(정책이 순위를 바꾼다)', sept2.allRecommendations[0].segmentId === in5[0].id);

  const saturated = twoSeg(in5[0], other, FULL, partial);
  const sat5 = saturated.allRecommendations.filter(r => r.segmentId === in5[0].id);
  const satOther = saturated.allRecommendations.filter(r => r.segmentId === other.id);
  check('12. 사업 우선도만 높은(이미 충분히 모은) 구간은 부족한 일반 구간보다 낮다 — 1위가 되지 않는다',
    saturated.allRecommendations[0].segmentId === other.id && Math.max(...sat5.map(r => r.score)) < Math.max(...satOther.map(r => r.score)),
    `최우선(충분) 최고 ${Math.max(...sat5.map(r => r.score))} < 일반(부족) 최고 ${Math.max(...satOther.map(r => r.score))}`);
  check('    목표를 채운 조건에는 사업 우선도를 더하지 않고 그 이유를 남긴다',
    sat5.every(r => !r.projectPriority.applied && /이미 목표/.test(r.projectPriority.skippedReason)),
    sat5[0] && sat5[0].projectPriority.skippedReason);

  const noPolicy = twoSeg(in5[0], other, partial, partial, null, { priorityPolicies: [] });
  const gapPolicy = twoSeg(in5[0], other, partial, partial, null, { now: '2026-11-19T01:00:00Z' });
  check('13. 적용 정책이 없으면(빈 목록·기간 밖) projectPriority 0 — 기존 부족도 점수 그대로',
    noPolicy.policy === null && noPolicy.projectPriority.applied === false && /적용되는 사업 우선 정책/.test(noPolicy.projectPriority.note)
      && noPolicy.allRecommendations.every(r => r.score === r.deficitScore && r.scoreComposition.projectPriorityScore === 0 && /적용 정책 없음/.test(r.scoreComposition.formula))
      && gapPolicy.policy === null,
    noPolicy.projectPriority.note);
  const seeded = twoSeg(in5[0], other, partial, partial, null, { priorityPolicies: undefined });
  check('    저장한 정책이 한 번도 없으면 구역 데이터 파일의 priority 로 만든 초기 정책을 쓴다(코드 값 아님)',
    seeded.policy && seeded.policy.policyId === PP.SEED_POLICY_ID && seeded.policy.areaPriorities['5'] === 100 && seeded.policy.areaPriorities['10'] === 70 && !('7' in seeded.policy.areaPriorities),
    seeded.policy && `${seeded.policy.policyName}: ${seeded.policy.summary}`);
  const zeroW = twoSeg(in5[0], other, partial, partial, { projectPriority: { weight: 0 } });
  check('    비중은 설정으로(0% 면 미사용 · 0~50% 만 허용)',
    zeroW.allRecommendations.every(r => r.score === r.deficitScore)
      && R.validateSegmentSettings({ projectPriority: { weight: 60 } }).ok === false
      && R.validateSegmentSettings({ projectPriority: { weight: 30 } }).ok === true
      && (() => { try { R.normalizeSegmentSettingsPatch({ segmentRecommendationSettings: { projectPriority: { weight: 90 } } }); return false; } catch (e) { return /0~50%/.test(e.message); } })());

  // 정책 선택·검증·보존
  const wide = { ...SEPT, policyId: 'wide', policyName: '하반기 기본', effectiveFrom: '2026-07-01', effectiveTo: '2026-12-31', updatedAt: '2026-09-29T00:00:00Z' };
  check('14. 기간이 겹치면 시작일이 늦은(더 구체적인) 정책을 쓴다',
    PP.activePolicy([wide, SEPT, OCT], '2026-09-17').policyId === SEPT.policyId
      && PP.activePolicy([wide, SEPT, OCT], '2026-11-02').policyId === 'wide'
      && PP.activePolicy([SEPT, OCT], '2026-12-01') === null
      && PP.overlaps([wide, SEPT]).length === 1);
  const bad = PP.mergePolicyPatch([], [{ policyName: 'x', effectiveFrom: '2026-10-31', effectiveTo: '2026-10-01', areaPriorities: { 5: 120 } }]);
  check('    잘못된 정책(기간 역전·0~100 밖·이름 없음)은 저장하지 않는다',
    !bad.ok && bad.errors.length === 2 && !PP.mergePolicyPatch([], [{ policyName: '' }]).ok, bad.errors.join(' / '));
  check('    프리셋 최우선 100 · 우선 70 · 보조 40 · 일반 10 · 비우선 0',
    PP.PRESETS.map(p => `${p.label}${p.value}`).join(',') === '최우선100,우선70,보조40,일반10,비우선0');

  const db2 = new RouteDatabase(freshPath());
  db2.setSettings({ priorityPolicies: [SEPT, OCT] });
  const edited = { ...OCT, areaPriorities: { 10: 100, 9: 90 } };
  db2.setSettings({ priorityPolicies: [edited] });             // 9월 정책을 목록에서 빼고 10월만 수정해 보낸다
  const stored = db2.getSettings().priorityPolicies;
  const octStored = stored.find(p => p.policyId === OCT.policyId);
  check('15. 정책은 삭제되지 않는다 — 저장 목록에서 빠져도 보존, 수정하면 이전 버전이 history 에 남는다',
    stored.length === 2 && stored.some(p => p.policyId === SEPT.policyId)
      && octStored.areaPriorities['9'] === 90 && octStored.history.length === 1 && octStored.history[0].areaPriorities['5'] === 10
      && octStored.updatedAt !== OCT.updatedAt,
    `보존 ${stored.map(p => p.policyName).join(', ')} · 10월 이력 ${octStored.history.length}건`);
  let threwBad = false;
  try { db2.setSettings({ priorityPolicies: [{ ...SEPT, areaPriorities: { 5: 150 } }] }); } catch (_) { threwBad = true; }
  check('    잘못된 정책 저장은 거절하고 기존 정책을 그대로 둔다',
    threwBad && db2.getSettings().priorityPolicies.find(p => p.policyId === SEPT.policyId).areaPriorities['5'] === 100);
  db2.setRecommendationState('seg|x', { status: 'completed', snapshot: { collectionSec: 0, visitCount: 0 }, policy: { policyId: SEPT.policyId, policyName: SEPT.policyName, projectPriority: 100, label: '사업 우선 구축지역 ⑤', dataNeedScore: 82, score: 85.6 } });
  const st = db2.listRecommendationStates()['seg|x'];
  check('16. 완료·제외한 추천에 당시 적용 정책을 함께 저장한다(과거 추천 추적)',
    st.policy && st.policy.policyName === SEPT.policyName && st.policy.projectPriority === 100 && st.policy.dataNeedScore === 82);
  check('    정책이 바뀌면 캐시 지문이 달라진다(추천 재계산 근거)',
    PP.fingerprint([SEPT, OCT]) !== PP.fingerprint(stored) && PP.fingerprint([SEPT, OCT]) === PP.fingerprint([SEPT, OCT]));
  check('    백업 복원에서 잘못된 정책은 빼고 나머지 설정은 둔다',
    !('priorityPolicies' in R.sanitizeRecommendationSettings({ priorityPolicies: [{ policyName: '' }], other: 1 })));

  // ══════════════════════════════════════════════════════
  section('D. 주행 계획 — Road Graph 이동 시간 · 구역 변경 비용');
  // ══════════════════════════════════════════════════════
  const router = RG.buildRouter(HDMAP_GANGNAM.lines.concat(HDMAP_SEOCHO.lines));
  const P = { lat: 37.5006, lng: 127.0364 }, Q = { lat: 37.4837, lng: 127.0324 };
  const rq = router.route(P, Q);
  const straight = R.travelEstimate(P, Q, 30, null);
  const byRoad = R.travelEstimate(P, Q, 30, router);
  check('13. HD Map 도로망 최단 거리로 이동 시간을 잰다(직선보다 길고, 방법을 기록)',
    rq && rq.method === 'road_graph' && byRoad.method === 'road_graph' && byRoad.distanceKm > straight.distanceKm && straight.method === 'haversine',
    `도로 ${byRoad.distanceKm}km ${byRoad.minutes}분 · 직선 ${straight.distanceKm}km ${straight.minutes}분 · 노드 ${router.nodeCount} · 연결요소 ${router.componentCount}`);
  const failing = { route: () => null };
  check('    도로망으로 못 이으면(또는 계산 실패) 직선 거리로 대신한다',
    R.travelEstimate(P, Q, 30, failing).method === 'haversine'
      && R.travelEstimate(P, Q, 30, { route: () => { throw new Error('x'); } }).method === 'haversine'
      && R.travelEstimate(null, Q, 30, router) === null);

  // 구역 A·B 가 시간대마다 번갈아 근소하게 앞서는 추천 결과 — 비용이 없으면 A→B→A 로 오간다
  const zonesAB = [{ name: 'A', active: true, centerLat: P.lat, centerLng: P.lng }, { name: 'B', active: true, centerLat: Q.lat, centerLng: Q.lng }];
  // 점수 차(70 vs 60)는 이동 5분을 감안해도 옮길 만하지만, 구역 변경 비용·최소 체류까지 치면 머무는 편이 낫다
  const lead = { morning_peak: 'A', morning_offpeak: 'B', lunch_peak: 'A', afternoon_offpeak: 'B', evening_peak: 'A' };
  const recs = [];
  ['A', 'B'].forEach(zone => TC.TRAFFIC_PERIOD_IDS.forEach(p => [...TC.LIGHT_CONDITION_IDS, 'any'].forEach(l => recs.push({
    id: [zone, 'weekday', p, l].join('|'), zone, score: lead[p] === zone ? 70 : 60,
    need: { additionalMinutes: 500 }, priority: 'high',
  }))));
  const fakeResult = { today: TODAY, zones: [{ zone: 'A' }, { zone: 'B' }], recommendations: recs };
  const planOf = extra => R.buildDrivePlan({ result: fakeResult, zones: zonesAB, settings: {}, router, plan: { startTime: '08:00', endTime: '18:00', ...(extra || {}) } });
  const seqOf = p => p.lanes[0].blocks.map(b => b.zone).join('');
  const noCost = planOf({ switchPenaltyMinutes: 0, minStayMinutes: 0 });
  const withCost = planOf();
  check('14. 비용이 없으면 블록마다 오가던 계획(A→B→A)이 구역 변경 비용으로 줄어든다',
    noCost.totals.zoneSwitches >= 3 && withCost.totals.zoneSwitches < noCost.totals.zoneSwitches,
    `비용 없음 ${seqOf(noCost)}(${noCost.totals.zoneSwitches}회) → 기본 ${seqOf(withCost)}(${withCost.totals.zoneSwitches}회)`);
  const moved = noCost.lanes[0].blocks.find(b => b.switched);
  check('    옮긴 블록에 도로망 거리·방법·변경 비용이 남고, 수집 시간은 이동 시간만 뺀다',
    moved && moved.travelMethod === 'road_graph' && moved.travelDistanceKm > 0 && /도로망 최단 거리/.test(moved.reason)
      && withCost.lanes[0].blocks.every(b => b.collectMinutes === b.minutes - b.travelMinutes),
    moved && `${moved.from} ${moved.zone} ${moved.travelDistanceKm}km ${moved.travelMinutes}분`);
  check('    계획 한계에 이동 시간 산정 방법이 사실대로 적힌다(도로망 / 직선 fallback)',
    withCost.limitations[0].includes('HD Map 도로망 최단 거리') && planOf({ switchPenaltyMinutes: 0, minStayMinutes: 0 }).travelBasis === 'road_graph'
      && R.buildDrivePlan({ result: fakeResult, zones: zonesAB, settings: {}, router: failing, plan: { startTime: '08:00', endTime: '18:00', switchPenaltyMinutes: 0, minStayMinutes: 0 } }).limitations[0].includes('직선 거리'));
  check('    부족분이 확실히 크면(점수 차가 크면) 비용이 있어도 옮긴다',
    (() => {
      const big = recs.map(r => ({ ...r, score: r.zone === 'B' && r.id.includes('lunch_peak') ? 100 : (r.zone === 'A' ? 30 : 10) }));
      const p = R.buildDrivePlan({ result: { ...fakeResult, recommendations: big }, zones: zonesAB, settings: {}, router, plan: { startTime: '08:00', endTime: '18:00' } });
      return p.lanes[0].blocks.some(b => b.zone === 'B' && b.trafficPeriod === 'lunch_peak');
    })());

  // ══════════════════════════════════════════════════════
  section('E. 오늘 추천 Top 3');
  // ══════════════════════════════════════════════════════
  const pool = twoSeg(in5[0], other, partial, partial).allRecommendations
    .concat(R.buildSegmentRecommendations({ analysis: oneSegmentAnalysis(segW), segmentStats: {}, now: NOW, segmentSettings: { maxCandidatesPerSegment: 50 } }).allRecommendations);
  const picks = R.buildTodayPicks({ segmentRecs: pool, zoneRecs: [], states: {}, now: NOW, window: { start: '07:00', end: '12:00' }, vehicleCount: 1 });
  check('15. 오늘 요일 유형(목요일=평일)·운행 시간에 맞는 추천만, 구간당 하나씩 최대 3개',
    picks.weekdayType === 'weekday' && picks.items.length === 3 && new Set(picks.items.map(i => i.segmentId)).size === 3
      && picks.items.every(i => i.weekdayLabel === '평일' && i.window && TC.parseClock(i.window.start) < TC.parseClock('12:00')),
    picks.items.map(i => `${i.order}.${i.title} ${i.window.text} ${i.minutes}분`).join(' | '));
  check('    어디(구역·도로·방향) · 언제(시간) · 왜(이유)를 모두 갖는다',
    picks.items.every(i => i.title && i.route && i.window && i.reasonText && i.minutes > 0)
      && picks.items.some(i => /사업 우선 구축지역 ⑤/.test(i.reasonText)),
    picks.items.map(i => i.reasonText).join(' / '));
  const hiddenId = picks.items[0].id;
  const after = R.buildTodayPicks({ segmentRecs: pool, states: { [hiddenId]: { status: 'completed', snapshot: { collectionSec: 1e9, visitCount: 1e9 } } }, sessionHidden: new Set([picks.items[1].id]), now: NOW, window: { start: '07:00', end: '12:00' } });
  check('16. 숨김·완료한 추천은 빼고 다음 순위로 채운다',
    !after.items.some(i => i.id === hiddenId || i.id === picks.items[1].id) && after.items.length > 0);
  const weekend = R.buildTodayPicks({ segmentRecs: pool, now: '2026-09-19T01:00:00Z', window: { start: '07:00', end: '12:00' } });
  check('    토요일이면 주말 후보에서 고른다', weekend.weekdayType === 'weekend' && weekend.items.every(i => i.weekdayLabel === '주말'));
  const zoneOnly = R.buildTodayPicks({ segmentRecs: [], zoneRecs: [{ id: 'z|weekday|morning_peak|any', zone: '강남', condition: { weekdayType: 'weekday', trafficPeriod: 'morning_peak' }, timeRange: { start: '07:00', end: '10:00' }, score: 70, need: { additionalMinutes: 30, estimatedMinutesThisStage: 60, additionalVisits: 1, targetVisits: 2 }, current: { visitCount: 0, collectionSec: 0 }, breakdown: [{ key: 'timePeriod', label: '시간대 부족도', value: 80, contribution: 16 }] }], now: NOW, window: { start: '07:00', end: '12:00' } });
  check('    도로 구간 분석이 아직 없으면 구역 추천으로 대신하고 그 사실을 적는다',
    zoneOnly.source === 'zone' && zoneOnly.items.length === 1 && /출근 피크 데이터 부족/.test(zoneOnly.items[0].reasonText) && zoneOnly.notes.some(n => /구역 단위/.test(n)));

  // ══════════════════════════════════════════════════════
  section('F. Edge Case 점수');
  // ══════════════════════════════════════════════════════
  const ecOf = (type, cells, source) => {
    const A = oneSegmentAnalysis(segW, type);
    A.segments[0].semanticTypes[0].source = source || AZ.SEMANTIC_TYPES[type].requires;
    const out = R.buildSegmentRecommendations({ analysis: A, segmentStats: cells ? { [segW.id]: stat(cells) } : {}, now: NOW, segmentSettings: { maxCandidatesPerSegment: 50 } });
    return out.allRecommendations.map(r => r.breakdown.find(b => b.key === 'edgeCase'));
  };
  const many = ecOf('commercial_district', FULL, 'poi');       // 예상 상황 4가지
  const manyShort = ecOf('commercial_district', null, 'poi');
  check('17. 예상 상황이 많아도 이미 충분히 모은 조건이면 Edge Case 점수가 0이다(개수로 올리지 않음)',
    many.every(b => b.value === 0) && manyShort.every(b => b.value > 0),
    `충분 ${many[0].value} · 부족 ${manyShort[0].value}`);
  check('    Edge Case = 발생 가능성(분류 근거) × 이 조건 수집 부족 — 근거가 강할수록 높다',
    ecOf('junction_cluster', null, 'graph')[0].value < ecOf('commercial_district', null, 'poi')[0].value
      && /발생 가능성 0\.\d+.*× 이 조건 수집 부족/.test(manyShort[0].current),
    manyShort[0].current);

  // ══════════════════════════════════════════════════════
  section('G. 저장소 — 설정 · 원본 불변 · 두 저장소 일치');
  // ══════════════════════════════════════════════════════
  const snapshotRecords = () => JSON.stringify(db.db.get('SELECT COUNT(*) AS n, SUM(latitude) AS la, SUM(longitude) AS lo, MAX(id) AS mx FROM driving_records'));
  const before = snapshotRecords();
  let threw = false;
  try { db.setSettings({ segmentRecommendationSettings: { projectPriority: { weight: 80 } } }); } catch (_) { threw = true; }
  db.setSettings({ segmentRecommendationSettings: { projectPriority: { weight: 30 } } });
  check('18. 사업 우선도 설정을 저장하고, 잘못된 값은 저장하지 않는다',
    threw && db.getSettings().segmentRecommendationSettings.projectPriority.weight === 30);
  const restored = R.sanitizeRecommendationSettings({ segmentRecommendationSettings: { projectPriority: { weight: 99 } }, other: 1 });
  check('    백업 복원·동기화에서는 잘못된 도로 추천 설정만 빼고 나머지는 둔다',
    !('segmentRecommendationSettings' in restored) && restored.other === 1);
  db.setRecommendationState(pool[0].id, { status: 'completed', snapshot: { collectionSec: 0, visitCount: 0 } });
  check('19. 분석·설정·추천 상태 저장이 원본 주행 기록을 바꾸지 않는다',
    snapshotRecords() === before && JSON.parse(before).n > 0 && Object.keys(db.listRecommendationStates()).includes(pool[0].id),
    `기록 ${JSON.parse(before).n}건 그대로`);

  const fake = createFakeIndexedDB();
  const ctx = baseContext({ indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange, HDMAP_GANGNAM_ROADS: HDMAP_GANGNAM, HDMAP_SEOCHO_ROADS: HDMAP_SEOCHO });
  ['src/js/coverage-grid.js', 'src/js/collection-stats.js', 'src/js/time-conditions.js', 'src/js/issue-filter.js',
    'src/js/subzones.js', 'src/js/road-graph.js', 'src/js/auto-subzones.js', 'src/js/condition-stats.js',
    'src/js/priority-policy.js', 'src/js/recommendation.js', 'src/js/storage.js'].forEach(f => load(ctx, f));
  await ctx.RouteDB.init();
  await ctx.RouteDB.setSettings({ priorityPolicies: [SEPT, OCT] });
  await ctx.RouteDB.setSettings({ priorityPolicies: [{ ...OCT, areaPriorities: { 10: 100, 9: 90 } }] });
  const idbPolicies = (await ctx.RouteDB.getSettings()).priorityPolicies;
  await ctx.RouteDB.setRecommendationState('seg|y', { status: 'snoozed', until: '2026-10-01', policy: { policyId: OCT.policyId, policyName: OCT.policyName, projectPriority: 100 } });
  const idbState = (await ctx.RouteDB.listRecommendationStates())['seg|y'];
  check('21. IndexedDB 저장소도 정책을 보존·이력화하고, 추천 상태에 당시 정책을 남긴다',
    idbPolicies.length === 2 && idbPolicies.find(x => x.policyId === OCT.policyId).history.length === 1
      && idbState.policy && idbState.policy.policyName === OCT.policyName);
  await ctx.RouteDB.saveZonePolygons({ ...(await ctx.RouteDB.getZonePolygons()), 강남: POLYGON });
  const idb = await ctx.RouteDB.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY, poi });
  const idbNone = await ctx.RouteDB.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  check('20. IndexedDB 저장소도 같은 POI 지문을 남기고 같은 유형으로 분류한다',
    idb.revisions.poiDataRevision === a2nd.revisions.poiDataRevision && idbNone.revisions.poiDataRevision === 'none'
      && JSON.stringify(idb.segments.map(s => s.primaryType).sort()) === JSON.stringify(a2nd.segments.map(s => s.primaryType).sort()),
    idb.revisions.poiDataRevision);


  // ══════════════════════════════════════════════════════
  section('H. 추천 · 설정 · 통계가 같은 정책 · 같은 분류');
  // ══════════════════════════════════════════════════════
  const HPm = require('../src/js/hdmap-priority.js');
  const tierMap = policy => {
    // 설정 탭 배지 = listAreas(policy) · 통계 = buildComparison(policy) · 추천 = projectPriorityOf(policy)
    const settingsTiers = Object.fromEntries(HPm.listAreas(null, {}, policy).map(a => [a.areaNo, a.priorityLabel]));
    const cmp = HPm.buildComparison({ areas: HPm.listAreas(), stats: [], policy });
    const statsTiers = Object.fromEntries(cmp.rows.map(r => [r.areaNo, r.priorityLabel]));
    const recTiers = {};
    [5, 6, 7, 9, 10].forEach(no => { const s = inArea(no)[0]; if (s) recTiers[no] = R.projectPriorityOf(s, AREAS, policy).label; });
    return { settingsTiers, statsTiers, recTiers, cmp };
  };
  const recTierWord = label => (/^사업 우선 구축지역/.test(label) ? '최우선' : /^우선 수집/.test(label) ? '우선' : /^보조/.test(label) ? '보조' : /^일반/.test(label) ? '일반' : /^비우선/.test(label) ? '비우선' : label);
  const agree = t => Object.keys(t.recTiers).every(no => recTierWord(t.recTiers[no]) === t.settingsTiers[no] && t.statsTiers[no] === t.settingsTiers[no])
    && Object.keys(t.settingsTiers).every(no => t.statsTiers[no] === t.settingsTiers[no]);

  const t5 = tierMap(SEPT);
  check('22. ⑤ 중심 정책: 설정 배지 · 통계 묶음 · 추천 라벨이 모두 ⑤ 최우선 기준으로 같다',
    agree(t5) && t5.settingsTiers[5] === '최우선' && t5.cmp.summary.primary.areaNo === 5
      && t5.cmp.summary.priorityGroupAreaNos.join() === '5,1,2,6,9,10' && recTierWord(t5.recTiers[5]) === '최우선',
    `통계 우선지역 ${t5.cmp.summary.priorityGroupAreaNos.join(',')} · 추천 ⑤ ${t5.recTiers[5]}`);
  const t10 = tierMap(OCT);
  check('    ⑩ 중심 정책으로 바꾸면 세 화면 모두 ⑩ 최우선 · ⑨ 우선 · ⑥ 보조 · ⑤ 일반',
    agree(t10) && t10.settingsTiers[10] === '최우선' && t10.settingsTiers[9] === '우선' && t10.settingsTiers[6] === '보조' && t10.settingsTiers[5] === '일반'
      && t10.cmp.summary.primary.areaNo === 10 && t10.cmp.summary.priorityGroupAreaNos.join() === '10,9,6'
      && t10.cmp.summary.normalGroupAreaNos.includes(5),
    `통계 우선지역 ${t10.cmp.summary.priorityGroupAreaNos.join(',')} · 일반지역 ${t10.cmp.summary.normalGroupAreaNos.join(',')}`);
  const t0 = tierMap(null);
  check('    정책 없음: 모든 구역 비우선 · 통계 우선지역 0개 · 최우선 없음 · 추천 사업 우선도 0',
    agree(t0) && Object.values(t0.settingsTiers).every(l => l === '비우선')
      && t0.cmp.summary.priorityGroupAreaNos.length === 0 && t0.cmp.summary.primary === null
      && Object.values(t0.recTiers).every(l => /^비우선 구역 /.test(l)),
    `최우선 ${t0.cmp.summary.primary} · 우선지역 ${t0.cmp.summary.priorityGroupAreaNos.length}개`);
  // 같은 GPS 집계(stats)로 정책만 바꿔 다시 묶는다 — 집계를 다시 돌리지 않아도 된다
  const fakeStats = HPm.listAreas().map((a, i) => ({ id: a.id, recordCount: 10, collectionSec: (i + 1) * 60, collectionMinutes: i + 1, visitCount: 1 }));
  const g5 = HPm.buildComparison({ areas: HPm.listAreas(), stats: fakeStats, policy: SEPT });
  const g10 = HPm.buildComparison({ areas: HPm.listAreas(), stats: fakeStats, policy: OCT });
  check('23. 정책만 바꾸면 같은 집계로 묶음만 달라진다(수집 시간 값은 그대로 · 재집계 불필요)',
    g5.rows.map(r => r.collectionMinutes).join() === g10.rows.map(r => r.collectionMinutes).join()
      && g5.summary.priorityTotalMinutes !== g10.summary.priorityTotalMinutes
      && g10.policy.policyName === OCT.policyName,
    `우선지역 합 ${g5.summary.priorityTotalMinutes}분(⑤ 중심) → ${g10.summary.priorityTotalMinutes}분(⑩ 중심)`);


  // ══════════════════════════════════════════════════════
  section('I. 오늘 추천 Top 3 — 같은 도로의 다른 구간이 구분되고, 어디·언제·왜가 한눈에');
  // ══════════════════════════════════════════════════════
  const allSegs = RG.labelSegments(RG.buildSegments(RG.buildGraph(HDMAP_GANGNAM.lines.concat(HDMAP_SEOCHO.lines)), { parentZone: '강남' }));
  const allAn = AZ.buildAnalysis({ parentZone: '강남', segments: allSegs, segmentStats: {}, today: TODAY });
  const allRecs = R.buildSegmentRecommendations({ analysis: allAn, segmentStats: {}, now: NOW, priorityAreas: AREAS, priorityPolicies: [SEPT], segmentSettings: { resultCount: 5000, maxCandidatesPerSegment: 1 } }).allRecommendations;
  const gyeongbu = allRecs.filter(r => r.roadName === '경부고속도로');
  const gyeongbuNumbered = gyeongbu.filter(r => /구간 #\d+$/.test(r.displayName));
  check('24. 교차 도로 이름이 없는 구간은 "도로명 · 구간 #N"(짧은 번호) — 내부 segmentId 를 보여주지 않는다',
    gyeongbu.length >= 3 && gyeongbu.filter(r => !r.fromName || !r.toName).every(r => /^경부고속도로 · 구간 #\d+$/.test(r.displayName)) && gyeongbu.every(r => !r.displayName.includes(r.segmentId))
      && new Set(gyeongbu.map(r => r.displayName)).size === gyeongbu.length,
    gyeongbu.slice(0, 3).map(r => r.displayName).join(' | '));
  const crossNamed = allRecs.filter(r => r.fromName && r.toName && r.fromName !== r.toName);
  check('    교차 도로 이름이 지도 데이터에 있으면 "도로명 · A → B" — 이름은 실제 HD Map 도로명만',
    crossNamed.length > 0 && crossNamed.every(r => r.displayName === `${r.roadName} · ${r.fromName} → ${r.toName}`
      && allSegs.some(s => s.roadName === r.fromName) && allSegs.some(s => s.roadName === r.toName)),
    crossNamed.slice(0, 2).map(r => r.displayName).join(' | '));
  // 구간 번호는 다시 분석해도 같다(안정적)
  const again = R.buildSegmentRecommendations({ analysis: AZ.buildAnalysis({ parentZone: '강남', segments: RG.labelSegments(RG.buildSegments(RG.buildGraph(HDMAP_GANGNAM.lines.concat(HDMAP_SEOCHO.lines)), { parentZone: '강남' })), segmentStats: {}, today: TODAY }), segmentStats: {}, now: NOW, segmentSettings: { resultCount: 5000, maxCandidatesPerSegment: 1 } }).allRecommendations;
  const nameById = new Map(again.map(r => [r.segmentId, r.displayName]));
  check('    구간 번호·이름은 다시 분석해도 같다', allRecs.every(r => nameById.get(r.segmentId) === r.displayName));

  // 같은 도로 3구간이 Top 3 를 차지하는 경우(정책 없음 · 경부고속도로)
  const threeSame = gyeongbuNumbered.slice(0, 3).map((r, i) => ({ ...r, score: 90 - i }));
  const tp = R.buildTodayPicks({ segmentRecs: threeSame, now: NOW });
  check('25. 같은 도로명의 서로 다른 구간 3개가 Top 3 이면 서로 다른 이름으로 보인다',
    tp.items.length === 3 && new Set(tp.items.map(i => i.title)).size === 3 && tp.items.every(i => /^경부고속도로 · 구간 #\d+$/.test(i.title)),
    tp.items.map(i => i.title).join(' | '));
  const sameCross = [0, 1].map(i => ({ ...crossNamed[0], id: `x${i}`, segmentId: `seg${i}`, score: 80 - i, numberedName: `${crossNamed[0].roadName} · 구간 #${i + 1}` }));
  const tp2 = R.buildTodayPicks({ segmentRecs: sameCross, now: NOW });
  check('    교차 도로 이름까지 같으면 구간 번호로 바꿔 구분한다',
    new Set(tp2.items.map(i => i.title)).size === 2, tp2.items.map(i => i.title).join(' | '));
  const pick = R.buildTodayPicks({ segmentRecs: twoSeg(in10[0], other, partial, partial, null, { now: OCT_NOW }).allRecommendations, now: OCT_NOW, window: { start: '07:00', end: '20:00' } }).items[0];
  check('26. 어디(도로 · 구간) · 언제(평일 시간 · 약 N분) · 왜(부족 이유) + 사업 우선도(활성 정책) 가 따로 보인다',
    pick && /·/.test(pick.title) && /^평일 \d{2}:\d{2}~\d{2}:\d{2} · 약 \d+분$/.test(pick.whenText)
      && pick.whyText && !/사업 우선/.test(pick.whyText) && pick.projectLabel === '사업 우선 구축지역 ⑩',
    pick && `${pick.title} / ${pick.whenText} / ${pick.whyText} / ${pick.projectLabel}`);
  const noPolPick = R.buildTodayPicks({ segmentRecs: twoSeg(in10[0], other, partial, partial, null, { priorityPolicies: [] }).allRecommendations, now: NOW, window: { start: '07:00', end: '20:00' } }).items[0];
  check('    정책이 없으면 사업 우선도 줄은 나오지 않는다(비우선 = 사업 우선도 없음)', noPolPick && noPolPick.projectLabel === null);
  check('27. 초기 정책의 ③④⑦⑧⑪⑫ 는 0(비우선) 그대로 — 표시를 위해 점수를 올리지 않는다',
    [3, 4, 7, 8, 11, 12].every(n => PP.areaValue(PP.seedFromAreas(AREAS), n) === 0 && PP.classifyArea(PP.seedFromAreas(AREAS), n).label === '비우선'));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('실패:', failures.join(' | ')); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
