// ══════════════════════════════════════════════════════════
//  time-conditions-test — 교통 시간대 · 조도 조건 · 요일 분류 규칙과 조건별 집계(순수 함수)
//
//   A. 교통 시간대 경계(시작 포함·종료 제외, 24:00, 잘못된 시각)
//   B. 교통 시간대 설정 검증(겹침·공백·형식·자정 넘김·순서/이름 무관)
//   C. 조도 조건 — USNO 공개 일출·일몰값과 비교, ±30분 경계, 날짜/GPS/시각 누락, 극지방
//   D. 한국 현지 시각 — TZ=UTC / America/Los_Angeles / Asia/Seoul 로 실행해도 결과가 같다
//   E. 한 기록이 두 축을 동시에 가진다(교통 '야간' ≠ 조도 '야간') · 복합 조건 표시
//   F. 조건 칸 — 수집 시간 합 = 기존 날짜 수집 시간(실제 주행기록 포함) · 입력 순서 무관
//   G. 집계 — 교통/조도별 기록 수·수집 시간, 구역·요일·교통·조도·날씨 복합 집계, 추천용 질문
//
//  실행: node tests/time-conditions-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TC = require('../src/js/time-conditions.js');
const CSt = require('../src/js/condition-stats.js');
const CollectionStats = require('../src/js/collection-stats.js');
const RouteParser = require('../src/js/parser.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  [32mPASS[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  [31mFAIL[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(t) { console.log(`\n[36m${t}[0m`); }
const hms = sec => [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map(n => String(n).padStart(2, '0')).join(':');
const GANGNAM = { lat: 37.4979, lng: 127.0276 };
const cfg = TC.classificationConfig({});

// ── A ───────────────────────────────────────────────────
section('A. 교통 시간대 경계 — startTime <= 시각 < endTime');
const boundaryCases = [
  ['00:00', 'late_night'], ['04:59', 'late_night'], ['04:59:59', 'late_night'], ['05:00', 'early_morning'],
  ['06:59', 'early_morning'], ['06:59:59', 'early_morning'], ['07:00', 'morning_peak'], ['09:59', 'morning_peak'],
  ['09:59:59', 'morning_peak'], ['10:00', 'morning_offpeak'], ['11:29:59', 'morning_offpeak'], ['11:30', 'lunch_peak'],
  ['13:29:59', 'lunch_peak'], ['13:30', 'afternoon_offpeak'], ['16:59:59', 'afternoon_offpeak'], ['17:00', 'evening_peak'],
  ['19:59:59', 'evening_peak'], ['20:00', 'night'], ['23:59', 'night'], ['23:59:59', 'night'],
];
boundaryCases.forEach(([t, want]) => {
  const got = TC.classifyTrafficPeriod(t, cfg.trafficPeriods);
  check(`${t} → ${TC.TRAFFIC_PERIOD_LABELS[want]}`, got === want, `실제 ${TC.TRAFFIC_PERIOD_LABELS[got]}(${got})`);
});
check('24:00:00 → 다음 날 00:00과 같은 경계 → 심야', TC.classifyTrafficPeriod('24:00:00', cfg.trafficPeriods) === 'late_night');
check("'YYYY-MM-DD HH:MM:SS' · 'YYYY-MM-DDTHH:MM:SS' 형식도 현지 시각 그대로",
  TC.classifyTrafficPeriod('2026-09-15 18:30:00', cfg) === 'evening_peak' && TC.classifyTrafficPeriod('2026-09-15T07:00:00', cfg) === 'morning_peak');
const badTimes = ['', null, undefined, 'abc', '25:00:00', '24:30:00', '12:60:00', '12:00:61', new Date(2026, 8, 15, 18, 30)];
check('시각이 없거나 파싱 실패 → 미분류(unknown), 임의의 시간대로 넣지 않는다',
  badTimes.every(t => TC.classifyTrafficPeriod(t, cfg.trafficPeriods) === 'unknown'),
  badTimes.map(t => `${t instanceof Date ? 'Date객체' : JSON.stringify(t)}→${TC.classifyTrafficPeriod(t, cfg.trafficPeriods)}`).join(' '));
{
  let unknown = 0, multi = 0;
  const counts = {};
  for (let s = 0; s < 86400; s++) {
    const hits = cfg.trafficPeriods.filter(p => TC.classifyTrafficPeriod(hms(s), [p]) === p.id).length;
    if (hits === 0) unknown++;
    if (hits > 1) multi++;
    const id = TC.classifyTrafficPeriod(hms(s), cfg.trafficPeriods);
    counts[id] = (counts[id] || 0) + 1;
  }
  check('하루 86,400초 전부 정확히 한 교통 시간대(누락 0 · 중복 0)', unknown === 0 && multi === 0 && !counts.unknown,
    Object.entries(counts).map(([k, v]) => `${k}:${v / 60}분`).join(' '));
}

// ── B ───────────────────────────────────────────────────
section('B. 교통 시간대 설정 검증');
const periods = () => TC.defaultTrafficPeriods();
check('기본값은 유효', TC.validateTrafficPeriods(periods()).ok);
{
  const p = periods(); p.find(x => x.id === 'morning_offpeak').start = '09:30';
  const v = TC.validateTrafficPeriods(p);
  check('겹치는 시간대 → 저장 거부 · 이유 표시', !v.ok && v.errors.some(e => /09:30~10:00에서 겹쳐요/.test(e)), v.errors.join(' | '));
}
{
  const p = periods(); p.find(x => x.id === 'morning_offpeak').end = '11:00';
  const v = TC.validateTrafficPeriods(p);
  check('비어 있는 시간 구간 → 저장 거부 · 이유 표시', !v.ok && v.errors.some(e => /11:00~11:30.*공백/.test(e)), v.errors.join(' | '));
}
{
  const p = periods().filter(x => x.id !== 'lunch_peak');
  const v = TC.validateTrafficPeriods(p);
  check('빠진 시간대 → 거부', !v.ok && v.errors.some(e => /점심 피크 설정이 빠져/.test(e)), v.errors.join(' | '));
  const d = periods(); d.push({ ...d[0] });
  check('중복 식별자 → 거부', !TC.validateTrafficPeriods(d).ok);
  const u = periods(); u[0] = { ...u[0], id: 'rush_hour' };
  check('알 수 없는 식별자 → 거부', !TC.validateTrafficPeriods(u).ok);
}
[['7:00', 'start'], ['07:60', 'start'], ['24:00', 'start'], ['24:30', 'end'], ['0700', 'end']].forEach(([val, field]) => {
  const p = periods(); p[2] = { ...p[2], [field]: val };
  const v = TC.validateTrafficPeriods(p);
  check(`HH:mm 형식 오류(${field}=${val}) → 거부`, !v.ok && v.errors.some(e => /형식이 아니에요/.test(e)), v.errors[0]);
});
{
  const p = periods(); p[2] = { ...p[2], end: p[2].start };
  check('시작=종료(길이 0) → 거부', !TC.validateTrafficPeriods(p).ok);
}
{
  const p = periods();
  p.find(x => x.id === 'night').end = '00:00';
  const v = TC.validateTrafficPeriods(p);
  check("종료 '00:00' = '24:00'(자정 경계)", v.ok && v.periods.find(x => x.id === 'night').end === '24:00');
}
{
  // 자정을 넘는 구간: 심야 22:00~05:00, 야간 20:00~22:00
  const p = periods();
  p.find(x => x.id === 'late_night').start = '22:00';
  p.find(x => x.id === 'late_night').end = '05:00';
  p.find(x => x.id === 'night').end = '22:00';
  const v = TC.validateTrafficPeriods(p);
  check('자정을 넘는 구간(22:00~05:00)도 24시간을 정확히 채우면 유효', v.ok, v.errors.join(' | '));
  const c = TC.classificationConfig({ trafficPeriods: v.periods });
  check('  23:00 → 심야, 21:59:59 → 야간, 04:59:59 → 심야',
    TC.classifyTrafficPeriod('23:00:00', c) === 'late_night' && TC.classifyTrafficPeriod('21:59:59', c) === 'night' && TC.classifyTrafficPeriod('04:59:59', c) === 'late_night');
}
{
  // 이름·배열 순서가 아니라 시작·종료 시각으로 판정
  const shuffled = periods().reverse().map(p => ({ ...p, label: '아무 이름' }));
  let same = true;
  for (let s = 0; s < 86400; s += 59) if (TC.classifyTrafficPeriod(hms(s), shuffled) !== TC.classifyTrafficPeriod(hms(s), cfg.trafficPeriods)) same = false;
  check('배열 순서를 뒤집고 이름을 바꿔도 판정이 같다(시작·종료 시각 기준)', same && TC.validateTrafficPeriods(shuffled).ok);
  check('  → 분류 서명도 같다(순서·이름은 서명에 안 들어감)',
    TC.classificationSignature(TC.classificationConfig({ trafficPeriods: shuffled })) === TC.classificationSignature(cfg));
}
{
  let threw = null;
  const p = periods(); p[3] = { ...p[3], start: '09:00' };
  try { TC.normalizeClassificationPatch({ trafficPeriods: p }); } catch (e) { threw = e; }
  check('normalizeClassificationPatch: 잘못된 설정이면 이유 목록(errors)을 담아 던진다(저장 전 차단)', threw && Array.isArray(threw.errors) && threw.errors.length > 0);
  let threw2 = null;
  try { TC.normalizeClassificationPatch({ sunriseWindowMinutes: 181 }); } catch (e) { threw2 = e; }
  check('  일출·일몰 전후 범위는 0~180 정수만', !!threw2 && TC.normalizeClassificationPatch({ sunsetWindowMinutes: '45' }).sunsetWindowMinutes === 45);
  const s = TC.sanitizeClassificationSettings({ trafficPeriods: p, sunriseWindowMinutes: -1, coverageDepthTiers: [1] });
  check('sanitize(백업·동기화용): 잘못된 분류 설정만 빼고 나머지는 둔다', !('trafficPeriods' in s) && !('sunriseWindowMinutes' in s) && Array.isArray(s.coverageDepthTiers));
  const broken = TC.classificationConfig({ trafficPeriods: p, sunsetWindowMinutes: 'x' });
  check('저장값이 깨졌으면 판정은 기본값으로', TC.classificationSignature(broken) === TC.classificationSignature(cfg));
  const shifted = periods(); shifted.find(x => x.id === 'evening_peak').start = '18:00'; shifted.find(x => x.id === 'afternoon_offpeak').end = '18:00';
  check('시각을 바꾸면 서명이 달라진다(재분류 필요 판정)', TC.classificationSignature(TC.classificationConfig({ trafficPeriods: shifted })) !== TC.classificationSignature(cfg));
}

// ── C ───────────────────────────────────────────────────
section('C. 조도 조건 — 일출·일몰 계산과 ±30분 경계');
// 기준값: 미 해군천문대(USNO) Astronomical Applications API, 2026-09-15 조회
//   https://aa.usno.navy.mil/api/rstt/oneday?date=<날짜>&coords=37.4979,127.0276&tz=9  (분 단위 반올림 값)
const USNO = {
  '2026-03-20': ['06:36', '18:43'], '2026-06-21': ['05:11', '19:56'], '2026-08-12': ['05:45', '19:28'],
  '2026-09-15': ['06:13', '18:40'], '2026-12-21': ['07:43', '17:17'],
};
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
Object.entries(USNO).forEach(([date, [rise, set]]) => {
  const st = TC.sunTimes(date, GANGNAM.lat, GANGNAM.lng, 'Asia/Seoul');
  const dr = st.sunriseMinutes - toMin(rise), ds = st.sunsetMinutes - toMin(set);
  check(`${date} 강남 일출·일몰이 USNO와 1분 이내`, Math.abs(dr) <= 1 && Math.abs(ds) <= 1,
    `계산 ${TC.formatClock(st.sunriseMinutes)}/${TC.formatClock(st.sunsetMinutes)} · USNO ${rise}/${set} · 차이 ${dr.toFixed(2)}/${ds.toFixed(2)}분`);
});
{
  const date = '2026-09-15';
  const { sunriseMinutes: rise, sunsetMinutes: set } = TC.sunTimes(date, GANGNAM.lat, GANGNAM.lng);
  const at = sec => TC.classifyLightCondition({ date, time: hms(sec), latitude: GANGNAM.lat, longitude: GANGNAM.lng, timezone: 'Asia/Seoul', sunriseWindowMinutes: 30, sunsetWindowMinutes: 30 });
  const inside = min => Math.ceil(min * 60);   // 경계 안쪽 첫 초
  const outsideBefore = min => Math.floor(min * 60) - 1;
  const outsideAfter = min => Math.floor(min * 60) + 1;
  const cases = [
    ['일출 30분 전(경계 포함)', inside(rise - 30), 'sunrise'],
    ['일출 31분 전', outsideBefore(rise - 30) - 59, 'night'],
    ['정확한 일출 시각', Math.round(rise * 60), 'sunrise'],
    ['일출 30분 후(경계 포함)', Math.floor((rise + 30) * 60), 'sunrise'],
    ['일출 30분 후 바로 다음', outsideAfter(rise + 30), 'daylight'],
    ['정상적인 주간(12:00)', 12 * 3600, 'daylight'],
    ['일몰 30분 전 바로 이전', outsideBefore(set - 30), 'daylight'],
    ['일몰 30분 전(경계 포함)', inside(set - 30), 'sunset'],
    ['정확한 일몰 시각', Math.round(set * 60), 'sunset'],
    ['일몰 30분 후(경계 포함)', Math.floor((set + 30) * 60), 'sunset'],
    ['일몰 30분 후 바로 다음', outsideAfter(set + 30), 'night'],
    ['야간(23:00)', 23 * 3600, 'night'],
    ['야간(03:00)', 3 * 3600, 'night'],
  ];
  cases.forEach(([name, sec, want]) => {
    const got = at(sec);
    check(`${name} ${hms(sec)} → ${TC.LIGHT_CONDITION_LABELS[want]}`, got === want, `일출 ${TC.formatClock(rise)} 일몰 ${TC.formatClock(set)} · 실제 ${got}`);
  });
  const narrow = TC.classifyLightCondition({ date, time: hms(Math.round((rise - 20) * 60)), latitude: GANGNAM.lat, longitude: GANGNAM.lng, sunriseWindowMinutes: 10, sunsetWindowMinutes: 10 });
  check('일출 전후 범위를 10분으로 바꾸면 일출 20분 전은 야간', narrow === 'night', narrow);
  check('24:00:00 은 다음 날 00:00 → 야간',
    TC.classifyLightCondition({ date, time: '24:00:00', latitude: GANGNAM.lat, longitude: GANGNAM.lng }) === 'night');
}
{
  const base = { date: '2026-09-15', time: '12:00:00', latitude: GANGNAM.lat, longitude: GANGNAM.lng };
  const unk = o => TC.classifyLightCondition({ ...base, ...o });
  check('날짜 누락 · 날짜미상 · 없는 날짜(2026-02-30) → 미분류',
    unk({ date: '' }) === 'unknown' && unk({ date: '날짜미상' }) === 'unknown' && unk({ date: '2026-02-30' }) === 'unknown');
  check('GPS 누락(null · 빈 문자열 · NaN · 0,0 · 범위 밖) → 미분류',
    unk({ latitude: null }) === 'unknown' && unk({ longitude: '' }) === 'unknown' && unk({ latitude: NaN }) === 'unknown'
    && unk({ latitude: 0, longitude: 0 }) === 'unknown' && unk({ latitude: 91 }) === 'unknown');
  check('잘못된 Timestamp(시각 없음 · 25:00 · 문자) → 미분류',
    unk({ time: '' }) === 'unknown' && unk({ time: '25:00:00' }) === 'unknown' && unk({ time: 'noon' }) === 'unknown');
  check('지원하지 않는 시간대 이름 → 미분류(임의 변환 안 함)', unk({ timezone: 'Mars/Olympus' }) === 'unknown');
  const cr = TC.classifyRecord({ date: '', time: '08:00:00', lat: GANGNAM.lat, lng: GANGNAM.lng }, cfg);
  check('날짜만 없으면 교통 시간대는 시각으로 정해지고 조도·요일은 미분류',
    cr.trafficPeriod === 'morning_peak' && cr.lightCondition === 'unknown' && cr.weekdayType === 'unknown', JSON.stringify(cr));
}
{
  const tromso = (date, time) => TC.classifyLightCondition({ date, time, latitude: 69.65, longitude: 18.96 });
  check('극지방: 백야(트롬쇠 6월 21일)에는 한밤도 주간, 극야(12월 21일)에는 한낮도 야간',
    tromso('2026-06-21', '00:30:00') === 'daylight' && tromso('2026-12-21', '12:00:00') === 'night');
}
{
  const before = { ...TC.sunStats };
  for (let i = 0; i < 1000; i++) {
    TC.classifyLightCondition({ date: '2031-01-05', time: hms(36000 + i), latitude: 37.4979 + (i % 3) * 0.001, longitude: 127.0276 });
  }
  const computed = TC.sunStats.computations - before.computations;
  check('같은 날짜·가까운 위치(0.01° 반올림)는 일출·일몰을 한 번만 계산(캐시)', computed === 1, `기록 1,000건 → 계산 ${computed}번`);
}

// ── D ───────────────────────────────────────────────────
section('D. 한국 현지 시각 — 실행 환경 시간대와 무관');
const tzBatch = [];
['2026-03-20', '2026-06-21', '2026-09-15', '2026-12-21', '2026-12-31', '2027-01-01'].forEach(date => {
  ['00:00:00', '05:40:00', '06:13:00', '06:44:00', '12:00:00', '17:00:00', '18:12:00', '18:40:00', '19:11:00', '23:59:59', '24:00:00']
    .forEach(time => tzBatch.push({ date, time, lat: GANGNAM.lat, lng: GANGNAM.lng }));
});
const script = `
  const TC=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'js', 'time-conditions.js'))});
  const cfg=TC.classificationConfig({});
  const batch=${JSON.stringify(tzBatch)};
  process.stdout.write(JSON.stringify({tz:process.env.TZ,offset:new Date(2026,8,15,12).getTimezoneOffset(),
    out:batch.map(r=>TC.classifyRecord(r,cfg)),sun:TC.sunTimes('2026-09-15',${GANGNAM.lat},${GANGNAM.lng})}));`;
const local = JSON.stringify({ out: tzBatch.map(r => TC.classifyRecord(r, cfg)), sun: TC.sunTimes('2026-09-15', GANGNAM.lat, GANGNAM.lng) });
const runs = ['UTC', 'America/Los_Angeles', 'Asia/Seoul'].map(tz => {
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch (_) { return { tz, error: r.stderr }; }
});
const offsets = runs.map(r => r.offset);
check('자식 프로세스가 실제로 서로 다른 시간대로 실행됐다(UTC=0, LA=420, 서울=-540)', offsets[0] === 0 && offsets[1] === 420 && offsets[2] === -540, `getTimezoneOffset: ${offsets.join(', ')}`);
check('UTC · LA · 서울 실행 결과가 모두 같고, 이 테스트 프로세스 결과와도 같다(기록 66건 × 교통·조도·요일)',
  runs.every(r => JSON.stringify({ out: r.out, sun: r.sun }) === local), `2026-09-15 일출 ${runs[0].sun && TC.formatClock(runs[0].sun.sunriseMinutes)} (UTC 실행)`);
check('UTC 실행에서도 06:13(일출)·18:40(일몰)은 한국 현지 기준 일출/일몰 전후',
  runs[0].out && runs[0].out[tzBatch.findIndex(r => r.date === '2026-09-15' && r.time === '06:13:00')].lightCondition === 'sunrise'
  && runs[0].out[tzBatch.findIndex(r => r.date === '2026-09-15' && r.time === '18:40:00')].lightCondition === 'sunset');
check('요일: 2026-09-15(화) 평일 · 09-19(토)·09-20(일) 주말 · 09-21(월) 평일 · 잘못된 날짜 미분류',
  TC.classifyWeekdayType('2026-09-15') === 'weekday' && TC.classifyWeekdayType('2026-09-19') === 'weekend'
  && TC.classifyWeekdayType('2026-09-20') === 'weekend' && TC.classifyWeekdayType('2026-09-21') === 'weekday'
  && TC.classifyWeekdayType('2026-13-01') === 'unknown');

// ── E ───────────────────────────────────────────────────
section('E. 한 기록이 두 분류를 동시에 가진다');
{
  const rec = { date: '2026-09-15', time: '18:30:00', lat: GANGNAM.lat, lng: GANGNAM.lng, weather: '비' };
  const c = TC.classifyRecord(rec, cfg);
  check('기록 시각 2026-09-15 18:30 → 교통: 퇴근 피크 · 조도: 일몰 전후 · 요일: 평일',
    c.trafficPeriod === 'evening_peak' && c.lightCondition === 'sunset' && c.weekdayType === 'weekday', JSON.stringify(c));
  const text = CSt.formatConditions({ ...rec, ...c });
  check("복합 조건 표시 '평일 · 퇴근 피크 · 일몰 전후 · 비'", text === '평일 · 퇴근 피크 · 일몰 전후 · 비', text);
  const parts = CSt.describeConditions({ ...rec, ...c }, ['trafficPeriod', 'lightCondition', 'weekdayType', 'weather']);
  check("축별로 따로: '교통: 퇴근 피크' / '조도: 일몰 전후' / '요일: 평일' / '날씨: 비' (한 필드에 섞지 않음)",
    parts.map(p => `${p.axis}: ${p.value}`).join(' / ') === '교통: 퇴근 피크 / 조도: 일몰 전후 / 요일: 평일 / 날씨: 비');
  const june = TC.classifyRecord({ date: '2026-06-21', time: '20:05:00', lat: GANGNAM.lat, lng: GANGNAM.lng }, cfg);
  const sept = TC.classifyRecord({ date: '2026-09-15', time: '21:30:00', lat: GANGNAM.lat, lng: GANGNAM.lng }, cfg);
  check("교통 '야간'(20~24시 고정)과 조도 '야간'(실제 어두움)은 다른 값: 6월 21일 20:05 = 교통 야간 + 조도 일몰 전후",
    june.trafficPeriod === 'night' && june.lightCondition === 'sunset' && sept.trafficPeriod === 'night' && sept.lightCondition === 'night',
    `6/21 20:05 ${JSON.stringify(june)} · 9/15 21:30 ${JSON.stringify(sept)}`);
  check("기존 timeOfDay(파일 원본)는 분류 결과에 없다 — 만들지도 덮어쓰지도 않음", !('timeOfDay' in c));
}

// ── F ───────────────────────────────────────────────────
section('F. 조건 칸 — 수집 시간 합 = 날짜 수집 시간');
{
  const rows = [];
  const push = (vehicle, startSec, n, step, extra) => {
    for (let i = 0; i < n; i++) rows.push({ date: '2026-09-15', time: hms(startSec + i * step), vehicle, zone: '강남', weather: '맑음', lat: 37.49 + i * 0.0001, lng: 127.02, ...(extra || {}) });
  };
  push('토레스 1호', 6 * 3600 + 59 * 60, 5, 30);           // 06:59:00~07:01:00 — 07:00 경계를 가로지름
  push('토레스 1호', 9 * 3600, 3, 30);                     // 긴 공백 뒤(9시)
  push('토레스 2호', 6 * 3600 + 59 * 60 + 30, 2, 30, { weather: '비' });
  rows.push({ ...rows[1], lat: 37.6 });                    // 같은 차량·같은 시각·다른 좌표
  const s = CSt.buildConditionSummary(rows, cfg);
  const cell = (tp, v) => s.conditionCells.filter(c => c.trafficPeriod === tp && c.vehicle === v).reduce((a, c) => a + c.collectionSec, 0);
  check('간격은 시작하는 기록의 칸으로: 1호 06:59:00~07:00:00 → 이른 아침 60초, 07:00~07:01 → 출근 피크 60초',
    cell('early_morning', '토레스 1호') === 60 && cell('morning_peak', '토레스 1호') === 60 + 60,
    `이른아침 ${cell('early_morning', '토레스 1호')}초 · 출근피크 ${cell('morning_peak', '토레스 1호')}초`);
  const sum = s.conditionCells.reduce((a, c) => a + c.collectionSec, 0);
  check('칸 합계 = CollectionStats.validDurationSec(90초 넘는 공백 제외, 차량별)', sum === CollectionStats.validDurationSec(rows), `${sum}초 = ${CollectionStats.validDurationSec(rows)}초`);
  check('기록 수 합계 = 기록 수(같은 시각 중복 포함)', s.conditionCells.reduce((a, c) => a + c.recordCount, 0) === rows.length);
  const reversed = CSt.buildConditionSummary([...rows].reverse(), cfg);
  check('입력 순서를 뒤집어도 칸이 완전히 같다(SQLite·IndexedDB 읽기 순서 무관)', JSON.stringify(reversed) === JSON.stringify(s));
  check('칸에 분류 서명이 함께 저장된다', s.classificationSignature === TC.classificationSignature(cfg));
}
{
  const dir = path.join(__dirname, '..', '주행기록');
  const byKey = new Map();
  for (const f of fs.readdirSync(dir).filter(x => /\.xlsx?$/i.test(x)).sort()) {
    for (const r of RouteParser.parseBuffer(fs.readFileSync(path.join(dir, f)))) {
      const k = [r.date, r.time, r.vehicle, r.lat.toFixed(6), r.lng.toFixed(6)].join('|');
      if (!byKey.has(k)) byKey.set(k, r);
    }
  }
  const byDate = {};
  for (const r of byKey.values()) (byDate[r.date] = byDate[r.date] || []).push(r);
  let okDates = 0;
  const bad = [];
  let totalSec = 0;
  const traffic = {}, light = {};
  for (const [date, rows] of Object.entries(byDate)) {
    const s = CSt.buildConditionSummary(rows, cfg);
    const sum = s.conditionCells.reduce((a, c) => a + c.collectionSec, 0);
    const n = s.conditionCells.reduce((a, c) => a + c.recordCount, 0);
    if (sum === CollectionStats.validDurationSec(rows) && n === rows.length) okDates++; else bad.push(date);
    totalSec += sum;
    s.conditionCells.forEach(c => { traffic[c.trafficPeriod] = (traffic[c.trafficPeriod] || 0) + c.collectionSec; light[c.lightCondition] = (light[c.lightCondition] || 0) + c.collectionSec; });
  }
  const dates = Object.keys(byDate).length;
  check(`실제 주행기록 ${dates}일 · ${byKey.size.toLocaleString()}건: 날짜마다 칸 수집 시간 합 = 날짜 수집 시간, 기록 수 합 = 기록 수`,
    okDates === dates && bad.length === 0, bad.length ? `불일치 ${bad.join(',')}` : `총 ${Math.round(totalSec / 60).toLocaleString()}분`);
  console.log('         실제 기록 교통 시간대(분): ' + TC.TRAFFIC_PERIOD_IDS.filter(k => traffic[k]).map(k => `${TC.TRAFFIC_PERIOD_LABELS[k]} ${Math.round(traffic[k] / 60)}`).join(' · '));
  console.log('         실제 기록 조도 조건(분): ' + Object.keys(light).map(k => `${TC.LIGHT_CONDITION_LABELS[k]} ${Math.round(light[k] / 60)}`).join(' · '));
}

// ── G ───────────────────────────────────────────────────
section('G. 집계 API');
function dayRows(date, zone, vehicle, weather, sessions) {
  const out = [];
  sessions.forEach(([start, count]) => {
    const [h, m] = start.split(':').map(Number);
    for (let i = 0; i < count; i++) out.push({ date, time: hms(h * 3600 + m * 60 + i * 30), vehicle, zone, weather, lat: 37.4979 + i * 0.00005, lng: 127.0276 });
  });
  return out;
}
// 2026-09-15(화) 강남 1호 비: 07:30~(출근 피크 60분) + 18:20~(일몰 전후 포함 퇴근 피크 30분)
// 2026-09-19(토) 판교 2호 맑음: 12:00~(점심 피크 60분)
// 2026-09-16(수) 강남 2호 비: 18:30~(퇴근 피크·일몰 전후 20분)
const summaries = [
  { date: '2026-09-15', ...CSt.buildConditionSummary(dayRows('2026-09-15', '강남', '토레스 1호차', '비', [['07:30', 121], ['18:20', 61]]), cfg) },
  { date: '2026-09-16', ...CSt.buildConditionSummary(dayRows('2026-09-16', '강남', '토레스 2호차', '비', [['18:30', 41]]), cfg) },
  { date: '2026-09-19', ...CSt.buildConditionSummary(dayRows('2026-09-19', '판교', '토레스 2호차', '맑음', [['12:00', 121]]), cfg) },
];
const sig = TC.classificationSignature(cfg);
{
  const t = CSt.aggregate(summaries, { groupBy: ['trafficPeriod'], signature: sig });
  const row = id => t.rows.find(r => r.trafficPeriod === id) || {};
  check('교통 시간대별 기록 수', row('morning_peak').recordCount === 121 && row('lunch_peak').recordCount === 121 && row('evening_peak').recordCount === 102,
    t.rows.map(r => `${r.trafficPeriod}:${r.recordCount}개`).join(' '));
  check('교통 시간대별 수집 시간(분)', row('morning_peak').collectionMinutes === 60 && row('lunch_peak').collectionMinutes === 60 && row('evening_peak').collectionMinutes === 50,
    t.rows.map(r => `${r.trafficPeriod}:${r.collectionMinutes}분`).join(' '));
  check('행은 교통 시간대 정의 순서(출근 → 점심 → 퇴근)', t.rows.map(r => r.trafficPeriod).join(',') === 'morning_peak,lunch_peak,evening_peak');
  const l = CSt.aggregate(summaries, { groupBy: ['lightCondition'], signature: sig });
  const lr = id => l.rows.find(r => r.lightCondition === id) || { recordCount: 0, collectionSec: 0 };
  const { sunsetMinutes: set15 } = TC.sunTimes('2026-09-15', 37.4979, 127.0276);
  check('조도 조건별 기록 수 · 수집 시간 — 기록 수 합 = 전체, 수집 시간 합 = 전체',
    l.rows.reduce((a, r) => a + r.recordCount, 0) === 344 && l.rows.reduce((a, r) => a + r.collectionSec, 0) === t.totals.collectionSec && lr('sunset').recordCount > 0 && lr('daylight').recordCount > 0,
    `${l.rows.map(r => `${r.lightCondition}:${r.recordCount}개/${r.collectionMinutes}분`).join(' ')} (9/15 일몰 ${TC.formatClock(set15)})`);
  check('staleDates: 서명이 같으면 0, 다르면 날짜 수만큼', t.staleDates === 0 && CSt.aggregate(summaries, { signature: 'other' }).staleDates === 3);
}
{
  const composite = CSt.aggregate(summaries, { groupBy: ['zone', 'weekdayType', 'trafficPeriod', 'lightCondition', 'weather'], signature: sig });
  const r = composite.rows.find(x => x.zone === '강남' && x.weekdayType === 'weekday' && x.trafficPeriod === 'evening_peak' && x.lightCondition === 'sunset' && x.weather === '비');
  const keys = r ? Object.keys(r).sort().join(',') : '';
  check('구역·요일·교통·조도·날씨 복합 집계 행 형태(추천 입력용)',
    !!r && keys === 'collectionMinutes,collectionSec,lastVisitedAt,lightCondition,recordCount,trafficPeriod,visitCount,weather,weekdayType,zone',
    r && JSON.stringify(r));
  check("  '평일 + 퇴근 피크 + 일몰 전후 + 비' — 두 날짜(9/15 1호, 9/16 2호)가 합쳐져 visitCount 2 · 마지막 방문 +09:00",
    r && r.visitCount === 2 && /^2026-09-16T\d{2}:\d{2}:\d{2}\+09:00$/.test(r.lastVisitedAt), r && `${r.recordCount}개 · ${r.collectionMinutes}분 · 방문 ${r.visitCount} · ${r.lastVisitedAt}`);
  const f = CSt.aggregate(summaries, { filter: { weekdayType: 'weekday', trafficPeriod: 'evening_peak', lightCondition: 'sunset', weather: '비' } });
  check('  같은 조건을 필터로 줘도 같은 합계', r && f.totals.recordCount === r.recordCount && f.totals.collectionSec === r.collectionSec);
  const range = CSt.aggregate(summaries, { filter: { fromDate: '2026-09-16', toDate: '2026-09-19', vehicleLike: '2호' }, groupBy: ['zone'] });
  check('날짜 범위 + 차량(부분 일치) 필터', range.dateCount === 2 && range.totals.recordCount === 41 + 121 && range.rows.map(x => x.zone).sort().join(',') === '강남,판교');
  const byZoneVehicle = CSt.aggregate(summaries, { filter: { zone: ['강남'] }, groupBy: ['vehicle', 'trafficPeriod'] });
  check('구역별·차량별 시간대 분포(배열 필터)', byZoneVehicle.rows.length === 3 && byZoneVehicle.rows.every(x => x.vehicle.startsWith('토레스')));
}
{
  // 향후 추천 질문 예시 — 집계 API 만으로 답할 수 있어야 한다
  const zones = ['강남', '판교', '시흥'];
  const peak = CSt.fillMissing(CSt.aggregate(summaries, { filter: { trafficPeriod: 'morning_peak' }, groupBy: ['zone'] }).rows, { zone: zones });
  const least = [...peak].sort((a, b) => a.collectionSec - b.collectionSec)[0];
  check('Q. 출근 피크에 가장 적게 주행한 구역 → 기록 없는 구역도 0으로 채워 비교', peak.length === 3 && least.collectionSec === 0 && least.zone !== '강남',
    peak.map(x => `${x.zone}:${x.collectionMinutes}분`).join(' '));
  const sunset = CSt.fillMissing(CSt.aggregate(summaries, { filter: { lightCondition: 'sunset' }, groupBy: ['zone'] }).rows, { zone: zones });
  const noSunset = sunset.filter(x => x.recordCount === 0).map(x => x.zone).sort();
  check('Q. 일몰 전후 데이터가 없는 구역 → 시흥·판교', noSunset.join(',') === ['시흥', '판교'].sort().join(','), noSunset.join(','));
  const cells = CSt.aggregate(summaries, { groupBy: ['zone', 'trafficPeriod'] }).rows;
  const oldest = [...cells].sort((a, b) => (a.lastVisitedAt < b.lastVisitedAt ? -1 : 1))[0];
  check('Q. 가장 오래 방문하지 않은 구역·시간대 → lastVisitedAt 로 정렬', oldest.zone === '강남' && oldest.trafficPeriod === 'morning_peak', `${oldest.zone} ${oldest.trafficPeriod} ${oldest.lastVisitedAt}`);
}

console.log('\n' + '─'.repeat(60));
console.log(`  통과 ${passed} / 실패 ${failed}`);
if (failures.length) failures.forEach(f => console.log('   - ' + f));
console.log('─'.repeat(60));
process.exit(failed ? 1 : 0);
