// ══════════════════════════════════════════════════════════
//  recommendation-test — 추천 주행 엔진(순수 함수)
//
//   A. 점수 계산 — 0/100 경계 · 기본 가중치 · 가중치 합계 검증 · 범위 · 같은 입력 = 같은 결과
//   B. 추천 순위 — 부족한 시간대/낮은 Coverage/오래된 미방문/차량 편중이 위로 · 내림차순 · 동점 규칙
//   C. 데이터 누락 — 없는 날씨를 만들지 않음 · GPS/시각 누락 시 신뢰도 하향·시간대 추천 제외 · 빈 데이터
//   D. Edge Case — 조건별 규칙 적용 · 근거 없으면 생성 안 함 · 가능성 표현
//   E. 권장 시간·횟수 — 일출/일몰 기준 시간 범위, 추가 방문·수집 시간 계산, 단계 상한
//   F. LLM 전달 구조 — 구조화된 사실만(원본 GPS·사람/차량 이름 없음)
//
//  실행: node tests/recommendation-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const TC = require('../src/js/time-conditions.js');
const CSt = require('../src/js/condition-stats.js');
const CS = require('../src/js/collection-stats.js');
const R = require('../src/js/recommendation.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  [32mPASS[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  [31mFAIL[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n[36m${t}[0m`);

const CFG = TC.classificationConfig({});
const NOW = '2026-09-16T01:00:00Z';               // 한국 시간 2026-09-16(수) 10:00
const GANGNAM = { lat: 37.4979, lng: 127.0276 };
const hms = sec => [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map(n => String(n).padStart(2, '0')).join(':');

function rows(date, opt) {
  const o = Object.assign({ zone: '강남', vehicle: '토레스 1호차', weather: '맑음', start: '09:00:00', count: 121, step: 30, speed: '20.0', lat: GANGNAM.lat, lng: GANGNAM.lng }, opt || {});
  const [h, m, s] = o.start.split(':').map(Number);
  const t0 = h * 3600 + m * 60 + s;
  return Array.from({ length: o.count }, (_, i) => ({
    date, time: hms(t0 + i * o.step), vehicle: o.vehicle, zone: o.zone, weather: o.weather,
    speed: o.speed, lat: o.lat + i * 0.00002, lng: o.lng,
  }));
}
function daySummary(date, allRows, extra) {
  return Object.assign({
    date, count: allRows.length,
    collectionSec: CS.validDurationSec(allRows), driveSpanSec: CS.spanDurationSec(allRows),
    quality: { gaps: 0, teleports: 0, total: 0 },
  }, CSt.buildConditionSummary(allRows, CFG), extra || {});
}
const zone = (name, lat, lng, extra) => Object.assign({ name, centerLat: lat, centerLng: lng, active: true, sortOrder: 0, polygon: [], manualCells: {} }, extra || {});
const ZONES = [zone('강남', GANGNAM.lat, GANGNAM.lng), zone('판교', 37.385, 127.115, { sortOrder: 1 })];
const build = (summaries, opt) => R.buildRecommendations(Object.assign({ summaries, zones: ZONES, settings: {}, coverageSnapshots: [], now: NOW }, opt || {}));
const find = (res, id) => res.recommendations.find(r => r.id === id);

// ── A ───────────────────────────────────────────────────
section('A. 점수 계산');
const zeroScores = Object.fromEntries(R.SCORE_KEYS.map(k => [k, 0]));
const fullScores = Object.fromEntries(R.SCORE_KEYS.map(k => [k, 100]));
check('1. 모든 하위 점수가 0이면 최종 점수 0', R.calculateRecommendationScore(zeroScores, R.DEFAULT_SETTINGS.weights).score === 0);
check('2. 모든 하위 점수가 100이면 최종 점수 100', R.calculateRecommendationScore(fullScores, R.DEFAULT_SETTINGS.weights).score === 100);
R.SCORE_KEYS.forEach(k => {
  const only = Object.assign({}, zeroScores, { [k]: 100 });
  const got = R.calculateRecommendationScore(only, R.DEFAULT_SETTINGS.weights).score;
  check(`3. 기본 가중치가 그대로 적용된다 — ${R.SCORE_LABELS[k]} 100점 → ${R.DEFAULT_SETTINGS.weights[k]}점`, got === R.DEFAULT_SETTINGS.weights[k], `${got}점`);
});
{
  const bad = R.defaultRecommendationSettings();
  bad.weights.timePeriod = 40;
  const v = R.validateRecommendationSettings(bad);
  check('4. 가중치 합계가 100%가 아니면 저장 거부(이유 표시)', !v.ok && v.errors.some(e => /합계가 120/.test(e)), v.errors.join(' | '));
  let threw = null;
  try { R.normalizeRecommendationPatch({ recommendationSettings: bad }); } catch (e) { threw = e; }
  check('   설정 패치도 같은 검증으로 막는다', !!threw && Array.isArray(threw.errors));
  const ok = R.validateRecommendationSettings(R.defaultRecommendationSettings());
  check('   기본값은 합계 100%로 통과', ok.ok && R.SCORE_KEYS.reduce((a, k) => a + ok.settings.weights[k], 0) === 100);
}
{
  const wild = R.calculateRecommendationScore({ timePeriod: 500, coverage: -80, lightCondition: 100, weatherDiversity: 100, staleness: 100, vehicleImbalance: 100 }, R.DEFAULT_SETTINGS.weights);
  check('5. 점수가 0~100 범위를 벗어나지 않는다', wild.score <= 100 && wild.score >= 0 && wild.breakdown.every(b => b.value === null || (b.value >= 0 && b.value <= 100)), `${wild.score}점`);
  const empty = R.calculateRecommendationScore({}, R.DEFAULT_SETTINGS.weights);
  check('   모든 항목이 데이터 없음이면 점수 null(판단 불가)', empty.score === null && R.priorityOf(null).id === 'none');
}
{
  const s = [daySummary('2026-09-14', rows('2026-09-14', {}))];
  const a = build(s), b = build(s);
  check('6. 같은 입력은 항상 같은 추천 결과', JSON.stringify(a.recommendations) === JSON.stringify(b.recommendations), `${a.candidateCount}개 후보`);
  const shuffled = build([...s].reverse());
  check('   요약 순서가 달라도 같은 순위', JSON.stringify(shuffled.recommendations.map(r => r.id)) === JSON.stringify(a.recommendations.map(r => r.id)));
}

// ── B ───────────────────────────────────────────────────
section('B. 추천 순위');
{
  // 평일 출근 피크만 충분히 수집(3일 × 2시간), 퇴근 피크는 없음
  const s = ['2026-09-14', '2026-09-15', '2026-09-16'].map(d => daySummary(d, rows(d, { start: '07:30:00', count: 241 })));
  const res = build(s);
  const morning = find(res, '강남|weekday|morning_peak|daylight');
  const evening = find(res, '강남|weekday|evening_peak|daylight');
  check('7. 부족한 시간대(퇴근)가 충분한 시간대(출근)보다 높은 순위',
    evening.rank < morning.rank && evening.score > morning.score,
    `퇴근 ${evening.rank}위 ${evening.score}점(${evening.current.collectionMinutes}분) · 출근 ${morning.rank}위 ${morning.score}점(${morning.current.collectionMinutes}분)`);
  check('   같은 조건에서 시간대 부족도 점수가 실제로 낮다', morning.subScores.timePeriod < evening.subScores.timePeriod);
}
{
  const s = [daySummary('2026-09-14', [...rows('2026-09-14', {}), ...rows('2026-09-14', { zone: '판교', lat: 37.385, lng: 127.115 })])];
  const snaps = [
    { zone: '강남', total: 1000, visited: 300, unvisited: 700, coveragePct: 30, provisional: false, fresh: true, computedAt: '2026-09-15T00:00:00Z' },
    { zone: '판교', total: 1000, visited: 950, unvisited: 50, coveragePct: 95, provisional: false, fresh: true, computedAt: '2026-09-15T00:00:00Z' },
  ];
  const res = build(s, { coverageSnapshots: snaps });
  const g = find(res, '강남|weekday|morning_peak|daylight'), p = find(res, '판교|weekday|morning_peak|daylight');
  check('8. Coverage 가 낮은 구역이 높은 구역보다 높은 순위(같은 조건)',
    g.score > p.score && g.subScores.coverage > p.subScores.coverage,
    `강남 ${g.score}점(Coverage 30%) · 판교 ${p.score}점(Coverage 95%)`);
  check('   Coverage 부족도 = (목표−현재)/목표×100', g.subScores.coverage === 62.5 && p.subScores.coverage === 0, `강남 ${g.subScores.coverage} · 판교 ${p.subScores.coverage}`);
  const stale = build(s, { coverageSnapshots: snaps.map(x => Object.assign({}, x, { fresh: false, staleReason: '주행 데이터가 바뀐 뒤 다시 계산하지 않음' })) });
  const gs = find(stale, '강남|weekday|morning_peak|daylight');
  check('   오래된 Coverage 스냅샷은 점수에서 제외하고 이유를 남긴다',
    gs.subScores.coverage === null && /다시 계산하지 않음/.test(gs.coverage.reason || '') && gs.confidence.reasons.some(r => /Coverage/.test(r.text)), gs.coverage.reason);
}
{
  const recent = [daySummary('2026-09-15', rows('2026-09-15', { start: '13:30:00', count: 61 }))];
  const old = [daySummary('2026-08-01', rows('2026-08-01', { start: '13:30:00', count: 61 }))];
  const a = find(build(recent), '강남|weekday|afternoon_offpeak|daylight');
  const b = find(build(old), '강남|weekday|afternoon_offpeak|daylight');
  check('9. 오랫동안 방문하지 않은 조건의 우선순위가 높다',
    b.score > a.score && b.subScores.staleness > a.subScores.staleness,
    `1일 전 ${a.score}점(${a.subScores.staleness}) · 46일 전 ${b.score}점(${b.subScores.staleness})`);
}
{
  const even = [daySummary('2026-09-14', [...rows('2026-09-14', { vehicle: '토레스 1호차', count: 61 }), ...rows('2026-09-14', { vehicle: '토레스 2호차', start: '09:30:00', count: 61 })])];
  const skewed = [daySummary('2026-09-14', [...rows('2026-09-14', { vehicle: '토레스 1호차', count: 115 }), ...rows('2026-09-14', { vehicle: '토레스 2호차', start: '09:58:00', count: 7 })])];
  const a = find(build(even), '강남|weekday|morning_peak|daylight');
  const b = find(build(skewed), '강남|weekday|morning_peak|daylight');
  check('10. 차량 편중이 큰 조건의 점수가 더 높다',
    b.subScores.vehicleImbalance > a.subScores.vehicleImbalance && b.score > a.score,
    `균등 ${a.subScores.vehicleImbalance}점 → ${a.score}점 · 편중 ${b.subScores.vehicleImbalance}점 → ${b.score}점`);
}
{
  const res = build([daySummary('2026-09-14', rows('2026-09-14', {}))]);
  const scores = res.recommendations.map(r => r.score);
  check('11. 추천은 점수 내림차순으로 정렬된다', scores.every((v, i) => i === 0 || scores[i - 1] >= v), `${scores[0]} → ${scores[scores.length - 1]}`);
  check('   rank 는 1부터 순서대로', res.recommendations.every((r, i) => r.rank === i + 1));
  const ties = res.recommendations.filter(r => r.score === res.recommendations[0].score);
  const sortedAgain = R.sortRecommendations([...res.recommendations].reverse(), 'score');
  check('12. 동점 정렬 규칙이 항상 같다(입력 순서를 뒤집어도 같은 순서)',
    JSON.stringify(sortedAgain.map(r => r.id)) === JSON.stringify(res.recommendations.map(r => r.id)), `동점 ${ties.length}개`);
  const byCoverage = R.sortRecommendations(res.recommendations, 'coverage');
  const byStale = R.sortRecommendations(res.recommendations, 'lastVisit');
  check('   다른 정렬(Coverage 낮은 순 · 마지막 방문 오래된 순)도 결정적',
    JSON.stringify(byCoverage.map(r => r.id)) === JSON.stringify(R.sortRecommendations([...res.recommendations].reverse(), 'coverage').map(r => r.id))
    && byStale[0].current.lastVisitedAt === null);
}

// ── C ───────────────────────────────────────────────────
section('C. 데이터 누락');
{
  const noWeather = [daySummary('2026-09-14', rows('2026-09-14', { weather: '' }))];
  const res = build(noWeather);
  const r = find(res, '강남|weekday|morning_peak|daylight');
  check('13. 날씨 데이터가 없으면 가상의 날씨를 만들지 않는다',
    r.condition.weather === null && r.subScores.weatherDiversity === null && res.dataset.weatherCategories.length === 0
    && !r.predictedEdgeCaseHints.some(h => h.code === 'RAIN_REFLECTION') && res.limitations.some(l => /날씨 기록이 없어/.test(l)),
    `weather=${r.condition.weather} · 날씨 점수 ${r.subScores.weatherDiversity}`);
  // Coverage·지도 Context·날씨·차량 편중은 근거가 없어 제외하고 남은 항목만 재정규화한다.
  const excluded = r.breakdown.filter(b => b.excluded).map(b => b.key).sort();
  check('   데이터가 없는 항목을 뺀 만큼 남은 가중치를 다시 100%로 나눈다(점수는 0~100)',
    excluded.join(',') === 'coverage,roadContext,vehicleImbalance,weatherDiversity' && r.availableWeight === 55 && r.score <= 100
    && Math.abs(r.breakdown.filter(b => !b.excluded).reduce((a2, b) => a2 + b.effectiveWeight, 0) - 100) < 0.05,
    `제외 ${excluded.join(',')} · 남은 가중치 ${r.availableWeight}%`);
}
{
  // GPS 를 못 읽은 기록(0,0) → 조도 unknown
  const bad = rows('2026-09-14', { count: 121 }).map(r => Object.assign({}, r, { lat: 0, lng: 0 }));
  const res = build([daySummary('2026-09-14', bad)]);
  const r = find(res, '강남|weekday|morning_peak|daylight');
  check('14. GPS 가 없으면 조도 조건을 unknown 으로 두고 신뢰도를 낮춘다',
    res.dataset.unknownRatios.lightCondition === 1 && r.confidence.level === 'low'
    && r.confidence.reasons.some(x => /GPS/.test(x.text)), `신뢰도 ${r.confidence.label} · ${r.confidence.reasons.map(x => x.text).join(' | ')}`);
  check('   그 기록은 조도별 추천의 현재 수집량에 들어가지 않는다', r.current.collectionMinutes === 0);
}
{
  const bad = rows('2026-09-14', { count: 121 }).map(r => Object.assign({}, r, { time: '' }));
  const res = build([daySummary('2026-09-14', bad)]);
  const r = find(res, '강남|weekday|morning_peak|daylight');
  check('15. Timestamp 가 없으면 시간대 추천에서 제외된다(기록 수 0)',
    res.dataset.unknownRatios.trafficPeriod === 1 && r.current.period.collectionMinutes === 0 && r.current.recordCount === 0
    && r.confidence.reasons.some(x => /시각/.test(x.text)), `시각 불명 ${Math.round(res.dataset.unknownRatios.trafficPeriod * 100)}%`);
}
{
  const mixed = [
    ...rows('2026-09-14', { count: 61 }),
    ...rows('2026-09-14', { count: 61, start: '11:00:00' }).map(r => Object.assign({}, r, { zone: '', lat: 0, lng: 0, time: '' })),
  ];
  const res = build([daySummary('2026-09-14', mixed)]);
  const r = find(res, '강남|weekday|morning_peak|daylight');
  check('16. unknown 이 많은 데이터는 신뢰도를 낮춘다', r.confidence.level === 'low' && r.confidence.reasons.filter(x => x.severity === 'major').length >= 1,
    r.confidence.reasons.map(x => `${x.severity}:${x.text}`).join(' | '));
}
{
  const res = build([]);
  check('17. 데이터가 전혀 없으면 오류 없이 안내를 준다',
    res.empty === true && /주행 기록이 없어/.test(res.emptyReason) && res.recommendations.length === 0 && res.candidateCount === 0, res.emptyReason);
  const noZones = R.buildRecommendations({ summaries: [daySummary('2026-09-14', rows('2026-09-14', {}))], zones: [], settings: {}, coverageSnapshots: [], now: NOW });
  check('   활성 구역이 없을 때도 오류 없이 안내', noZones.empty === true && /구역/.test(noZones.emptyReason), noZones.emptyReason);
}

// ── D ───────────────────────────────────────────────────
section('D. Edge Case 규칙');
{
  const res = build([daySummary('2026-09-14', rows('2026-09-14', { weather: '비' }))]);
  const morning = find(res, '강남|weekday|morning_peak|daylight');
  check('18. 출근 피크 → 정체·합류·차선 변경·끼어들기 규칙',
    morning.predictedEdgeCaseHints.some(h => h.code === 'MORNING_RUSH_MERGE') && ['정체', '합류 차량', '끼어들기'].every(x => morning.expectedConditions.includes(x))
    && morning.predictedEdgeCaseHints.find(h => h.code === 'MORNING_RUSH_MERGE').evidence === 'trafficPeriod=morning_peak',
    morning.expectedConditions.join(','));
  const sunset = find(res, '강남|weekday|evening_peak|sunset');
  check('19. 일몰 전후 → 역광·조도 변화 규칙',
    sunset.predictedEdgeCaseHints.some(h => h.code === 'SUNSET_GLARE') && sunset.expectedConditions.includes('역광')
    && sunset.predictedEdgeCaseHints.find(h => h.code === 'SUNSET_GLARE').evidence === 'lightCondition=sunset', sunset.expectedConditions.join(','));
  check('20. 우천 → 반사·차선 가시성·물보라 규칙(기록에 있는 날씨일 때만)',
    morning.condition.weather === '비' && morning.predictedEdgeCaseHints.some(h => h.code === 'RAIN_REFLECTION')
    && ['노면 반사', '차선 가시성 저하', '물보라'].every(x => morning.expectedConditions.includes(x)));
  const lunchNoRain = build([daySummary('2026-09-14', rows('2026-09-14', { weather: '' }))]);
  const plain = find(lunchNoRain, '강남|weekday|afternoon_offpeak|daylight');
  check('21. 근거가 없으면 Edge Case 를 만들지 않는다(오후 비피크·주간·날씨 없음 → 규칙 0개)',
    plain.predictedEdgeCaseHints.length === 0 && plain.expectedConditions.length === 0);
  check('   도로 속성 데이터가 없는 규칙은 적용하지 않고 이유를 남긴다',
    morning.skippedEdgeCaseRules.map(x => x.code).sort().join(',') === 'APARTMENT_ADJACENT,INTERSECTION,SCHOOL_ZONE_ARRIVAL'
    && morning.skippedEdgeCaseRules.every(x => /정보가 없어/.test(x.reason)));
  const withRoadData = R.inferEdgeCaseHints({ trafficPeriod: 'morning_peak', lightCondition: 'daylight', weather: null }, { schoolZone: true });
  check('   데이터가 생기면 그 규칙이 적용되는 구조', withRoadData.applied.some(h => h.code === 'SCHOOL_ZONE_ARRIVAL'));
  const claims = /반드시|보장|확실|틀림없/;
  check('22. 발생을 확정하는 표현을 쓰지 않는다(가능성 표현 + 고지)',
    morning.predictedEdgeCaseHints.every(h => h.wording === '관찰 가능성이 높은 상황' && !claims.test(h.label))
    && /보장하지 않습니다/.test(morning.edgeCaseDisclaimer) && !claims.test(morning.reason) && morning.edgeCaseEvidenceLevel === 'condition_only'
    && morning.observedEdgeCases.length === 0);
}

// ── E ───────────────────────────────────────────────────
section('E. 권장 시간 · 횟수 · 수집 시간');
{
  const res = build([daySummary('2026-09-14', rows('2026-09-14', {}))]);
  const sunset = find(res, '강남|weekday|evening_peak|sunset');
  const sun = TC.sunTimes(sunset.timeRange.referenceDate, GANGNAM.lat, GANGNAM.lng);
  const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  check('권장 시간은 구역 위치·추천 날짜의 일몰에서 계산한다(고정 시각 아님)',
    toMin(sunset.timeRange.start) >= Math.floor(sun.sunsetMinutes - 30) && toMin(sunset.timeRange.end) <= Math.ceil(sun.sunsetMinutes + 30)
    && toMin(sunset.timeRange.start) >= 17 * 60 && toMin(sunset.timeRange.end) <= 20 * 60,
    `${sunset.timeRange.start}~${sunset.timeRange.end} (일몰 ${TC.formatClock(sun.sunsetMinutes)} · 기준일 ${sunset.timeRange.referenceDate})`);
  check('추천 기준일은 "다음 평일/주말"이다', TC.classifyWeekdayType(sunset.timeRange.referenceDate) === 'weekday'
    && sunset.timeRange.referenceDate > '2026-09-16' && /다음 평일/.test(sunset.timeRange.sunText), sunset.timeRange.referenceDate);
  const weekend = find(res, '강남|weekend|evening_peak|sunset');
  check('   주말 후보는 다음 주말 날짜로 계산', TC.classifyWeekdayType(weekend.timeRange.referenceDate) === 'weekend', weekend.timeRange.referenceDate);
  check('   그 시간대에 사실상 생기지 않는 조도 조합은 후보에서 뺀다(출근 피크 × 일몰 없음)',
    !find(res, '강남|weekday|morning_peak|sunset') && !!find(res, '강남|weekday|morning_peak|daylight'));
  const need = sunset.need;
  check('권장 횟수 = max(목표 방문 − 현재, ⌈부족 수집 시간 ÷ 회당 수집량⌉)',
    need.totalVisitsNeeded === Math.max(need.visitsByCount, need.visitsByMinutes) && need.additionalVisits === Math.min(need.totalVisitsNeeded, 3),
    `목표 ${need.targetVisits}회 · 부족 ${need.additionalMinutes}분 · 회당 ${need.perVisitMinutes}분 → ${need.totalVisitsNeeded}회(이번 ${need.additionalVisits}회)`);
  check('   회당 수집량은 데이터에서 나온 수집 효율(수집 시간/주행 시간)을 쓴다',
    need.efficiency > 0 && need.efficiency <= 1 && /수집 효율/.test(need.efficiencyBasis), need.efficiencyBasis);
  const capped = build([daySummary('2026-09-14', rows('2026-09-14', {}))], { settings: { recommendationSettings: Object.assign(R.defaultRecommendationSettings(), { maxVisitsPerRecommendation: 2 }) } });
  const c = find(capped, '강남|weekday|night|night');
  check('   비현실적으로 큰 횟수는 상한을 두고 단계로 나눈다', c.need.additionalVisits <= 2 && c.need.staged === (c.need.totalVisitsNeeded > 2) && (!c.need.staged || /전체 필요/.test(c.need.stageNote)), c.need.stageNote || '단계 없음');
  const filled = find(res, '강남|weekday|morning_peak|daylight');
  check('   목표를 이미 채운 조건은 추가 수집 0분·0회', filled.current.collectionMinutes >= filled.need.targetMinutes ? (filled.need.additionalMinutes === 0 && filled.need.visitsByMinutes === 0) : true,
    `${filled.current.collectionMinutes}/${filled.need.targetMinutes}분`);
}
{
  // 목표가 0이면 같은 구역·같은 요일의 다른 시간대 중앙값을 비교 기준으로 쓴다
  const s = ['2026-09-14', '2026-09-15'].map(d => daySummary(d, rows(d, { start: '09:00:00', count: 121 })));
  const settings = { recommendationSettings: (() => { const x = R.defaultRecommendationSettings(); x.periodTargets.evening_peak = { minutes: 0, visits: 0 }; return x; })() };
  const r = find(build(s, { settings }), '강남|weekday|evening_peak|daylight');
  check('목표가 없으면 같은 구역·요일의 다른 시간대 중앙값을 기준으로 삼고 그 기준을 표시한다',
    /중앙값/.test(r.targets.periodBasis) && r.targets.periodMinutes >= 0, `${r.targets.periodMinutes}분 · ${r.targets.periodBasis}`);
}

// ── F ───────────────────────────────────────────────────
section('F. LLM 전달 구조 · 이유 문장');
{
  const res = build([daySummary('2026-09-14', [...rows('2026-09-14', { weather: '비', count: 61 }), ...rows('2026-09-14', { vehicle: '토레스 2호차', weather: '맑음', start: '17:10:00', count: 61 })])]);
  const r = res.recommendations[0];
  const p = R.toLlmPayload(r);
  const json = JSON.stringify(p);
  check('추천 결과가 구조화 JSON 으로 나온다(필수 키)',
    ['recommendationId', 'rank', 'zone', 'recommendedCondition', 'recommendedTimeRange', 'currentStatus', 'recommendation', 'scoreBreakdown', 'predictedEdgeCaseHints', 'evidenceLevel', 'reasonFacts'].every(k => k in p)
    && p.recommendation.score === r.score && p.scoreBreakdown.timePeriodDeficit === r.subScores.timePeriod);
  check('   원본 GPS 좌표·사람 이름·차량 이름을 넘기지 않는다',
    !/lat|lng|latitude|longitude|호차|importedBy/.test(json), json.slice(0, 120));
  check('   데이터가 없는 항목은 null 로 넘기고 제외 목록에 남긴다',
    p.scoreBreakdown.coverageDeficit === null && p.excludedScoreItems.includes('coverageDeficit'));
  const ctx = R.buildLlmContext(res, res.recommendations.slice(0, 3));
  check('   LLM 컨텍스트에는 지시문·한계·고지가 함께 들어간다',
    ctx.recommendations.length === 3 && ctx.instructions.some(i => /순위를 바꾸거나 새 장소·통계·Edge Case를 만들지 말 것/.test(i))
    && /보장하지 않습니다/.test(ctx.edgeCaseDisclaimer) && Array.isArray(ctx.dataLimitations) && ctx.dataLimitations.length > 0);
  check('추천 이유는 사실을 인용한 템플릿 문장이다',
    r.reasonFacts.length >= 2 && r.reason.includes(r.zone) && /권장|목표/.test(r.reason) && r.reason.length < 400, r.reason.slice(0, 80) + '…');
  check('우선순위 구간(80/60/40)이 점수와 일치한다',
    R.priorityOf(87.4).id === 'very_high' && R.priorityOf(60).id === 'high' && R.priorityOf(59.9).id === 'medium' && R.priorityOf(39.9).id === 'low');
}

  // ══════════════════════════════════════════════════════
  section('G. 주행 계획 — 그 시간에 나가면 어디부터 어떻게 돌까');
  // ══════════════════════════════════════════════════════
  {
    const zones = ZONES;
    // 강남만 평일 10시~17시에 모은 상태 — 출근 피크(07~10)와 판교가 비어 있다
    const summaries = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-07', '2026-09-08', '2026-09-09']
      .map(date => daySummary(date, rows(date, { start: '10:00:00', count: 481, step: 30 })));
    const res = build(summaries);

    const plan = R.buildDrivePlan({ result: res, zones, settings: {}, plan: { startTime: '08:00', endTime: '18:00' } });
    check('1. 운행 시간을 교통 시간대·조도 경계로 잘라 블록을 만든다', plan.ok && plan.lanes[0].blocks.length >= 5,
      plan.ok ? `${plan.lanes[0].blocks.length}블록` : (plan.errors || []).join(' '));
    check('   블록이 운행 시간을 빈틈없이 덮는다(겹치지도 않는다)', (() => {
      const b = plan.lanes[0].blocks;
      if (b[0].from !== '08:00' || b[b.length - 1].to !== '18:00') return false;
      for (let i = 1; i < b.length; i++) if (b[i - 1].to !== b[i].from) return false;
      return true;
    })(), `${plan.lanes[0].blocks[0].from} ~ ${plan.lanes[0].blocks[plan.lanes[0].blocks.length - 1].to}`);
    check('   블록마다 그 시각의 교통 시간대·조도 조건이 붙는다',
      plan.lanes[0].blocks.every(b => b.trafficPeriod && b.conditionLabel)
      && plan.lanes[0].blocks[0].trafficPeriod === 'morning_peak',
      plan.lanes[0].blocks[0].conditionLabel);
    check('   8시 블록은 비어 있는 조건(출근 피크)이라 추천 점수가 높다',
      plan.lanes[0].blocks[0].score >= 60, `${plan.lanes[0].blocks[0].score}점`);

    check('2. 한 조건을 채우면 다음으로 부족한 곳으로 옮긴다(하루 종일 한 칸에 머물지 않는다)',
      new Set(plan.lanes[0].blocks.map(b => `${b.zone}|${b.trafficPeriod}`)).size > 1,
      [...new Set(plan.lanes[0].blocks.map(b => b.zone + ' ' + b.trafficPeriod))].join(' → '));
    check('   남은 부족분은 블록을 지날수록 줄어든다',
      (() => {
        const first = plan.lanes[0].blocks.find(b => b.remainingBefore > 0);
        const later = plan.lanes[0].blocks.filter(b => b.zone === first.zone && b.trafficPeriod === first.trafficPeriod);
        return later.length < 2 || later[1].remainingBefore < later[0].remainingBefore;
      })());

    const ganAm = R.buildDrivePlan({ result: res, zones, settings: {}, plan: { startTime: '08:00', endTime: '18:00', zones: ['강남'] } });
    check('3. 구역을 골라 계획할 수 있다(오늘은 강남만)',
      ganAm.ok && ganAm.zones.join(',') === '강남' && ganAm.lanes[0].blocks.every(b => b.zone === '강남'));

    const compared = R.buildDrivePlan({
      result: res, zones, settings: {},
      plan: { startTime: '08:00', endTime: '18:00', baselineStartTime: '09:00', baselineEndTime: '18:00' },
    });
    check('4. 지금 운행 시간과 비교해서 무엇이 새로 잡히는지 알려준다',
      compared.comparison && compared.comparison.collectMinutesDiff === 60
      && compared.comparison.newConditions.length > 0,
      `수집 ${compared.comparison.collectMinutesDiff}분 · 새 조건 ${compared.comparison.newConditions.map(c => c.label).join(', ')}`);
    check('   새로 잡히는 조건에 "부족분을 얼마나 메우는지"가 붙는다',
      compared.comparison.newConditions.every(c => c.coversMinutes == null || c.coversMinutes <= c.shortfallMinutes),
      compared.comparison.newConditions.map(c => `${c.label} ${c.coversMinutes}/${c.shortfallMinutes}분`).join(' · '));
    check('   1시간 일찍 시작하면 그만큼 총 수집 시간이 늘어난다',
      compared.totals.collectMinutes - compared.baseline.totals.collectMinutes === 60,
      `${compared.baseline.totals.collectMinutes}분 → ${compared.totals.collectMinutes}분`);

    const later = R.buildDrivePlan({
      result: res, zones, settings: {},
      plan: { startTime: '09:00', endTime: '19:00', baselineStartTime: '09:00', baselineEndTime: '18:00' },
    });
    check('5. 늦게까지 달리는 계획은 저녁·야간 조건이 새로 잡힌다',
      later.comparison.newConditions.some(c => ['evening_peak', 'night'].includes(c.trafficPeriod)),
      later.comparison.newConditions.map(c => c.label).join(' / '));

    const two = R.buildDrivePlan({ result: res, zones, settings: {}, plan: { startTime: '08:00', endTime: '12:00', vehicleCount: 2 } });
    check('6. 차량이 여러 대면 같은 시간에 서로 다른 구역으로 나눈다',
      two.lanes.length === 2 && two.lanes[0].blocks.every((b, i) => b.zone !== two.lanes[1].blocks[i].zone),
      two.lanes.map(l => `차량${l.vehicleIndex}: ${l.blocks[0].zone}`).join(' · '));

    const noSun = R.buildDrivePlan({ result: res, zones: [{ name: '강남', active: true }], settings: {}, plan: { startTime: '08:00', endTime: '18:00' } });
    check('7. 구역 좌표가 없으면 조도 없이 교통 시간대만으로 계획하고 그 사실을 밝힌다',
      noSun.ok && noSun.limitations.some(l => /일출·일몰/.test(l)),
      noSun.limitations.find(l => /일출·일몰/.test(l)) || '(없음)');

    const bad = R.buildDrivePlan({ result: res, zones, settings: {}, plan: { startTime: '18:00', endTime: '09:00' } });
    check('8. 시작이 종료보다 늦으면 계획을 세우지 않고 이유를 알려준다',
      bad.ok === false && bad.errors.length > 0, (bad.errors || []).join(' '));

    check('9. 계획은 이동 시간을 수집 시간에서 뺀다',
      plan.lanes[0].blocks.every(b => b.collectMinutes === b.minutes - b.travelMinutes));
    check('10. 같은 입력이면 같은 계획이 나온다(무작위 없음)',
      JSON.stringify(R.buildDrivePlan({ result: res, zones, settings: {}, plan: { startTime: '08:00', endTime: '18:00' } }))
      === JSON.stringify(plan));
    check('11. 한계(이동 시간 어림·날씨 미예측)를 함께 알려준다',
      plan.limitations.some(l => /직선 거리/.test(l)) && plan.limitations.some(l => /날씨는 예측하지 않습니다/.test(l)));
  }

console.log('\n' + '─'.repeat(60));
console.log(`  통과 ${passed} / 실패 ${failed}`);
if (failures.length) failures.forEach(f => console.log('   - ' + f));
console.log('─'.repeat(60));
process.exit(failed ? 1 : 0);
