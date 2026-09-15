// ══════════════════════════════════════════════════════════
//  time-conditions — 주행기록 한 건의 "조건" 분류 규칙 (순수 함수, 단일 원천)
//
//  하나의 기록은 서로 독립된 세 축의 값을 동시에 가진다. 한 필드에 섞지 않는다.
//    · 교통 시간대 trafficPeriod  — 출근·점심·퇴근 같은 "교통 흐름" 기준의 고정 시각 구간
//    · 조도 조건   lightCondition — 날짜·GPS 위치로 계산한 일출·일몰 기준의 "빛" 상태
//    · 요일 구분   weekdayType    — 평일/주말(날짜만으로 결정)
//  (날씨는 파일의 '날씨' 열 원본 값을 그대로 쓴다)
//
//  교통 시간대의 '야간'(20:00~24:00 고정 구간)과 조도 조건의 '야간'(실제로 해가 없는 시간)은
//  이름만 같고 의미가 다르다 — 내부 식별자도 필드도 따로다(trafficPeriod:'night' ≠ lightCondition:'night').
//
//  파일의 '시간대' 열(기존 timeOfDay: nav-app이 넣은 '주간'/'일몰' 원본 텍스트)은 이 모듈과
//  무관하게 그대로 보존한다 — 여기서 만들지도, 덮어쓰지도 않는다.
//
//  시간 처리: 기록의 date('YYYY-MM-DD')·time('HH:MM:SS')는 이미 한국 현지 벽시계 값이다.
//  그래서 new Date('…T…') 처럼 실행 환경의 시간대로 해석되는 변환을 절대 쓰지 않고, 문자열을
//  숫자로 쪼개 계산한다. 일출·일몰은 UTC 기준으로 계산한 뒤 고정 오프셋(Asia/Seoul = +09:00,
//  서머타임 없음)을 더해 현지 시각으로 바꾼다 → 앱이 UTC로 실행돼도 결과가 같다.
//
//  desktop(SQLite, electron/database.js)·브라우저(IndexedDB, src/js/storage.js)·통계·달력이
//  모두 이 파일 하나를 쓴다(coverage-grid.js/collection-stats.js와 같은 UMD 패턴).
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TimeConditions = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 분류 규칙(판정식) 버전 — 판정식을 바꾸면 올린다. 설정값과 함께 서명(signature)에 들어가서,
  // 서명이 다른 날짜 요약은 "재분류가 필요한 것"으로 본다.
  const CLASSIFICATION_VERSION = 1;
  const UNKNOWN = 'unknown';

  const DEFAULT_TRAFFIC_PERIODS = Object.freeze([
    Object.freeze({ id: 'late_night', label: '심야', start: '00:00', end: '05:00' }),
    Object.freeze({ id: 'early_morning', label: '이른 아침', start: '05:00', end: '07:00' }),
    Object.freeze({ id: 'morning_peak', label: '출근 피크', start: '07:00', end: '10:00' }),
    Object.freeze({ id: 'morning_offpeak', label: '오전 비피크', start: '10:00', end: '11:30' }),
    Object.freeze({ id: 'lunch_peak', label: '점심 피크', start: '11:30', end: '13:30' }),
    Object.freeze({ id: 'afternoon_offpeak', label: '오후 비피크', start: '13:30', end: '17:00' }),
    Object.freeze({ id: 'evening_peak', label: '퇴근 피크', start: '17:00', end: '20:00' }),
    Object.freeze({ id: 'night', label: '야간', start: '20:00', end: '24:00' }),
  ]);
  const TRAFFIC_PERIOD_IDS = DEFAULT_TRAFFIC_PERIODS.map(p => p.id);

  // 화면 표시명은 여기서만 정한다. 저장값은 항상 내부 식별자라 이름을 바꿔도 기존 데이터가 깨지지 않는다.
  const TRAFFIC_PERIOD_LABELS = Object.freeze({
    late_night: '심야', early_morning: '이른 아침', morning_peak: '출근 피크', morning_offpeak: '오전 비피크',
    lunch_peak: '점심 피크', afternoon_offpeak: '오후 비피크', evening_peak: '퇴근 피크', night: '야간',
    unknown: '미분류',
  });
  const LIGHT_CONDITION_IDS = Object.freeze(['sunrise', 'daylight', 'sunset', 'night']);
  const LIGHT_CONDITION_LABELS = Object.freeze({
    daylight: '주간', sunrise: '일출 전후', sunset: '일몰 전후', night: '야간', unknown: '미분류',
  });
  const WEEKDAY_TYPE_IDS = Object.freeze(['weekday', 'weekend']);
  const WEEKDAY_TYPE_LABELS = Object.freeze({ weekday: '평일', weekend: '주말', unknown: '미분류' });

  const DEFAULT_SUNRISE_WINDOW_MINUTES = 30;
  const DEFAULT_SUNSET_WINDOW_MINUTES = 30;
  const MAX_WINDOW_MINUTES = 180;

  const DEFAULT_TIMEZONE = 'Asia/Seoul';
  // 고정 오프셋(분). 대한민국은 1988년 이후 서머타임이 없어서 연중 +09:00 이다.
  const TIMEZONE_OFFSET_MINUTES = Object.freeze({ 'Asia/Seoul': 540 });

  const CLASSIFICATION_SETTING_KEYS = Object.freeze(['trafficPeriods', 'sunriseWindowMinutes', 'sunsetWindowMinutes']);

  // ── 문자열 → 숫자 (환경 시간대와 무관) ─────────────────
  const pad2 = n => String(n).padStart(2, '0');

  // 설정용 'HH:mm'. 시작은 00:00~23:59, 종료는 00:00~24:00(24:00 = 다음 날 00:00 경계).
  function parseClock(value, allow24) {
    const m = /^(\d{2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (mi > 59) return null;
    if (h === 24 && mi === 0 && allow24) return 1440;
    if (h > 23) return null;
    return h * 60 + mi;
  }

  function formatClock(minutes) {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    if (Math.round(minutes) === 1440) return '24:00';
    return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  }

  // 기록 시각 'HH:MM:SS' 또는 'HH:MM'(앞에 'YYYY-MM-DD ' / 'T'가 붙어도 된다) → 자정부터 초.
  // 24:00:00 은 86400(다음 날 00:00). 파싱 실패 → null.
  function parseRecordTime(value) {
    if (value == null || typeof value === 'object') return null; // Date 객체는 시간대가 모호해서 받지 않는다
    let s = String(value).trim();
    const sep = s.search(/[T ]/);
    if (sep >= 0) s = s.slice(sep + 1).trim();
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]), se = m[3] == null ? 0 : Number(m[3]);
    if (mi > 59 || se > 59) return null;
    if (h === 24) return (mi === 0 && se === 0) ? 86400 : null;
    if (h > 23) return null;
    return h * 3600 + mi * 60 + se;
  }

  // 'YYYY-MM-DD'(달력에 실제로 있는 날짜만) → {y,m,d}
  function parseDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return { y, m: mo, d };
  }

  function formatDate({ y, m, d }) { return `${y}-${pad2(m)}-${pad2(d)}`; }

  function addDays(ymd, days) {
    const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + days));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  // ── 교통 시간대 설정 ─────────────────────────────────
  // 한 구간을 [시작, 종료) 분 범위로. 종료가 시작보다 이르면 자정을 넘는 구간이다(예: 22:00~05:00).
  // 종료 '00:00'과 '24:00'은 같은 경계(1440)로 본다.
  function periodRange(p) {
    const start = parseClock(p && p.start, false);
    let end = parseClock(p && p.end, true);
    if (start == null || end == null) return null;
    if (end === 0) end = 1440;
    if (end === start) return null;
    return { start, end, wraps: end < start };
  }

  function rangeContainsSec(range, sec) {
    const s = range.start * 60, e = range.end * 60;
    return range.wraps ? (sec >= s || sec < e) : (sec >= s && sec < e);
  }

  function periodLabel(id) { return TRAFFIC_PERIOD_LABELS[id] || id; }

  // 검증: 형식 · 알 수 없는/빠진/중복 식별자 · 겹침 · 공백 · 24시간 정확히 한 번씩.
  // 판정은 이름이나 배열 순서가 아니라 저장된 시작·종료 시각으로만 한다.
  function validateTrafficPeriods(list) {
    const errors = [];
    if (!Array.isArray(list)) return { ok: false, errors: ['교통 시간대 설정이 목록 형식이 아니에요.'], periods: null };

    const seen = new Map();
    const periods = [];
    list.forEach((raw, i) => {
      const id = raw && String(raw.id || '');
      if (!TRAFFIC_PERIOD_IDS.includes(id)) { errors.push(`${i + 1}번째 항목의 식별자 "${id}"는 알 수 없는 교통 시간대예요.`); return; }
      if (seen.has(id)) { errors.push(`${periodLabel(id)}이(가) 두 번 들어 있어요.`); return; }
      seen.set(id, true);
      const start = String(raw.start == null ? '' : raw.start).trim();
      const end = String(raw.end == null ? '' : raw.end).trim();
      if (parseClock(start, false) == null) { errors.push(`${periodLabel(id)} 시작 시각 "${start}"은(는) HH:mm(00:00~23:59) 형식이 아니에요.`); return; }
      if (parseClock(end, true) == null) { errors.push(`${periodLabel(id)} 종료 시각 "${end}"은(는) HH:mm(00:00~24:00) 형식이 아니에요.`); return; }
      const range = periodRange({ start, end });
      if (!range) { errors.push(`${periodLabel(id)}의 시작(${start})과 종료(${end})가 같아서 길이가 0이에요.`); return; }
      periods.push({ id, label: periodLabel(id), start, end: end === '00:00' ? '24:00' : end, range });
    });
    TRAFFIC_PERIOD_IDS.forEach(id => { if (!seen.has(id)) errors.push(`${periodLabel(id)} 설정이 빠져 있어요.`); });
    if (errors.length) return { ok: false, errors, periods: null };

    // 하루 1440분을 분 단위로 칠해서 겹침(2개 이상)·공백(0개)을 찾는다
    const owners = Array.from({ length: 1440 }, () => []);
    periods.forEach((p, idx) => {
      for (let min = 0; min < 1440; min++) if (rangeContainsSec(p.range, min * 60)) owners[min].push(idx);
    });
    let runStart = 0;
    for (let min = 1; min <= 1440; min++) {
      const same = min < 1440 && owners[min].join(',') === owners[runStart].join(',');
      if (same) continue;
      const who = owners[runStart];
      const span = `${formatClock(runStart)}~${formatClock(min)}`;
      if (who.length === 0) errors.push(`${span}이(가) 어느 교통 시간대에도 속하지 않아요(공백).`);
      else if (who.length > 1) errors.push(`${who.map(i => `${periods[i].label}(${periods[i].start}~${periods[i].end})`).join('와(과) ')}이(가) ${span}에서 겹쳐요.`);
      runStart = min;
    }
    if (errors.length) return { ok: false, errors, periods: null };

    // 저장 형식: 시작 시각 순(표시용일 뿐, 판정에는 순서를 쓰지 않는다)
    const normalized = periods
      .map(({ id, label, start, end }) => ({ id, label, start, end }))
      .sort((a, b) => parseClock(a.start, false) - parseClock(b.start, false));
    return { ok: true, errors: [], periods: normalized };
  }

  function defaultTrafficPeriods() { return DEFAULT_TRAFFIC_PERIODS.map(p => ({ ...p })); }

  function validateWindowMinutes(value, name) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isInteger(n) || n < 0 || n > MAX_WINDOW_MINUTES) {
      return { ok: false, error: `${name || '전후 범위'}는 0~${MAX_WINDOW_MINUTES} 사이의 정수(분)여야 해요.`, value: null };
    }
    return { ok: true, error: null, value: n };
  }

  // 저장된 설정 → 실제 판정에 쓰는 설정. 저장값이 없거나 깨졌으면 기본값(조용히 대체).
  function classificationConfig(settings) {
    const s = settings || {};
    const tp = validateTrafficPeriods(s.trafficPeriods);
    const sr = validateWindowMinutes(s.sunriseWindowMinutes);
    const ss = validateWindowMinutes(s.sunsetWindowMinutes);
    return {
      trafficPeriods: tp.ok ? tp.periods : defaultTrafficPeriods(),
      sunriseWindowMinutes: sr.ok ? sr.value : DEFAULT_SUNRISE_WINDOW_MINUTES,
      sunsetWindowMinutes: ss.ok ? ss.value : DEFAULT_SUNSET_WINDOW_MINUTES,
      timezone: DEFAULT_TIMEZONE,
    };
  }

  // 사용자가 저장하려는 부분 설정을 검증·정규화한다. 분류와 무관한 키는 그대로 통과.
  // 잘못된 값이 하나라도 있으면 저장하지 않도록 Error(errors 속성 포함)를 던진다.
  function normalizeClassificationPatch(partial) {
    const out = { ...(partial || {}) };
    const errors = [];
    if (Object.prototype.hasOwnProperty.call(out, 'trafficPeriods')) {
      const v = validateTrafficPeriods(out.trafficPeriods);
      if (v.ok) out.trafficPeriods = v.periods; else errors.push(...v.errors);
    }
    [['sunriseWindowMinutes', '일출 전후 범위'], ['sunsetWindowMinutes', '일몰 전후 범위']].forEach(([key, name]) => {
      if (!Object.prototype.hasOwnProperty.call(out, key)) return;
      const v = validateWindowMinutes(out[key], name);
      if (v.ok) out[key] = v.value; else errors.push(v.error);
    });
    if (errors.length) {
      const err = new Error(errors.join('\n'));
      err.errors = errors;
      throw err;
    }
    return out;
  }

  // 백업 복원·서버 동기화용 — 잘못된 분류 설정은 던지지 않고 빼버린다(지금 설정을 유지).
  function sanitizeClassificationSettings(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    const out = { ...settings };
    if ('trafficPeriods' in out && !validateTrafficPeriods(out.trafficPeriods).ok) delete out.trafficPeriods;
    if ('sunriseWindowMinutes' in out && !validateWindowMinutes(out.sunriseWindowMinutes).ok) delete out.sunriseWindowMinutes;
    if ('sunsetWindowMinutes' in out && !validateWindowMinutes(out.sunsetWindowMinutes).ok) delete out.sunsetWindowMinutes;
    return out;
  }

  function isClassificationOnlyPatch(partial) {
    const keys = Object.keys(partial || {});
    return keys.length > 0 && keys.every(k => CLASSIFICATION_SETTING_KEYS.includes(k));
  }

  // 판정 규칙 + 판정에 쓰인 설정의 서명. 날짜 요약에 함께 저장해서 재분류 필요 여부를 가린다.
  function classificationSignature(config) {
    const c = config || classificationConfig({});
    const byId = new Map(c.trafficPeriods.map(p => [p.id, p]));
    return JSON.stringify({
      v: CLASSIFICATION_VERSION,
      tz: c.timezone,
      sr: c.sunriseWindowMinutes,
      ss: c.sunsetWindowMinutes,
      tp: TRAFFIC_PERIOD_IDS.map(id => [id, byId.get(id).start, byId.get(id).end]),
    });
  }

  // ── 교통 시간대 판정 ─────────────────────────────────
  // localDateTime: 'HH:MM:SS' | 'YYYY-MM-DD HH:MM:SS' | 'YYYY-MM-DDTHH:MM:SS' (한국 현지 벽시계)
  // 규칙: 시작 <= 시각 < 종료. 24:00:00 은 00:00:00 과 같다.
  function classifyTrafficPeriod(localDateTime, trafficPeriodSettings) {
    let sec = parseRecordTime(localDateTime);
    if (sec == null) return UNKNOWN;
    if (sec === 86400) sec = 0;
    let periods = trafficPeriodSettings;
    if (periods && !Array.isArray(periods) && Array.isArray(periods.trafficPeriods)) periods = periods.trafficPeriods;
    if (!Array.isArray(periods)) periods = DEFAULT_TRAFFIC_PERIODS;
    for (const p of periods) {
      const range = periodRange(p);
      if (range && rangeContainsSec(range, sec)) return p.id;
    }
    return UNKNOWN;
  }

  // ── 일출·일몰 계산 (NOAA Solar Calculator 방식, Meeus 천문 알고리즘) ──────────
  // 외부 API 없이 로컬 계산. 대기 굴절·태양 반지름을 반영한 천정각 90.833°를 일출·일몰로 본다.
  // 미 해군천문대(USNO) 공개값과 비교해 강남 기준 오차 1분 이내(tests/time-conditions-test.js).
  const RAD = Math.PI / 180;

  function solarAt(jd) {
    const T = (jd - 2451545) / 36525;
    const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
      + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
    const omega = 125.04 - 1934.136 * T;
    const appLong = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
    const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(appLong * RAD));
    const yv = Math.tan((eps / 2) * RAD) ** 2;
    const eqTime = (4 / RAD) * (yv * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
      + 4 * e * yv * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
      - 0.5 * yv * yv * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
    return { decl, eqTime };
  }

  // kind: 'rise'|'set' → 그 현지 날짜 자정부터의 분(실수) · 백야/극야면 {polar}
  function solarEventMinutes(ymd, lat, lng, offsetMin, kind) {
    const jdMidnightUtc = Date.UTC(ymd.y, ymd.m - 1, ymd.d) / 86400000 + 2440587.5;
    let utcMin = 720 - 4 * lng; // 첫 추정: 경도 기준 남중 시각(UTC)
    for (let i = 0; i < 4; i++) { // 사건 시각에서 태양 위치를 다시 계산해 수렴시킨다
      const { decl, eqTime } = solarAt(jdMidnightUtc + utcMin / 1440);
      const cosH = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) - Math.tan(lat * RAD) * Math.tan(decl);
      if (cosH > 1) return { polar: 'night' };
      if (cosH < -1) return { polar: 'day' };
      const H = Math.acos(cosH) / RAD;
      utcMin = 720 - 4 * (lng + (kind === 'rise' ? H : -H)) - eqTime;
    }
    return { minutes: utcMin + offsetMin };
  }

  // 같은 날짜·가까운 위치(0.01° ≈ 1.1km 반올림)는 한 번만 계산한다. 반올림한 좌표로 계산하므로
  // 캐시 여부와 무관하게 항상 같은 값이 나온다(그 차이는 일출·일몰 몇 초 수준).
  const sunCache = new Map();
  const SUN_CACHE_MAX = 20000;
  const sunStats = { computations: 0, hits: 0 };

  function sunTimes(date, latitude, longitude, timezone) {
    const ymd = typeof date === 'string' ? parseDate(date) : date;
    if (!ymd) return null;
    const offset = TIMEZONE_OFFSET_MINUTES[timezone || DEFAULT_TIMEZONE];
    if (offset == null) return null;
    const lat = Math.round(Number(latitude) * 100) / 100;
    const lng = Math.round(Number(longitude) * 100) / 100;
    const key = `${formatDate(ymd)}|${lat.toFixed(2)}|${lng.toFixed(2)}|${offset}`;
    const hit = sunCache.get(key);
    if (hit) { sunStats.hits++; return hit; }
    sunStats.computations++;
    const rise = solarEventMinutes(ymd, lat, lng, offset, 'rise');
    const set = solarEventMinutes(ymd, lat, lng, offset, 'set');
    let result;
    if (rise.polar || set.polar) result = { polar: rise.polar || set.polar };
    else result = { sunriseMinutes: rise.minutes, sunsetMinutes: set.minutes };
    if (sunCache.size >= SUN_CACHE_MAX) sunCache.clear();
    sunCache.set(key, Object.freeze(result));
    return result;
  }

  function validCoordinate(latitude, longitude) {
    if (latitude == null || longitude == null || latitude === '' || longitude === '') return null;
    const lat = Number(latitude), lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (lat === 0 && lng === 0) return null; // GPS 미수신 기본값(0,0)
    return { lat, lng };
  }

  // 일출 전후: 일출 ± sunriseWindowMinutes (양 끝 포함) · 일몰 전후: 일몰 ± sunsetWindowMinutes (양 끝 포함)
  // 주간: 일출 전후가 끝난 뒤 ~ 일몰 전후가 시작되기 전 · 야간: 나머지. 겹치면 일출 전후가 우선.
  function classifyLightCondition(input) {
    const o = input || {};
    let ymd = parseDate(o.date);
    let sec = parseRecordTime(o.time);
    const pos = validCoordinate(o.latitude != null ? o.latitude : o.lat, o.longitude != null ? o.longitude : o.lng);
    if (!ymd || sec == null || !pos) return UNKNOWN;
    if (sec === 86400) { ymd = addDays(ymd, 1); sec = 0; }
    const timezone = o.timezone || DEFAULT_TIMEZONE;
    if (TIMEZONE_OFFSET_MINUTES[timezone] == null) return UNKNOWN;
    const srw = validateWindowMinutes(o.sunriseWindowMinutes == null ? DEFAULT_SUNRISE_WINDOW_MINUTES : o.sunriseWindowMinutes);
    const ssw = validateWindowMinutes(o.sunsetWindowMinutes == null ? DEFAULT_SUNSET_WINDOW_MINUTES : o.sunsetWindowMinutes);
    if (!srw.ok || !ssw.ok) return UNKNOWN;

    const sun = sunTimes(ymd, pos.lat, pos.lng, timezone);
    if (!sun) return UNKNOWN;
    if (sun.polar === 'day') return 'daylight';
    if (sun.polar === 'night') return 'night';

    const t = sec / 60;
    const withinSunriseWindow = Math.abs(t - sun.sunriseMinutes) <= srw.value;
    if (withinSunriseWindow) return 'sunrise';
    const withinSunsetWindow = Math.abs(t - sun.sunsetMinutes) <= ssw.value;
    if (withinSunsetWindow) return 'sunset';
    if (t > sun.sunriseMinutes && t < sun.sunsetMinutes) return 'daylight';
    return 'night';
  }

  function classifyWeekdayType(date) {
    const ymd = parseDate(date);
    if (!ymd) return UNKNOWN;
    const dow = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
    return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
  }

  // 기록 한 건 → 세 축. config 는 classificationConfig(settings) 결과.
  // 교통 시간대는 시각만 있으면 되지만, 조도·요일은 날짜가 필요하다.
  function classifyRecord(rec, config) {
    const c = config || classificationConfig({});
    const r = rec || {};
    return {
      trafficPeriod: classifyTrafficPeriod(r.time, c.trafficPeriods),
      lightCondition: classifyLightCondition({
        date: r.date, time: r.time,
        latitude: r.lat != null ? r.lat : r.latitude,
        longitude: r.lng != null ? r.lng : r.longitude,
        timezone: c.timezone,
        sunriseWindowMinutes: c.sunriseWindowMinutes,
        sunsetWindowMinutes: c.sunsetWindowMinutes,
      }),
      weekdayType: classifyWeekdayType(r.date),
    };
  }

  function timezoneOffsetString(timezone) {
    const off = TIMEZONE_OFFSET_MINUTES[timezone || DEFAULT_TIMEZONE];
    if (off == null) return '';
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
  }

  return {
    CLASSIFICATION_VERSION,
    UNKNOWN,
    DEFAULT_TRAFFIC_PERIODS,
    TRAFFIC_PERIOD_IDS,
    TRAFFIC_PERIOD_LABELS,
    LIGHT_CONDITION_IDS,
    LIGHT_CONDITION_LABELS,
    WEEKDAY_TYPE_IDS,
    WEEKDAY_TYPE_LABELS,
    DEFAULT_SUNRISE_WINDOW_MINUTES,
    DEFAULT_SUNSET_WINDOW_MINUTES,
    MAX_WINDOW_MINUTES,
    DEFAULT_TIMEZONE,
    TIMEZONE_OFFSET_MINUTES,
    CLASSIFICATION_SETTING_KEYS,
    parseClock,
    formatClock,
    parseRecordTime,
    parseDate,
    validateTrafficPeriods,
    validateWindowMinutes,
    defaultTrafficPeriods,
    classificationConfig,
    normalizeClassificationPatch,
    sanitizeClassificationSettings,
    isClassificationOnlyPatch,
    classificationSignature,
    classifyTrafficPeriod,
    sunTimes,
    sunStats,
    classifyLightCondition,
    classifyWeekdayType,
    classifyRecord,
    timezoneOffsetString,
  };
}));
