// ══════════════════════════════════════════════════════════
//  recommendation — 추천 주행 엔진 (순수 함수, 통계·규칙 기반)
//
//  목적: 지금까지 수집된 데이터에서 "어느 구역 · 어떤 요일 · 어떤 교통 시간대 · 어떤 조도 · 어떤 날씨"가
//  부족한지 근거를 가지고 계산하고, 어느 시간에 몇 회·몇 분 더 모으면 좋을지 제안한다.
//
//  흐름 — 순위와 수치는 전부 이 파일의 통계·규칙이 정한다(LLM이 정하지 않는다):
//    날짜 요약의 조건 칸(conditionCells) + 구역 설정 + Coverage 스냅샷 + 설정
//    → buildRecommendationFeatures   구역×요일×교통×조도×날씨 집계(ConditionStats.aggregate)
//    → 후보 생성                       활성 구역 × 평일/주말 × 교통 시간대 × (그 시간대에 실제로 생기는) 조도
//    → calculateDeficitScores          하위 점수 6개(0~100)
//    → calculateRecommendationScore    가중합(0~100) · 데이터가 없는 항목은 빼고 남은 가중치로 다시 나눔
//    → estimateCollectionNeed          권장 시간 범위 · 추가 방문 횟수 · 추가 수집 시간
//    → inferEdgeCaseHints              조건 → 관찰 가능성이 높은 상황(규칙 표, 근거 추적)
//    → calculateConfidence             점수와 별개인 "판단에 쓸 데이터가 충분한가"
//    → generateRecommendationReason    템플릿 문장 + 사실 목록(reasonFacts)
//    → toLlmPayload                    향후 LLM에 넘길 구조화 사실(원본 GPS·사람 이름 없음)
//
//  원칙
//    · 없는 데이터는 만들지 않는다: 날씨 기록이 없으면 날씨 항목은 "데이터 없음"으로 점수에서 빼고,
//      Coverage 계산값이 없거나 오래됐으면 Coverage 항목을 빼고 신뢰도를 낮춘다.
//    · 교통 시간대(trafficPeriod)와 조도 조건(lightCondition)은 서로 다른 축이다.
//    · 시각은 한국 현지(+09:00) 기준이며 실행 환경 시간대와 무관하다(time-conditions.js).
//    · 예상 Edge Case 는 조건에서 추정한 "가능성"일 뿐 발생을 보장하지 않는다.
//    · 미래 날짜의 날씨는 예측하지 않는다("우천 시 우선 수집 권장"까지만).
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./time-conditions.js'), require('./condition-stats.js'), require('./collection-stats.js'), require('./issue-filter.js'), require('./subzones.js'), require('./auto-subzones.js'), require('./priority-policy.js'));
  } else {
    // PriorityPolicy 는 사업 우선도에만 쓴다 — 없는 화면(테스트 컨텍스트 등)에서는 "정책 없음"으로 동작한다
    root.Recommendation = factory(root.TimeConditions, root.ConditionStats, root.CollectionStats, root.IssueFilter, root.SubZones, root.AutoSubZones, root.PriorityPolicy || null);
  }
}(typeof self !== 'undefined' ? self : this, function (TC, CSt, CS, IF, SZ, SZA, PP) {
  'use strict';

  const RECOMMENDATION_VERSION = 2;

  // ── 점수 항목 ─────────────────────────────────────────
  const SCORE_KEYS = Object.freeze(['timePeriod', 'coverage', 'lightCondition', 'weatherDiversity', 'maneuver', 'roadContext', 'staleness', 'vehicleImbalance']);
  const SCORE_LABELS = Object.freeze({
    timePeriod: '시간대 부족도', coverage: 'Coverage 부족도', lightCondition: '조도 조건 부족도',
    weatherDiversity: '날씨 다양성 부족도', maneuver: '자차 행동 부족도', roadContext: '도로 Context 부족도',
    staleness: '최근 미방문 기간', vehicleImbalance: '차량 편중도',
  });
  // LLM·외부로 넘기는 이름(scoreBreakdown)
  const SCORE_EXPORT_NAMES = Object.freeze({
    timePeriod: 'timePeriodDeficit', coverage: 'coverageDeficit', lightCondition: 'lightConditionDeficit',
    weatherDiversity: 'weatherDiversityDeficit', maneuver: 'maneuverDeficit', roadContext: 'roadContextDeficit', staleness: 'staleness', vehicleImbalance: 'vehicleImbalance',
  });

  // 부족도 = 100 × (1 − (수집 시간 달성률×0.5 + 방문 횟수 달성률×0.3 + 고유 수집일 달성률×0.2))
  // 기록 수(GPS 포인트 수)는 쓰지 않는다 — 하루 한 번 오래 모은 것을 다양하다고 보지 않기 위해
  // 방문 횟수와 고유 수집일을 함께 본다. 달성률은 각각 1(100%)에서 자른다.
  const DEFICIT_MIX = Object.freeze({ minutes: 0.5, visits: 0.3, days: 0.2 });
  const MANEUVER_EVENT_MIX = Object.freeze({ events: 0.7, days: 0.3 });
  const MANEUVER_EVENT_IDS = Object.freeze(['LEFT_TURN', 'RIGHT_TURN', 'U_TURN', 'MERGE', 'DIVERGE']);
  const MANEUVER_DURATION_IDS = Object.freeze(['STRAIGHT']);
  const DRIVING_STATE_IDS = Object.freeze(['MOVING', 'SLOW', 'STOPPED']);
  const ROAD_CONTEXT_IDS = Object.freeze(['NORMAL_ROAD', 'INTERSECTION', 'MERGE_AREA', 'DIVERGE_AREA', 'HIGHWAY', 'RAMP', 'SCHOOL_ZONE']);

  const PRIORITY_BANDS = Object.freeze([
    { min: 80, id: 'very_high', label: '매우 높음' },
    { min: 60, id: 'high', label: '높음' },
    { min: 40, id: 'medium', label: '보통' },
    { min: 0, id: 'low', label: '낮음' },
  ]);
  const CONFIDENCE_LEVELS = Object.freeze({ high: { rank: 3, label: '높음' }, medium: { rank: 2, label: '보통' }, low: { rank: 1, label: '낮음' } });

  const HORIZON_DAYS = 14;                   // "다음 평일/주말" 기준 날짜를 찾는 범위
  const MIN_CANDIDATE_WINDOW_MINUTES = 20;   // 교통 시간대 안에 그 조도가 이만큼은 있어야 후보로 본다
  const TIME_ROUNDING_MINUTES = 5;           // 권장 시간 범위를 5분 단위로 안쪽으로 맞춤

  const EDGE_CASE_DISCLAIMER = '예상 Edge Case는 현재 시간대·도로 환경·날씨 조건을 기반으로 한 가능성 추정이며, 실제 발생을 보장하지 않습니다.';
  const RAIN_PATTERN = /비|우천|강우|소나기|rain/i;

  // 규칙 표 — when 이 참이고 requires 데이터가 있을 때만 적용한다. 적용 여부와 근거를 모두 추적한다.
  // requires 가 있는 규칙은 지금 데이터(도로종류 전부 '도심', 어린이보호구역·아파트 인접·교차로 정보 없음)로는
  // 판단할 수 없어 적용하지 않고 skippedEdgeCaseRules 에 이유를 남긴다.
  const EDGE_CASE_RULES = Object.freeze([
    { code: 'MORNING_RUSH_MERGE', label: '정체 · 빈번한 차선 변경 · 합류 · 끼어들기', expects: ['정체', '빈번한 차선 변경', '합류 차량', '끼어들기'], when: c => c.trafficPeriod === 'morning_peak', evidence: c => `trafficPeriod=${c.trafficPeriod}` },
    { code: 'LUNCH_SHORT_TRIPS', label: '단거리 이동 차량 · 주정차 · 보행자 증가', expects: ['단거리 이동 차량', '주정차', '보행자'], when: c => c.trafficPeriod === 'lunch_peak', evidence: c => `trafficPeriod=${c.trafficPeriod}` },
    { code: 'EVENING_RUSH_CUTIN', label: '정체 · 끼어들기(Cut-in) 가능성 · 복잡한 합류', expects: ['정체', 'Cut-in 가능성', '복잡한 합류'], when: c => c.trafficPeriod === 'evening_peak', evidence: c => `trafficPeriod=${c.trafficPeriod}` },
    { code: 'SUNRISE_LOW_SUN', label: '저각도 역광 · 노출 변화', expects: ['저각도 역광', '노출 변화'], when: c => c.lightCondition === 'sunrise', evidence: c => `lightCondition=${c.lightCondition}` },
    { code: 'SUNSET_GLARE', label: '역광 · 급격한 조도 변화', expects: ['역광', '급격한 조도 변화'], when: c => c.lightCondition === 'sunset', evidence: c => `lightCondition=${c.lightCondition}` },
    { code: 'NIGHT_LOW_LIGHT', label: '저조도 · 헤드라이트 Glare · 인식 거리 감소', expects: ['저조도', '헤드라이트 Glare', '인식 거리 감소'], when: c => c.lightCondition === 'night', evidence: c => `lightCondition=${c.lightCondition}` },
    { code: 'RAIN_REFLECTION', label: '노면 반사 · 차선 가시성 저하 · 물보라', expects: ['노면 반사', '차선 가시성 저하', '물보라'], when: c => !!c.weather && RAIN_PATTERN.test(c.weather), evidence: c => `weather=${c.weather}(기록된 날씨 값, 추천 조건: 해당 날씨일 때)` },
    { code: 'SCHOOL_ZONE_ARRIVAL', label: '보행자 · 어린이 · 불법 주정차', expects: ['보행자', '어린이', '불법 주정차'], requires: 'schoolZone', when: c => c.trafficPeriod === 'morning_peak', evidence: () => 'schoolZone' },
    { code: 'APARTMENT_ADJACENT', label: '주정차 차량 · 보행자 · 진출입 차량', expects: ['주정차 차량', '보행자', '진출입 차량'], requires: 'apartmentAdjacency', when: () => true, evidence: () => 'apartmentAdjacency' },
    { code: 'INTERSECTION', label: '신호 변화 · 좌우회전 차량 · 횡단보도 보행자', expects: ['신호 변화', '좌우회전 차량', '횡단보도 보행자'], requires: 'intersection', when: () => true, evidence: () => 'intersection' },
  ]);
  const REQUIRED_DATA_LABELS = Object.freeze({ schoolZone: '어린이보호구역 정보', apartmentAdjacency: '아파트 인접 도로 정보', intersection: '교차로 정보' });

  // ── 설정 ─────────────────────────────────────────────
  // 목표 수집 시간·방문 횟수는 "구역 × 요일 유형(평일/주말) × 교통 시간대" 한 칸의 목표다. 데이터에서 나온 값이
  // 아니라 첫 버전의 정책 기본값이라, 설정에서 운영 목표에 맞게 바꾸는 것을 전제로 한다(피크 3시간 구간 = 회당
  // 약 60분 × 4회 → 240분). 분이 0이면 "목표 없음"으로 보고 같은 구역·같은 요일 유형의 다른 시간대 중앙값과 비교한다.
  const DEFAULT_SETTINGS = Object.freeze({
    weights: Object.freeze({ timePeriod: 20, coverage: 15, lightCondition: 10, weatherDiversity: 10, maneuver: 15, roadContext: 15, staleness: 10, vehicleImbalance: 5 }),
    periodTargets: Object.freeze({
      late_night: Object.freeze({ minutes: 60, visits: 2 }),
      early_morning: Object.freeze({ minutes: 120, visits: 2 }),
      morning_peak: Object.freeze({ minutes: 240, visits: 4 }),
      morning_offpeak: Object.freeze({ minutes: 120, visits: 3 }),
      lunch_peak: Object.freeze({ minutes: 180, visits: 3 }),
      afternoon_offpeak: Object.freeze({ minutes: 180, visits: 3 }),
      evening_peak: Object.freeze({ minutes: 240, visits: 4 }),
      night: Object.freeze({ minutes: 120, visits: 3 }),
    }),
    zoneCoverageTargets: Object.freeze({ default: 80, zones: Object.freeze({}) }),
    maneuverTargets: Object.freeze({
      LEFT_TURN: Object.freeze({ events: 100, days: 5 }), RIGHT_TURN: Object.freeze({ events: 100, days: 5 }),
      U_TURN: Object.freeze({ events: 20, days: 3 }), MERGE: Object.freeze({ events: 50, days: 4 }), DIVERGE: Object.freeze({ events: 50, days: 4 }),
      STRAIGHT: Object.freeze({ minutes: 300, visits: 5, days: 5 }),
    }),
    drivingStateTargets: Object.freeze({
      MOVING: Object.freeze({ minutes: 300, visits: 5, days: 5 }), SLOW: Object.freeze({ minutes: 120, visits: 4, days: 4 }), STOPPED: Object.freeze({ minutes: 60, visits: 3, days: 3 }),
    }),
    roadContextTargets: Object.freeze({
      NORMAL_ROAD: Object.freeze({ minutes: 300, visits: 5, days: 5 }), INTERSECTION: Object.freeze({ minutes: 300, visits: 15, days: 8 }),
      MERGE_AREA: Object.freeze({ minutes: 60, visits: 5, days: 4 }), DIVERGE_AREA: Object.freeze({ minutes: 60, visits: 5, days: 4 }),
      HIGHWAY: Object.freeze({ minutes: 180, visits: 4, days: 3 }), RAMP: Object.freeze({ minutes: 60, visits: 5, days: 4 }), SCHOOL_ZONE: Object.freeze({ minutes: 90, visits: 5, days: 4 }),
    }),
    minUniqueDays: 3,
    staleDays: 14,
    maxVisitsPerRecommendation: 3,
    resultCount: 10,
    showLowConfidence: true,
    snoozeDays: 7,
  });

  const clone = v => JSON.parse(JSON.stringify(v));
  function defaultRecommendationSettings() { return clone(DEFAULT_SETTINGS); }

  const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const toNum = v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);

  function mergeWithDefaults(s) {
    const d = defaultRecommendationSettings();
    const src = s && typeof s === 'object' ? s : {};
    const out = { ...d, ...src };
    const legacyWeights = src.weights || {};
    const isLegacy = !Object.prototype.hasOwnProperty.call(legacyWeights, 'maneuver') || !Object.prototype.hasOwnProperty.call(legacyWeights, 'roadContext');
    if (isLegacy && Object.keys(legacyWeights).length) {
      const oldKeys = SCORE_KEYS.filter(k => k !== 'maneuver' && k !== 'roadContext');
      const oldSum = oldKeys.reduce((a, k) => a + (Number(legacyWeights[k]) || 0), 0);
      out.weights = { ...d.weights };
      if (oldSum > 0) oldKeys.forEach(k => { out.weights[k] = Math.round(((Number(legacyWeights[k]) || 0) / oldSum) * 70 * 100) / 100; });
      const rounding = 100 - SCORE_KEYS.reduce((a, k) => a + out.weights[k], 0);
      out.weights.timePeriod = Math.round((out.weights.timePeriod + rounding) * 100) / 100;
    } else out.weights = { ...d.weights, ...legacyWeights };
    out.periodTargets = {};
    TC.TRAFFIC_PERIOD_IDS.forEach(id => { out.periodTargets[id] = { ...d.periodTargets[id], ...((src.periodTargets || {})[id] || {}) }; });
    out.zoneCoverageTargets = { ...d.zoneCoverageTargets, ...(src.zoneCoverageTargets || {}), zones: { ...((src.zoneCoverageTargets || {}).zones || {}) } };
    out.maneuverTargets = {}; Object.keys(d.maneuverTargets).forEach(id => { out.maneuverTargets[id] = { ...d.maneuverTargets[id], ...((src.maneuverTargets || {})[id] || {}) }; });
    out.drivingStateTargets = {}; Object.keys(d.drivingStateTargets).forEach(id => { out.drivingStateTargets[id] = { ...d.drivingStateTargets[id], ...((src.drivingStateTargets || {})[id] || {}) }; });
    out.roadContextTargets = {}; Object.keys(d.roadContextTargets).forEach(id => { out.roadContextTargets[id] = { ...d.roadContextTargets[id], ...((src.roadContextTargets || {})[id] || {}) }; });
    return out;
  }

  // 검증 — 하나라도 잘못되면 저장하지 않는다(가중치 합계 100% 포함)
  function validateRecommendationSettings(input) {
    const s = mergeWithDefaults(input);
    const errors = [];
    const w = {};
    let sum = 0;
    SCORE_KEYS.forEach(k => {
      const v = toNum(s.weights[k]);
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) errors.push(`${SCORE_LABELS[k]} 가중치는 0~100 사이 숫자여야 해요.`);
      else { w[k] = Math.round(v * 100) / 100; sum += w[k]; }
    });
    if (Object.keys(w).length === SCORE_KEYS.length && Math.abs(sum - 100) > 0.001) {
      errors.push(`가중치 합계가 ${Math.round(sum * 100) / 100}%예요. 모든 가중치의 합은 100%여야 해요.`);
    }
    const periodTargets = {};
    TC.TRAFFIC_PERIOD_IDS.forEach(id => {
      const t = s.periodTargets[id] || {};
      const minutes = toNum(t.minutes), visits = toNum(t.visits);
      const label = TC.TRAFFIC_PERIOD_LABELS[id];
      if (!isInt(minutes, 0, 100000)) errors.push(`${label} 목표 수집 시간은 0 이상의 정수(분)여야 해요.`);
      if (!isInt(visits, 0, 1000)) errors.push(`${label} 목표 방문 횟수는 0 이상의 정수여야 해요.`);
      periodTargets[id] = { minutes, visits };
    });
    const validateTargets = (source, ids, fields, label) => {
      const result = {};
      ids.forEach(id => {
        const row = source[id] || {}; result[id] = {};
        fields.forEach(field => {
          const value = toNum(row[field]);
          if (!isInt(value, 0, 100000)) errors.push(`${label} ${id} 목표 ${field} 값은 0 이상의 정수여야 해요.`);
          result[id][field] = value;
        });
      });
      return result;
    };
    const maneuverTargets = {
      ...validateTargets(s.maneuverTargets, MANEUVER_EVENT_IDS, ['events', 'days'], 'Ego Maneuver'),
      ...validateTargets(s.maneuverTargets, MANEUVER_DURATION_IDS, ['minutes', 'visits', 'days'], 'Ego Maneuver'),
    };
    const drivingStateTargets = validateTargets(s.drivingStateTargets, DRIVING_STATE_IDS, ['minutes', 'visits', 'days'], 'Driving State');
    const roadContextTargets = validateTargets(s.roadContextTargets, ROAD_CONTEXT_IDS, ['minutes', 'visits', 'days'], 'Road Context');
    const covDefault = toNum(s.zoneCoverageTargets.default);
    if (typeof covDefault !== 'number' || !(covDefault > 0 && covDefault <= 100)) errors.push('기본 목표 Coverage는 0 초과 100 이하(%)여야 해요.');
    const zones = {};
    Object.entries(s.zoneCoverageTargets.zones || {}).forEach(([name, v]) => {
      const n = toNum(v);
      if (v === '' || v == null) return; // 비워 두면 기본값 사용
      if (typeof n !== 'number' || !(n > 0 && n <= 100)) errors.push(`${name} 목표 Coverage는 0 초과 100 이하(%)여야 해요.`);
      else zones[name] = n;
    });
    const ints = [
      ['minUniqueDays', '최소 고유 수집일', 0, 365], ['staleDays', '오래된 방문 기준 일수', 1, 3650],
      ['maxVisitsPerRecommendation', '추천당 최대 권장 횟수', 1, 50], ['resultCount', '추천 결과 개수', 1, 200],
      ['snoozeDays', '추천 제외 기간', 1, 365],
    ];
    const values = {};
    ints.forEach(([key, label, min, max]) => {
      const v = toNum(s[key]);
      if (!isInt(v, min, max)) errors.push(`${label}은(는) ${min}~${max} 사이 정수여야 해요.`);
      values[key] = v;
    });
    if (typeof s.showLowConfidence !== 'boolean') errors.push('낮은 신뢰도 추천 표시 여부는 켬/끔이어야 해요.');
    // 키 순서를 기본값과 같게 맞춘다 — 저장·백업·동기화에서 같은 설정이면 JSON 도 같아진다
    const out = {
      weights: w, periodTargets, zoneCoverageTargets: { default: covDefault, zones }, maneuverTargets, drivingStateTargets, roadContextTargets,
      minUniqueDays: values.minUniqueDays, staleDays: values.staleDays,
      maxVisitsPerRecommendation: values.maxVisitsPerRecommendation, resultCount: values.resultCount,
      showLowConfidence: s.showLowConfidence, snoozeDays: values.snoozeDays,
    };
    return errors.length ? { ok: false, errors, settings: null } : { ok: true, errors: [], settings: out };
  }

  // 저장된 값 → 실제로 쓰는 설정(없거나 깨졌으면 기본값)
  function effectiveRecommendationSettings(saved) {
    const v = validateRecommendationSettings(saved);
    return v.ok ? v.settings : defaultRecommendationSettings();
  }

  // 앱 설정 저장 패치 중 recommendationSettings 를 검증(잘못되면 이유를 담아 던짐)
  function normalizeRecommendationPatch(partial) {
    const out = { ...(partial || {}) };
    if (!Object.prototype.hasOwnProperty.call(out, 'recommendationSettings')) return out;
    const v = validateRecommendationSettings(out.recommendationSettings);
    if (!v.ok) {
      const err = new Error(v.errors.join('\n'));
      err.errors = v.errors;
      throw err;
    }
    out.recommendationSettings = v.settings;
    return out;
  }

  // 백업 복원·서버 동기화용 — 잘못된 추천 설정은 빼고(지금 설정 유지) 나머지는 둔다
  function sanitizeRecommendationSettings(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    const hasRec = 'recommendationSettings' in settings, hasSeg = 'segmentRecommendationSettings' in settings;
    if (!hasRec && !hasSeg && !('priorityPolicies' in settings)) return settings;
    const out = { ...settings };
    if (hasRec && !validateRecommendationSettings(out.recommendationSettings).ok) delete out.recommendationSettings;
    // 함수 선언은 호이스팅되므로 아래(도로 Segment 추천)의 검증을 여기서 써도 된다
    if (hasSeg && !validateSegmentSettings(out.segmentRecommendationSettings).ok) delete out.segmentRecommendationSettings;
    if ('priorityPolicies' in out && PP && !PP.mergePolicyPatch([], out.priorityPolicies).ok) delete out.priorityPolicies;
    return out;
  }

  function settingsSignature(settings) { return JSON.stringify(effectiveRecommendationSettings(settings)); }

  // ── Coverage 스냅샷 지문 — SQLite·IndexedDB 가 같은 방식으로 만든다 ──
  function fnv1a(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  // summaries: [{date, count}] · zone: {polygon, manualCells}
  function coverageFingerprint(summaries, zone) {
    const data = fnv1a([...(summaries || [])].map(s => `${s.date}:${s.count}`).sort().join(';'));
    const poly = zone && Array.isArray(zone.polygon) && zone.polygon.length >= 3
      ? fnv1a(zone.polygon.map(([la, lo]) => `${Number(la).toFixed(7)},${Number(lo).toFixed(7)}`).join(';')) : 'none';
    const manual = fnv1a(JSON.stringify((zone && zone.manualCells) || {}));
    return { data, polygon: poly, manual };
  }
  function recommendationDataFingerprint(summaries) {
    const compact = (summaries || []).map(s => ({
      date: s.date, count: s.count,
      conditionCells: (s.conditionCells || []).map(c => [c.zone,c.weekdayType,c.trafficPeriod,c.lightCondition,c.recordCount,c.collectionSec]),
      maneuverCells: (s.maneuverCells || []).map(c => [c.zone,c.weekdayType,c.trafficPeriod,c.lightCondition,c.egoManeuver,c.drivingState,c.confidence,c.recordCount,c.collectionSec,c.eventCount]),
      roadContextCells: (s.roadContextCells || []).map(c => [c.zone,c.weekdayType,c.trafficPeriod,c.lightCondition,c.roadContext,c.confidence,c.recordCount,c.collectionSec,c.eventCount]),
    }));
    return fnv1a(`${RECOMMENDATION_VERSION}|${JSON.stringify(compact)}`);
  }
  // 저장된 스냅샷이 지금 데이터·경계·수동 셀과 같은 상태에서 계산됐는지
  function coverageSnapshotFreshness(snapshot, currentFingerprint) {
    if (!snapshot || !snapshot.fingerprint) return { fresh: false, staleReason: '계산 기록 없음' };
    const f = snapshot.fingerprint, c = currentFingerprint || {};
    if (f.polygon !== c.polygon) return { fresh: false, staleReason: '구역 경계가 바뀐 뒤 다시 계산하지 않음' };
    if (f.manual !== c.manual) return { fresh: false, staleReason: '수동 방문·미방문·제외 칸이 바뀐 뒤 다시 계산하지 않음' };
    if (f.data !== c.data) return { fresh: false, staleReason: '주행 데이터가 바뀐 뒤 다시 계산하지 않음' };
    return { fresh: true, staleReason: null };
  }

  // ── 날짜·시간 (한국 현지, 환경 시간대 무관) ─────────────
  const pad2 = n => String(n).padStart(2, '0');
  function toMs(now) {
    if (now == null) return Date.now();
    if (typeof now === 'number') return now;
    const t = Date.parse(now);
    return Number.isFinite(t) ? t : Date.now();
  }
  function kstDate(now) {
    const offset = TC.TIMEZONE_OFFSET_MINUTES[TC.DEFAULT_TIMEZONE];
    const d = new Date(toMs(now) + offset * 60000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  function addDaysStr(date, n) {
    const p = TC.parseDate(date);
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  function daysBetween(from, to) {
    const a = TC.parseDate(from), b = TC.parseDate(to);
    if (!a || !b) return null;
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  }
  function nextDateOfType(today, weekdayType) {
    for (let i = 1; i <= HORIZON_DAYS; i++) {
      const d = addDaysStr(today, i);
      if (TC.classifyWeekdayType(d) === weekdayType) return d;
    }
    return null;
  }
  const round1 = v => Math.round(v * 10) / 10;
  const round2 = v => Math.round(v * 100) / 100;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pct1 = (a, b) => (b > 0 ? round1((a / b) * 100) : null);
  function median(values) {
    const v = [...values].sort((a, b) => a - b);
    if (!v.length) return 0;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  // ── 구간(분) 계산 ─────────────────────────────────────
  function periodIntervals(period) {
    const s = TC.parseClock(period.start, false);
    let e = TC.parseClock(period.end, true);
    if (s == null || e == null) return [];
    if (e === 0) e = 1440;
    return e > s ? [[s, e]] : [[s, 1440], [0, e]];
  }
  // 그 날짜·위치의 조도 조건별 구간(분) — 판정 규칙은 TimeConditions.classifyLightCondition 과 같다
  function lightIntervals(date, location, config) {
    const sun = TC.sunTimes(date, location.lat, location.lng, config.timezone);
    if (!sun) return null;
    if (sun.polar === 'day') return { sun, intervals: { daylight: [[0, 1440]], sunrise: [], sunset: [], night: [] } };
    if (sun.polar === 'night') return { sun, intervals: { night: [[0, 1440]], sunrise: [], sunset: [], daylight: [] } };
    const sr = config.sunriseWindowMinutes, ss = config.sunsetWindowMinutes;
    const c = ([a, b]) => [clamp(a, 0, 1440), clamp(b, 0, 1440)];
    const sunrise = c([sun.sunriseMinutes - sr, sun.sunriseMinutes + sr]);
    let sunset = c([sun.sunsetMinutes - ss, sun.sunsetMinutes + ss]);
    if (sunset[0] < sunrise[1]) sunset = [sunrise[1], Math.max(sunrise[1], sunset[1])]; // 겹치면 일출 전후 우선
    const daylight = sunrise[1] < sunset[0] ? [sunrise[1], sunset[0]] : null;
    const valid = seg => seg && seg[1] - seg[0] > 0;
    return {
      sun,
      intervals: {
        sunrise: valid(sunrise) ? [sunrise] : [],
        daylight: valid(daylight) ? [daylight] : [],
        sunset: valid(sunset) ? [sunset] : [],
        night: [[0, sunrise[0]], [sunset[1], 1440]].filter(valid),
      },
    };
  }
  function intersect(a, b) {
    const out = [];
    a.forEach(([s1, e1]) => b.forEach(([s2, e2]) => { const s = Math.max(s1, s2), e = Math.min(e1, e2); if (e > s) out.push([s, e]); }));
    return out;
  }
  const lengthOf = segs => segs.reduce((acc, [s, e]) => acc + (e - s), 0);
  function roundSegment([s, e]) {
    const rs = Math.ceil(s / TIME_ROUNDING_MINUTES) * TIME_ROUNDING_MINUTES;
    const re = Math.floor(e / TIME_ROUNDING_MINUTES) * TIME_ROUNDING_MINUTES;
    if (re - rs >= 10) return [rs, re];
    return [Math.ceil(s), Math.floor(e)];
  }

  function zoneLocation(zone) {
    if (!zone) return null;
    const lat = Number(zone.centerLat), lng = Number(zone.centerLng);
    if (zone.centerLat != null && zone.centerLng != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
      return { lat, lng, source: '구역 중심 좌표' };
    }
    if (Array.isArray(zone.polygon) && zone.polygon.length >= 3) {
      const la = zone.polygon.reduce((a, p) => a + Number(p[0]), 0) / zone.polygon.length;
      const lo = zone.polygon.reduce((a, p) => a + Number(p[1]), 0) / zone.polygon.length;
      if (Number.isFinite(la) && Number.isFinite(lo)) return { lat: la, lng: lo, source: '구역 경계 꼭짓점 평균' };
    }
    return null;
  }

  // ══════════════════════════════════════════════════════
  //  1) 특징 — 날짜 요약의 조건 칸만 더한다(원본 GPS 기록을 읽지 않음)
  // ══════════════════════════════════════════════════════
  // input: { summaries, zones, settings(앱 설정 전체), coverageSnapshots, now, vehicle(필터, 선택) }
  // 추천 결과 위에 적는 "무엇을 기준으로 센 숫자인지" — 화면마다 다시 쓰지 않는다
  const ISSUE_BASIS_TEXT = Object.freeze({
    all: '추천 계산 기준: 전체 데이터(이슈 포함)',
    clean: '추천 계산 기준: 확인 필요 이슈 데이터 제외',
    issue_all: '추천 계산 기준: 이슈로 표시한 데이터만',
  });

  function buildRecommendationFeatures(input) {
    const o = input || {};
    const summaries = (o.summaries || []).filter(s => s && Array.isArray(s.conditionCells));
    const appSettings = o.settings || {};
    const classification = TC.classificationConfig(appSettings);
    const rec = effectiveRecommendationSettings(appSettings.recommendationSettings);
    const signature = TC.classificationSignature(classification);
    const vehicleFilter = o.vehicle ? String(o.vehicle) : '';
    // 추천은 기본적으로 "확인 필요" 이슈 파일에서만 온 데이터를 빼고 센다(clean).
    // 아직 확인하지 않은 데이터로 "여기는 이미 충분하다"고 판단하면 안 되기 때문이다.
    const issueFilter = IF.normalizeFilter(o.issueFilter === undefined ? 'clean' : o.issueFilter);
    const filter = vehicleFilter ? { vehicleLike: vehicleFilter } : {};
    if (issueFilter !== 'all') filter.issueFilter = issueFilter;
    const agg = groupBy => CSt.aggregate(summaries, { filter, groupBy, details: true, signature });
    const index = rows => new Map(rows.map(r => [keyOf(r), r]));
    const keyOf = r => [r.zone, r.weekdayType, r.trafficPeriod, r.lightCondition, r.weather].filter(v => v !== undefined).join('');

    const total = agg([]);
    const totals = total.rows[0] || { recordCount: 0, collectionSec: 0, visitCount: 0, uniqueDays: 0, vehicleSeconds: {}, speed: {} };
    const ratioOf = (dim, isUnknown) => {
      const rows = agg([dim]).rows;
      const bad = rows.filter(r => isUnknown(r[dim])).reduce((a, r) => a + r.recordCount, 0);
      return totals.recordCount ? bad / totals.recordCount : 0;
    };
    const unknownRatios = totals.recordCount ? {
      trafficPeriod: ratioOf('trafficPeriod', v => v === TC.UNKNOWN),
      lightCondition: ratioOf('lightCondition', v => v === TC.UNKNOWN),
      weekdayType: ratioOf('weekdayType', v => v === TC.UNKNOWN),
      zone: ratioOf('zone', v => !v),
      weather: ratioOf('weather', v => !v),
    } : { trafficPeriod: 0, lightCondition: 0, weekdayType: 0, zone: 0, weather: 0 };

    // 전체 데이터(차량 필터와 무관) — 차량 대수·수집 효율·품질 경고
    const allRows = CSt.aggregate(summaries, { groupBy: ['vehicle', 'weather'], details: true, filter: issueFilter === 'all' ? {} : { issueFilter } }).rows;
    const fleet = [...new Set(allRows.map(r => r.vehicle).filter(Boolean))].sort();
    const weatherCategories = [...new Set(agg(['weather']).rows.map(r => r.weather).filter(Boolean))].sort();
    const weatherTotals = {};
    agg(['weather']).rows.forEach(r => { weatherTotals[r.weather] = r.collectionSec; });
    const collection = CS.summarizeCollection(
      issueFilter === 'all' ? summaries : summaries.map(s => CSt.filterDaySummary(s, issueFilter)).filter(s => s && s.count > 0)
    );
    const efficiency = collection.totalSpanSec > 0 ? collection.totalSec / collection.totalSpanSec : null;
    let gaps = 0, teleports = 0, records = 0;
    summaries.forEach(s => { const q = s.quality || {}; gaps += q.gaps || 0; teleports += q.teleports || 0; records += s.count || 0; });
    const dates = summaries.map(s => s.date).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).sort();

    const zones = (o.zones || []).filter(z => z && z.name && z.active !== false)
      .sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(z => ({ name: z.name, location: zoneLocation(z) }));
    const zoneNames = new Set(zones.map(z => z.name));
    const snapshots = new Map((o.coverageSnapshots || []).filter(s => s && s.zone).map(s => [s.zone, s]));
    // 이슈 데이터가 하나도 없으면 어떤 필터로 계산했든 결과가 같다 — 그럴 땐 굳이 다르다고 하지 않는다
    const hasOpenIssueData = summaries.some(s => (s.conditionCells || []).some(c => (Number(c.issueMask) || 0) & IF.MASK.OPEN));
    const coverageIssueMismatch = hasOpenIssueData
      && [...snapshots.values()].some(s => IF.normalizeFilter(s.issueFilter || 'all') !== issueFilter);
    const zoneRows = index(agg(['zone']).rows);
    const dataZonesNotActive = [...zoneRows.values()].map(r => r.zone).filter(z => z && !zoneNames.has(z));
    const analysisFilter = { ...filter };
    const analysisKey = (r, fields) => fields.map(k => r[k]).join('\u0001');
    const maneuverFields = ['zone', 'weekdayType', 'trafficPeriod', 'lightCondition', 'egoManeuver'];
    const stateFields = ['zone', 'weekdayType', 'trafficPeriod', 'lightCondition', 'drivingState'];
    const contextFields = ['zone', 'weekdayType', 'trafficPeriod', 'lightCondition', 'roadContext'];
    const maneuverRows = CSt.aggregateAnalysis(summaries, { kind: 'maneuver', filter: analysisFilter, groupBy: maneuverFields }).rows;
    const stateRows = CSt.aggregateAnalysis(summaries, { kind: 'maneuver', filter: analysisFilter, groupBy: stateFields }).rows;
    const contextRows = CSt.aggregateAnalysis(summaries, { kind: 'roadContext', filter: analysisFilter, groupBy: contextFields }).rows;
    const allManeuverQuality = CSt.aggregateAnalysis(summaries, { kind: 'maneuver', filter: analysisFilter, groupBy: ['egoManeuver', 'confidence'], excludeLow: false }).rows;
    const allContextQuality = CSt.aggregateAnalysis(summaries, { kind: 'roadContext', filter: analysisFilter, groupBy: ['roadContext', 'confidence'], excludeLow: false }).rows;
    const qualityShape = (rows, valueKey) => {
      const total = rows.reduce((a, r) => a + r.recordCount, 0);
      const unknown = rows.filter(r => r[valueKey] === 'UNKNOWN').reduce((a, r) => a + r.recordCount, 0);
      const confidence = { HIGH: 0, MEDIUM: 0, LOW: 0 };
      rows.forEach(r => { confidence[r.confidence] = (confidence[r.confidence] || 0) + r.recordCount; });
      return { total, validRatio: total ? (total - unknown) / total : 0, unknownRatio: total ? unknown / total : 0, confidence };
    };

    return {
      version: RECOMMENDATION_VERSION,
      today: kstDate(o.now),
      now: new Date(toMs(o.now)).toISOString(),
      vehicleFilter,
      issueFilter,
      dataFingerprint: recommendationDataFingerprint(summaries),
      coverageIssueMismatch,
      classification,
      signature,
      settings: rec,
      dataset: {
        recordCount: totals.recordCount,
        collectionSec: totals.collectionSec,
        visitCount: totals.visitCount,
        dateCount: dates.length,
        dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
        staleSummaryDates: total.staleDates,
        unknownRatios,
        weatherCategories,
        weatherTotals,
        fleet,
        efficiency,
        collectionTotals: collection,
        kpi: CS.collectionProgress(collection.totalSec, undefined, collection.totalSpanSec),
        quality: { gaps, teleports, records, per1000: records ? ((gaps + teleports) / records) * 1000 : 0 },
        speed: totals.speed || null,
        dataZonesNotActive,
        analysisQuality: { maneuver: qualityShape(allManeuverQuality, 'egoManeuver'), roadContext: qualityShape(allContextQuality, 'roadContext') },
      },
      zones,
      coverage: snapshots,
      rows: {
        zone: zoneRows,
        period: index(agg(['zone', 'weekdayType', 'trafficPeriod']).rows),
        light: index(agg(['zone', 'weekdayType', 'trafficPeriod', 'lightCondition']).rows),
        weather: index(agg(['zone', 'weekdayType', 'trafficPeriod', 'lightCondition', 'weather']).rows),
        maneuver: new Map(maneuverRows.map(r => [analysisKey(r, maneuverFields), r])),
        drivingState: new Map(stateRows.map(r => [analysisKey(r, stateFields), r])),
        roadContext: new Map(contextRows.map(r => [analysisKey(r, contextFields), r])),
      },
      // 분석 단위(구역×요일×교통×조도×날씨) 표 — 추천 탭 "데이터 부족 현황"과 외부 활용용
      analysisUnits: agg(['zone', 'weekdayType', 'trafficPeriod', 'lightCondition', 'weather']).rows,
      breakdowns: {
        weekdayType: agg(['weekdayType']).rows,
        trafficPeriod: agg(['trafficPeriod']).rows,
        lightCondition: agg(['lightCondition']).rows,
        weather: agg(['weather']).rows,
        vehicle: CSt.aggregate(summaries, { groupBy: ['vehicle'], details: true }).rows,
        maneuver: CSt.aggregateAnalysis(summaries, { kind: 'maneuver', filter: analysisFilter, groupBy: ['egoManeuver'] }).rows,
        drivingState: CSt.aggregateAnalysis(summaries, { kind: 'maneuver', filter: analysisFilter, groupBy: ['drivingState'] }).rows,
        roadContext: CSt.aggregateAnalysis(summaries, { kind: 'roadContext', filter: analysisFilter, groupBy: ['roadContext'] }).rows,
      },
    };
  }

  // ══════════════════════════════════════════════════════
  //  2) 하위 점수(0~100) — null 은 "데이터 없음 → 점수에서 제외"
  // ══════════════════════════════════════════════════════
  const EMPTY_ROW = Object.freeze({ recordCount: 0, collectionSec: 0, collectionMinutes: 0, visitCount: 0, uniqueDays: 0, lastVisitedAt: null, vehicleSeconds: {}, vehicleRecordCounts: {}, speed: null });

  function deficitFromTargets(row, targetMinutes, targetVisits, minUniqueDays) {
    const r = row || EMPTY_ROW;
    const minutes = r.collectionSec / 60;
    const mRatio = targetMinutes > 0 ? Math.min(1, minutes / targetMinutes) : 1;
    const vRatio = targetVisits > 0 ? Math.min(1, r.visitCount / targetVisits) : 1;
    const dRatio = minUniqueDays > 0 ? Math.min(1, (r.uniqueDays || 0) / minUniqueDays) : 1;
    const achieved = mRatio * DEFICIT_MIX.minutes + vRatio * DEFICIT_MIX.visits + dRatio * DEFICIT_MIX.days;
    return { value: round1(clamp(100 * (1 - achieved), 0, 100)), ratios: { minutes: mRatio, visits: vRatio, days: dRatio } };
  }

  function eventDeficit(row, targetEvents, targetDays) {
    const r = row || EMPTY_ROW;
    const eRatio = targetEvents > 0 ? Math.min(1, (r.eventCount || 0) / targetEvents) : 1;
    const dRatio = targetDays > 0 ? Math.min(1, (r.uniqueDays || 0) / targetDays) : 1;
    return { value: round1(clamp(100 * (1 - eRatio * MANEUVER_EVENT_MIX.events - dRatio * MANEUVER_EVENT_MIX.days), 0, 100)), ratios: { events: eRatio, days: dRatio } };
  }

  function analysisKey(candidate, value) {
    return [candidate.zone, candidate.weekdayType, candidate.trafficPeriod, candidate.lightCondition, value].join('\u0001');
  }

  function pickManeuverDeficit(candidate, features) {
    const choices = [];
    const observedInZone = new Set(features.breakdowns.maneuver.filter(r => r.egoManeuver !== 'UNKNOWN' && features.rows.maneuver.size && [...features.rows.maneuver.values()].some(x => x.zone === candidate.zone && x.egoManeuver === r.egoManeuver)).map(r => r.egoManeuver));
    MANEUVER_EVENT_IDS.filter(id => id !== 'MERGE' && id !== 'DIVERGE' || observedInZone.has(id)).forEach(id => {
      const row = features.rows.maneuver.get(analysisKey(candidate, id)) || EMPTY_ROW;
      const target = features.settings.maneuverTargets[id];
      choices.push({ kind: 'maneuver', value: id, row, target, deficit: eventDeficit(row, target.events, target.days).value, unit: 'events' });
    });
    MANEUVER_DURATION_IDS.forEach(id => {
      const row = features.rows.maneuver.get(analysisKey(candidate, id)) || EMPTY_ROW, target = features.settings.maneuverTargets[id];
      choices.push({ kind: 'maneuver', value: id, row, target, deficit: deficitFromTargets(row, target.minutes, target.visits, target.days).value, unit: 'duration' });
    });
    DRIVING_STATE_IDS.forEach(id => {
      const row = features.rows.drivingState.get(analysisKey(candidate, id)) || EMPTY_ROW, target = features.settings.drivingStateTargets[id];
      choices.push({ kind: 'drivingState', value: id, row, target, deficit: deficitFromTargets(row, target.minutes, target.visits, target.days).value, unit: 'duration' });
    });
    return choices.sort((a, b) => b.deficit - a.deficit || a.value.localeCompare(b.value))[0] || null;
  }

  function pickRoadContextDeficit(candidate, features) {
    const zoneTypes = new Set([...features.rows.roadContext.values()].filter(r => r.zone === candidate.zone && r.roadContext !== 'UNKNOWN').map(r => r.roadContext));
    if (!zoneTypes.size) return null;
    const choices = [...zoneTypes].filter(id => ROAD_CONTEXT_IDS.includes(id)).map(id => {
      const row = features.rows.roadContext.get(analysisKey(candidate, id)) || EMPTY_ROW, target = features.settings.roadContextTargets[id];
      return { value: id, row, target, deficit: deficitFromTargets(row, target.minutes, target.visits, target.days).value };
    });
    return choices.sort((a, b) => b.deficit - a.deficit || a.value.localeCompare(b.value))[0] || null;
  }

  // 교통 시간대 목표 — 설정값, 0 이면 같은 구역·요일 유형의 다른 교통 시간대 중앙값(비교 기준을 기록)
  function periodTargetFor(features, zone, weekdayType, periodId) {
    const t = features.settings.periodTargets[periodId];
    if (t.minutes > 0 || t.visits > 0) {
      return { minutes: t.minutes, visits: t.visits, basis: `설정 목표(${TC.TRAFFIC_PERIOD_LABELS[periodId]} · 구역×요일 유형당)` };
    }
    const others = TC.TRAFFIC_PERIOD_IDS.filter(id => id !== periodId).map(id => features.rows.period.get([zone, weekdayType, id].join('')) || EMPTY_ROW);
    return {
      minutes: Math.round(median(others.map(r => r.collectionSec / 60))),
      visits: Math.round(median(others.map(r => r.visitCount))),
      basis: `설정 목표 없음 → 같은 구역(${zone})·같은 요일 유형의 다른 교통 시간대 7개 수집 시간·방문 횟수 중앙값`,
    };
  }

  function calculateDeficitScores(candidate, features) {
    const s = features.settings;
    const c = candidate;
    const periodRow = features.rows.period.get([c.zone, c.weekdayType, c.trafficPeriod].join('')) || null;
    const lightRow = c.lightCondition ? (features.rows.light.get([c.zone, c.weekdayType, c.trafficPeriod, c.lightCondition].join('')) || null) : periodRow;
    const periodTarget = periodTargetFor(features, c.zone, c.weekdayType, c.trafficPeriod);
    const lightShare = c.lightCondition && c.window ? c.window.overlapMinutes / c.window.periodMinutes : 1;
    const target = { minutes: Math.round(periodTarget.minutes * lightShare), visits: periodTarget.visits };
    const scores = {};
    const details = {};

    const tp = deficitFromTargets(periodRow, periodTarget.minutes, periodTarget.visits, s.minUniqueDays);
    const pr = periodRow || EMPTY_ROW;
    scores.timePeriod = tp.value;
    details.timePeriod = {
      current: `${Math.round(pr.collectionSec / 60)}분 / ${periodTarget.minutes}분(${pct1(pr.collectionSec / 60, periodTarget.minutes) ?? '—'}%) · 방문 ${pr.visitCount}/${periodTarget.visits}회 · 수집일 ${pr.uniqueDays || 0}/${s.minUniqueDays}일`,
      basis: `${periodTarget.basis} · 부족도 = 100×(1−(수집 시간 달성률×0.5+방문 달성률×0.3+수집일 달성률×0.2))`,
    };

    if (c.lightCondition) {
      const lr = deficitFromTargets(lightRow, target.minutes, target.visits, s.minUniqueDays);
      const l = lightRow || EMPTY_ROW;
      scores.lightCondition = lr.value;
      details.lightCondition = {
        current: `${Math.round(l.collectionSec / 60)}분 / ${target.minutes}분 · 방문 ${l.visitCount}/${target.visits}회 · 수집일 ${l.uniqueDays || 0}/${s.minUniqueDays}일`,
        basis: `${TC.TRAFFIC_PERIOD_LABELS[c.trafficPeriod]} 목표 ${periodTarget.minutes}분을 ${c.window.referenceDate} 기준 이 시간대 ${c.window.periodMinutes}분 중 ${TC.LIGHT_CONDITION_LABELS[c.lightCondition]} ${c.window.overlapMinutes}분(${round1(lightShare * 100)}%) 비율로 배분`,
      };
    } else {
      scores.lightCondition = null;
      details.lightCondition = { current: '조도별로 나누지 않음', basis: '구역 위치(중심 좌표·경계)가 없어 일출·일몰을 계산할 수 없음 → 점수에서 제외' };
    }

    const cats = features.dataset.weatherCategories;
    if (!cats.length) {
      scores.weatherDiversity = null;
      details.weatherDiversity = { current: '날씨 기록 없음', basis: '파일의 날씨 열이 비어 있어 판단할 수 없음 → 점수에서 제외' };
      candidate.weather = null;
    } else {
      const per = cats.map(w => {
        const row = features.rows.weather.get([c.zone, c.weekdayType, c.trafficPeriod, c.lightCondition, w].filter(v => v !== null).join(''))
          || (c.lightCondition ? null : sumWeatherForPeriod(features, c, w));
        return { weather: w, sec: row ? row.collectionSec : 0 };
      });
      const share = target.minutes / cats.length;
      const ratio = x => (share > 0 ? Math.min(1, x.sec / 60 / share) : 1);
      const value = round1(clamp(100 * (1 - per.reduce((a, x) => a + ratio(x), 0) / cats.length), 0, 100));
      // 우선 수집할 날씨: 달성률이 가장 낮은 것 → 같으면 전체에서 가장 적게 모인 날씨 → 이름 순
      const pick = [...per].sort((a, b) => (ratio(a) - ratio(b)) || ((features.dataset.weatherTotals[a.weather] || 0) - (features.dataset.weatherTotals[b.weather] || 0)) || (a.weather < b.weather ? -1 : 1))[0];
      scores.weatherDiversity = value;
      candidate.weather = pick.weather;
      candidate.weatherMinutes = per.map(x => ({ weather: x.weather, minutes: Math.round(x.sec / 60) }));
      details.weatherDiversity = {
        current: per.map(x => `${x.weather} ${Math.round(x.sec / 60)}분`).join(' · '),
        basis: `이 조건 목표 ${target.minutes}분을 기록된 날씨 ${cats.length}종(${cats.join('·')})에 균등 배분해 비교 — 미래 날씨는 예측하지 않음`,
      };
    }

    const snap = features.coverage.get(c.zone);
    const covTarget = s.zoneCoverageTargets.zones[c.zone] != null ? s.zoneCoverageTargets.zones[c.zone] : s.zoneCoverageTargets.default;
    if (snap && snap.fresh && snap.total > 0) {
      scores.coverage = round1(clamp(((covTarget - snap.coveragePct) / covTarget) * 100, 0, 100));
      details.coverage = {
        current: `${round1(snap.coveragePct)}% · 미방문 Cell ${snap.unvisited.toLocaleString('en-US')}개 / 유효 ${snap.total.toLocaleString('en-US')}개${snap.provisional ? ' (건물 데이터를 못 받아 대체값으로 계산된 임시값)' : ''}`,
        basis: `구역 목표 Coverage ${covTarget}% · 부족도 = (목표−현재)/목표×100 · 구역 단위 값(조건별 Coverage 는 아직 없음)`,
      };
    } else {
      scores.coverage = null;
      details.coverage = {
        current: snap ? `계산값 있음 · ${snap.staleReason || '유효 Cell 없음'}` : '계산값 없음',
        basis: '누적 지도에서 "커버리지 갭 보기"로 이 구역을 계산하면 저장돼요 → 지금은 점수에서 제외',
      };
    }

    const ref = c.lightCondition ? lightRow : periodRow;
    const last = ref && ref.lastVisitedAt ? ref.lastVisitedAt.slice(0, 10) : null;
    const days = last ? daysBetween(last, features.today) : null;
    scores.staleness = last == null ? 100 : round1(clamp((Math.max(0, days) / s.staleDays) * 100, 0, 100));
    details.staleness = {
      current: last ? `마지막 방문 ${last} · ${Math.max(0, days)}일 전` : '이 조건의 방문 기록 없음',
      basis: `기준 ${s.staleDays}일(이상이면 100점) · 점수 = 경과 일수/기준×100 · 오늘(한국 시간) ${features.today}`,
    };

    const fleetSize = features.dataset.fleet.length;
    if (features.vehicleFilter) {
      scores.vehicleImbalance = null;
      details.vehicleImbalance = { current: `차량 필터(${features.vehicleFilter}) 적용 중`, basis: '한 차량만 보고 있어 편중을 판단하지 않음 → 점수에서 제외' };
    } else if (fleetSize <= 1) {
      scores.vehicleImbalance = null;
      details.vehicleImbalance = { current: `기록된 차량 ${fleetSize}대`, basis: '차량이 2대 이상일 때만 편중을 판단 → 점수에서 제외' };
    } else if (!ref || !ref.recordCount) {
      scores.vehicleImbalance = null;
      details.vehicleImbalance = { current: '이 조건 기록 없음', basis: '편중을 판단할 기록이 없음 → 점수에서 제외' };
    } else {
      const bySec = ref.collectionSec > 0 ? ref.vehicleSeconds : ref.vehicleRecordCounts;
      const totalV = Object.values(bySec).reduce((a, v) => a + v, 0);
      const top = Object.entries(bySec).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0];
      const topShare = totalV > 0 ? top[1] / totalV : 0;
      const even = 1 / fleetSize;
      scores.vehicleImbalance = round1(clamp(((topShare - even) / (1 - even)) * 100, 0, 100));
      candidate.topVehicle = { vehicle: top[0], share: round1(topShare * 100) };
      details.vehicleImbalance = {
        current: `${top[0] || '차량 미상'} ${round1(topShare * 100)}%(${ref.collectionSec > 0 ? '수집 시간' : '기록 수'} 기준)`,
        basis: `기록된 차량 ${fleetSize}대 · 점수 = (최다 차량 비율−균등 비율 ${round1(even * 100)}%)/(100%−균등 비율)×100`,
      };
    }

    const maneuver = pickManeuverDeficit(c, features);
    if (maneuver) {
      scores.maneuver = maneuver.deficit;
      const r = maneuver.row, t = maneuver.target;
      details.maneuver = maneuver.unit === 'events'
        ? { current: `${maneuver.value} ${r.eventCount || 0}/${t.events}회 · 수집일 ${r.uniqueDays || 0}/${t.days}일`, basis: `Observed Ego Maneuver(HIGH/MEDIUM) · 달성률 = 이벤트 70% + 고유 수집일 30% · LOW/UNKNOWN 제외` }
        : { current: `${maneuver.value} ${Math.round((r.collectionSec || 0)/60)}/${t.minutes}분 · 방문 ${r.visitCount || 0}/${t.visits}회 · 수집일 ${r.uniqueDays || 0}/${t.days}일`, basis: 'Observed Ego Maneuver/Driving State(HIGH/MEDIUM) · 수집 시간 50% + 방문 30% + 고유 수집일 20%' };
      candidate.maneuverNeed = maneuver;
    } else {
      scores.maneuver = null; details.maneuver = { current: '유효 Ego Maneuver 분석 없음', basis: 'LOW/UNKNOWN만 있거나 분석 요약이 없어 점수에서 제외' };
    }
    const roadContext = pickRoadContextDeficit(c, features);
    if (roadContext) {
      scores.roadContext = roadContext.deficit;
      const r = roadContext.row, t = roadContext.target;
      details.roadContext = { current: `${roadContext.value} ${Math.round((r.collectionSec || 0)/60)}/${t.minutes}분 · 방문 ${r.visitCount || 0}/${t.visits}회 · 수집일 ${r.uniqueDays || 0}/${t.days}일`, basis: 'Observed Road Context(HIGH/MEDIUM) · 지도에서 확인된 Context만 후보화 · 수집 시간 50% + 방문 30% + 고유 수집일 20%' };
      candidate.roadContextNeed = roadContext;
    } else {
      scores.roadContext = null; details.roadContext = { current: '이 구역의 확인된 Road Context 없음', basis: '지도/도로망 근거가 없거나 LOW/UNKNOWN뿐임 → 부족도 100이 아니라 unavailable로 점수에서 제외' };
    }

    return { scores, details, periodRow, lightRow, periodTarget, target, coverageTarget: covTarget, snapshot: snap || null, maneuver, roadContext };
  }

  function sumWeatherForPeriod(features, c, weather) {
    let sec = 0;
    features.rows.weather.forEach(r => { if (r.zone === c.zone && r.weekdayType === c.weekdayType && r.trafficPeriod === c.trafficPeriod && r.weather === weather) sec += r.collectionSec; });
    return { collectionSec: sec };
  }

  // ══════════════════════════════════════════════════════
  //  3) 최종 점수 — 데이터 없는 항목은 빼고 남은 가중치를 다시 100%로 나눈다
  // ══════════════════════════════════════════════════════
  function calculateRecommendationScore(scores, weights) {
    const w = weights || DEFAULT_SETTINGS.weights;
    const available = SCORE_KEYS.filter(k => scores[k] != null && Number.isFinite(scores[k]));
    const availableWeight = available.reduce((a, k) => a + (w[k] || 0), 0);
    const breakdown = SCORE_KEYS.map(k => {
      const value = scores[k] != null && Number.isFinite(scores[k]) ? clamp(scores[k], 0, 100) : null;
      const effectiveWeight = value != null && availableWeight > 0 ? round2(((w[k] || 0) / availableWeight) * 100) : 0;
      const contribution = value != null && availableWeight > 0 ? round2((value * (w[k] || 0)) / availableWeight) : 0;
      return { key: k, label: SCORE_LABELS[k], value, weight: w[k] || 0, effectiveWeight, contribution, excluded: value == null };
    });
    const score = availableWeight > 0 ? round1(clamp(breakdown.reduce((a, b) => a + b.contribution, 0), 0, 100)) : null;
    return { score, breakdown, availableWeight: round2(availableWeight) };
  }

  function priorityOf(score) {
    if (score == null) return { id: 'none', label: '판단 불가' };
    const band = PRIORITY_BANDS.find(b => score >= b.min);
    return { id: band.id, label: band.label };
  }

  // ══════════════════════════════════════════════════════
  //  4) 권장 시간 범위 · 추가 방문 · 추가 수집 시간
  // ══════════════════════════════════════════════════════
  function estimateCollectionNeed(candidate, deficit, features) {
    const s = features.settings;
    const current = deficit.lightRow || EMPTY_ROW;
    const currentMinutes = current.collectionSec / 60;
    const additionalMinutes = Math.max(0, Math.ceil(deficit.target.minutes - currentMinutes));
    const windowMinutes = candidate.timeRange ? candidate.timeRange.minutes : 0;
    const eff = features.dataset.efficiency;
    const efficiency = eff != null && eff > 0 ? eff : 1;
    const perVisitMinutes = Math.max(1, Math.floor(windowMinutes * efficiency));
    const visitsByMinutes = additionalMinutes > 0 ? Math.ceil(additionalMinutes / perVisitMinutes) : 0;
    const visitsByCount = Math.max(0, deficit.target.visits - current.visitCount);
    const totalVisitsNeeded = Math.max(visitsByMinutes, visitsByCount);
    const additionalVisits = Math.min(totalVisitsNeeded, s.maxVisitsPerRecommendation);
    const staged = totalVisitsNeeded > additionalVisits;
    const minutesThisStage = Math.min(additionalMinutes, additionalVisits * perVisitMinutes);
    return {
      targetMinutes: deficit.target.minutes,
      targetVisits: deficit.target.visits,
      currentMinutes: Math.round(currentMinutes),
      currentVisits: current.visitCount,
      additionalMinutes,
      additionalVisits,
      totalVisitsNeeded,
      visitsByMinutes,
      visitsByCount,
      perVisitMinutes,
      estimatedMinutesThisStage: minutesThisStage,
      efficiency: round2(efficiency),
      efficiencyBasis: eff != null
        ? `전체 수집 효율 ${round1(eff * 100)}%(수집 시간 ÷ 주행 시간) → 권장 시간 ${windowMinutes}분 주행 시 약 ${perVisitMinutes}분 수집`
        : '주행 시간 기록이 없어 수집 효율 100%로 가정',
      staged,
      stageNote: staged ? `전체 필요 ${totalVisitsNeeded}회 중 이번 추천은 ${additionalVisits}회(추천당 최대 ${s.maxVisitsPerRecommendation}회) — 나머지는 다음 추천에서` : null,
      basis: `추가 방문 = max(목표 방문 ${deficit.target.visits} − 현재 ${current.visitCount}, ⌈추가 수집 ${additionalMinutes}분 ÷ 회당 약 ${perVisitMinutes}분⌉)`,
    };
  }

  // 후보의 권장 시간 범위(추천 기준 날짜·구역 위치로 계산 — 일출·일몰 시각을 하드코딩하지 않는다)
  function recommendTimeRange(candidate, period, features) {
    const pIntervals = periodIntervals(period);
    const periodMinutes = lengthOf(pIntervals);
    const periodText = `${period.start}~${period.end}`;
    const wdLabel = TC.WEEKDAY_TYPE_LABELS[candidate.weekdayType];
    if (!candidate.lightCondition) {
      const seg = pIntervals.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
      const r = roundSegment(seg);
      return { start: TC.formatClock(r[0]), end: TC.formatClock(r[1]), minutes: r[1] - r[0], referenceDate: candidate.referenceDate, periodText, conditionText: `${wdLabel} ${TC.TRAFFIC_PERIOD_LABELS[candidate.trafficPeriod]} 전체`, sunText: null };
    }
    const segs = candidate.window.segments;
    const longest = segs.slice().sort((a, b) => ((b[1] - b[0]) - (a[1] - a[0])) || (a[0] - b[0]))[0];
    const r = roundSegment(longest);
    const sun = candidate.window.sun;
    const cfg = features.classification;
    let conditionText = `${wdLabel} ${TC.TRAFFIC_PERIOD_LABELS[candidate.trafficPeriod]} 중 ${TC.LIGHT_CONDITION_LABELS[candidate.lightCondition]}`;
    if (candidate.lightCondition === 'sunrise') conditionText = `${wdLabel} 일출 ${cfg.sunriseWindowMinutes}분 전부터 ${cfg.sunriseWindowMinutes}분 후까지 중 ${TC.TRAFFIC_PERIOD_LABELS[candidate.trafficPeriod]}(${periodText})에 걸친 시간`;
    if (candidate.lightCondition === 'sunset') conditionText = `${wdLabel} 일몰 ${cfg.sunsetWindowMinutes}분 전부터 ${cfg.sunsetWindowMinutes}분 후까지 중 ${TC.TRAFFIC_PERIOD_LABELS[candidate.trafficPeriod]}(${periodText})에 걸친 시간`;
    const sunText = sun && !sun.polar
      ? `다음 ${wdLabel}(${candidate.referenceDate}) ${candidate.zone} 기준 일출 ${TC.formatClock(sun.sunriseMinutes)} · 일몰 ${TC.formatClock(sun.sunsetMinutes)} — 주행 당일의 일출·일몰에 맞춰 조정하세요`
      : (sun && sun.polar ? `${candidate.referenceDate} ${sun.polar === 'day' ? '백야' : '극야'}` : null);
    return { start: TC.formatClock(r[0]), end: TC.formatClock(r[1]), minutes: r[1] - r[0], referenceDate: candidate.referenceDate, periodText, conditionText, sunText };
  }

  // ══════════════════════════════════════════════════════
  //  5) 예상 Edge Case — 조건 규칙 표로만(발생 보장 아님)
  // ══════════════════════════════════════════════════════
  // availableData: {schoolZone:false, apartmentAdjacency:false, intersection:false} — 해당 속성 데이터가 있을 때만 규칙 적용
  function inferEdgeCaseHints(condition, availableData) {
    const data = availableData || {};
    const applied = [], skipped = [];
    EDGE_CASE_RULES.forEach(rule => {
      if (!rule.when(condition)) return;
      if (rule.requires && !data[rule.requires]) {
        skipped.push({ code: rule.code, label: rule.label, reason: `${REQUIRED_DATA_LABELS[rule.requires]}가 없어 적용하지 않음` });
        return;
      }
      applied.push({ code: rule.code, label: rule.label, expects: rule.expects.slice(), evidence: rule.evidence(condition), wording: '관찰 가능성이 높은 상황' });
    });
    return { applied, skipped };
  }

  // ══════════════════════════════════════════════════════
  //  6) 신뢰도 — 점수와 별개("이 판단에 쓸 데이터가 충분한가")
  // ══════════════════════════════════════════════════════
  function calculateConfidence(candidate, deficit, features) {
    const d = features.dataset;
    const reasons = [];
    const add = (severity, text) => reasons.push({ severity, text });
    const p = v => `${round1(v * 100)}%`;
    const u = d.unknownRatios;
    if (u.trafficPeriod > 0.3) add('major', `시각을 읽지 못한 기록이 ${p(u.trafficPeriod)} — 교통 시간대 판단이 불확실`);
    else if (u.trafficPeriod > 0.05) add('minor', `시각을 읽지 못한 기록 ${p(u.trafficPeriod)}`);
    if (u.lightCondition > 0.3) add('major', `날짜·GPS가 없어 조도를 판단하지 못한 기록이 ${p(u.lightCondition)}`);
    else if (u.lightCondition > 0.05) add('minor', `날짜·GPS가 없어 조도를 판단하지 못한 기록 ${p(u.lightCondition)}`);
    if (u.zone > 0.3) add('major', `구역을 판정하지 못한 기록이 ${p(u.zone)}`);
    else if (u.zone > 0.05) add('minor', `구역을 판정하지 못한 기록 ${p(u.zone)}`);
    if (u.weather > 0.3) add('minor', `날씨가 비어 있는 기록 ${p(u.weather)}`);
    if (d.dateCount < 2) add('major', `수집일이 ${d.dateCount}일뿐이라 기간이 너무 짧음`);
    else if (d.dateCount < 7) add('minor', `수집일이 ${d.dateCount}일로 적음`);
    const comparable = [...features.rows.light.values()].filter(r => r.recordCount > 0).length;
    if (comparable < 2) add('minor', `비교할 수 있는 다른 조건 데이터가 ${comparable}개뿐`);
    if (d.quality.per1000 > 100) add('major', `GPS 공백·점프 경고가 기록 1,000건당 ${round1(d.quality.per1000)}건`);
    else if (d.quality.per1000 > 20) add('minor', `GPS 공백·점프 경고가 기록 1,000건당 ${round1(d.quality.per1000)}건`);
    if (d.staleSummaryDates > 0) add('minor', `분류 기준이 바뀐 뒤 재분류하지 않은 날짜 ${d.staleSummaryDates}일`);
    if (deficit.scores.coverage == null) add('minor', `Coverage 계산값 없음(${deficit.details.coverage.current})`);
    else if (deficit.snapshot && deficit.snapshot.provisional) add('minor', 'Coverage 가 건물 데이터 없이 계산된 임시값');
    if (features.coverageIssueMismatch) add('minor', `Coverage 는 다른 데이터 상태 필터로 계산된 값(추천 기준: ${IF.filterLabel(features.issueFilter)})`);
    if (!candidate.lightCondition) add('minor', '구역 위치가 없어 조도별 시간 계산 불가');
    const majors = reasons.filter(r => r.severity === 'major').length;
    const level = majors ? 'low' : (reasons.length ? 'medium' : 'high');
    if (!reasons.length) reasons.push({ severity: 'ok', text: '시각·GPS·구역 판정 비율이 높고, 수집 기간·비교 조건·Coverage 가 모두 있음' });
    return { level, label: CONFIDENCE_LEVELS[level].label, rank: CONFIDENCE_LEVELS[level].rank, reasons };
  }

  // ══════════════════════════════════════════════════════
  //  7) 이유 문장(템플릿) · 사실 목록
  // ══════════════════════════════════════════════════════
  function conditionText(c) {
    return [TC.WEEKDAY_TYPE_LABELS[c.weekdayType], TC.TRAFFIC_PERIOD_LABELS[c.trafficPeriod], c.lightCondition ? TC.LIGHT_CONDITION_LABELS[c.lightCondition] : null]
      .filter(Boolean).join(' · ');
  }

  function buildReasonFacts(r) {
    const facts = [];
    const periodRow = r.internal.periodRow || EMPTY_ROW;
    const pt = r.targets.periodMinutes;
    const tpLabel = TC.TRAFFIC_PERIOD_LABELS[r.condition.trafficPeriod];
    const b = key => r.breakdown.find(x => x.key === key);
    if (b('timePeriod').value != null) facts.push(`${TC.WEEKDAY_TYPE_LABELS[r.condition.weekdayType]} ${tpLabel} 수집률 ${pct1(periodRow.collectionSec / 60, pt) ?? 0}%(${Math.round(periodRow.collectionSec / 60)}/${pt}분)`);
    if (r.condition.lightCondition) facts.push(`${TC.LIGHT_CONDITION_LABELS[r.condition.lightCondition]} 방문 ${r.current.visitCount}회 · 수집 ${r.current.collectionMinutes}분`);
    if (r.coverage.available) facts.push(`Coverage ${r.coverage.coveragePercent}% · 미방문 Cell ${r.coverage.unvisitedCellCount}개`);
    if (r.condition.weather && b('weatherDiversity').value != null) {
      const m = (r.current.weatherMinutes || []).find(x => x.weather === r.condition.weather);
      facts.push(`날씨 '${r.condition.weather}'일 때 이 조건 수집 ${m ? m.minutes : 0}분`);
    }
    facts.push(r.current.lastVisitedAt ? `마지막 방문 ${r.current.lastVisitedAt.slice(0, 10)}(${r.current.daysSinceLastVisit}일 전)` : '이 조건 방문 기록 없음');
    if (r.internal.topVehicle && b('vehicleImbalance').value != null) facts.push(`${r.internal.topVehicle.vehicle} 편중 ${r.internal.topVehicle.share}%`);
    return facts;
  }

  function generateRecommendationReason(r) {
    const parts = [];
    const cond = conditionText(r.condition);
    parts.push(`${r.zone}의 ${cond} 수집은 목표의 ${pct1(r.need.currentMinutes, r.need.targetMinutes) ?? 100}%(${r.need.currentMinutes}/${r.need.targetMinutes}분)이고 방문 ${r.need.currentVisits}회(목표 ${r.need.targetVisits}회)입니다.`);
    const drivers = r.breakdown.filter(x => !x.excluded && x.value >= 50).sort((a, b) => (b.contribution - a.contribution) || (a.key < b.key ? -1 : 1)).slice(0, 2);
    if (drivers.length) parts.push(`점수를 가장 많이 올린 항목은 ${drivers.map(x => `${x.label}(${x.value}점)`).join(', ')}입니다.`);
    if (r.need.additionalVisits > 0 && r.timeRange) {
      parts.push(`${TC.WEEKDAY_TYPE_LABELS[r.condition.weekdayType]} ${r.timeRange.start}~${r.timeRange.end}에 ${r.need.additionalVisits}회(약 ${r.need.estimatedMinutesThisStage}분) 추가 주행을 권장합니다.`);
    } else {
      parts.push('수집 시간·방문 횟수 목표는 채웠고, 점수는 Coverage·최근 미방문·편중 같은 다른 항목에서 나왔습니다.');
    }
    if (r.condition.weather) parts.push(`날씨가 '${r.condition.weather}'인 날에 우선 수집하면 좋습니다(날씨 예보와 연결돼 있지 않아 특정 날짜의 날씨는 예측하지 않습니다).`);
    return parts.join(' ');
  }

  // ══════════════════════════════════════════════════════
  //  전체 — 후보 생성 → 점수 → 정렬
  // ══════════════════════════════════════════════════════
  // input: buildRecommendationFeatures 와 같음 · options.availableData: 도로 속성 데이터 유무(Edge Case 규칙)
  function buildRecommendations(input, options) {
    const features = buildRecommendationFeatures(input);
    const opts = options || {};
    const d = features.dataset;
    const limitations = [];
    if (!d.weatherCategories.length) limitations.push('날씨 기록이 없어 날씨 다양성 항목을 점수에서 뺐습니다.');
    limitations.push('교통밀도 열은 사용하지 않습니다(값이 대부분 "(미측정)"). 차량속도는 참고 관찰값으로만 표시하고 정체를 단정하지 않습니다.');
    limitations.push('어린이보호구역·아파트 인접 도로·교차로 정보가 없어 해당 Edge Case 규칙은 적용하지 않습니다.');
    limitations.push('Coverage 는 구역 단위 값만 있습니다(요일·시간대·조도별 Coverage 는 계산하지 않음).');
    limitations.push('날씨 예보와 연결돼 있지 않아 특정 날짜의 날씨는 예측하지 않습니다.');
    limitations.push(`${ISSUE_BASIS_TEXT[features.issueFilter] || ISSUE_BASIS_TEXT.all} — 이슈 데이터를 포함/제외하면 부족 판단과 순위가 달라질 수 있습니다.`);
    if (features.coverageIssueMismatch) limitations.push('Coverage 스냅샷은 누적 지도에서 다른 데이터 상태 필터로 계산된 값이라, 추천이 쓰는 기준과 다릅니다.');
    limitations.push('실제 Edge Case 이벤트 로그(검출·급정거·Cut-in 등)가 없어 모든 예상 Edge Case 는 조건 기반 추정(condition_only)입니다.');
    if (d.dataZonesNotActive.length) limitations.push(`활성 구역 목록에 없는 구역의 기록은 추천 후보에서 뺐습니다: ${d.dataZonesNotActive.join(', ')}`);
    if (d.recordCount > 0 && d.unknownRatios.zone > 0) limitations.push(`구역을 판정하지 못한 기록 ${round1(d.unknownRatios.zone * 100)}%는 구역별 추천에 쓰이지 않습니다.`);
    if (d.recordCount > 0 && d.unknownRatios.trafficPeriod > 0) limitations.push(`시각을 읽지 못한 기록 ${round1(d.unknownRatios.trafficPeriod * 100)}%는 시간대 추천에서 제외됩니다.`);
    if (d.analysisQuality.maneuver.total) limitations.push(`Ego Maneuver UNKNOWN ${round1(d.analysisQuality.maneuver.unknownRatio * 100)}%는 데이터 품질 지표이며 부족도에는 넣지 않습니다.`);
    if (d.analysisQuality.roadContext.total) limitations.push(`Road Context UNKNOWN ${round1(d.analysisQuality.roadContext.unknownRatio * 100)}%는 지도 데이터 부족 지표이며 수집 부족으로 간주하지 않습니다. Context는 복수 태그가 가능해 항목별 시간 합이 전체보다 클 수 있습니다.`);

    const base = {
      version: RECOMMENDATION_VERSION,
      generatedAt: features.now,
      today: features.today,
      vehicleFilter: features.vehicleFilter,
      issueFilter: features.issueFilter,
      issueBasisText: ISSUE_BASIS_TEXT[features.issueFilter] || ISSUE_BASIS_TEXT.all,
      classificationSignature: features.signature,
      settings: features.settings,
      dataset: d,
      breakdowns: features.breakdowns,
      analysisUnitCount: features.analysisUnits.length,
      limitations,
      edgeCaseDisclaimer: EDGE_CASE_DISCLAIMER,
      zones: features.zones.map(z => {
        const row = features.rows.zone.get(z.name) || EMPTY_ROW;
        const snap = features.coverage.get(z.name);
        return {
          zone: z.name, hasLocation: !!z.location, locationSource: z.location ? z.location.source : null,
          collectionMinutes: Math.round(row.collectionSec / 60), visitCount: row.visitCount, uniqueDays: row.uniqueDays || 0, recordCount: row.recordCount,
          lastVisitedAt: row.lastVisitedAt,
          coverage: snap ? { coveragePercent: round1(snap.coveragePct), unvisitedCellCount: snap.unvisited, validCellCount: snap.total, fresh: !!snap.fresh, provisional: !!snap.provisional, staleReason: snap.staleReason || null, computedAt: snap.computedAt || null } : null,
        };
      }),
    };
    if (d.recordCount === 0) return { ...base, empty: true, emptyReason: '아직 주행 기록이 없어 무엇이 부족한지 판단할 수 없어요. 파일을 불러오면 추천이 계산돼요.', recommendations: [], candidateCount: 0 };
    if (!features.zones.length) return { ...base, empty: true, emptyReason: '활성화된 구역이 없어 추천할 장소가 없어요. [설정]에서 구역을 활성화해 주세요.', recommendations: [], candidateCount: 0 };

    const periods = features.classification.trafficPeriods;
    const recs = [];
    features.zones.forEach(zone => {
      TC.WEEKDAY_TYPE_IDS.forEach(weekdayType => {
        const referenceDate = nextDateOfType(features.today, weekdayType);
        const light = zone.location && referenceDate ? lightIntervals(referenceDate, zone.location, features.classification) : null;
        TC.TRAFFIC_PERIOD_IDS.forEach(periodId => {
          const period = periods.find(p => p.id === periodId);
          const pIntervals = periodIntervals(period);
          const periodMinutes = lengthOf(pIntervals);
          const lightIds = light ? TC.LIGHT_CONDITION_IDS : [null];
          lightIds.forEach(lightCondition => {
            let window = null;
            if (lightCondition) {
              const segments = intersect(pIntervals, light.intervals[lightCondition]);
              const overlapMinutes = lengthOf(segments);
              if (overlapMinutes < MIN_CANDIDATE_WINDOW_MINUTES) return; // 그 시간대에 사실상 생기지 않는 조도 → 후보 아님
              window = { segments, overlapMinutes: round1(overlapMinutes), periodMinutes, referenceDate, sun: light.sun };
            }
            const candidate = { zone: zone.name, weekdayType, trafficPeriod: periodId, lightCondition, referenceDate, window, weather: null };
            candidate.timeRange = recommendTimeRange(candidate, period, features);
            recs.push(scoreCandidate(candidate, features, opts));
          });
        });
      });
    });
    const sorted = sortRecommendations(recs, 'score');
    sorted.forEach((r, i) => { r.rank = i + 1; });
    return { ...base, empty: false, emptyReason: null, recommendations: sorted, candidateCount: sorted.length };
  }

  function scoreCandidate(candidate, features, opts) {
    const deficit = calculateDeficitScores(candidate, features);
    const scored = calculateRecommendationScore(deficit.scores, features.settings.weights);
    const priority = priorityOf(scored.score);
    const need = estimateCollectionNeed(candidate, deficit, features);
    const condition = { weekdayType: candidate.weekdayType, trafficPeriod: candidate.trafficPeriod, lightCondition: candidate.lightCondition, weather: candidate.weather };
    const hints = inferEdgeCaseHints(condition, opts.availableData);
    const row = deficit.lightRow || EMPTY_ROW;
    const last = row.lastVisitedAt ? row.lastVisitedAt.slice(0, 10) : null;
    const snap = deficit.snapshot;
    const coverageAvailable = deficit.scores.coverage != null;
    const r = {
      id: [candidate.zone, candidate.weekdayType, candidate.trafficPeriod, candidate.lightCondition || 'any'].join('|'),
      rank: null,
      zone: candidate.zone,
      condition,
      conditionLabel: conditionText(condition),
      timeRange: candidate.timeRange,
      current: {
        collectionSec: row.collectionSec, collectionMinutes: Math.round(row.collectionSec / 60), visitCount: row.visitCount, uniqueDays: row.uniqueDays || 0,
        recordCount: row.recordCount, lastVisitedAt: row.lastVisitedAt, daysSinceLastVisit: last ? Math.max(0, daysBetween(last, features.today)) : null,
        period: { collectionMinutes: Math.round((deficit.periodRow || EMPTY_ROW).collectionSec / 60), visitCount: (deficit.periodRow || EMPTY_ROW).visitCount, uniqueDays: (deficit.periodRow || EMPTY_ROW).uniqueDays || 0 },
        weatherMinutes: candidate.weatherMinutes || [],
        speed: row.speed && row.speed.count ? row.speed : null,
        maneuver: deficit.maneuver ? { value: deficit.maneuver.value, eventCount: deficit.maneuver.row.eventCount || 0, collectionMinutes: Math.round((deficit.maneuver.row.collectionSec || 0)/60), visitCount: deficit.maneuver.row.visitCount || 0, uniqueDays: deficit.maneuver.row.uniqueDays || 0, confidenceCounts: deficit.maneuver.row.confidenceCounts || {} } : null,
        roadContext: deficit.roadContext ? { value: deficit.roadContext.value, collectionMinutes: Math.round((deficit.roadContext.row.collectionSec || 0)/60), visitCount: deficit.roadContext.row.visitCount || 0, uniqueDays: deficit.roadContext.row.uniqueDays || 0, confidenceCounts: deficit.roadContext.row.confidenceCounts || {} } : null,
      },
      targets: {
        periodMinutes: deficit.periodTarget.minutes, periodVisits: deficit.periodTarget.visits, periodBasis: deficit.periodTarget.basis,
        minutes: deficit.target.minutes, visits: deficit.target.visits, minUniqueDays: features.settings.minUniqueDays,
        lightShare: candidate.window ? round2(candidate.window.overlapMinutes / candidate.window.periodMinutes) : 1,
        coveragePercent: deficit.coverageTarget,
        maneuver: deficit.maneuver ? deficit.maneuver.target : null,
        roadContext: deficit.roadContext ? deficit.roadContext.target : null,
      },
      coverage: {
        available: coverageAvailable,
        fresh: !!(snap && snap.fresh),
        provisional: !!(snap && snap.provisional),
        coveragePercent: snap && snap.total > 0 ? round1(snap.coveragePct) : null,
        validCellCount: snap ? snap.total : null,
        visitedCellCount: snap ? snap.visited : null,
        unvisitedCellCount: snap ? snap.unvisited : null,
        computedAt: snap ? snap.computedAt || null : null,
        reason: coverageAvailable ? null : deficit.details.coverage.current,
      },
      need,
      subScores: deficit.scores,
      scoreDetails: deficit.details,
      breakdown: scored.breakdown.map(b => ({ ...b, current: deficit.details[b.key].current, basis: deficit.details[b.key].basis })),
      availableWeight: scored.availableWeight,
      score: scored.score,
      priority: priority.id,
      priorityLabel: priority.label,
      confidence: null,
      predictedEdgeCaseHints: hints.applied,
      skippedEdgeCaseRules: hints.skipped,
      expectedConditions: [...new Set(hints.applied.flatMap(h => h.expects))],
      observedEdgeCases: [],                 // 실제 이벤트 로그가 생기면 여기에 채운다(지금은 항상 비어 있음)
      observedAnalysis: { maneuver: candidate.maneuverNeed ? candidate.maneuverNeed.value : null, roadContext: candidate.roadContextNeed ? candidate.roadContextNeed.value : null },
      edgeCaseEvidenceLevel: 'condition_only',
      edgeCaseDisclaimer: EDGE_CASE_DISCLAIMER,
      supportingObservations: row.speed && row.speed.count
        ? [`이 조건 과거 기록 ${row.speed.count.toLocaleString('en-US')}건 평균 ${row.speed.averageKmh}km/h · 정차(0km/h) ${round1(row.speed.stoppedRatio * 100)}% · 10km/h 미만 주행 ${round1(row.speed.slowRatio * 100)}% — 참고값이며 정체로 단정하지 않음`]
        : [],
      dataRange: { ...(features.dataset.dateRange || { from: null, to: null }), dateCount: features.dataset.dateCount, vehicleFilter: features.vehicleFilter || null },
      missingData: SCORE_KEYS.filter(k => deficit.scores[k] == null).map(k => `${SCORE_LABELS[k]}: ${deficit.details[k].current} — ${deficit.details[k].basis}`),
      internal: { periodRow: deficit.periodRow, topVehicle: candidate.topVehicle || null },
    };
    r.confidence = calculateConfidence(candidate, deficit, features);
    r.reasonFacts = buildReasonFacts(r);
    r.deficitConditions = r.breakdown.filter(b => !b.excluded && b.value >= 40).sort((a, b) => b.contribution - a.contribution).map(b => `${b.label} ${b.value}점 — ${b.current}`);
    r.reason = generateRecommendationReason(r);
    delete r.internal;
    return r;
  }

  // ══════════════════════════════════════════════════════
  //  8) 주행 계획 — "그 시간에 나가면 어디부터 어떻게 돌까"
  //
  //  추천 카드가 "무엇이 부족한가"를 말한다면, 주행 계획은 그 답을 하루 일정으로 바꾼다.
  //    · 운행 시간(예: 08:00~18:00)을 교통 시간대·조도 경계로 잘라 시간 블록을 만들고,
  //    · 블록마다 그 조건에서 가장 부족한 구역을 고르고(추천 점수를 그대로 쓴다),
  //    · 구역을 옮기면 이동 시간만큼 수집이 줄어드는 것을 감안해 하루 경로를 정한다.
  //    · 지금 운행 시간(기본 09:00~18:00)으로 같은 계산을 한 번 더 해서 무엇이 달라지는지 비교한다.
  //
  //  순위·수치는 전부 여기(통계·규칙)가 정한다. 이동 시간은 구역 중심 사이 직선 거리 ÷ 평균 속도
  //  로 잡은 어림값이고(실제 도로·신호 미반영), 날씨는 예측하지 않는다.
  // ══════════════════════════════════════════════════════
  const PLAN_DEFAULTS = Object.freeze({
    startTime: '09:00',
    endTime: '18:00',
    baselineStartTime: '09:00',
    baselineEndTime: '18:00',
    maxBlockMinutes: 60,   // 한 블록이 이보다 길면 나눈다(구역을 바꿀 기회를 준다)
    minBlockMinutes: 15,   // 이보다 짧은 꼬리는 앞 블록에 붙인다
    travelSpeedKmh: 30,    // 시내 평균 — 구역 간 이동 시간 어림
    vehicleCount: 1,
    // A → B → A 처럼 블록마다 오가지 않게 — 계획 가치에서만 깎는다(실제 수집 시간 계산은 그대로)
    switchPenaltyMinutes: 10,   // 구역을 바꿀 때마다 드는 정리·진입 비용(분)
    minStayMinutes: 60,         // 한 구역에 이만큼은 머물러야 옮길 때 추가 비용이 없다(남은 부족분이 있을 때만)
  });

  function planClock(value, fallback) {
    const v = TC.parseClock(value, true);
    return v == null ? TC.parseClock(fallback, true) : v;
  }

  // 운행 시간 안의 경계(교통 시간대 시작/끝 · 조도 구간 시작/끝)를 모아 블록으로 자른다
  function planBlocks(startMin, endMin, periods, light, limits) {
    const edges = new Set([startMin, endMin]);
    periods.forEach(p => {
      periodIntervals(p).forEach(([s, e]) => { edges.add(s); edges.add(e); });
    });
    if (light) {
      Object.values(light.intervals).forEach(list => list.forEach(([s, e]) => { edges.add(s); edges.add(e); }));
    }
    const inside = [...edges].filter(v => v > startMin && v < endMin).sort((a, b) => a - b);
    const cuts = [startMin, ...inside, endMin];
    const blocks = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      let from = cuts[i];
      const to = cuts[i + 1];
      if (to - from <= 0) continue;
      // 긴 구간은 maxBlockMinutes 로 쪼갠다
      while (to - from > limits.maxBlockMinutes) {
        blocks.push([from, from + limits.maxBlockMinutes]);
        from += limits.maxBlockMinutes;
      }
      blocks.push([from, to]);
    }
    // 너무 짧은 꼬리는 앞 블록에 붙인다(5분짜리 줄이 늘어서 계획이 읽기 어려워지지 않게)
    const merged = [];
    blocks.forEach(b => {
      const prev = merged[merged.length - 1];
      if (prev && b[1] - b[0] < limits.minBlockMinutes && prev[1] === b[0]) prev[1] = b[1];
      else merged.push([b[0], b[1]]);
    });
    return merged;
  }

  function lightConditionAt(light, minute) {
    if (!light) return null;
    for (const id of TC.LIGHT_CONDITION_IDS) {
      if ((light.intervals[id] || []).some(([s, e]) => minute >= s && minute < e)) return id;
    }
    return null;
  }

  function trafficPeriodAt(periods, minute) {
    for (const p of periods) {
      if (periodIntervals(p).some(([s, e]) => minute >= s && minute < e)) return p.id;
    }
    return TC.UNKNOWN;
  }

  // 구역 사이 이동 시간(분) — 직선 거리 ÷ 평균 속도. 좌표가 없으면 null(모르면 0으로 두지 않고 밝힌다)
  function travelMinutes(fromLoc, toLoc, speedKmh) {
    if (!fromLoc || !toLoc) return null;
    const km = haversineKm(fromLoc.lat, fromLoc.lng, toLoc.lat, toLoc.lng);
    if (!Number.isFinite(km)) return null;
    return Math.round((km / Math.max(5, speedKmh)) * 60);
  }

  // 이동 추정 — 1) 도로망 최단 거리(router.route, road-graph.js buildRouter) 2) 안 되면 직선 거리.
  // 어떤 방법으로 셌는지(method)와 거리를 함께 돌려준다. 좌표가 없으면 null.
  function travelEstimate(fromLoc, toLoc, speedKmh, router) {
    if (!fromLoc || !toLoc) return null;
    const speed = Math.max(5, speedKmh);
    if (router && typeof router.route === 'function') {
      let r = null;
      try { r = router.route(fromLoc, toLoc); } catch (_) { r = null; }
      if (r && Number.isFinite(r.distanceM)) {
        const km = r.distanceM / 1000;
        return { minutes: Math.round((km / speed) * 60), distanceKm: round1(km), method: 'road_graph', snapM: r.snapM };
      }
    }
    const km = haversineKm(fromLoc.lat, fromLoc.lng, toLoc.lat, toLoc.lng);
    if (!Number.isFinite(km)) return null;
    return { minutes: Math.round((km / speed) * 60), distanceKm: round1(km), method: 'haversine', snapM: 0 };
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // 조건 한 칸(구역 × 요일 × 교통 시간대 × 조도)에 이 계획이 더 담을 수 있는 분.
  // 목표를 이미 채운 칸에 하루 종일 머무르지 않도록, 남은 부족분까지만 제값으로 치고
  // 그 뒤는 값을 크게 깎는다(0으로 두면 "갈 곳이 없다"가 되어 계획이 비어버린다).
  const OVERFILL_VALUE_RATIO = 0.15;

  // 운행 시간 하나에 대한 계획(차량 여러 대면 대수만큼 lane 을 만든다)
  function planWindow(ctx, startMin, endMin) {
    const { periods, light, limits, zoneNames, recByKey, locations, weekdayType } = ctx;
    // 구역 쌍마다 한 번만 잰다(도로망 최단 거리는 계산이 들어간다)
    const travelMemo = ctx.travelMemo || (ctx.travelMemo = new Map());
    const travelBetween = (a, b) => {
      const key = `${a}→${b}`;
      if (!travelMemo.has(key)) travelMemo.set(key, travelEstimate(locations.get(a), locations.get(b), limits.travelSpeedKmh, ctx.router));
      return travelMemo.get(key);
    };
    const blocks = planBlocks(startMin, endMin, periods, light, limits);
    const conditions = blocks.map(([from, to]) => {
      const mid = from + Math.max(1, Math.round((to - from) / 2));
      return {
        from, to, minutes: to - from,
        trafficPeriod: trafficPeriodAt(periods, mid),
        lightCondition: lightConditionAt(light, mid),
      };
    });
    const recFor = (zone, cond) => recByKey.get([zone, weekdayType, cond.trafficPeriod, cond.lightCondition || 'any'].join('|'))
      || recByKey.get([zone, weekdayType, cond.trafficPeriod, 'any'].join('|')) || null;

    // 시간 순서대로 한 블록씩 정한다. 각 조건 칸의 "남은 부족분"을 장부로 들고 있어서,
    // 한 칸을 채우고 나면 자연히 다음으로 부족한 곳으로 옮겨간다.
    // 옮길지 말지는 "옮겨서 더 버는 값 vs 이동에 쓰는 수집 시간"으로 정한다(억지로 돌아다니지 않는다).
    const remaining = new Map();
    const remainingOf = (zone, cond) => {
      const key = `${zone}|${cond.trafficPeriod}|${cond.lightCondition || 'any'}`;
      if (!remaining.has(key)) {
        const rec = recFor(zone, cond);
        remaining.set(key, rec ? Math.max(0, rec.need.additionalMinutes) : 0);
      }
      return { key, minutes: remaining.get(key) };
    };
    const lanes = [];
    const taken = conditions.map(() => new Set());
    const zoneMinutes = new Map(zoneNames.map(n => [n, 0]));
    const vehicles = Math.max(1, Math.min(8, Math.round(limits.vehicleCount || 1)));
    for (let v = 0; v < vehicles; v++) {
      let current = null;
      let dwell = 0;   // 지금 구역에 연속으로 머문 분
      const laneBlocks = conditions.map((cond, i) => {
        const currentLeft = current ? remainingOf(current, cond).minutes : 0;
        const options = zoneNames.filter(z => !taken[i].has(z)).map(zone => {
          const switching = !!current && current !== zone;
          const est = switching ? travelBetween(current, zone) : null;
          const travel = switching ? ((est && est.minutes) || 0) : 0;
          const collect = Math.max(0, cond.minutes - travel);
          const rec = recFor(zone, cond);
          const score = rec ? rec.score : 0;
          const left = remainingOf(zone, cond).minutes;
          // 계획 가치 = 추천 가치 − 이동 비용 − 구역 변경 비용. 변경 비용은 "그만큼 덜 모은 것"으로 친다.
          //   · 구역을 바꿀 때마다 switchPenaltyMinutes
          //   · 지금 구역에 아직 부족분이 남았는데 minStayMinutes 전에 떠나면 모자란 체류 분만큼 더
          const stayShort = switching && currentLeft > 0 && dwell < limits.minStayMinutes ? limits.minStayMinutes - dwell : 0;
          const penalty = switching ? limits.switchPenaltyMinutes + stayShort : 0;
          const planningCollect = Math.max(0, collect - penalty);
          const useful = Math.min(planningCollect, left);
          const overfill = planningCollect - useful;
          return {
            zone, travel, est, collect, rec, score, left, penalty,
            value: score * (useful + overfill * OVERFILL_VALUE_RATIO),
          };
        });
        options.sort((a, b) =>
          b.value - a.value
          || (a.zone === current ? -1 : b.zone === current ? 1 : 0)   // 값이 같으면 있던 곳에 머문다
          || b.left - a.left
          || (zoneMinutes.get(a.zone) || 0) - (zoneMinutes.get(b.zone) || 0)
          || (a.zone < b.zone ? -1 : 1));
        const pick = options[0] || { zone: zoneNames[0], travel: 0, collect: cond.minutes, rec: null, score: 0, left: 0, penalty: 0, est: null };
        const step = { zone: pick.zone, travel: current ? pick.travel : 0 };
        const rec = pick.rec;
        const travel = step.travel;
        const collectMinutes = Math.max(0, cond.minutes - travel);
        const switched = !!current && current !== step.zone;
        taken[i].add(step.zone);
        dwell = switched || !current ? collectMinutes : dwell + collectMinutes;
        current = step.zone;
        zoneMinutes.set(step.zone, (zoneMinutes.get(step.zone) || 0) + collectMinutes);
        const ledger = remainingOf(step.zone, cond);
        remaining.set(ledger.key, Math.max(0, ledger.minutes - collectMinutes));
        return {
          from: TC.formatClock(cond.from), to: TC.formatClock(cond.to), minutes: cond.minutes,
          trafficPeriod: cond.trafficPeriod, lightCondition: cond.lightCondition,
          conditionLabel: [TC.TRAFFIC_PERIOD_LABELS[cond.trafficPeriod], cond.lightCondition ? TC.LIGHT_CONDITION_LABELS[cond.lightCondition] : null].filter(Boolean).join(' · '),
          zone: step.zone,
          travelMinutes: travel,
          travelMethod: switched && pick.est ? pick.est.method : null,
          travelDistanceKm: switched && pick.est ? pick.est.distanceKm : null,
          switchPenaltyMinutes: switched ? pick.penalty : 0,
          switched,
          collectMinutes,
          score: rec ? rec.score : null,
          priority: rec ? rec.priority : null,
          recommendationId: rec ? rec.id : null,
          shortfallMinutes: rec ? rec.need.additionalMinutes : null,
          remainingBefore: ledger.minutes,
          reason: (rec
            ? `${TC.TRAFFIC_PERIOD_LABELS[cond.trafficPeriod]}${cond.lightCondition ? ' · ' + TC.LIGHT_CONDITION_LABELS[cond.lightCondition] : ''} 조건에서 ${step.zone}이(가) 가장 부족해요(추천 점수 ${rec.score}점 · 이 조건 남은 부족 ${ledger.minutes}분)`
            : `${step.zone}의 이 조건 기록이 없어 비교할 근거가 없어요(점수 없음)`)
            + (switched && pick.est ? ` · 이동 ${pick.est.distanceKm}km(${pick.est.method === 'road_graph' ? '도로망 최단 거리' : '직선 거리'}) · 구역 변경 비용 ${pick.penalty}분을 감안하고도 옮기는 쪽이 나음` : ''),
        };
      });
      lanes.push({ vehicleIndex: v + 1, blocks: laneBlocks });
    }
    return { blocks: conditions, lanes };
  }

  function summarizeLanes(lanes) {
    const byZone = {}, byPeriod = {}, byLight = {}, byCondition = {};
    let collect = 0, travel = 0, switches = 0;
    const travelMethods = { road_graph: 0, haversine: 0 };
    lanes.forEach(lane => lane.blocks.forEach(b => {
      collect += b.collectMinutes;
      travel += b.travelMinutes;
      if (b.switched) switches++;
      if (b.travelMethod) travelMethods[b.travelMethod] = (travelMethods[b.travelMethod] || 0) + 1;
      byZone[b.zone] = (byZone[b.zone] || 0) + b.collectMinutes;
      byPeriod[b.trafficPeriod] = (byPeriod[b.trafficPeriod] || 0) + b.collectMinutes;
      const lk = b.lightCondition || 'unknown';
      byLight[lk] = (byLight[lk] || 0) + b.collectMinutes;
      const ck = `${b.zone}|${b.trafficPeriod}|${b.lightCondition || 'any'}`;
      byCondition[ck] = (byCondition[ck] || 0) + b.collectMinutes;
    }));
    return { collectMinutes: collect, travelMinutes: travel, zoneSwitches: switches, travelMethods, byZone, byPeriod, byLight, byCondition };
  }

  function buildDrivePlan(input) {
    const o = input || {};
    const result = o.result;
    const plan = { ...PLAN_DEFAULTS, ...(o.plan || {}) };
    const errors = [];
    if (!result || !Array.isArray(result.recommendations) || !result.recommendations.length) {
      errors.push('추천을 먼저 계산해야 계획을 세울 수 있어요(기록이 없거나 활성 구역이 없어요).');
    }
    const startMin = TC.parseClock(plan.startTime, true);
    const endMin = TC.parseClock(plan.endTime, true);
    if (startMin == null) errors.push('시작 시각을 HH:MM 으로 적어주세요.');
    if (endMin == null) errors.push('종료 시각을 HH:MM 으로 적어주세요.');
    if (startMin != null && endMin != null && endMin - startMin < 30) errors.push('운행 시간이 30분보다는 길어야 계획을 세울 수 있어요.');
    if (errors.length) return { ok: false, errors };

    const cfg = TC.classificationConfig(o.settings || {});
    const today = result.today;
    const weekdayType = plan.weekdayType && TC.WEEKDAY_TYPE_IDS.includes(plan.weekdayType) ? plan.weekdayType : 'weekday';
    const date = plan.date && TC.parseDate(plan.date) ? plan.date : nextDateOfType(today, weekdayType);
    const rawZones = (o.zones || []).filter(z => z && z.name && z.active !== false);
    const locations = new Map();
    rawZones.forEach(z => { const loc = zoneLocation(z); if (loc) locations.set(z.name, loc); });
    const allZoneNames = result.zones.map(z => z.zone);
    // 계획에 넣을 구역을 고를 수 있다(예: 오늘은 강남만 돈다). 고른 게 없으면 활성 구역 전부.
    const wanted = Array.isArray(plan.zones) ? plan.zones.filter(z => allZoneNames.includes(z)) : [];
    const zoneNames = wanted.length ? wanted : allZoneNames;
    const reference = zoneNames.map(n => locations.get(n)).find(Boolean) || null;
    const light = reference ? lightIntervals(date, reference, cfg) : null;
    const recByKey = new Map(result.recommendations.map(r => [r.id, r]));

    const numOr = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
    const ctx = {
      periods: cfg.trafficPeriods, light, zoneNames, recByKey, locations, weekdayType,
      router: o.router || null,
      limits: {
        maxBlockMinutes: Math.max(20, Math.min(240, Number(plan.maxBlockMinutes) || PLAN_DEFAULTS.maxBlockMinutes)),
        minBlockMinutes: Math.max(5, Math.min(60, Number(plan.minBlockMinutes) || PLAN_DEFAULTS.minBlockMinutes)),
        travelSpeedKmh: Math.max(5, Math.min(120, Number(plan.travelSpeedKmh) || PLAN_DEFAULTS.travelSpeedKmh)),
        switchPenaltyMinutes: Math.max(0, Math.min(120, numOr(plan.switchPenaltyMinutes, PLAN_DEFAULTS.switchPenaltyMinutes))),
        minStayMinutes: Math.max(0, Math.min(240, numOr(plan.minStayMinutes, PLAN_DEFAULTS.minStayMinutes))),
        vehicleCount: plan.vehicleCount,
      },
    };

    const planned = planWindow(ctx, startMin, endMin);
    const plannedTotals = summarizeLanes(planned.lanes);

    // 비교 기준(지금 운행 시간)으로 같은 계산을 한 번 더 — "한 시간 일찍 나가면 뭐가 달라지나"
    const baseStart = planClock(plan.baselineStartTime, PLAN_DEFAULTS.baselineStartTime);
    const baseEnd = planClock(plan.baselineEndTime, PLAN_DEFAULTS.baselineEndTime);
    const sameWindow = baseStart === startMin && baseEnd === endMin;
    const baseline = sameWindow ? null : planWindow(ctx, baseStart, baseEnd);
    const baselineTotals = baseline ? summarizeLanes(baseline.lanes) : null;

    const comparison = baselineTotals ? buildPlanComparison({
      plannedTotals, baselineTotals, recByKey,
      window: { start: TC.formatClock(startMin), end: TC.formatClock(endMin) },
      baselineWindow: { start: TC.formatClock(baseStart), end: TC.formatClock(baseEnd) },
    }) : null;

    const methods = [...ctx.travelMemo ? ctx.travelMemo.values() : []].filter(Boolean).map(e => e.method);
    const usedRoad = methods.includes('road_graph'), usedLine = methods.includes('haversine');
    const travelText = usedRoad && !usedLine
      ? `구역 사이 이동 시간은 HD Map 도로망 최단 거리 ÷ 평균 ${ctx.limits.travelSpeedKmh}km/h 로 잡은 어림값입니다(신호·정체·일방통행·주차 시간은 반영하지 않습니다).`
      : usedRoad
        ? `구역 사이 이동 시간은 HD Map 도로망 최단 거리 ÷ 평균 ${ctx.limits.travelSpeedKmh}km/h 로 잡았고, 도로망으로 이어지지 않는 구역 쌍만 직선 거리로 대신했습니다(신호·정체 미반영).`
        : ctx.router
          ? `도로망으로 구역을 잇지 못해 구역 사이 이동 시간은 구역 중심을 잇는 직선 거리 ÷ 평균 ${ctx.limits.travelSpeedKmh}km/h 로 잡은 어림값입니다(실제 도로·신호·주차 시간 미반영).`
          : `구역 사이 이동 시간은 구역 중심을 잇는 직선 거리 ÷ 평균 ${ctx.limits.travelSpeedKmh}km/h 로 잡은 어림값입니다(도로망 데이터 없음 · 실제 도로·신호·주차 시간 미반영).`;
    const limitations = [
      travelText,
      `블록마다 가장 부족한 구역을 고르되, 구역을 바꿀 때 ${ctx.limits.switchPenaltyMinutes}분의 변경 비용과 최소 체류 ${ctx.limits.minStayMinutes}분(부족분이 남아 있을 때)을 계획 가치에서 빼서 A→B→A 처럼 오가지 않게 했습니다(실제 수집 시간 계산에는 이동 시간만 뺍니다).`,
      '계획의 수집 시간은 "그 시간에 그 구역에 있으면 계속 기록된다"고 본 최대치입니다(신호 대기·휴식은 빼지 않았습니다).',
      '날씨는 예측하지 않습니다 — 비 오는 날 우선 수집 같은 판단은 당일에 직접 하세요.',
    ];
    if (!reference) limitations.push('구역 좌표가 없어 일출·일몰(조도 조건)을 계산하지 못했습니다 — 교통 시간대만으로 계획했습니다.');
    if (zoneNames.some(n => !locations.has(n))) {
      limitations.push(`좌표가 없는 구역(${zoneNames.filter(n => !locations.has(n)).join(', ')})은 이동 시간을 0분으로 봤습니다.`);
    }

    return {
      ok: true,
      date,
      weekdayType,
      weekdayLabel: TC.WEEKDAY_TYPE_LABELS[weekdayType],
      window: { start: TC.formatClock(startMin), end: TC.formatClock(endMin), minutes: endMin - startMin },
      zones: zoneNames,
      availableZones: allZoneNames,
      baselineWindow: { start: TC.formatClock(baseStart), end: TC.formatClock(baseEnd), minutes: baseEnd - baseStart },
      sun: light && light.sun && !light.sun.polar
        ? { sunrise: TC.formatClock(light.sun.sunriseMinutes), sunset: TC.formatClock(light.sun.sunsetMinutes), place: reference }
        : null,
      vehicleCount: ctx.limits.vehicleCount,
      travelSpeedKmh: ctx.limits.travelSpeedKmh,
      switchPenaltyMinutes: ctx.limits.switchPenaltyMinutes,
      minStayMinutes: ctx.limits.minStayMinutes,
      travelBasis: usedRoad ? 'road_graph' : 'haversine',
      lanes: planned.lanes,
      totals: plannedTotals,
      baseline: baseline ? { window: { start: TC.formatClock(baseStart), end: TC.formatClock(baseEnd) }, lanes: baseline.lanes, totals: baselineTotals } : null,
      comparison,
      limitations,
    };
  }

  // 지금 운행 시간과 견줘서 "무엇이 새로 잡히고, 부족분을 얼마나 메우는지"
  function buildPlanComparison({ plannedTotals, baselineTotals, recByKey, window, baselineWindow }) {
    const newConditions = [];
    Object.entries(plannedTotals.byCondition).forEach(([key, minutes]) => {
      const before = baselineTotals.byCondition[key] || 0;
      if (minutes - before <= 0) return;
      const [zone, trafficPeriod, lightCondition] = key.split('|');
      const rec = recByKey.get([zone, 'weekday', trafficPeriod, lightCondition].join('|'))
        || recByKey.get([zone, 'weekend', trafficPeriod, lightCondition].join('|')) || null;
      newConditions.push({
        zone, trafficPeriod, lightCondition: lightCondition === 'any' ? null : lightCondition,
        label: [zone, TC.TRAFFIC_PERIOD_LABELS[trafficPeriod], lightCondition === 'any' ? null : TC.LIGHT_CONDITION_LABELS[lightCondition]].filter(Boolean).join(' · '),
        addedMinutes: minutes - before,
        beforeMinutes: before,
        score: rec ? rec.score : null,
        shortfallMinutes: rec ? rec.need.additionalMinutes : null,
        // 그 조건의 부족분 중 이번 계획이 메우는 몫(부족분을 넘어서 세지 않는다)
        coversMinutes: rec ? Math.min(rec.need.additionalMinutes, minutes) : null,
      });
    });
    newConditions.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.addedMinutes - a.addedMinutes);
    const lostConditions = [];
    Object.entries(baselineTotals.byCondition).forEach(([key, minutes]) => {
      const after = plannedTotals.byCondition[key] || 0;
      if (minutes - after <= 0) return;
      const [zone, trafficPeriod, lightCondition] = key.split('|');
      lostConditions.push({
        zone, trafficPeriod, lightCondition: lightCondition === 'any' ? null : lightCondition,
        label: [zone, TC.TRAFFIC_PERIOD_LABELS[trafficPeriod], lightCondition === 'any' ? null : TC.LIGHT_CONDITION_LABELS[lightCondition]].filter(Boolean).join(' · '),
        lostMinutes: minutes - after,
      });
    });
    lostConditions.sort((a, b) => b.lostMinutes - a.lostMinutes);
    return {
      window, baselineWindow,
      collectMinutesDiff: plannedTotals.collectMinutes - baselineTotals.collectMinutes,
      travelMinutesDiff: plannedTotals.travelMinutes - baselineTotals.travelMinutes,
      newConditions, lostConditions,
      coversMinutes: newConditions.reduce((a, c) => a + (c.coversMinutes || 0), 0),
    };
  }

  // ══════════════════════════════════════════════════════
  //  9) 세부 구역 추천 — "강남"이 아니라 "테헤란로 업무지구 / 테헤란로 구간"으로
  //
  //  입력은 subzones.js 가 낸 구역별 집계(getSubZoneStats)다. 여기서는
  //    · 그 구역의 장소 유형이 볼 만한 시간대(후보)와
  //    · 실제로 부족한 조건(수집 시간·방문·마지막 방문)을 맞춰 보고
  //    · 부족한 쪽만 추천으로 올린다(시간 규칙만으로는 추천하지 않는다).
  //
  //  도로·구간·방향은 지도 데이터에 실제로 있는 것만 쓴다. 이름을 못 찾으면 '확인 불가'로 둔다.
  // ══════════════════════════════════════════════════════
  const SUBZONE_TARGET_DEFAULTS = Object.freeze({
    minutesPerCondition: 120,   // 세부 구역 한 칸(요일×교통 시간대×조도)의 기본 목표 수집 시간
    visitsPerCondition: 3,
    staleDays: 14,
  });

  function subZoneConditionKey(c) {
    return [c.weekdayType, c.trafficPeriod, c.lightCondition || 'any'].join('|');
  }

  // 조건 칸을 날씨 구분 없이 합친다(날씨는 따로 "부족한 날씨"로 본다)
  function foldConditions(conditions) {
    const map = new Map();
    (conditions || []).forEach(c => {
      const key = subZoneConditionKey(c);
      let acc = map.get(key);
      if (!acc) {
        acc = {
          weekdayType: c.weekdayType, trafficPeriod: c.trafficPeriod, lightCondition: c.lightCondition,
          collectionSec: 0, collectionMinutes: 0, recordCount: 0, visitCount: 0, uniqueDays: 0,
          lastVisitedAt: null, weather: {},
        };
        map.set(key, acc);
      }
      acc.collectionSec += c.collectionSec;
      acc.recordCount += c.recordCount;
      acc.visitCount += c.visitCount;
      acc.uniqueDays = Math.max(acc.uniqueDays, c.uniqueDays || 0);
      if (c.weather) acc.weather[c.weather] = (acc.weather[c.weather] || 0) + Math.round(c.collectionSec / 60);
      if (c.lastVisitedAt && (!acc.lastVisitedAt || c.lastVisitedAt > acc.lastVisitedAt)) acc.lastVisitedAt = c.lastVisitedAt;
    });
    map.forEach(acc => { acc.collectionMinutes = Math.round(acc.collectionSec / 60); });
    return map;
  }

  // 그 구역에서 지금 볼 만한 조건 후보 — 장소 유형의 후보 시간대 × 요일 × (그 시간에 실제로 생기는 조도)
  function subZoneCandidates(subZone, features, today) {
    const periods = SZ.candidatePeriods(subZone);
    const type = SZ.PLACE_TYPES[subZone.type] || {};
    const weekdayTypes = type.weekdayTypes && type.weekdayTypes.length ? type.weekdayTypes : TC.WEEKDAY_TYPE_IDS;
    const cfg = features.classification;
    const out = [];
    weekdayTypes.forEach(weekdayType => {
      const referenceDate = nextDateOfType(today, weekdayType);
      const location = subZone.center && Number.isFinite(subZone.center.lat) ? subZone.center : null;
      const light = location ? lightIntervals(referenceDate, location, cfg) : null;
      periods.forEach(periodId => {
        const period = cfg.trafficPeriods.find(p => p.id === periodId);
        if (!period) return;
        const pIntervals = periodIntervals(period);
        const lights = light ? TC.LIGHT_CONDITION_IDS.map(id => {
          const segments = intersect(pIntervals, light.intervals[id] || []);
          return { id, minutes: lengthOf(segments), segments };
        }).filter(l => l.minutes >= 15) : [];
        if (!lights.length) {
          out.push({ subZone, weekdayType, trafficPeriod: periodId, lightCondition: null, referenceDate, period, window: null, sun: light && light.sun });
          return;
        }
        lights.forEach(l => out.push({
          subZone, weekdayType, trafficPeriod: periodId, lightCondition: l.id, referenceDate, period,
          window: { segments: l.segments, overlapMinutes: l.minutes, periodMinutes: lengthOf(pIntervals), sun: light.sun },
          sun: light.sun,
        }));
      });
    });
    return out;
  }

  // 부족도 — 0(충분) ~ 100(전혀 없음). 세부 구역은 칸이 작아서 시간·방문·최신성만 본다.
  function subZoneDeficit(candidate, folded, settings, today) {
    const key = subZoneConditionKey(candidate);
    const row = folded.get(key) || { collectionMinutes: 0, visitCount: 0, uniqueDays: 0, lastVisitedAt: null, weather: {} };
    const targetMinutes = settings.minutesPerCondition;
    const targetVisits = settings.visitsPerCondition;
    const minuteScore = clamp(100 * (1 - row.collectionMinutes / Math.max(1, targetMinutes)), 0, 100);
    const visitScore = clamp(100 * (1 - row.visitCount / Math.max(1, targetVisits)), 0, 100);
    const lastDate = row.lastVisitedAt ? String(row.lastVisitedAt).slice(0, 10) : null;
    const daysSince = lastDate ? Math.max(0, daysBetween(lastDate, today)) : null;
    const staleScore = daysSince == null ? 100 : clamp(100 * (daysSince / Math.max(1, settings.staleDays)), 0, 100);
    const score = round1(minuteScore * 0.5 + visitScore * 0.3 + staleScore * 0.2);
    return {
      row, score, daysSince, targetMinutes, targetVisits,
      parts: [
        { key: 'minutes', label: '수집 시간 부족', value: round1(minuteScore), current: `${row.collectionMinutes}분 / 목표 ${targetMinutes}분` },
        { key: 'visits', label: '방문 횟수 부족', value: round1(visitScore), current: `${row.visitCount}회 / 목표 ${targetVisits}회` },
        { key: 'staleness', label: '오래됨', value: round1(staleScore), current: daysSince == null ? '이 조건 기록 없음' : `마지막 수집 ${daysSince}일 전` },
      ],
      needMinutes: Math.max(0, targetMinutes - row.collectionMinutes),
      needVisits: Math.max(0, targetVisits - row.visitCount),
    };
  }

  // 그 조건에서 실제로 부족한 도로 구간과 방향 — 지도에 있는 도로만, 방향은 믿을 만할 때만
  function pickRoads(stats, candidate, limit) {
    const key = subZoneConditionKey(candidate);
    const roads = (stats.roads || []).slice(0, Math.max(1, limit || 3));
    return roads.map(r => {
      const cond = (r.conditions || []).find(c => [c.weekdayType, c.trafficPeriod, c.lightCondition || 'any'].join('|') === key)
        || { recordCount: 0, forward: 0, backward: 0 };
      const forwardLabel = SZ.compassOf(r.bearing);
      const backwardLabel = SZ.compassOf((r.bearing + 180) % 360);
      let recommendedDirection = { id: 'both', label: '양방향', reason: r.direction.reason };
      if (r.direction.ok) {
        // 방향별로 모인 양이 다르면 적게 모인 쪽을 권한다
        if (cond.forward + cond.backward > 0 && cond.forward !== cond.backward) {
          const less = cond.forward < cond.backward ? 'forward' : 'backward';
          recommendedDirection = {
            id: less,
            label: `${less === 'forward' ? forwardLabel : backwardLabel}쪽 방향`,
            reason: `이 조건에서 ${forwardLabel}쪽 ${cond.forward}건 · ${backwardLabel}쪽 ${cond.backward}건 — 적은 쪽을 권합니다.`,
          };
        } else if (r.forward !== r.backward) {
          const less = r.forward < r.backward ? 'forward' : 'backward';
          recommendedDirection = {
            id: less,
            label: `${less === 'forward' ? forwardLabel : backwardLabel}쪽 방향`,
            reason: `이 구간 전체에서 ${forwardLabel}쪽 ${r.forward}건 · ${backwardLabel}쪽 ${r.backward}건 — 적은 쪽을 권합니다.`,
          };
        }
      }
      return {
        roadId: r.roadId, name: r.name, named: r.named,
        lengthM: r.lengthM, lengthKm: r.lengthM != null ? round1(r.lengthM / 1000) : null,
        start: r.start, end: r.end,
        headingLabel: forwardLabel ? `${forwardLabel}쪽` : null,
        recordCount: r.recordCount,
        conditionRecordCount: cond.recordCount,
        forward: r.forward, backward: r.backward,
        directionConfidence: r.direction,
        recommendedDirection,
        lastVisitedAt: r.lastVisitedAt,
      };
    });
  }

  // 권장 수집량 — 부족한 분을 회당 주행 시간으로 나눠서 "몇 회"로 바꾼다(회당 최대 2회씩 단계로)
  function subZoneNeed(deficit, roads, candidate) {
    const perPass = roads.length && roads[0].lengthKm
      ? Math.max(10, Math.round((roads[0].lengthKm / 20) * 60))   // 혼잡 구간 평균 20km/h 가정
      : 30;
    const passes = deficit.needMinutes > 0 ? Math.max(1, Math.ceil(deficit.needMinutes / perPass)) : 0;
    const thisStage = Math.min(passes, 3);
    const direction = roads.length ? roads[0].recommendedDirection : null;
    return {
      additionalMinutes: deficit.needMinutes,
      additionalVisits: Math.max(deficit.needVisits, passes ? 1 : 0),
      perPassMinutes: perPass,
      passesTotal: passes,
      passesThisStage: thisStage,
      estimatedMinutesThisStage: thisStage * perPass,
      directionPlan: direction && direction.id !== 'both'
        ? `${direction.label} ${Math.max(1, Math.ceil(thisStage * 0.67))}회 · 반대 방향 ${Math.max(1, thisStage - Math.ceil(thisStage * 0.67))}회`
        : `양방향 각 ${Math.max(1, Math.ceil(thisStage / 2))}회`,
    };
  }

  function subZoneTimeWindow(candidate) {
    if (!candidate.window || !candidate.window.segments.length) {
      return {
        start: candidate.period.start, end: candidate.period.end,
        text: `${candidate.period.start}~${candidate.period.end}`,
        note: '교통 시간대 구간 전체입니다(조도 조건 없음).',
      };
    }
    const longest = candidate.window.segments.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
    const r = roundSegment(longest);
    return {
      start: TC.formatClock(r[0]), end: TC.formatClock(r[1]),
      text: `${TC.formatClock(r[0])}~${TC.formatClock(r[1])}`,
      note: candidate.lightCondition === 'sunset' || candidate.lightCondition === 'sunrise'
        ? '실제 일출·일몰 시각에 따라 ±30분 조정하세요.'
        : null,
    };
  }

  // input: { subZones, stats, settings, now, issueFilter, targets }
  function buildSubZoneRecommendations(input) {
    const o = input || {};
    const settings = { ...SUBZONE_TARGET_DEFAULTS, ...(o.targets || {}) };
    const cfg = TC.classificationConfig(o.settings || {});
    const today = kstDate(o.now);
    const features = { classification: cfg };
    const statsById = new Map((o.stats || []).map(s => [s.id, s]));
    const items = [];
    const skipped = [];

    (o.subZones || []).forEach(subZone => {
      if (!subZone || subZone.active === false) return;
      const stats = statsById.get(subZone.id);
      if (!stats) { skipped.push({ subZone: subZone.name, reason: '집계 결과가 없어요.' }); return; }
      const folded = foldConditions(stats.conditions);
      const candidates = subZoneCandidates(subZone, features, today);
      if (!candidates.length) {
        skipped.push({ subZone: subZone.name, reason: '이 장소 유형에 정해 둔 후보 시간대가 없어요(설정에서 관심 시간대를 골라주세요).' });
        return;
      }
      const evidence = SZ.evidenceLevel({
        hdmap: (stats.roads || []).some(r => r.named),
        osm: !!subZone.sourceIdentifiers && subZone.sourceType === 'osm',
        gps: stats.recordCount > 0,
        manual: subZone.sourceType === 'manual',
      });
      candidates.forEach(candidate => {
        const deficit = subZoneDeficit(candidate, folded, settings, today);
        const roads = pickRoads(stats, candidate, 3);
        const need = subZoneNeed(deficit, roads, candidate);
        const window = subZoneTimeWindow(candidate);
        const priority = priorityOf(deficit.score);
        const row = deficit.row;
        const weatherGaps = Object.keys(row.weather || {});
        items.push({
          id: `${subZone.id}|${candidate.weekdayType}|${candidate.trafficPeriod}|${candidate.lightCondition || 'any'}`,
          parentZone: subZone.parentZone,
          subZoneId: subZone.id,
          subZoneName: subZone.name,
          placeType: subZone.type,
          placeTypeLabel: SZ.placeTypeLabel(subZone.type),
          condition: { weekdayType: candidate.weekdayType, trafficPeriod: candidate.trafficPeriod, lightCondition: candidate.lightCondition },
          conditionLabel: [TC.WEEKDAY_TYPE_LABELS[candidate.weekdayType], TC.TRAFFIC_PERIOD_LABELS[candidate.trafficPeriod],
            candidate.lightCondition ? TC.LIGHT_CONDITION_LABELS[candidate.lightCondition] : null].filter(Boolean).join(' · '),
          referenceDate: candidate.referenceDate,
          timeWindow: window,
          sun: candidate.sun && !candidate.sun.polar
            ? { sunrise: TC.formatClock(candidate.sun.sunriseMinutes), sunset: TC.formatClock(candidate.sun.sunsetMinutes) } : null,
          roads,
          roadNote: roads.length
            ? (roads.every(r => r.named) ? null : '이름이 지도 데이터에 없는 도로가 있어 "이름 없는 도로"로 표시했습니다.')
            : 'HD Map 도로 데이터가 없어 구간을 표시하지 못했어요(구역 단위로만 추천합니다).',
          current: {
            collectionMinutes: row.collectionMinutes, visitCount: row.visitCount, uniqueDays: row.uniqueDays,
            lastVisitedAt: row.lastVisitedAt, daysSinceLastVisit: deficit.daysSince,
            weatherMinutes: row.weather || {},
            subZoneTotalMinutes: stats.collectionMinutes, subZoneVisits: stats.visitCount,
          },
          targets: { minutes: deficit.targetMinutes, visits: deficit.targetVisits },
          need,
          score: deficit.score,
          breakdown: deficit.parts,
          priority: priority.id,
          priorityLabel: priority.label,
          evidence,
          expects: SZ.expectedSituations(subZone),
          safetyNote: SZ.safetyNote(subZone),
          typeNote: (SZ.PLACE_TYPES[subZone.type] || {}).note || null,
          weatherSeen: weatherGaps,
          issueRecordCount: stats.issueRecordCount || 0,
          matchNote: stats.match ? stats.match.note : null,
          dataSources: [
            roads.some(r => r.named) ? 'HD Map 도로 구간' : null,
            stats.recordCount ? `이 구역 GPS 기록 ${stats.recordCount.toLocaleString('en-US')}건` : null,
            subZone.sourceType === 'manual' ? '사용자 직접 등록 구역' : null,
            subZone.sourceType === 'osm' ? 'OpenStreetMap 조회 결과' : null,
          ].filter(Boolean),
          edgeCaseDisclaimer: EDGE_CASE_DISCLAIMER,
        });
      });
    });

    items.sort((a, b) => b.score - a.score
      || b.need.additionalMinutes - a.need.additionalMinutes
      || (a.id < b.id ? -1 : 1));
    items.forEach((r, i) => { r.rank = i + 1; });
    return {
      version: RECOMMENDATION_VERSION,
      today,
      generatedAt: new Date(toMs(o.now)).toISOString(),
      issueFilter: IF.normalizeFilter(o.issueFilter === undefined ? 'clean' : o.issueFilter),
      targets: settings,
      recommendations: items,
      skipped,
      limitations: [
        '세부 구역은 등록된 구역만 봅니다 — 지도 전체를 자동으로 나누지 않습니다.',
        '도로 이름과 구간은 HD Map 에 실제로 있는 것만 씁니다(없으면 "이름 없는 도로" 또는 구간 생략).',
        '방향은 25m 안의 도로에 맞춘 기록으로만 나눕니다. 표본이 적으면 방향을 단정하지 않고 양방향으로 봅니다.',
        '예상 상황은 조건에서 나온 가능성이며 실제 발생을 보장하지 않습니다.',
      ],
    };
  }

  // ══════════════════════════════════════════════════════
  //  10) 도로 Segment 추천 — 자동 분석 결과로 "어디를 어느 방향으로 언제" 를 만든다
  //
  //  후보 = 도로 Segment × 요일 × 교통 시간대 × 조도 × 진행 방향.
  //  점수는 여덟 가지 부족도의 가중합이고, 가중치는 설정에서 바꿀 수 있다(합계 100%).
  //  모든 수치는 우리 데이터에서 나온 값이고, 없는 것은 "데이터 없음"으로 빼고 남은 가중치로 다시 나눈다.
  // ══════════════════════════════════════════════════════
  const SEGMENT_SCORE_KEYS = Object.freeze([
    'timePeriod', 'segmentCoverage', 'direction', 'lightCondition',
    'weatherDiversity', 'edgeCase', 'staleness', 'vehicleBias',
  ]);
  const SEGMENT_SCORE_LABELS = Object.freeze({
    timePeriod: '시간대 부족도', segmentCoverage: '구간 Coverage 부족도', direction: '방향별 부족도',
    lightCondition: '조도 조건 부족도', weatherDiversity: '날씨 다양성 부족도', edgeCase: 'Edge Case 가능성',
    staleness: '최근 미방문 기간', vehicleBias: '차량 편중도',
  });
  const SEGMENT_DEFAULTS = Object.freeze({
    weights: Object.freeze({
      timePeriod: 20, segmentCoverage: 20, direction: 15, lightCondition: 10,
      weatherDiversity: 10, edgeCase: 10, staleness: 10, vehicleBias: 5,
    }),
    targetMinutesPerCell: 60,     // 한 칸(구간×요일×시간대×조도×방향)의 목표 수집 시간
    targetVisitsPerCell: 2,
    staleDays: 21,
    maxCandidatesPerSegment: 4,
    resultCount: 12,
    minSegmentM: 60,              // 이보다 짧은 구간은 추천 대상에서 뺀다(교차로 조각)
    // 사업 우선도(HD Map 우선 구축구역) — 부족도 점수를 대신하지 않고 "보조"로만 섞는다.
    //   최종 점수 = Data Need Score × (100 − weight)% + Project Priority × weight%
    //   구역별 우선도(0~100)는 여기 두지 않는다 — 날짜별 Priority Policy(priority-policy.js, 설정 데이터)에서 읽는다.
    //   이 조건을 이미 목표만큼 모았으면 사업 우선도를 더하지 않는다(최우선 구역이라도 충분하면 올리지 않음).
    projectPriority: Object.freeze({ weight: 20 }),
  });

  function segmentSettings(input) {
    const s = input && typeof input === 'object' ? input : {};
    const weights = { ...SEGMENT_DEFAULTS.weights, ...(s.weights || {}) };
    const pp = s.projectPriority || {};
    // 예전 버전이 저장한 values(단계별 점수)는 쓰지 않는다 — 구역 우선도는 Priority Policy 에서 온다
    const projectPriority = { weight: pp.weight != null ? Number(pp.weight) : SEGMENT_DEFAULTS.projectPriority.weight };
    return { ...SEGMENT_DEFAULTS, ...s, weights, projectPriority };
  }

  // 가중치 합계가 100이 아니면 저장하지 않는다(추천 설정과 같은 규칙)
  function validateSegmentSettings(input) {
    const s = segmentSettings(input);
    const errors = [];
    let sum = 0;
    SEGMENT_SCORE_KEYS.forEach(k => {
      const v = Number(s.weights[k]);
      if (!Number.isFinite(v) || v < 0 || v > 100) errors.push(`${SEGMENT_SCORE_LABELS[k]} 가중치는 0~100 사이여야 해요.`);
      else sum += v;
    });
    if (!errors.length && Math.round(sum) !== 100) errors.push(`가중치 합계가 ${Math.round(sum)}% 예요 — 100% 가 되어야 저장할 수 있어요.`);
    if (!(s.targetMinutesPerCell > 0)) errors.push('한 칸 목표 수집 시간은 1분 이상이어야 해요.');
    const pw = s.projectPriority.weight;
    // 사업 우선도가 부족도를 넘어서면 "우선지역이라서 1등"이 된다 — 50% 까지만 허용한다
    if (!Number.isFinite(pw) || pw < 0 || pw > 50) errors.push('사업 우선도 비중은 0~50% 사이여야 해요(부족도 점수가 중심이어야 합니다).');
    return { ok: !errors.length, errors, value: s };
  }

  // 앱 설정 패치 중 segmentRecommendationSettings 를 검증(잘못되면 저장하지 않고 던짐)
  function normalizeSegmentSettingsPatch(partial) {
    const out = { ...(partial || {}) };
    if (!Object.prototype.hasOwnProperty.call(out, 'segmentRecommendationSettings')) return out;
    const v = validateSegmentSettings(out.segmentRecommendationSettings);
    if (!v.ok) { const err = new Error(v.errors.join('\n')); err.errors = v.errors; throw err; }
    out.segmentRecommendationSettings = v.value;
    return out;
  }

  // 앱 설정 패치 중 priorityPolicies 를 검증하고, 이전 정책은 목록에서 빠져도 보존한다(삭제 없음).
  // prevSettings: 저장소의 지금 설정. 잘못된 정책이 하나라도 있으면 아무것도 저장하지 않고 던진다.
  function normalizePriorityPolicyPatch(partial, prevSettings) {
    const out = { ...(partial || {}) };
    if (!Object.prototype.hasOwnProperty.call(out, 'priorityPolicies')) return out;
    if (!PP) return out;
    const prev = (prevSettings && Array.isArray(prevSettings.priorityPolicies)) ? prevSettings.priorityPolicies : [];
    const v = PP.mergePolicyPatch(prev, out.priorityPolicies);
    if (!v.ok) { const err = new Error(v.errors.join('\n')); err.errors = v.errors; throw err; }
    out.priorityPolicies = v.value;
    return out;
  }

  // ── 사업 우선도(HD Map 우선 구축구역 × Priority Policy) ──────────
  // areas: HDMapPriority.listAreas() 결과 [{areaNo, name, polygon, hasPolygon}] — 경계만 쓴다.
  // 구역별 우선도는 코드에 없다. 날짜별 Priority Policy(areaPriorities)에서 읽는다.
  // 구간이 어느 구역에 속하는지는 구간 중심 → (없으면) 좌표 과반으로 정한다. 경계 밖이면 null.
  const circledNo = n => (Number(n) >= 1 && Number(n) <= 20 ? String.fromCharCode(0x2460 + Number(n) - 1) : String(n));
  // 단계는 PriorityPolicy.tierOf 하나로 정한다(100 최우선 · 70~99 우선 · 40~69 보조 · 1~39 일반 · 0 비우선)
  // — 설정 탭 배지·통계 묶음과 같은 분류. 어느 구역인지와 무관하게 값에서 나온다.
  const TIER_LABELS = Object.freeze({ primary: '사업 우선 구축지역', priority: '우선 수집 구역', secondary: '보조 수집 구역', normal: '일반 구역', none: '비우선 구역' });
  const tierOfValue = v => (PP ? PP.tierOf(v) : { id: 'none', label: '비우선' });

  function projectAreaOf(seg, areas) {
    const list = (areas || []).filter(a => a && a.hasPolygon !== false && Array.isArray(a.polygon) && a.polygon.length >= 3);
    if (!list.length || !seg) return null;
    const c = seg.center;
    const byCenter = c ? list.find(a => SZ.pointInPolygon(c.lat, c.lng, a.polygon)) : null;
    if (byCenter) return { area: byCenter, basis: `구간 중심이 ${circledNo(byCenter.areaNo)} 경계 안` };
    const pts = seg.geometry || [];
    let best = null, bestN = 0;
    list.forEach(a => {
      const n = pts.filter(([la, lo]) => SZ.pointInPolygon(la, lo, a.polygon)).length;
      if (n > bestN) { best = a; bestN = n; }
    });
    if (best && bestN * 2 >= pts.length) return { area: best, basis: `구간 좌표 ${bestN}/${pts.length}개가 ${circledNo(best.areaNo)} 경계 안` };
    return null;
  }

  // 사업 우선도(0~100) — policy 의 areaPriorities 에서. 정책에 없는 구역·경계 밖은 0.
  function projectPriorityOf(seg, areas, policy) {
    const policyName = policy ? policy.policyName : null;
    const hit = projectAreaOf(seg, areas);
    // 정책이 없으면 모든 구역 비우선(설정·통계 화면과 같은 분류) — 사업 우선도 0
    if (!policy) {
      return hit
        ? { value: 0, level: 'none', areaNo: hit.area.areaNo, label: `${TIER_LABELS.none} ${circledNo(hit.area.areaNo)}`, basis: `${hit.basis} · 오늘 적용되는 Priority Policy 가 없어 모든 구역 비우선 → 0점`, policyName }
        : { value: 0, level: null, areaNo: null, label: '우선 구축구역 밖', basis: '오늘 적용되는 Priority Policy 가 없어 0점', policyName };
    }
    if (!hit) return { value: 0, level: null, areaNo: null, label: '우선 구축구역 밖', basis: `HD Map 우선 구축구역 경계 밖 → 0점 (정책: ${policyName})`, policyName };
    const a = hit.area;
    const raw = (policy.areaPriorities || {})[String(a.areaNo)];
    const value = Number.isFinite(Number(raw)) ? Math.max(0, Math.min(100, Number(raw))) : 0;
    const tier = tierOfValue(value);
    const no = circledNo(a.areaNo);
    return {
      value, level: tier.id, areaNo: a.areaNo,
      label: `${TIER_LABELS[tier.id]} ${no}`,
      basis: `${hit.basis} · 정책 "${policyName}"의 ${no} 우선도 ${value}${raw == null ? '(정책에 없음 → 0)' : ''}`,
      policyName,
    };
  }

  // 그 칸(요일·시간대·조도·방향)의 현재 수집 상태
  function cellStateOf(stat, cond, direction) {
    const cells = (stat && stat.cells) || [];
    let minutes = 0, visits = 0, records = 0, last = null;
    const weather = {};
    cells.forEach(c => {
      if (c.weekdayType !== cond.weekdayType || c.trafficPeriod !== cond.trafficPeriod) return;
      if (cond.lightCondition && c.lightCondition !== cond.lightCondition) return;
      if (direction !== 'both' && c.direction !== direction) return;
      minutes += c.collectionMinutes;
      visits += c.visitCount;
      records += c.recordCount;
      if (c.weather) weather[c.weather] = (weather[c.weather] || 0) + c.collectionMinutes;
      if (c.lastVisitedAt && (!last || c.lastVisitedAt > last)) last = c.lastVisitedAt;
    });
    return { minutes, visits, records, lastVisitedAt: last, weather };
  }

  // 평일/주말 후보 — 후보 시간대 중 하나라도 목표(한 칸 목표 분)에 못 미친 요일 유형만 만든다.
  //   기록이 전혀 없으면 둘 다, 둘 다 채웠으면 둘 다(점수가 낮게 나와 뒤로 밀린다) — 판단 근거를 남긴다.
  // ── 구간 표시 이름 ─────────────────────────────────────
  // 같은 도로의 서로 다른 구간이 "경부고속도로 · 경부고속도로 · …"처럼 똑같아 보이지 않게,
  //   (1) 구간 양끝에서 만나는 다른 도로의 이름(지도 데이터에 실제로 있는 이름)으로 "A → B"를 만들고
  //   (2) 그게 없으면 도로별 짧은 번호 "구간 #N"(서→동, 같으면 남→북 순서라 다시 분석해도 같다)을 쓴다.
  // IC·역 이름은 지도 데이터에 없어 만들지 않는다. 내부 segmentId 는 상세 화면에서만 보여준다.
  function segmentNaming(segments) {
    const byNode = new Map();
    segments.forEach(s => [s.startNode, s.endNode].forEach(n => {
      if (!n) return;
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n).push(s);
    }));
    const crossAt = (seg, node) => {
      const lengths = new Map();
      (byNode.get(node) || []).forEach(o => {
        if (o === seg || !o.named || o.roadName === seg.roadName) return;
        lengths.set(o.roadName, (lengths.get(o.roadName) || 0) + (o.lengthM || 0));
      });
      const best = [...lengths.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      return best ? best[0] : null;
    };
    const numberOf = new Map(), countOf = new Map();
    const byRoad = new Map();
    segments.forEach(s => { const k = s.named ? s.roadName : ''; if (!byRoad.has(k)) byRoad.set(k, []); byRoad.get(k).push(s); });
    byRoad.forEach((list, k) => {
      list.slice().sort((a, b) => (a.center.lng - b.center.lng) || (a.center.lat - b.center.lat) || (a.id < b.id ? -1 : 1))
        .forEach((s, i) => numberOf.set(s.id, i + 1));
      countOf.set(k, list.length);
    });
    return {
      cross: seg => ({ start: crossAt(seg, seg.startNode), end: crossAt(seg, seg.endNode) }),
      number: seg => numberOf.get(seg.id) || null,
      count: seg => countOf.get(seg.named ? seg.roadName : '') || 0,
    };
  }

  function segmentDisplay(seg, dir, naming) {
    const road = seg.named ? seg.roadName : '이름 없는 도로';
    const no = naming ? naming.number(seg) : null;
    const cross = naming ? naming.cross(seg) : { start: null, end: null };
    const backward = dir && dir.id === 'backward';
    const fromName = backward ? cross.end : cross.start;
    const toName = backward ? cross.start : cross.end;
    const numbered = no ? `${road} · 구간 #${no}` : road;
    const displayName = fromName && toName && fromName !== toName ? `${road} · ${fromName} → ${toName}` : numbered;
    return {
      displayName, numberedName: numbered, fromName: fromName || null, toName: toName || null,
      segmentNo: no, roadSegmentCount: naming ? naming.count(seg) : null,
      displayBasis: fromName && toName && fromName !== toName
        ? `구간 양끝에서 만나는 도로(지도 데이터): ${fromName} → ${toName}${dir && dir.id !== 'both' ? ` · ${dir.label} 기준` : ''}`
        : `양끝 교차 도로 이름이 지도 데이터에 없어 ${road}의 구간 번호로 표시(서→동 순서 #${no || '—'})`,
    };
  }

  function segmentWeekdayTypes(stat, periods, settings) {
    const t = settings.targetMinutesPerCell;
    const ids = ['weekday', 'weekend'];
    if (!stat || !stat.recordCount) {
      return ids.map(id => ({ id, deficient: true, basis: `이 구간 주행 기록이 없어 ${TC.WEEKDAY_TYPE_LABELS[id]}도 후보로 봅니다.` }));
    }
    const rows = ids.map(id => {
      const per = periods.map(p => ({ p, minutes: cellStateOf(stat, { weekdayType: id, trafficPeriod: p, lightCondition: null }, 'both').minutes }));
      const short = per.filter(x => x.minutes < t);
      return {
        id, deficient: short.length > 0,
        basis: short.length
          ? `${TC.WEEKDAY_TYPE_LABELS[id]} ${short.map(x => `${TC.TRAFFIC_PERIOD_LABELS[x.p]} ${x.minutes}분`).join(' · ')} — 한 칸 목표 ${t}분 미달`
          : `${TC.WEEKDAY_TYPE_LABELS[id]} 후보 시간대 모두 목표 ${t}분 이상`,
      };
    });
    const deficient = rows.filter(r => r.deficient);
    return deficient.length ? deficient : rows;
  }

  // 최종 점수 구성 — 부족도(기존 가중합 × 관련도)가 중심, 사업 우선도는 보조.
  // 이 조건의 목표를 이미 채웠으면 사업 우선도를 더하지 않는다("⑤인데 충분"은 올리지 않음).
  // Data Need Score(데이터 부족도)와 Project Priority(사업 우선도)를 따로 계산해 둔 뒤 섞는다.
  function composeSegmentScore(c, project, settings, policyRef) {
    const w = project ? settings.projectPriority.weight : 0;
    const needMinutes = Math.max(0, settings.targetMinutesPerCell - c.state.minutes);
    const applied = !!project && needMinutes > 0;
    const pv = project ? project.value : 0;
    const final = round1(c.deficitScore * (100 - w) / 100 + (applied ? pv * w / 100 : 0));
    return {
      rawDeficitScore: round1(c.rawScore),
      relevance: c.relevance,
      dataNeedScore: c.deficitScore,
      deficitScore: c.deficitScore,
      deficitWeight: 100 - w,
      projectPriorityScore: project ? pv : 0,
      policy: policyRef ? { policyId: policyRef.policyId, policyName: policyRef.policyName, updatedAt: policyRef.updatedAt } : null,
      project: project ? {
        value: pv, weight: w, applied, label: project.label, level: project.level, areaNo: project.areaNo, basis: project.basis,
        policyName: project.policyName,
        contribution: applied ? round2(pv * w / 100) : 0,
        skippedReason: !applied ? '이 조건은 이미 목표 수집 시간을 채워 사업 우선도를 더하지 않음' : null,
      } : null,
      deficitContribution: round2(c.deficitScore * (100 - w) / 100),
      final,
      formula: project
        ? `Final ${final} = Data Need ${c.deficitScore} × ${100 - w}% + Project Priority ${applied ? pv : 0} × ${w}%`
        : `Final ${final} = Data Need ${c.deficitScore} (Project Priority 0 · ${policyRef ? '이 범위에 해당 없음' : '적용 정책 없음'})`,
    };
  }

  function buildSegmentRecommendations(input) {
    const o = input || {};
    const analysis = o.analysis || { segments: [], zones: [] };
    const stats = o.segmentStats || {};
    const settings = segmentSettings(o.segmentSettings);
    const cfg = TC.classificationConfig(o.settings || {});
    const today = kstDate(o.now);
    const zoneBySegment = new Map();
    (analysis.zones || []).forEach(z => {
      if (z.active === false) return;
      (z.segmentIds || []).forEach(id => zoneBySegment.set(id, z));
    });
    const items = [];
    const skipped = [];
    // 사업 우선도 — 우선 구축구역 경계를 받았고, 이 분석 범위의 구간이 하나라도 그 안에 있을 때만 쓴다.
    // (서초처럼 ①~⑫ 와 겹치지 않는 구역은 "모두 0점"이 아니라 "해당 없음"으로 빼고 부족도만으로 순위를 정한다)
    const priorityAreas = (o.priorityAreas || []).filter(a => a && Array.isArray(a.polygon) && a.polygon.length >= 3);
    // 오늘(한국 날짜)에 적용되는 Priority Policy — 저장된 적이 없으면 구역 데이터 파일로 만든 초기 정책
    const policies = PP ? PP.resolvePolicies(o.priorityPolicies, o.priorityAreas || [], o.priorityAreasMeta) : [];
    const policy = PP ? PP.activePolicy(policies, today) : null;
    const projectAreasKnown = !!policy && priorityAreas.length > 0 && settings.projectPriority.weight > 0
      && (analysis.segments || []).some(s => projectAreaOf(s, priorityAreas));
    const projectNote = !policy
      ? `${today}에 적용되는 사업 우선 정책(Priority Policy)이 없어 사업 우선도는 0 — 데이터 부족도만으로 순위를 정했습니다.`
      : !priorityAreas.length
        ? 'HD Map 우선 구축구역 경계를 받지 못해 사업 우선도는 반영하지 않았습니다.'
        : settings.projectPriority.weight <= 0
          ? '사업 우선도 비중이 0% 라 반영하지 않았습니다.'
          : !projectAreasKnown ? '이 분석 범위에는 HD Map 우선 구축구역(①~⑫)이 없어 사업 우선도는 반영하지 않았습니다.' : null;
    const policyRef = PP ? PP.reference(policy) : null;
    const naming = segmentNaming(analysis.segments || []);

    (analysis.segments || []).forEach(seg => {
      const zone = zoneBySegment.get(seg.id);
      if (!zone) { return; }                       // 제외(보정)된 구역의 구간은 추천하지 않는다
      // 너무 짧은 구간(교차로 꼭짓점 조각 등)은 "달리러 갈 곳"이 못 된다
      if (seg.lengthM < settings.minSegmentM) { skipped.push({ segment: seg.label, reason: `구간이 ${seg.lengthM}m 로 너무 짧습니다.` }); return; }
      const stat = stats[seg.id] || null;
      const type = SZA.SEMANTIC_TYPES[zone.semanticType] || SZA.SEMANTIC_TYPES.unclassified;
      // 후보 시간대 — 유형이 정한 시간대. 유형을 모르면 그 구간에 기록이 있는 시간대로.
      let periods = (zone.candidateTimes || []).slice();
      if (!periods.length && stat && stat.periods) {
        periods = Object.entries(stat.periods).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
      }
      if (!periods.length) periods = ['morning_peak', 'evening_peak'];
      // 평일/주말 — 이 구간에서 실제로 부족한 요일 유형만 후보로 만든다(근거를 카드에 남긴다)
      const weekdayPlan = segmentWeekdayTypes(stat, periods, settings);
      const weekdayBasisOf = new Map(weekdayPlan.map(w => [w.id, w.basis]));
      const location = seg.center;
      const perSegment = [];
      const project = projectAreasKnown ? projectPriorityOf(seg, priorityAreas, policy) : null;

      weekdayPlan.map(w => w.id).forEach(weekdayType => {
        const referenceDate = nextDateOfType(today, weekdayType);
        const light = location ? lightIntervals(referenceDate, location, cfg) : null;
        periods.forEach(periodId => {
          const period = cfg.trafficPeriods.find(p => p.id === periodId);
          if (!period) return;
          const pIntervals = periodIntervals(period);
          const lightOptions = light
            ? TC.LIGHT_CONDITION_IDS.map(id => ({ id, segments: intersect(pIntervals, light.intervals[id] || []) }))
              .filter(l => lengthOf(l.segments) >= MIN_CANDIDATE_WINDOW_MINUTES)
            : [{ id: null, segments: pIntervals }];
          lightOptions.forEach(lightOpt => {
            const cond = { weekdayType, trafficPeriod: periodId, lightCondition: lightOpt.id };
            // 방향 — 신뢰할 만하면 적게 모인 쪽, 아니면 양방향
            const dirs = stat ? directionsOf(seg, stat) : [{ id: 'both', label: '양방향', confident: false, reason: '이 구간 주행 기록이 아직 없어 방향을 알 수 없어요.' }];
            dirs.forEach(dir => {
              const state = cellStateOf(stat, cond, dir.id);
              const scored = scoreSegmentCandidate({ seg, zone, stat, state, cond, dir, settings, today, analysis });
              perSegment.push({ seg, zone, stat, state, cond, dir, lightOpt, referenceDate, light, weekdayBasis: weekdayBasisOf.get(weekdayType), ...scored });
            });
          });
        });
      });

      // 관련도 — 부족한 것만 보면 "한 번도 안 가봤고 성격도 모르는 골목"이 항상 1등이 된다.
      // 우리가 실제로 다니는 구간(기록 있음)과 지도로 성격이 확인된 구간을 먼저 권한다.
      // 낮춘 이유는 카드에 그대로 적는다(숨기지 않는다).
      const confirmed = zone.semanticType !== 'unclassified';
      const relevance = stat && stat.recordCount ? 1 : (confirmed ? 0.8 : 0.35);
      const relevanceReason = stat && stat.recordCount
        ? null
        : (confirmed
          ? '이 구간 주행 기록이 아직 없어 우선순위를 낮췄어요(지도로 성격은 확인됨).'
          : '이 구간 주행 기록도 없고 지도에서 성격도 확인되지 않아 우선순위를 크게 낮췄어요.');
      perSegment.forEach(c => {
        c.rawScore = c.score;
        c.relevance = relevance;
        c.relevanceReason = relevanceReason;
        c.deficitScore = round1(c.score * relevance);
        c.composition = composeSegmentScore(c, project, settings, policyRef);
        c.score = c.composition.final;
      });
      perSegment.sort((a, b) => b.score - a.score);
      perSegment.slice(0, settings.maxCandidatesPerSegment).forEach(c => items.push(makeSegmentRecommendation({ ...c, naming }, settings, today)));
      if (!perSegment.length) skipped.push({ segment: seg.label, reason: '후보 시간대를 정하지 못했습니다.' });
    });

    items.sort((a, b) => b.score - a.score
      || b.need.additionalMinutes - a.need.additionalMinutes
      || (a.id < b.id ? -1 : 1));
    items.forEach((r, i) => { r.rank = i + 1; });
    const visible = items.slice(0, settings.resultCount);
    return {
      version: RECOMMENDATION_VERSION,
      algorithmVersion: SZA.AUTO_ANALYSIS_VERSION,
      today,
      generatedAt: new Date(toMs(o.now)).toISOString(),
      issueFilter: IF.normalizeFilter(o.issueFilter === undefined ? 'clean' : o.issueFilter),
      settings,
      weights: settings.weights,
      projectPriority: { applied: projectAreasKnown, weight: settings.projectPriority.weight, note: projectNote },
      // 이 추천을 만든 정책 — 과거 추천을 다시 볼 때 "당시 적용 정책"
      policy: policyRef,
      policyCount: policies.length,
      candidateCount: items.length,
      recommendations: visible,
      allRecommendations: items,
      skipped,
      dataLevels: analysis.dataLevels || null,
      analysisNotes: analysis.notes || [],
      limitations: [
        projectAreasKnown
          ? `최종 점수 = Data Need Score × ${100 - settings.projectPriority.weight}% + Project Priority × ${settings.projectPriority.weight}% — 적용 정책 "${policy.policyName}"(${PP.summarize(policy)}). 이 조건을 이미 목표만큼 모은 구간은 사업 우선도를 더하지 않습니다.`
          : projectNote,
        'Edge Case 점수는 실제 이벤트 기록이 없어 "그 장소 유형에서 상황이 생길 가능성(분류 근거의 확실성) × 이 조건 수집 부족"으로 잡은 대리 지표입니다.',
        '자동 분류는 지도 데이터와 우리 주행 기록에서 나온 근거만 씁니다 — 확인되지 않은 장소·시설 이름은 만들지 않습니다.',
        '예상 상황은 조건에서 나온 가능성이며 실제 발생을 보장하지 않습니다.',
        '방향은 25m 안의 도로에 맞춘 기록으로만 나눕니다. 표본이 적으면 양방향으로 봅니다.',
        '진입 금지·보행자 전용·사유지 도로 정보는 지도 데이터에 없으면 알 수 없습니다 — 현장 표지와 교통법규를 우선하세요.',
      ],
    };
  }

  // 방향 후보 — 방향 판정이 믿을 만하면 적게 모인 쪽 하나, 아니면 양방향 하나
  function directionsOf(seg, stat) {
    const f = stat.directions.forward || 0;
    const b = stat.directions.backward || 0;
    const conf = SZ.directionConfidence(f, b, stat.directions.unknown || 0);
    if (!conf.ok) return [{ id: 'both', label: '양방향', confident: false, reason: conf.reason }];
    const less = f <= b ? 'forward' : 'backward';
    const label = less === 'forward' ? `${seg.headingLabel}쪽 방향` : `${seg.backHeadingLabel}쪽 방향`;
    return [{
      id: less, label, confident: true,
      reason: `${seg.headingLabel}쪽 ${f}건 · ${seg.backHeadingLabel}쪽 ${b}건 — 적게 모인 쪽을 권합니다.`,
    }];
  }

  function scoreSegmentCandidate({ seg, zone, stat, state, cond, dir, settings, today }) {
    const sub = {};
    const details = {};
    const t = settings.targetMinutesPerCell;

    sub.timePeriod = clamp(100 * (1 - state.minutes / Math.max(1, t)), 0, 100);
    details.timePeriod = `${state.minutes}분 / 목표 ${t}분`;

    if (stat && stat.coverage) {
      sub.segmentCoverage = clamp(100 - stat.coverage.percent, 0, 100);
      details.segmentCoverage = `이 구간 ${stat.coverage.percent}% (20m 칸 ${stat.coverage.coveredCells}/${stat.coverage.totalCells})`;
    } else {
      sub.segmentCoverage = 100;
      details.segmentCoverage = '이 구간 주행 기록 없음';
    }

    if (stat && dir.confident) {
      const f = stat.directions.forward || 0, b = stat.directions.backward || 0;
      const less = Math.min(f, b), more = Math.max(f, b);
      sub.direction = more > 0 ? clamp(100 * (1 - less / more), 0, 100) : 100;
      details.direction = `${seg.headingLabel}쪽 ${f}건 · ${seg.backHeadingLabel}쪽 ${b}건`;
    } else {
      sub.direction = null;
      details.direction = dir.reason || '방향을 확인할 수 없음';
    }

    if (cond.lightCondition) {
      const lightMinutes = cellStateOf(stat, { ...cond }, dir.id).minutes;
      sub.lightCondition = clamp(100 * (1 - lightMinutes / Math.max(1, t)), 0, 100);
      details.lightCondition = `${TC.LIGHT_CONDITION_LABELS[cond.lightCondition]} ${lightMinutes}분 / 목표 ${t}분`;
    } else {
      sub.lightCondition = null;
      details.lightCondition = '구역 좌표가 없어 조도를 계산하지 못함';
    }

    const weathers = Object.keys(state.weather || {});
    if (stat && stat.recordCount) {
      sub.weatherDiversity = weathers.length >= 2 ? 0 : weathers.length === 1 ? 60 : 100;
      details.weatherDiversity = weathers.length ? `${weathers.join(', ')} 만 수집됨` : '이 조건 날씨 기록 없음';
    } else {
      sub.weatherDiversity = null;
      details.weatherDiversity = '이 구간 기록이 없어 날씨 다양성을 알 수 없음';
    }

    // Edge Case 우선도 = 발생 가능성(그 장소 유형 판정이 얼마나 확실한가) × 이 조건의 수집 부족.
    // 예상 상황 "개수"로 점수를 올리지 않는다 — 많이 나열된 유형이 부족하지 않아도 앞서는 것을 막는다.
    // 실제 Edge Case 이벤트 기록이 없어 발생 빈도는 모른다 → 분류 근거를 가능성의 대리값으로 쓴다.
    const expects = zone.expects || [];
    const likelihood = edgeCaseLikelihood(seg, zone);
    if (expects.length && likelihood) {
      const shortfall = clamp(1 - state.minutes / Math.max(1, t), 0, 1);
      sub.edgeCase = round1(100 * likelihood.value * shortfall);
      details.edgeCase = `${zone.semanticLabel} 예상 상황 ${expects.length}가지 · 발생 가능성 ${likelihood.value}(${likelihood.basis}) × 이 조건 수집 부족 ${Math.round(shortfall * 100)}%`;
    } else {
      sub.edgeCase = null;
      details.edgeCase = '유형을 확인하지 못해 기대 상황을 정하지 못함';
    }

    const lastDate = state.lastVisitedAt ? String(state.lastVisitedAt).slice(0, 10) : null;
    const days = lastDate ? Math.max(0, daysBetween(lastDate, today)) : null;
    sub.staleness = days == null ? 100 : clamp(100 * (days / Math.max(1, settings.staleDays)), 0, 100);
    details.staleness = days == null ? '이 조건 기록 없음' : `마지막 수집 ${days}일 전`;

    if (stat && stat.vehicleCounts && stat.vehicleCounts.length) {
      const total = stat.vehicleCounts.reduce((a, v) => a + v[1], 0);
      const top = stat.vehicleCounts[0][1] / total;
      sub.vehicleBias = clamp((top - 1 / Math.max(1, stat.vehicleCounts.length)) * 150, 0, 100);
      details.vehicleBias = `${stat.vehicleCounts[0][0]} 비중 ${Math.round(top * 100)}% (차량 ${stat.vehicleCounts.length}대)`;
    } else {
      sub.vehicleBias = null;
      details.vehicleBias = '차량별 기록 없음';
    }

    // 데이터가 없는 항목은 빼고 남은 가중치로 다시 나눈다(없는 것을 0점으로 깎지 않는다)
    let sum = 0, available = 0;
    const breakdown = SEGMENT_SCORE_KEYS.map(key => {
      const w = settings.weights[key] || 0;
      const v = sub[key];
      const excluded = v == null;
      if (!excluded) { sum += v * w; available += w; }
      return { key, label: SEGMENT_SCORE_LABELS[key], weight: w, value: excluded ? null : round1(v), excluded, current: details[key] };
    });
    const score = available > 0 ? round1(sum / available) : 0;
    breakdown.forEach(b => { b.contribution = b.excluded ? 0 : round2((b.value * b.weight) / Math.max(1, available)); });
    return { score, subScores: sub, breakdown, availableWeight: available, details };
  }

  function makeSegmentRecommendation(c, settings, today) {
    const { seg, zone, stat, state, cond, dir, lightOpt } = c;
    const period = TC.TRAFFIC_PERIOD_LABELS[cond.trafficPeriod];
    const window = (() => {
      const segs = lightOpt && lightOpt.segments && lightOpt.segments.length ? lightOpt.segments : null;
      if (!segs) return { text: '시간대 전체', note: null };
      const longest = segs.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
      const r = roundSegment(longest);
      return {
        start: TC.formatClock(r[0]), end: TC.formatClock(r[1]),
        text: `${TC.formatClock(r[0])}~${TC.formatClock(r[1])}`,
        note: (cond.lightCondition === 'sunset' || cond.lightCondition === 'sunrise')
          ? '실제 일출·일몰 시각에 따라 ±30분 조정하세요.' : null,
      };
    })();
    const needMinutes = Math.max(0, settings.targetMinutesPerCell - state.minutes);
    const passMinutes = Math.max(6, Math.round((seg.lengthM / 1000) / 20 * 60));  // 혼잡 구간 20km/h 가정
    const passes = needMinutes > 0 ? Math.max(1, Math.ceil(needMinutes / passMinutes)) : 0;
    const priority = priorityOf(c.score);
    const days = state.lastVisitedAt ? daysBetween(String(state.lastVisitedAt).slice(0, 10), today) : null;
    const confidence = segmentConfidence(c);
    return {
      id: `${seg.id}|${cond.weekdayType}|${cond.trafficPeriod}|${cond.lightCondition || 'any'}|${dir.id}`,
      rank: null,
      parentZone: seg.parentZone,
      subZoneId: zone.id,
      subZoneName: zone.name,
      subZoneAuto: zone.auto !== false,
      semanticType: zone.semanticType,
      semanticLabel: zone.semanticLabel,
      segmentId: seg.id,
      segmentLabel: seg.label,
      // 사람이 읽는 이름 — "도로명 · 교차 도로 → 교차 도로"(진행 방향 기준), 모르면 "도로명 · 구간 #N"
      ...segmentDisplay(seg, dir, c.naming),
      roadName: seg.roadName,
      roadNamed: seg.named,
      lengthM: seg.lengthM,
      lengthKm: round1(seg.lengthM / 1000),
      start: seg.start,
      end: seg.end,
      startLabel: seg.startJunction ? '교차로' : '구간 시작',
      endLabel: seg.endJunction ? '교차로' : '구간 끝',
      geometry: seg.geometry,
      direction: { id: dir.id, label: dir.label, confident: dir.confident, reason: dir.reason },
      condition: cond,
      conditionLabel: [TC.WEEKDAY_TYPE_LABELS[cond.weekdayType], period,
        cond.lightCondition ? TC.LIGHT_CONDITION_LABELS[cond.lightCondition] : null].filter(Boolean).join(' · '),
      timeWindow: window,
      weekdayType: cond.weekdayType,
      weekdayLabel: TC.WEEKDAY_TYPE_LABELS[cond.weekdayType],
      weekdayBasis: c.weekdayBasis || null,
      current: {
        collectionMinutes: state.minutes, collectionSec: state.minutes * 60, visitCount: state.visits, recordCount: state.records,
        lastVisitedAt: state.lastVisitedAt, daysSinceLastVisit: days,
        coveragePercent: stat && stat.coverage ? stat.coverage.percent : null,
        segmentTotalMinutes: stat ? stat.collectionMinutes : 0,
        weatherMinutes: state.weather,
        vehicles: stat ? stat.vehicleCounts : [],
      },
      targets: { minutes: settings.targetMinutesPerCell, visits: settings.targetVisitsPerCell },
      need: {
        additionalMinutes: needMinutes,
        targetMinutes: settings.targetMinutesPerCell,
        targetVisits: settings.targetVisitsPerCell,
        passes, passMinutes,
        estimatedMinutes: passes * passMinutes,
        text: passes ? `${dir.label} ${passes}회(편도 약 ${passMinutes}분)` : '이 조건은 목표를 채웠어요',
      },
      score: c.score,
      deficitScore: c.deficitScore != null ? c.deficitScore : c.score,
      scoreComposition: c.composition || null,
      dataNeedScore: c.deficitScore != null ? c.deficitScore : c.score,
      policy: c.composition ? c.composition.policy : null,
      projectPriority: c.composition && c.composition.project ? c.composition.project : null,
      rawScore: c.rawScore != null ? c.rawScore : c.score,
      relevance: c.relevance != null ? c.relevance : 1,
      relevanceReason: c.relevanceReason || null,
      breakdown: c.breakdown,
      availableWeight: c.availableWeight,
      priority: priority.id,
      priorityLabel: priority.label,
      confidence,
      expects: zone.expects || [],
      safetyFirst: !!zone.safetyFirst,
      classificationBasis: zone.basis || [],
      nameBasis: zone.nameBasis,
      evidence: zone.evidence || seg.evidence,
      dataSources: [
        seg.source && seg.source.type === 'hdmap' ? 'HD Map 도로 구간' : null,
        stat ? `이 구간 GPS 기록 ${stat.recordCount.toLocaleString('en-US')}건` : '이 구간 GPS 기록 없음',
        zone.override ? '사용자 보정' : null,
      ].filter(Boolean),
      reason: segmentReason({ seg, zone, state, cond, dir, c, days }),
      edgeCaseDisclaimer: EDGE_CASE_DISCLAIMER,
      safetyNote: zone.safetyFirst
        ? '어린이보호구역·학교 주변은 데이터 수집보다 안전과 법규 준수가 먼저입니다. 제한속도를 지키고, 정문 앞 정차나 반복 배회 없이 정상 통과 주행으로만 수집하세요.'
        : null,
    };
  }

  // 그 장소 유형에서 예상 상황이 생길 가능성의 대리값(0~1) — 판정 근거의 출처·확실성으로만 정한다.
  // 공식 데이터·지도 등급 > POI > 도로망 모양 > 우리 주행 패턴 관측. 사용자가 고친 유형은 사람이 확인한 것으로 본다.
  const EDGE_SOURCE_LIKELIHOOD = Object.freeze({ official: 1, map: 0.9, poi: 0.8, graph: 0.7, gps: 0.6 });
  const EDGE_CONF_FACTOR = Object.freeze({ high: 1, medium: 0.9, low: 0.7 });
  const EDGE_SOURCE_LABELS = Object.freeze({ official: '공식 데이터', map: '지도 도로 등급', poi: '지도 POI', graph: '도로망 모양', gps: '주행 기록 관측' });
  function edgeCaseLikelihood(seg, zone) {
    if (!zone || zone.semanticType === 'unclassified') return null;
    if (zone.override && zone.override.semanticType) return { value: 0.8, basis: '사용자가 유형을 직접 지정' };
    const t = ((seg && seg.semanticTypes) || []).find(x => x.type === zone.semanticType);
    if (!t || !EDGE_SOURCE_LIKELIHOOD[t.source]) return null;
    const value = round2(EDGE_SOURCE_LIKELIHOOD[t.source] * (EDGE_CONF_FACTOR[t.confidence] || 0.7));
    return { value, basis: `${EDGE_SOURCE_LABELS[t.source]} 근거 · 신뢰 ${t.confidence}` };
  }

  function segmentConfidence(c) {
    const reasons = [];
    const stat = c.stat;
    if (!stat || !stat.recordCount) reasons.push({ severity: 'major', text: '이 구간 주행 기록이 아직 없어 현재 수집량을 비교할 수 없음' });
    else if (stat.recordCount < 50) reasons.push({ severity: 'minor', text: `이 구간 기록이 ${stat.recordCount}건으로 적음` });
    if (!c.dir.confident) reasons.push({ severity: 'minor', text: '방향을 확정할 만큼 표본이 많지 않아 양방향으로 봄' });
    if (c.zone.semanticType === 'unclassified') reasons.push({ severity: 'major', text: '지도 POI·도로 등급이 없어 구간 성격을 확인하지 못함' });
    else if ((c.zone.evidence || {}).id === 'low') reasons.push({ severity: 'minor', text: '장소 근거가 약함(지도 정보 제한적)' });
    if (!c.cond.lightCondition) reasons.push({ severity: 'minor', text: '조도 조건을 계산하지 못함' });
    const majors = reasons.filter(r => r.severity === 'major').length;
    const level = majors ? 'low' : (reasons.length ? 'medium' : 'high');
    if (!reasons.length) reasons.push({ severity: 'ok', text: '지도 구간·주행 기록·방향 표본이 모두 있음' });
    return { level, label: CONFIDENCE_LEVELS[level].label, rank: CONFIDENCE_LEVELS[level].rank, reasons };
  }

  function segmentReason({ seg, zone, state, cond, dir, c, days }) {
    const worst = c.breakdown.filter(b => !b.excluded).sort((a, b) => b.contribution - a.contribution)[0];
    const parts = [];
    parts.push(`${seg.label}(${zone.semanticLabel})의 ${TC.WEEKDAY_TYPE_LABELS[cond.weekdayType]} ${TC.TRAFFIC_PERIOD_LABELS[cond.trafficPeriod]}${cond.lightCondition ? ` · ${TC.LIGHT_CONDITION_LABELS[cond.lightCondition]}` : ''} 수집은 ${state.minutes}분입니다.`);
    if (dir.confident) parts.push(`${dir.reason}`);
    if (days != null) parts.push(`마지막 수집은 ${days}일 전입니다.`);
    if (c.relevanceReason) parts.push(c.relevanceReason);
    if (worst) parts.push(`점수를 가장 많이 올린 항목은 ${worst.label}(${worst.value}점 — ${worst.current})입니다.`);
    if (c.weekdayBasis) parts.push(`${TC.WEEKDAY_TYPE_LABELS[cond.weekdayType]} 후보 근거: ${c.weekdayBasis}.`);
    const p = c.composition && c.composition.project;
    if (p && p.level && p.value > 0) parts.push(p.applied ? `${p.label}(사업 우선도 ${p.value}점 × ${p.weight}% 반영 · 정책 "${p.policyName}").` : `${p.label}이지만 ${p.skippedReason}.`);
    return parts.join(' ');
  }

  // ── 정렬 · 필터 · 상태(숨김/제외/완료) ─────────────────
  const idCompare = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const SORTS = {
    // 동점이면: 추가로 필요한 수집 시간이 큰 순 → 신뢰도 높은 순 → id 순(항상 같은 순서)
    score: (a, b) => ((b.score ?? -1) - (a.score ?? -1)) || (b.need.additionalMinutes - a.need.additionalMinutes) || (b.confidence.rank - a.confidence.rank) || idCompare(a, b),
    coverage: (a, b) => ((a.coverage.coveragePercent ?? Infinity) - (b.coverage.coveragePercent ?? Infinity)) || SORTS.score(a, b),
    minutesDeficit: (a, b) => (b.need.additionalMinutes - a.need.additionalMinutes) || SORTS.score(a, b),
    lastVisit: (a, b) => {
      const av = a.current.lastVisitedAt || '', bv = b.current.lastVisitedAt || '';
      if (av !== bv) { if (!av) return -1; if (!bv) return 1; return av < bv ? -1 : 1; }
      return SORTS.score(a, b);
    },
  };
  const SORT_LABELS = Object.freeze({ score: '추천 점수 높은 순', coverage: 'Coverage 낮은 순', minutesDeficit: '수집 시간 부족 순', lastVisit: '마지막 방문이 오래된 순' });
  function sortRecommendations(recs, sortKey) {
    return [...(recs || [])].sort(SORTS[sortKey] || SORTS.score);
  }

  // filters: {zone, weekdayType, trafficPeriod, lightCondition, weather, minConfidence('low'|'medium'|'high')}
  function filterRecommendations(recs, filters, settings) {
    const f = filters || {};
    const minRank = f.minConfidence && CONFIDENCE_LEVELS[f.minConfidence] ? CONFIDENCE_LEVELS[f.minConfidence].rank : 1;
    const showLow = !settings || settings.showLowConfidence !== false;
    const want = (v, actual) => !v || v === 'all' || v === actual;
    return (recs || []).filter(r => want(f.zone, r.zone) && want(f.weekdayType, r.condition.weekdayType) && want(f.trafficPeriod, r.condition.trafficPeriod)
      && want(f.lightCondition, r.condition.lightCondition) && want(f.weather, r.condition.weather)
      && r.confidence.rank >= minRank && (showLow || r.confidence.level !== 'low'));
  }

  // states: {id: {status:'snoozed'|'completed', until, markedAt, snapshot:{collectionSec, visitCount}}}
  // sessionHidden: 이번 화면에서만 숨긴 id 집합(저장하지 않음)
  // 실제 수집 데이터는 절대 바꾸지 않는다 — 상태는 추천 표시만 바꾼다.
  function applyRecommendationStates(recs, states, sessionHidden, now) {
    const today = kstDate(now);
    const visible = [], hidden = [];
    (recs || []).forEach(r => {
      const st = states && states[r.id];
      if (sessionHidden && (sessionHidden.has ? sessionHidden.has(r.id) : sessionHidden[r.id])) { hidden.push({ rec: r, status: 'hidden_once', note: '이번에만 숨김 — 화면을 새로 열면 다시 보여요' }); return; }
      if (st && st.status === 'snoozed' && st.until && st.until > today) { hidden.push({ rec: r, status: 'snoozed', note: `${st.until}까지 추천 제외` }); return; }
      if (st && st.status === 'completed') {
        const snap = st.snapshot || { collectionSec: 0, visitCount: 0 };
        const met = r.need.additionalMinutes === 0 && r.current.visitCount >= r.need.targetVisits;
        const grew = r.current.collectionSec > snap.collectionSec || r.current.visitCount > snap.visitCount;
        if (met) { hidden.push({ rec: r, status: 'achieved', note: '수집 완료로 표시했고 실제 수집량도 목표를 채웠어요' }); return; }
        if (grew) {
          visible.push({ ...r, reopened: true, stateNote: `완료로 표시한 뒤 ${Math.round((r.current.collectionSec - snap.collectionSec) / 60)}분·방문 ${r.current.visitCount - snap.visitCount}회가 새로 수집됐지만 아직 목표(${r.need.targetMinutes}분·${r.need.targetVisits}회)에 못 미쳐 다시 추천해요` });
          return;
        }
        hidden.push({ rec: r, status: 'completed', note: '수집 완료로 표시함 — 아직 새 주행 데이터가 없어요. 파일을 불러오면 실제 수집량으로 다시 평가해요' });
        return;
      }
      visible.push(r);
    });
    return { visible, hidden };
  }

  function snoozeUntil(now, days) { return addDaysStr(kstDate(now), days); }

  // ══════════════════════════════════════════════════════
  //  오늘 추천 주행(간단 보기) — "어디를 · 언제 · 왜" 만 뽑는다
  //
  //  새 점수를 만들지 않는다. 이미 계산된 도로 Segment 추천(없으면 구역 추천)에서
  //    · 오늘의 요일 유형(평일/주말)과 운행 시간에 맞는 것만,
  //    · 숨김·기간 제외·완료 상태를 적용하고,
  //    · 같은 구간은 한 번만 골라 점수 순 Top N 을 만든 뒤 시간 순서로 보여준다.
  //  이유 문장은 그 추천의 점수 항목 중 기여가 큰 것을 짧은 말로 바꾼 것뿐이다.
  // ══════════════════════════════════════════════════════
  const SHORT_ANALYSIS_LABELS = Object.freeze({
    LEFT_TURN: '좌회전', RIGHT_TURN: '우회전', U_TURN: '유턴', MERGE: '합류', DIVERGE: '분기', STRAIGHT: '직진',
    MOVING: '주행', SLOW: '저속', STOPPED: '정지',
    NORMAL_ROAD: '일반도로', INTERSECTION: '교차로', MERGE_AREA: '합류구간', DIVERGE_AREA: '분기구간',
    HIGHWAY: '고속도로', RAMP: '램프', SCHOOL_ZONE: 'SCHOOL_ZONE',
  });

  function shortReasonOf(b, r) {
    const cond = r.condition || {};
    const period = TC.TRAFFIC_PERIOD_LABELS[cond.trafficPeriod] || '';
    const light = cond.lightCondition ? TC.LIGHT_CONDITION_LABELS[cond.lightCondition] : '';
    switch (b.key) {
      case 'timePeriod': return `${period} 데이터 부족`;
      case 'coverage': case 'segmentCoverage': return 'Coverage 부족';
      case 'direction': return `${(r.direction && r.direction.label) || '한쪽 방향'} 데이터 부족`;
      case 'lightCondition': return `${light || '조도'} 조건 부족`;
      case 'weatherDiversity': return '날씨 다양성 부족';
      case 'maneuver': return `${SHORT_ANALYSIS_LABELS[(r.current && r.current.maneuver && r.current.maneuver.value)] || 'Ego Maneuver'} 데이터 부족`;
      case 'roadContext': return `${SHORT_ANALYSIS_LABELS[(r.current && r.current.roadContext && r.current.roadContext.value)] || 'Road Context'} 데이터 부족`;
      case 'edgeCase': return `${r.semanticLabel || '이 장소 유형'} 상황 데이터 부족`;
      case 'staleness': return r.current && r.current.daysSinceLastVisit != null ? `${r.current.daysSinceLastVisit}일째 미방문` : '방문 기록 없음';
      case 'vehicleImbalance': case 'vehicleBias': return '차량 편중';
      default: return b.label;
    }
  }

  function windowOf(r) {
    const w = r.timeWindow || r.timeRange || null;
    if (!w || !w.start || !w.end) return null;
    const s = TC.parseClock(w.start, false), e = TC.parseClock(w.end, true);
    return s == null || e == null ? null : { start: w.start, end: w.end, from: s, to: e > s ? e : e + 1440 };
  }

  // input: { segmentRecs, zoneRecs, states, sessionHidden, now, window:{start,end}, weekdayType, count, vehicleCount }
  function buildTodayPicks(input) {
    const o = input || {};
    const count = Math.max(1, Math.min(10, Number(o.count) || 3));
    const today = kstDate(o.now);
    const weekdayType = o.weekdayType && TC.WEEKDAY_TYPE_IDS.includes(o.weekdayType) ? o.weekdayType : TC.classifyWeekdayType(today);
    const useSegments = Array.isArray(o.segmentRecs) && o.segmentRecs.length > 0;
    const source = useSegments ? 'segment' : 'zone';
    const pool = (useSegments ? o.segmentRecs : (o.zoneRecs || [])).filter(r => r && r.condition && r.condition.weekdayType === weekdayType);
    const stated = applyRecommendationStates(pool, o.states || {}, o.sessionHidden || null, o.now).visible
      .filter(r => r.score != null && r.need && r.need.additionalMinutes > 0);
    const ws = o.window ? TC.parseClock(o.window.start, false) : null;
    const we = o.window ? TC.parseClock(o.window.end, true) : null;
    const hasWindow = ws != null && we != null && we > ws;
    const overlap = r => {
      const w = windowOf(r);
      if (!w || !hasWindow) return 0;
      return Math.max(0, Math.min(w.to, we) - Math.max(w.from, ws));
    };
    let candidates = hasWindow ? stated.filter(r => overlap(r) >= 15) : stated;
    const notes = [];
    if (hasWindow && !candidates.length && stated.length) {
      notes.push(`운행 시간(${o.window.start}~${o.window.end})에 맞는 추천이 없어, 시간과 무관하게 부족한 순서로 보여줍니다.`);
      candidates = stated;
    }
    const seen = new Set();
    const picked = [];
    [...candidates].sort((a, b) => (b.score - a.score) || (b.need.additionalMinutes - a.need.additionalMinutes) || idCompare(a, b)).forEach(r => {
      if (picked.length >= count) return;
      const key = useSegments ? r.segmentId : `${r.zone}|${r.condition.trafficPeriod}`;
      if (seen.has(key)) return;
      seen.add(key);
      picked.push(r);
    });
    const items = picked.map((r, i) => {
      const w = windowOf(r);
      const reasons = (r.breakdown || []).filter(b => !b.excluded && b.value >= 40)
        .sort((a, b) => b.contribution - a.contribution).slice(0, 2).map(b => shortReasonOf(b, r));
      const project = r.projectPriority && r.projectPriority.level && r.projectPriority.applied && r.projectPriority.value > 0 ? r.projectPriority.label : null;
      const minutes = useSegments
        ? Math.max(r.need.passMinutes || 0, Math.min(r.need.estimatedMinutes || 0, w ? w.to - w.from : Infinity))
        : Math.max(0, r.need.estimatedMinutesThisStage || 0);
      return {
        id: r.id, scoreRank: i + 1, source,
        // 어디 — 도로 구간은 "도로명 · A → B"(없으면 "도로명 · 구간 #N"), 구역 추천은 구역 이름
        title: useSegments ? (r.displayName || r.segmentLabel) : r.zone,
        numberedTitle: useSegments ? (r.numberedName || r.segmentLabel) : r.zone,
        area: useSegments ? [r.parentZone, r.projectPriority && r.projectPriority.areaNo ? `${circledNo(r.projectPriority.areaNo)}구역` : null].filter(Boolean).join(' ') : r.zone,
        place: useSegments ? r.subZoneName : null,
        semanticLabel: r.semanticLabel || null,
        direction: useSegments ? r.direction.label : null,
        route: useSegments ? r.direction.label : null,
        // 언제 — 요일 유형 + 권장 시간 + 예상 소요
        weekdayType, weekdayLabel: TC.WEEKDAY_TYPE_LABELS[weekdayType],
        conditionLabel: r.conditionLabel,
        window: w ? { start: w.start, end: w.end, text: `${w.start}~${w.end}` } : null,
        minutes: Math.round(minutes),
        whenText: `${TC.WEEKDAY_TYPE_LABELS[weekdayType]} ${w ? `${w.start}~${w.end}` : '시간대 전체'} · 약 ${Math.round(minutes)}분`,
        passesText: useSegments ? r.need.text : `${r.need.additionalVisits}회`,
        // 왜 — 데이터 부족 이유(점수 기여 큰 순 2개)와 사업 우선도를 따로
        reasons: reasons.length ? reasons : ['부족도 점수 기준 상위'],
        whyText: (reasons.length ? reasons : ['부족도 점수 기준 상위']).join(' + '),
        reasonText: [project, ...reasons].filter(Boolean).join(' + ') || '부족도 점수 기준 상위',
        projectLabel: project,
        score: r.score, priorityLabel: r.priorityLabel,
        confidenceLabel: r.confidence ? r.confidence.label : null,
        segmentId: r.segmentId || null,
      };
    }).sort((a, b) => ((a.window ? TC.parseClock(a.window.start, false) : 9999) - (b.window ? TC.parseClock(b.window.start, false) : 9999)) || a.scoreRank - b.scoreRank);
    // 그래도 이름이 겹치면(같은 도로 · 같은 교차 도로) 구간 번호로 바꾸고, 그것도 겹치면 순번을 붙인다
    const seenTitle = new Map();
    items.forEach(it => seenTitle.set(it.title, (seenTitle.get(it.title) || 0) + 1));
    items.forEach(it => { if (seenTitle.get(it.title) > 1) it.title = it.numberedTitle; });
    const again = new Map();
    items.forEach(it => { const n = (again.get(it.title) || 0) + 1; again.set(it.title, n); if (n > 1) it.title = `${it.title} (${n})`; });
    items.forEach((it, i) => { it.order = i + 1; });
    return {
      today, weekdayType, weekdayLabel: TC.WEEKDAY_TYPE_LABELS[weekdayType], source,
      window: hasWindow ? { start: o.window.start, end: o.window.end } : null,
      vehicleCount: Math.max(1, Number(o.vehicleCount) || 1),
      items, totalMinutes: items.reduce((a, it) => a + it.minutes, 0),
      candidateCount: stated.length,
      notes: notes.concat(source === 'zone' ? ['도로 구간 자동 분석 결과가 아직 없어 구역 단위 추천으로 보여줍니다.'] : []),
    };
  }

  // ══════════════════════════════════════════════════════
  //  향후 LLM 연결 — 구조화된 사실만(원본 GPS·사람 이름·차량 이름 없음)
  // ══════════════════════════════════════════════════════
  function toLlmPayload(r) {
    const byKey = Object.fromEntries(r.breakdown.map(b => [SCORE_EXPORT_NAMES[b.key], b.value]));
    return {
      recommendationId: r.id,
      rank: r.rank,
      zone: r.zone,
      recommendedCondition: { ...r.condition },
      recommendedTimeRange: r.timeRange ? { start: r.timeRange.start, end: r.timeRange.end, referenceDate: r.timeRange.referenceDate, condition: r.timeRange.conditionText } : null,
      currentStatus: {
        collectionMinutes: r.current.collectionMinutes, targetMinutes: r.need.targetMinutes,
        visitCount: r.current.visitCount, targetVisitCount: r.need.targetVisits,
        uniqueDays: r.current.uniqueDays,
        coveragePercent: r.coverage.available ? r.coverage.coveragePercent : null,
        unvisitedCells: r.coverage.available ? r.coverage.unvisitedCellCount : null,
        lastVisitedAt: r.current.lastVisitedAt,
      },
      recommendation: { additionalMinutes: r.need.estimatedMinutesThisStage, additionalVisits: r.need.additionalVisits, totalVisitsNeeded: r.need.totalVisitsNeeded, score: r.score, priority: r.priority, confidence: r.confidence.level },
      scoreBreakdown: byKey,
      excludedScoreItems: r.breakdown.filter(b => b.excluded).map(b => SCORE_EXPORT_NAMES[b.key]),
      predictedEdgeCaseHints: r.expectedConditions.slice(),
      edgeCaseRuleCodes: r.predictedEdgeCaseHints.map(h => h.code),
      evidenceLevel: r.edgeCaseEvidenceLevel,
      observedEdgeCases: [],
      reasonFacts: r.reasonFacts.filter(f => !/호차|호 편중/.test(f)), // 차량 이름이 들어간 사실은 빼고 넘긴다
      confidenceReasons: r.confidence.reasons.map(x => x.text),
    };
  }

  // LLM 호출부가 쓰는 전체 컨텍스트 — 설명·비교만 하도록 지시문을 함께 둔다
  function buildLlmContext(result, recs) {
    return {
      schema: 'route-viewer.recommendation-context.v1',
      generatedAt: result.generatedAt,
      instructions: [
        '아래 추천 순위·점수·수치·Edge Case 규칙은 통계 엔진이 계산한 확정 입력이다. 순위를 바꾸거나 새 장소·통계·Edge Case를 만들지 말 것.',
        '설명할 때는 reasonFacts·scoreBreakdown·currentStatus 의 값만 인용할 것.',
        '예상 Edge Case 는 가능성으로만 표현하고 발생을 확정하지 말 것.',
        '미래 날짜의 날씨를 예측하지 말 것.',
      ],
      edgeCaseDisclaimer: EDGE_CASE_DISCLAIMER,
      dataRange: result.dataset.dateRange,
      dataLimitations: result.limitations.slice(),
      recommendations: (recs || []).map(toLlmPayload),
    };
  }

  return {
    RECOMMENDATION_VERSION,
    SCORE_KEYS,
    SCORE_LABELS,
    DEFICIT_MIX,
    MANEUVER_EVENT_MIX,
    MANEUVER_EVENT_IDS,
    MANEUVER_DURATION_IDS,
    DRIVING_STATE_IDS,
    ROAD_CONTEXT_IDS,
    PRIORITY_BANDS,
    CONFIDENCE_LEVELS,
    HORIZON_DAYS,
    MIN_CANDIDATE_WINDOW_MINUTES,
    EDGE_CASE_RULES,
    EDGE_CASE_DISCLAIMER,
    SORT_LABELS,
    DEFAULT_SETTINGS,
    defaultRecommendationSettings,
    validateRecommendationSettings,
    effectiveRecommendationSettings,
    normalizeRecommendationPatch,
    sanitizeRecommendationSettings,
    settingsSignature,
    fnv1a,
    coverageFingerprint,
    recommendationDataFingerprint,
    coverageSnapshotFreshness,
    kstDate,
    buildRecommendationFeatures,
    calculateDeficitScores,
    calculateRecommendationScore,
    priorityOf,
    estimateCollectionNeed,
    recommendTimeRange,
    inferEdgeCaseHints,
    calculateConfidence,
    generateRecommendationReason,
    buildRecommendations,
    buildDrivePlan,
    PLAN_DEFAULTS,
    buildSubZoneRecommendations,
    SUBZONE_TARGET_DEFAULTS,
    buildSegmentRecommendations,
    validateSegmentSettings,
    normalizeSegmentSettingsPatch,
    segmentSettings,
    projectPriorityOf,
    circledNo,
    normalizePriorityPolicyPatch,
    travelEstimate,
    buildTodayPicks,
    SEGMENT_SCORE_KEYS,
    SEGMENT_SCORE_LABELS,
    SEGMENT_DEFAULTS,
    sortRecommendations,
    filterRecommendations,
    applyRecommendationStates,
    snoozeUntil,
    toLlmPayload,
    buildLlmContext,
    lightIntervals,
  };
}));
