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
    module.exports = factory(require('./time-conditions.js'), require('./condition-stats.js'), require('./collection-stats.js'), require('./issue-filter.js'));
  } else {
    root.Recommendation = factory(root.TimeConditions, root.ConditionStats, root.CollectionStats, root.IssueFilter);
  }
}(typeof self !== 'undefined' ? self : this, function (TC, CSt, CS, IF) {
  'use strict';

  const RECOMMENDATION_VERSION = 1;

  // ── 점수 항목 ─────────────────────────────────────────
  const SCORE_KEYS = Object.freeze(['timePeriod', 'coverage', 'lightCondition', 'weatherDiversity', 'staleness', 'vehicleImbalance']);
  const SCORE_LABELS = Object.freeze({
    timePeriod: '시간대 부족도', coverage: 'Coverage 부족도', lightCondition: '조도 조건 부족도',
    weatherDiversity: '날씨 다양성 부족도', staleness: '최근 미방문 기간', vehicleImbalance: '차량 편중도',
  });
  // LLM·외부로 넘기는 이름(scoreBreakdown)
  const SCORE_EXPORT_NAMES = Object.freeze({
    timePeriod: 'timePeriodDeficit', coverage: 'coverageDeficit', lightCondition: 'lightConditionDeficit',
    weatherDiversity: 'weatherDiversityDeficit', staleness: 'staleness', vehicleImbalance: 'vehicleImbalance',
  });

  // 부족도 = 100 × (1 − (수집 시간 달성률×0.5 + 방문 횟수 달성률×0.3 + 고유 수집일 달성률×0.2))
  // 기록 수(GPS 포인트 수)는 쓰지 않는다 — 하루 한 번 오래 모은 것을 다양하다고 보지 않기 위해
  // 방문 횟수와 고유 수집일을 함께 본다. 달성률은 각각 1(100%)에서 자른다.
  const DEFICIT_MIX = Object.freeze({ minutes: 0.5, visits: 0.3, days: 0.2 });

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
    weights: Object.freeze({ timePeriod: 30, coverage: 25, lightCondition: 15, weatherDiversity: 15, staleness: 10, vehicleImbalance: 5 }),
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
    out.weights = { ...d.weights, ...(src.weights || {}) };
    out.periodTargets = {};
    TC.TRAFFIC_PERIOD_IDS.forEach(id => { out.periodTargets[id] = { ...d.periodTargets[id], ...((src.periodTargets || {})[id] || {}) }; });
    out.zoneCoverageTargets = { ...d.zoneCoverageTargets, ...(src.zoneCoverageTargets || {}), zones: { ...((src.zoneCoverageTargets || {}).zones || {}) } };
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
      weights: w, periodTargets, zoneCoverageTargets: { default: covDefault, zones },
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
    if (!settings || typeof settings !== 'object' || !('recommendationSettings' in settings)) return settings;
    const out = { ...settings };
    if (!validateRecommendationSettings(out.recommendationSettings).ok) delete out.recommendationSettings;
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

    return {
      version: RECOMMENDATION_VERSION,
      today: kstDate(o.now),
      now: new Date(toMs(o.now)).toISOString(),
      vehicleFilter,
      issueFilter,
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
      },
      zones,
      coverage: snapshots,
      rows: {
        zone: zoneRows,
        period: index(agg(['zone', 'weekdayType', 'trafficPeriod']).rows),
        light: index(agg(['zone', 'weekdayType', 'trafficPeriod', 'lightCondition']).rows),
        weather: index(agg(['zone', 'weekdayType', 'trafficPeriod', 'lightCondition', 'weather']).rows),
      },
      // 분석 단위(구역×요일×교통×조도×날씨) 표 — 추천 탭 "데이터 부족 현황"과 외부 활용용
      analysisUnits: agg(['zone', 'weekdayType', 'trafficPeriod', 'lightCondition', 'weather']).rows,
      breakdowns: {
        weekdayType: agg(['weekdayType']).rows,
        trafficPeriod: agg(['trafficPeriod']).rows,
        lightCondition: agg(['lightCondition']).rows,
        weather: agg(['weather']).rows,
        vehicle: CSt.aggregate(summaries, { groupBy: ['vehicle'], details: true }).rows,
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

    return { scores, details, periodRow, lightRow, periodTarget, target, coverageTarget: covTarget, snapshot: snap || null };
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
      },
      targets: {
        periodMinutes: deficit.periodTarget.minutes, periodVisits: deficit.periodTarget.visits, periodBasis: deficit.periodTarget.basis,
        minutes: deficit.target.minutes, visits: deficit.target.visits, minUniqueDays: features.settings.minUniqueDays,
        lightShare: candidate.window ? round2(candidate.window.overlapMinutes / candidate.window.periodMinutes) : 1,
        coveragePercent: deficit.coverageTarget,
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
    sortRecommendations,
    filterRecommendations,
    applyRecommendationStates,
    snoozeUntil,
    toLlmPayload,
    buildLlmContext,
    lightIntervals,
  };
}));
