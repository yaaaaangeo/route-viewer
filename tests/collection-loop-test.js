// ══════════════════════════════════════════════════════════
//  collection-loop-test — Route Viewer ↔ nav-app 수집 순환 (서버 없는 파일 연계)
//
//   A. 정규 직렬화 · SHA-256 — Node crypto · nav-app Route Package 와 같은 값
//   B. 실제 추천 엔진 결과 → 수집 계획(CollectionPlan) — 점수·근거·방향·시간대를 그대로 담는다
//   C. 계획 대비 수행 평가 — GPS 원본 기준 (방향 반대·시간대 밖·일부만·공백/점프·GPS 없음)
//   D. 자동 가져오기 — 결과 JSON 과 엑셀이 어느 순서로 와도 · 같은 파일 반복 · 기록 삭제 후 재계산
//   E. 추천 전후 변화 — 새 GPS 로 추천 엔진을 다시 돌리면 그 구간 우선순위가 내려간다
//   F. 기존 기능 회귀 — 주행기록 엑셀 자동 가져오기는 그대로
//
//  실행: node tests/collection-loop-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const CL = require('../src/js/collection-loop.js');
const SZ = require('../src/js/subzones.js');
const R = require('../src/js/recommendation.js');
const RouteParser = require('../src/js/parser.js');
const { RouteDatabase } = require('../electron/database.js');
const { AutoImporter } = require('../electron/auto-import.js');

const ROOT = path.join(__dirname, '..');
const NOW = '2026-09-17T01:00:00Z';
const TODAY = '2026-09-17';
const VEHICLE = '토레스 9호차';   // 시험용 차량 — 실제 기록과 섞이지 않게

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n\x1b[36m${t}\x1b[0m`);
const tmpDir = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const freshPath = () => path.join(tmpDir('rv-loop-'), 'route-viewer.db');

const GANGNAM_POLYGON = [[37.4940, 127.0230], [37.5060, 127.0230], [37.5060, 127.0500], [37.4940, 127.0500]];
const XLSX_DIR = path.join(ROOT, '주행기록');
const FILES = fs.existsSync(XLSX_DIR) ? fs.readdirSync(XLSX_DIR).filter(f => /\.xlsx?$/i.test(f)).sort().slice(0, 5) : [];
const PARSED = FILES.map(f => {
  const buf = fs.readFileSync(path.join(XLSX_DIR, f));
  return { records: RouteParser.parseBuffer(buf), meta: { filename: f, fileHash: RouteDatabase.hashFile(buf) } };
});

function seededDb() {
  const db = new RouteDatabase(freshPath());
  db.saveZonePolygons({ ...db.getZonePolygons(), 강남: GANGNAM_POLYGON });
  PARSED.forEach(p => db.importRecords(p.records, p.meta));
  return db;
}

/* ── 시험 주행 만들기 ── */
const pad2 = n => String(n).padStart(2, '0');
const clock = sec => `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor(sec / 60) % 60)}:${pad2(sec % 60)}`;
const secOf = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60; };

/** 좌표 목록을 따라 stepM 간격의 점 */
function along(geom, stepM) {
  const out = [];
  for (let i = 1; i < geom.length; i++) {
    const a = geom[i - 1], b = geom[i];
    const d = SZ.distanceM(a[0], a[1], b[0], b[1]);
    const n = Math.max(1, Math.round(d / stepM));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  out.push(geom[geom.length - 1]);
  return out;
}

/**
 * 구간을 passes 번 지나는 1초 기록 — reverse 면 반대 방향, startSec 부터.
 * 통과 사이는 70초 쉰다(새 통과로 세게). jumpEvery 면 그 간격마다 1km 튄 점을 넣는다.
 */
function drivePasses(geom, o) {
  const pts = along(o.reverse ? geom.slice().reverse() : geom, o.stepM || 8);
  const rows = [];
  let t = o.startSec;
  for (let p = 0; p < (o.passes || 1); p++) {
    pts.forEach((q, i) => {
      if (o.gapAt != null && i === o.gapAt) t += 30;    // GPS 공백
      rows.push({ date: o.date, time: clock(t), vehicle: o.vehicle || VEHICLE, lat: q[0], lng: q[1], speed: '28.8', zone: '강남', place: '강남', road: '도심', weather: '맑음', timeOfDay: '주간', traffic: '(미측정)' });
      if (o.jumpEvery && i % o.jumpEvery === o.jumpEvery - 1) {
        t += 1;
        rows.push({ date: o.date, time: clock(t), vehicle: o.vehicle || VEHICLE, lat: q[0] + 0.01, lng: q[1], speed: '0', zone: '강남', place: '강남', road: '도심', weather: '맑음', timeOfDay: '주간', traffic: '(미측정)' });
      }
      t += 1;
    });
    t += 70;
  }
  return { rows, endSec: t };
}

/** nav-app 주행기록 엑셀과 같은 모양의 파일 (1행 로그인 정보 · 3행 머리글) */
function navAppXlsx(rows, vehicle) {
  const aoa = [['차량', vehicle || VEHICLE, '입장시각', rows[0] ? rows[0].time : ''], [],
    ['번호', '날짜', '시각', 'GPS위치', '도로종류', '날씨', '시간대', '장소', '교통밀도', '차량속도(km/h)']];
  rows.forEach((r, i) => aoa.push([i + 1, r.date, r.time, `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`, r.road, r.weather, r.timeOfDay, r.place, r.traffic, r.speed]));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '주행기록');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** nav-app 이 만드는 것과 같은 주행 결과 (tests/fixtures/drive_result_sample.json 과 같은 규격) */
function driveResult(plan, o) {
  const start = Date.parse(`${o.date}T${clock(o.startSec)}+09:00`);
  const end = Date.parse(`${o.date}T${clock(o.endSec)}+09:00`);
  return CL.seal({
    format: CL.RESULT_FORMAT, schemaVersion: 1, canonicalization: CL.C14N,
    resultId: o.resultId || 'dr-20260916-test0001', sessionId: o.sessionId || 'ds-20260916-test0001',
    createdAt: new Date(end).toISOString(), driveDate: o.date, vehicle: o.vehicle || VEHICLE,
    app: { name: 'nav-app', version: 'v4.3.0' }, device: 'android-app',
    plan: plan ? { planId: plan.planId, planVersion: plan.planVersion, planHash: plan.integrity.sha256 } : null,
    routePackage: { packageId: 'rp-20260916-test', routeVersion: 1, sha256: 'a'.repeat(64) },
    startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), lastHeartbeatAt: new Date(end).toISOString(),
    endReason: o.endReason || 'completed',
    summary: { distanceKm: 1.2, drivingSec: o.endSec - o.startSec, collectionSec: o.endSec - o.startSec, fixes: 0, validFixes: 0, validRatio: 100, gaps: 0, gapSec: 0, jumps: 0, offRouteEvents: 0, pauses: 0 },
    legs: (plan ? plan.items : []).map((it, i) => ({ sequence: i, legId: `RV-${i + 1}`, planItemId: it.itemId, segmentId: it.segmentId, passNo: 1, status: 'completed', startedAt: null, completedAt: null, maxProgressPct: 100, offRouteCount: 0 })),
    events: [], issues: [], hasIssue: false,
    gpsSource: { kind: 'nav-app-trip-log', vehicle: o.vehicle || VEHICLE, date: o.date, fromTime: clock(o.startSec), toTime: clock(o.endSec), fileNamePrefix: '주행기록_' },
  });
}

/** 계획 항목 하나만으로 시험 계획 (부족분·횟수·시간대를 시험에 맞게) */
function testPlan(seg, o) {
  const rec = {
    id: `${seg.id}|weekday|evening_peak|daylight|${o.dir || 'forward'}`, segmentId: seg.id, segmentLabel: seg.label, roadName: seg.roadName,
    parentZone: '강남', geometry: seg.geometry, lengthM: seg.lengthM,
    direction: { id: o.dir || 'forward', label: o.dir === 'backward' ? '역방향' : '정방향' },
    condition: { weekdayType: 'weekday', trafficPeriod: 'evening_peak', lightCondition: 'daylight' },
    timeWindow: o.window || { start: '17:00', end: '18:00' },
    need: { additionalMinutes: o.needMin != null ? o.needMin : 2, targetMinutes: 60, targetVisits: 4, passes: o.passes || 1, passMinutes: 6, estimatedMinutes: 6 },
    current: { collectionMinutes: 58, visitCount: 3 }, score: 70, breakdown: [{ key: 'timePeriod', label: '시간대 부족도', value: 80, contribution: 30 }],
  };
  return CL.buildCollectionPlan({ recommendations: [rec], region: '강남', planDate: o.date, now: Date.parse(NOW), order: 'given' });
}

async function main() {
  section('A. 정규 직렬화 · SHA-256');
  check('SHA-256 — Node crypto 와 같다 (한글·긴 문자열·이모지)',
    ['', 'abc', '강남 · 테헤란로', 'x'.repeat(3000), '📌'].every(s => CL.sha256Hex(s) === crypto.createHash('sha256').update(s, 'utf8').digest('hex')));
  check('정규 직렬화 — 키 정렬, 숫자 10⁶ 배 정수', CL.c14n({ b: 1, a: [37.4978612, 'x"y'], c: null }) === '{"a":[37497861,"x\\"y"],"b":1000000,"c":null}');
  const navPkgPath = path.join(__dirname, 'fixtures', 'route_package_sample.json');
  if (fs.existsSync(navPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(navPkgPath, 'utf8'));
    check('nav-app 이 만든 Route Package 를 같은 규칙으로 검증하면 같은 해시', CL.documentHash(pkg) === pkg.integrity.sha256, pkg.integrity.sha256.slice(0, 12));
  } else check('nav-app Route Package 공용 시험 파일 있음', false, navPkgPath);
  const navResultPath = path.join(__dirname, 'fixtures', 'drive_result_sample.json');
  if (fs.existsSync(navResultPath)) {
    const v = CL.validateDriveResult(fs.readFileSync(navResultPath, 'utf8'));
    check('nav-app 이 만든 DriveResult 를 그대로 검증·수용한다', v.ok, v.ok ? v.result.resultId : v.errors.join(','));
    const sharedPlanPath = path.join(__dirname, 'fixtures', 'collection_plan_sample.json');
    if (v.ok && fs.existsSync(sharedPlanPath)) {
      const sp = JSON.parse(fs.readFileSync(sharedPlanPath, 'utf8'));
      const ev = CL.evaluatePlanExecution({ plan: sp, result: v.result, records: [] });
      check('nav-app 결과가 공용 계획과 이어지고(planId·항목), GPS 원본이 없으면 "GPS 미검증" — 보고값으로 달성 처리하지 않는다',
        v.result.plan && v.result.plan.planId === sp.planId && v.result.legs.every(l => !l.planItemId || sp.items.some(i => i.itemId === l.planItemId))
        && ev.gpsStatus === 'unverified' && ev.items.every(i => i.status === 'unverified'),
        `${ev.gpsStatusLabel} · 보고 완료 구간 ${ev.reported ? ev.reported.legsCompleted : '-'}개`);
    }
  } else check('nav-app DriveResult 공용 시험 파일 있음', false, navResultPath);

  section('A2. 통과 판정 공용 규격 (nav-app-pass-v1) — 같은 궤적에 같은 판정');
  const casesPath = path.join(__dirname, 'fixtures', 'pass_judge_cases.json');
  const judgeCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const pickDir = r => ({ coverage: r.coverage, cells: r.cells, seconds: r.seconds, windowSeconds: r.windowSeconds, passes: r.passes, windowPasses: r.windowPasses, partials: r.partials });
  const intentOk = (it, j) => Object.entries(it).every(([k, v]) => ({
    forwardPasses: () => j.forward.passes === v, backwardPasses: () => j.backward.passes === v, forwardPartials: () => j.forward.partials === v,
    forwardWindowPasses: () => j.forward.windowPasses === v, runs: () => j.runs === v, onNeighborMin: () => j.onNeighbor >= v,
    jumpsMin: () => j.jumps >= v, forwardSecondsMax: () => j.forward.seconds <= v,
  }[k] || (() => false))());
  judgeCases.cases.forEach(c => {
    const j = CL.passJudge(c.track, c.path, c.options);
    const got = { totalCells: j.totalCells, points: j.points, used: j.used, jumps: j.jumps, gaps: j.gaps, runs: j.runs, onTarget: j.onTarget, onNeighbor: j.onNeighbor,
      unknownHeading: j.unknownHeading, forward: pickDir(j.forward), backward: pickDir(j.backward) };
    check(`[판정 사례] ${c.name} — ${c.desc}`, intentOk(c.intent, j) && JSON.stringify(got) === JSON.stringify(c.result),
      `정방향 ${j.forward.passes}회(${j.forward.coverage}) · 역방향 ${j.backward.passes}회(${j.backward.coverage}) · 옆 도로 ${j.onNeighbor}`);
  });
  // nav-app 저장소가 옆에 있으면 판정 코드가 글자 그대로 같은지도 본다 (없으면 공용 시험 파일 기대값으로만)
  const navHtml = path.join(ROOT, '..', 'nav-app', 'index.html');
  const blockOf = t => { const s = t.replace(/\r\n/g, '\n'); const i = s.indexOf('/* PASS-JUDGE nav-app-pass-v1 BEGIN'); const e = s.indexOf('/* PASS-JUDGE nav-app-pass-v1 END */'); return i >= 0 && e > i ? s.slice(i, e) : null; };
  const rvBlock = blockOf(fs.readFileSync(path.join(ROOT, 'src', 'js', 'collection-loop.js'), 'utf8'));
  if (fs.existsSync(navHtml)) {
    const navBlock = blockOf(fs.readFileSync(navHtml, 'utf8'));
    check('nav-app index.html 의 통과 판정 코드가 Route Viewer 와 글자 그대로 같다', !!rvBlock && navBlock === rvBlock, navBlock ? `${rvBlock.length}자` : 'nav-app 에 판정 블록 없음');
  } else console.log('  (nav-app 저장소가 옆에 없어 코드 글자 비교는 건너뜀 — 공용 시험 파일 기대값으로 확인)');

  section('B. 실제 추천 → 수집 계획');
  if (!PARSED.length) { check('주행기록 시험 데이터(주행기록/*.xlsx)가 있다', false); return; }
  const db = seededDb();
  const analysis = db.getAutoAnalysis('강남', { issueFilter: 'all', today: TODAY });
  const recRes = R.buildSegmentRecommendations({ analysis, segmentStats: analysis.segmentStats, settings: db.getSettings(), now: NOW });
  const recs = (recRes.allRecommendations || recRes.recommendations || []).filter(r => r.need && r.need.additionalMinutes > 0);
  check('자동 분석 추천이 있다', recs.length >= 3, `부족한 구간 추천 ${recs.length}개`);
  const top = recs.slice(0, 3);
  const plan = CL.buildCollectionPlan({ recommendations: top, region: '강남', planDate: TODAY, now: Date.parse(NOW),
    policy: { policyId: 'p-test', policyName: '시험 정책' }, window: { start: '09:00', end: '18:00' }, source: { appVersion: '3.1.5', dataRevision: 'test' },
    roadSegments: analysis.segments, segmentStats: analysis.segmentStats });
  const v = CL.validateCollectionPlan(JSON.stringify(plan));
  check('계획 검증 통과 · 검증 코드', v.ok, v.ok ? v.code : v.errors.join(','));
  check('추천 점수·부족분을 다시 계산하지 않고 그대로 담는다',
    top.every(r => { const it = plan.items.find(i => i.recommendationId === r.id); return it && it.score === Math.round(r.score * 10) / 10 && it.deficit.additionalMinutes === Math.round(r.need.additionalMinutes); }));
  check('도로 Segment ID·형상·필수 통과 구간(권장 방향 순서)·진입/진출 지점',
    plan.items.every(it => {
      const r = top.find(x => x.id === it.recommendationId);
      const fwd = it.direction.id !== 'backward';
      return it.segmentId === r.segmentId && it.geometry.length === r.geometry.length
        && it.mustPass.path[0][0] === it.geometry[fwd ? 0 : it.geometry.length - 1][0]
        && it.routeHints.entry === it.mustPass.path[0];
    }));
  check('권장 방향·시간대·반복 횟수·근거·데이터 출처',
    plan.items.every(it => ['forward', 'backward', 'both'].includes(it.direction.id) && it.passes >= 1 && it.reasons.length >= 0 && it.roadSource.type === 'hdmap'),
    plan.items.map(it => `${it.title} ${it.direction.id} ${it.timeWindow ? it.timeWindow.start : '-'} ×${it.passes}`).join(' / '));
  check('방문 순서 — 권장 시간대가 이른 것부터 (시간대를 앞당기지 않는다)',
    plan.items.every((it, i) => i === 0 || (plan.items[i - 1].timeWindow ? plan.items[i - 1].timeWindow.start : '99') <= (it.timeWindow ? it.timeWindow.start : '99')));
  check('구간 간 이동 거리·시간과 총 예상 거리', plan.travel.length === plan.items.length - 1 && plan.totals.distanceKm > 0,
    `이동 ${plan.totals.travelKm}km · 수집 ${plan.totals.collectKm}km · 총 ${plan.totals.distanceKm}km`);
  const tampered = JSON.parse(JSON.stringify(plan)); tampered.items[0].score = 99;
  check('계획을 고치면 SHA-256 검증 실패', !CL.validateCollectionPlan(tampered).ok);
  check('계획에 비밀정보 키가 있으면 받지 않는다', !CL.validateCollectionPlan({ ...plan, apiKey: 'x' }).ok);
  db.saveCollectionPlan(plan);
  check('보낸 계획을 DB 에 남긴다 (나중에 결과와 비교)', !!db.getCollectionPlan(plan.planId), db.listCollectionPlans().length + '개');
  // 공용 시험 파일 — nav-app 이 이 계획을 그대로 가져와 검증한다
  const fixtures = path.join(__dirname, 'fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  const planFixture = path.join(fixtures, 'collection_plan_sample.json');
  if (process.env.UPDATE_FIXTURES || !fs.existsSync(planFixture)) fs.writeFileSync(planFixture, JSON.stringify(plan, null, 1) + '\n');
  check('공용 계획 시험 파일(nav-app 가져오기 시험용)이 검증된다', CL.validateCollectionPlan(fs.readFileSync(planFixture, 'utf8')).ok);

  section('C. 계획 대비 수행 — GPS 원본 기준');
  const seg = analysis.segments.filter(s => s.lengthM > 250 && s.lengthM < 700)[0];
  const DATE = '2026-09-16';   // 수요일(평일)
  const p1 = testPlan(seg, { date: DATE, needMin: 2, passes: 1 });
  const ev = (rows) => CL.evaluatePlanExecution({ plan: p1, records: rows.map((r, i) => ({ ...r, id: i + 1, issueMask: r.issueMask || 0 })) });

  const good = drivePasses(seg.geometry, { date: DATE, startSec: secOf('17:10'), passes: 2, stepM: 2 });
  const eGood = ev(good.rows);
  check('권장 방향·시간대에 통과하고 부족분을 채우면 "목표 달성"', eGood.items[0].status === 'achieved' && eGood.gpsStatus === 'verified',
    `${eGood.items[0].status} · 권장 방향 ${eGood.items[0].coverageRight}% · 시간대 수집 ${eGood.items[0].inWindowMinutes}분 · 통과 ${eGood.items[0].passCount}회`);

  const rev = drivePasses(seg.geometry, { date: DATE, startSec: secOf('17:10'), passes: 2, reverse: true, stepM: 2 });
  const eRev = ev(rev.rows);
  check('추천 방향과 반대로 달리면 "방향 반대" — 달성 아님', eRev.items[0].status === 'wrong_direction' && !eRev.items[0].achieved,
    `${eRev.items[0].status} · 반대 ${eRev.items[0].coverageWrong}% · ${eRev.items[0].reasons[0]}`);

  const late = drivePasses(seg.geometry, { date: DATE, startSec: secOf('20:30'), passes: 2, stepM: 2 });
  const eLate = ev(late.rows);
  check('시간대 밖에 달리면 "지나감"(passed)이지 "목표 달성"이 아니다', eLate.items[0].status === 'passed' && eLate.items[0].inWindowMinutes === 0,
    eLate.items[0].reasons.join(' · '));

  const once = drivePasses(seg.geometry, { date: DATE, startSec: secOf('17:10'), passes: 1, stepM: 2 });
  const pMany = testPlan(seg, { date: DATE, needMin: 1, passes: 3 });
  // 계획 반복은 이제 부족분·시간대로 정한다 — 이 시험은 '계획이 3회를 요구할 때'를 보려고 방문 3회짜리 계획으로 바꾼다
  pMany.items[0].visits = [1, 2, 3].map(n => ({ passNo: n, direction: 'forward' })); pMany.items[0].passes = 3;
  const eOnce = CL.evaluatePlanExecution({ plan: pMany, records: once.rows.map((r, i) => ({ ...r, id: i + 1, issueMask: 0 })) });
  check('한 번 통과로 반복 3회 목표를 채운 것으로 보지 않는다', eOnce.items[0].status === 'passed' && eOnce.items[0].passCount === 1,
    eOnce.items[0].reasons.join(' · '));

  // 같은 도로 구간이 시간대만 달리해 두 항목(아침·오후)으로 들어온 계획 — 아침에만 달리면 오후 항목은 달성이 아니다
  const twoWin = CL.buildCollectionPlan({ recommendations: [['17:00', '18:00', 'evening_peak'], ['07:00', '09:00', 'morning_peak']].map(([ws, we, tp], i) => ({
    id: `${seg.id}|weekday|${tp}|daylight|both`, segmentId: seg.id, geometry: seg.geometry, lengthM: seg.lengthM,
    direction: { id: 'both', label: '양방향' }, condition: { weekdayType: 'weekday', trafficPeriod: tp }, timeWindow: { start: ws, end: we },
    need: { additionalMinutes: 1, passes: 2 }, current: {}, score: 60 - i })), region: '강남', planDate: DATE, now: Date.parse(NOW), order: 'given' });
  const there = drivePasses(seg.geometry, { date: DATE, startSec: secOf('17:10'), passes: 1, stepM: 2 });
  const back = drivePasses(seg.geometry, { date: DATE, startSec: there.endSec - 69, passes: 1, stepM: 2, reverse: true });   // 끝에서 바로 되돌아 달림
  const eWin = CL.evaluatePlanExecution({ plan: twoWin, records: there.rows.concat(back.rows).map((r, i) => ({ ...r, id: i + 1, issueMask: 0 })) });
  check('같은 구간·다른 시간대 두 항목 — 시간대 수집·통과를 항목마다 따로 센다 (양방향 되돌아 달림 = 2회)',
    eWin.items[0].status === 'achieved' && eWin.items[0].passCount === 2 && eWin.items[1].status === 'passed' && eWin.items[1].inWindowMinutes === 0 && eWin.items[1].passCount === 0,
    `17시 항목 ${eWin.items[0].status} ${eWin.items[0].passCount}회 · 7시 항목 ${eWin.items[1].status} 시간대 ${eWin.items[1].inWindowMinutes}분`);

  const twoSegs = analysis.segments.filter(s => s.lengthM > 250 && s.lengthM < 700).slice(0, 2);
  const p2 = CL.buildCollectionPlan({ recommendations: twoSegs.map((s, i) => ({ id: s.id + '|x', segmentId: s.id, geometry: s.geometry, lengthM: s.lengthM,
    direction: { id: 'forward' }, condition: { weekdayType: 'weekday', trafficPeriod: 'evening_peak' }, timeWindow: { start: '17:00', end: '18:00' },
    need: { additionalMinutes: 1, passes: 1 }, current: {}, score: 50 - i })), region: '강남', planDate: DATE, now: Date.parse(NOW), order: 'given',
    roadSegments: analysis.segments });
  const ePart = CL.evaluatePlanExecution({ plan: p2, records: good.rows.map((r, i) => ({ ...r, id: i + 1, issueMask: 0 })) });
  check('계획의 일부만 달리면 나머지는 "주행 안 함" (나란한 반대 차도도 — 옆 도로 정보로 구분)', ePart.items[0].status === 'achieved' && ePart.items[1].status === 'not_driven'
    && ePart.roadIndex === 'plan_neighbors',
    `${twoSegs.map(s => s.id).join(' · ')} · 달성 ${ePart.totals.achieved} · 안 함 ${ePart.totals.not_driven} · ${ePart.roadIndex}`);
  // 같은 계획에서 옆 도로 정보를 빼면 반대 차도 주행을 이 도로의 '반대 방향 주행'으로 잘못 본다 — 브라우저·예전 계획의 한계(화면에 표시)
  const p2bare = JSON.parse(JSON.stringify(p2)); p2bare.items.forEach(it => { delete it.mustPass.neighbors; delete it.mustPass.neighborsKnown; });
  const eBare = CL.evaluatePlanExecution({ plan: p2bare, records: good.rows.map((r, i) => ({ ...r, id: i + 1, issueMask: 0 })) });
  check('옆 도로 정보가 없으면 판정 근거가 "계획 구간만"으로 표시된다 (한계 공개)', eBare.roadIndex === 'plan_only' && /부풀/.test(eBare.roadIndexNote),
    `옆 도로 없음 → 둘째 구간 ${eBare.items[1].status}`);

  const gappy = drivePasses(seg.geometry, { date: DATE, startSec: secOf('17:10'), passes: 2, stepM: 2, gapAt: 20, jumpEvery: 5 });
  const eGap = ev(gappy.rows);
  check('GPS 공백·점프를 센다 — 점프가 많으면 "GPS 품질 낮음"으로 완료 확정하지 않는다',
    eGap.gps.gaps >= 2 && eGap.gps.jumps > 3 && eGap.gpsStatus === 'low_quality' && !eGap.items[0].achieved,
    `공백 ${eGap.gps.gaps} · 점프 ${eGap.gps.jumps} · ${eGap.gpsStatusLabel}`);

  const issueRows = good.rows.map(r => ({ ...r, issueMask: 2 }));
  const eIssue = ev(issueRows);
  check('이슈로 표시한 파일의 기록은 달성에 쓰지 않는다 (기존 이슈 필터) · "GPS 없음"이 아니라 "모두 이슈 표시"라고 알린다',
    eIssue.gpsStatus === 'unverified' && eIssue.gps.issueRecords === issueRows.length && /이슈/.test(eIssue.gpsStatusLabel) && /이슈로 표시/.test(eIssue.items[0].reasons[0]),
    eIssue.items[0].reasons[0]);

  const eNone = ev([]);
  check('GPS 원본이 없으면 "수행 보고 수신 / GPS 미검증" — 완료로 보지 않는다', eNone.gpsStatus === 'unverified' && eNone.items[0].status === 'unverified',
    eNone.gpsStatusLabel);

  section('D. 자동 가져오기 — 순서 뒤바뀜 · 중복 · 삭제 후 재계산');
  const run = async (order) => {
    const ddb = new RouteDatabase(freshPath());
    ddb.saveCollectionPlan(p1);
    const folder = tmpDir('rv-drive-');
    // 자동 가져오기는 파일 수정 시각과 견주므로 실제 시계 기준으로 앞당겨 둔다
    let clockMs = Date.now() + 60000;
    const ai = new AutoImporter({ db: ddb, parseBuffer: RouteParser.parseBuffer, now: () => clockMs, settleMs: 0, minAgeMs: 0 });
    await ai.setFolder(folder);
    await ai.confirmInitial('all');
    const res = driveResult(p1, { date: DATE, startSec: secOf('17:10'), endSec: good.endSec });
    const writeJson = () => fs.writeFileSync(path.join(folder, `driveresult_${DATE}_9호차.json`), JSON.stringify(res));
    const writeXlsx = () => fs.writeFileSync(path.join(folder, `주행기록_${DATE}_1830.xlsx`), navAppXlsx(good.rows));
    const steps = [];
    for (const what of order) {
      (what === 'json' ? writeJson : writeXlsx)();
      clockMs = Date.now() + 120000;
      await ai.runOnce('test');
      const row = ddb.listDriveResults()[0];
      steps.push(row ? row.gpsStatus : 'none');
    }
    return { ddb, folder, ai, res, steps, setClock: ms => { clockMs = ms; } };
  };
  const jsonFirst = await run(['json', 'xlsx']);
  check('결과 JSON 이 먼저 오면 "GPS 미검증" → 엑셀이 들어오면 자동으로 다시 평가해 "검증됨"',
    jsonFirst.steps[0] === 'unverified' && jsonFirst.steps[1] === 'verified', jsonFirst.steps.join(' → '));
  const xlsxFirst = await run(['xlsx', 'json']);
  check('엑셀이 먼저 와도 결과가 들어오는 순간 바로 "검증됨"', xlsxFirst.steps[1] === 'verified', xlsxFirst.steps.join(' → '));
  const evJ = jsonFirst.ddb.listDriveResults()[0].evaluation;
  check('평가 결과 — 계획 항목 달성 (보고 요약이 아니라 GPS 원본으로)', evJ.items[0].status === 'achieved' && evJ.reported && /참고용/.test(evJ.reported.note),
    `${evJ.items[0].status} · GPS ${evJ.gps.records}건`);

  // 같은 결과 파일을 이름만 바꿔 다시 올려도 중복 없음
  fs.writeFileSync(path.join(jsonFirst.folder, 'driveresult_copy.json'), JSON.stringify(jsonFirst.res));
  jsonFirst.setClock(Date.now() + 600000);
  await jsonFirst.ai.runOnce('test');
  check('같은 결과 파일을 다시 가져와도 한 건 (중복 없음)', jsonFirst.ddb.listDriveResults({ includeSuperseded: true }).length === 1,
    `결과 ${jsonFirst.ddb.listDriveResults({ includeSuperseded: true }).length}건`);
  const recCount = jsonFirst.ddb.db.get('SELECT COUNT(*) AS n FROM driving_records').n;
  fs.writeFileSync(path.join(jsonFirst.folder, '주행기록_다시.xlsx'), navAppXlsx(good.rows));
  await jsonFirst.ai.runOnce('test');
  check('같은 GPS 를 다시 올려도 기록이 늘지 않는다 (기존 중복 규칙)', jsonFirst.ddb.db.get('SELECT COUNT(*) AS n FROM driving_records').n === recCount, `${recCount}건`);

  // 같은 세션의 마지막 저장본이 앞 저장본을 대체
  const final = driveResult(p1, { date: DATE, startSec: secOf('17:10'), endSec: good.endSec + 60, resultId: 'dr-20260916-test0002' });
  jsonFirst.ddb.saveDriveResult(final, { source: 'manual' });
  check('같은 세션의 나중 결과가 앞 결과를 대체한다 (중간 저장 → 최종)', jsonFirst.ddb.listDriveResults().length === 1
    && jsonFirst.ddb.listDriveResults()[0].resultId === 'dr-20260916-test0002');

  // 기록 삭제 → 다시 GPS 미검증
  jsonFirst.ddb.deleteDate(DATE);
  jsonFirst.ddb.evaluateAllDriveResults();
  check('주행 기록을 지우면 결과가 다시 "GPS 미검증"으로 재계산된다', jsonFirst.ddb.listDriveResults()[0].gpsStatus === 'unverified');

  const badRes = JSON.parse(JSON.stringify(jsonFirst.res)); badRes.summary.distanceKm = 99;
  fs.writeFileSync(path.join(jsonFirst.folder, 'driveresult_bad.json'), JSON.stringify(badRes));
  fs.writeFileSync(path.join(jsonFirst.folder, 'other.json'), '{"hello":1}');
  await jsonFirst.ai.runOnce('test');
  const files = jsonFirst.ddb.listAutoImportFiles(jsonFirst.ai.folderKey(jsonFirst.ai.config().folder));
  check('위조·손상된 결과는 "실패"로 받지 않고, 다른 JSON 은 건너뛴다(실패로 세지 않음)',
    files.find(f => f.name === 'driveresult_bad.json').status === 'failed' && files.find(f => f.name === 'other.json').status === 'ignored',
    files.find(f => f.name === 'driveresult_bad.json').reason);

  section('E. 추천 전후 변화 — 새 GPS 로 추천 엔진을 다시 돌린다');
  const target = recs.find(r => r.condition.weekdayType === 'weekday' && r.timeWindow && r.timeWindow.start && r.geometry && r.lengthM > 120) || recs[0];
  const planE = CL.buildCollectionPlan({ recommendations: [target], region: '강남', planDate: '2026-09-16', now: Date.parse(NOW) });
  const ws = secOf(target.timeWindow.start);
  const passSec = Math.max(30, Math.round(target.lengthM / 3));
  const passesNeeded = Math.ceil((target.need.additionalMinutes * 60) / passSec) + 2;
  const drive = drivePasses(target.geometry, { date: '2026-09-16', startSec: ws + 60, passes: Math.min(passesNeeded, 80),
    reverse: target.direction.id === 'backward', stepM: 3 });
  db.importRecords(drive.rows, { filename: '시험_추천구간.xlsx', fileHash: 'test-' + Date.now() });
  db.rebuildDateSummaries(['2026-09-16']);
  const after = db.getAutoAnalysis('강남', { issueFilter: 'all', today: TODAY, force: true });
  const recAfter = R.buildSegmentRecommendations({ analysis: after, segmentStats: after.segmentStats, settings: db.getSettings(), now: NOW });
  const evE = CL.evaluatePlanExecution({ plan: planE, records: drive.rows.map((r, i) => ({ ...r, id: i + 1, issueMask: 0 })) });
  const changes = CL.compareRecommendations(planE, recAfter.allRecommendations || recAfter.recommendations, evE);
  const ch = changes[0];
  // 전후 판정은 GPS 판정과 어긋나면 안 된다: GPS 로 달성했으면 '충족', 아니면 줄었거나(같은 방향 추천이 남음) '알 수 없음'
  // (예전에는 추천 ID 가 방향까지 같아야 맞춰, 엔진이 반대 방향을 권하게 되면 '목록에서 빠짐 = 충족'으로 잘못 봤다)
  const evItem = evE.items[0];
  check('주행한 구간의 전후 판정이 GPS 판정과 맞는다 (달성이면 충족 · 반대 방향으로 바뀌면 계획 방향 부족분을 지어내지 않는다)',
    evE.gpsStatus === 'verified' && (evItem.status === 'achieved' ? ch.status === 'resolved' : ch.status !== 'resolved')
      && (ch.status !== 'unknown' || ch.afterNeedMinutes === null),
    `${target.displayName || target.segmentLabel} · GPS ${evItem.status}(시간대 ${evItem.inWindowMinutes}분/${evItem.needMinutes}분) · 전후 ${ch.status} · 점수 ${ch.beforeScore} → ${ch.afterScore == null ? '—' : ch.afterScore} · ${ch.reason}`);
  db.saveCollectionPlan(planE);
  db.saveRecommendationChanges(planE.planId, changes, ['ds-test-e']);
  const saved = db.listRecommendationChanges(planE.planId);
  check('전후 비교를 저장한다 (기존·새 점수·부족량 감소·근거·반영 세션)',
    saved.length === 1 && saved[0].beforeScore === ch.beforeScore && saved[0].sessionIds === 'ds-test-e' && saved[0].reason.length > 0);
  const untouched = recs.find(r => r.segmentId !== target.segmentId && r.need.additionalMinutes > 0);
  if (untouched) {
    const planU = CL.buildCollectionPlan({ recommendations: [untouched], region: '강남', planDate: TODAY, now: Date.parse(NOW) });
    const cu = CL.compareRecommendations(planU, recAfter.allRecommendations || recAfter.recommendations)[0];
    check('주행하지 않은 구간은 계속 추천된다 (목표 미충족)', cu.status !== 'resolved' && cu.needReducedMinutes === 0, `${cu.status} · ${cu.reason}`);
  }

  // 실주행 검증(2026-10-17)에서 찾은 것 — ① 측위 잡음으로 방향이 한두 건 뒤집혀도 통과 횟수가 늘지 않는다
  //  ② 엔진이 방향을 다시 정해도(양방향 → 한쪽) 같은 조건으로 맞춘다 ③ 목록에 없다고 '충족'으로 보지 않는다
  const noisy = drivePasses(seg.geometry, { date: DATE, startSec: secOf('17:10'), passes: 2, stepM: 8 });
  let s2 = 11; const rn = () => { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647 - 0.5; };
  const noisyRows = noisy.rows.map(r => ({ ...r, lat: r.lat + rn() * 0.00008, lng: r.lng + rn() * 0.0001 }));   // 약 ±4~5m
  const pBoth = CL.buildCollectionPlan({ recommendations: [{ id: `${seg.id}|weekday|evening_peak|daylight|both`, segmentId: seg.id, geometry: seg.geometry, lengthM: seg.lengthM,
    direction: { id: 'both', label: '양방향' }, condition: { weekdayType: 'weekday', trafficPeriod: 'evening_peak', lightCondition: 'daylight' }, timeWindow: { start: '17:00', end: '18:00' },
    need: { additionalMinutes: 30, passes: 2 }, current: {}, score: 80 }], region: '강남', planDate: DATE, now: Date.parse(NOW), order: 'given' });
  const eNoisy = CL.evaluatePlanExecution({ plan: pBoth, records: noisyRows.map((r, i) => ({ ...r, id: i + 1, issueMask: 0 })) });
  check('측위 잡음(±5m)에도 통과 횟수는 실제 통과 수 그대로 · 시간대 수집 분 ≤ 권장 방향 수집 분',
    eNoisy.items[0].passCount === 2 && eNoisy.items[0].inWindowMinutes <= eNoisy.items[0].collectedMinutes,
    `통과 ${eNoisy.items[0].passCount}회 · 시간대 ${eNoisy.items[0].inWindowMinutes}분 / 권장 방향 ${eNoisy.items[0].collectedMinutes}분`);
  const relabeled = [{ id: `${seg.id}|weekday|evening_peak|daylight|backward`, segmentId: seg.id, condition: { weekdayType: 'weekday', trafficPeriod: 'evening_peak', lightCondition: 'daylight' },
    direction: { id: 'backward', label: '역방향' }, need: { additionalMinutes: 22 }, score: 61 }, { id: 'other|x', segmentId: 'other', condition: {}, need: { additionalMinutes: 5 }, score: 50 }];
  const cRel = CL.compareRecommendations(pBoth, relabeled, eNoisy)[0];
  check('엔진이 방향을 다시 정해도(양방향 → 역방향) 같은 조건으로 비교한다', cRel.status === 'lowered' && cRel.afterNeedMinutes === 22 && /방향이/.test(cRel.reason), `${cRel.status} · ${cRel.reason}`);
  const cGone = CL.compareRecommendations(pBoth, [relabeled[1]], eNoisy)[0];
  check('추천 목록에 없다고 목표 충족으로 보지 않는다 (GPS 로 달성 확인 전에는 "알 수 없음")',
    cGone.status === 'unknown' && cGone.needReducedMinutes === 0 && cGone.afterNeedMinutes === null, cGone.reason);

  // ④ 이어지는 같은 도로 구간을 달린 기록은 계획 구간에 넣지 않는다 (지역 도로망을 주면)
  const near = (p, q) => SZ.distanceM(p[0], p[1], q[0], q[1]) < 3;
  const pair = (() => {
    for (const a of analysis.segments) {
      if (!(a.lengthM > 200 && a.lengthM < 600)) continue;
      const b = analysis.segments.find(s => s !== a && s.roadName === a.roadName && s.lengthM > 200 && near(s.geometry[0], a.geometry[a.geometry.length - 1]));
      if (b) return [a, b];
    }
    return null;
  })();
  if (pair) {
    const [segA, segB] = pair;
    const pAdj = CL.buildCollectionPlan({ recommendations: [{ id: `${segA.id}|weekday|evening_peak|daylight|forward`, segmentId: segA.id, geometry: segA.geometry, lengthM: segA.lengthM,
      direction: { id: 'forward', label: '정방향' }, condition: { weekdayType: 'weekday', trafficPeriod: 'evening_peak' }, timeWindow: { start: '17:00', end: '18:00' },
      need: { additionalMinutes: 5, passes: 1 }, current: {}, score: 70 }], region: '강남', planDate: DATE, now: Date.parse(NOW), order: 'given' });
    const both = drivePasses(segA.geometry.concat(segB.geometry.slice(1)), { date: DATE, startSec: secOf('17:10'), passes: 1, stepM: 8 });
    const recsAdj = both.rows.map((r, i) => ({ ...r, id: i + 1, issueMask: 0 }));
    const onlyPlan = CL.evaluatePlanExecution({ plan: pAdj, records: recsAdj }).items[0];
    const withNet = CL.evaluatePlanExecution({ plan: pAdj, records: recsAdj, roadSegments: analysis.segments }).items[0];
    const expectMin = Math.round(segA.lengthM / 8 / 6) / 10;
    check('지역 도로망으로 대응하면 이어지는 같은 도로 구간의 기록을 계획 구간에 넣지 않는다',
      withNet.collectedMinutes < onlyPlan.collectedMinutes && Math.abs(withNet.collectedMinutes - expectMin) <= 0.4,
      `${segA.roadName} — 계획 구간만 ${onlyPlan.collectedMinutes}분 · 지역 도로망 ${withNet.collectedMinutes}분 (구간 길이로 어림 ${expectMin}분)`);
  } else check('이어지는 같은 도로 구간 쌍을 찾았다', false);

  section('G. 안정화 — 방향 가능성 · 반복 횟수 · 계획별 상태 · 동기화 중 JSON');
  // P1-3 반복 횟수와 수집 목표 — 실제 추천(전부 '10회 × 6분' 제안)을 고정 5회로 자르지 않고 구간 길이·시간대로 정한다
  const realTop = recs.filter(r => r.timeWindow && r.timeWindow.start).slice(0, 4);
  const pReal = CL.buildCollectionPlan({ recommendations: realTop, region: '강남', planDate: TODAY, now: Date.parse(NOW), order: 'given',
    roadSegments: analysis.segments, segmentStats: analysis.segmentStats });
  check('반복 횟수는 고정 5회가 아니다 — 부족분·권장 시간대·구간 길이로 정하고 최대 ' + CL.MAX_PASSES + '회',
    pReal.items.every(it => it.passes >= 1 && it.passes <= CL.MAX_PASSES && it.passes === it.estimate.plannedPasses && it.visits.length === it.passes)
      && pReal.items.some(it => it.passes !== 5),
    pReal.items.map(it => `${it.title} ${it.passes}회(필요 ${it.estimate.neededPasses} · 시간대 ${it.estimate.fitPasses})`).join(' / '));
  check('추천 엔진의 목표·누적·부족·방향·기존 방문·고정 반복 제안을 따로 남긴다',
    pReal.items.every(it => { const r = realTop.find(x => x.id === it.recommendationId);
      return it.target.deficitMinutes === Math.round(r.need.additionalMinutes) && it.target.recommendedPasses === r.need.passes && it.target.direction === r.direction.id; }));
  check('다 못 채우면 계획 확정 전에 예상 부족량과 원인을 남긴다 (예상은 달성이 아님)',
    pReal.items.every(it => Math.abs(it.estimate.expectedMinutes - Math.round(it.passes * it.estimate.passSec / 6) / 10) < 0.05
      && it.estimate.shortfallMinutes === Math.max(0, Math.round((it.estimate.deficitMinutes - it.estimate.expectedMinutes) * 10) / 10))
      && pReal.totals.shortfallMinutes > 0 && pReal.feasibility.warnings.some(w => /남음/.test(w)),
    `예상 ${pReal.totals.expectedMinutes}분 / 부족 ${pReal.totals.deficitMinutes}분 · ${pReal.feasibility.warnings[0] || ''}`);
  // P1-2 방향 가능성 — 지도만으로 단정하지 않는다
  check('방향 가능 여부는 지도로 단정하지 않는다 — 기본 "확인 필요", GPS 기록은 참고로만',
    pReal.items.every(it => ['forward', 'backward'].every(d => ['needs_check', 'gps_seen'].includes(it.directionPlan.feasibility[d].status))),
    pReal.items.map(it => `${it.title}: ${it.directionPlan.feasibility.forward.status}/${it.directionPlan.feasibility.backward.status}`).join(' · '));
  const bothRec = realTop.find(r => r.direction.id === 'both') || realTop[0];
  const fb = [{ segmentId: bothRec.segmentId, direction: 'backward', cause: 'direction_unreachable', at: '2026-09-16T10:00:00Z', resultId: 'dr-x' }];
  const pFb = CL.buildCollectionPlan({ recommendations: [bothRec], region: '강남', planDate: TODAY, now: Date.parse(NOW), order: 'given', directionFeedback: fb });
  check('nav-app TMAP 이 "그 방향 경로 없음"을 보고한 방향은 빼고 이유를 남긴다 (나머지 방향만 방문)',
    pFb.items[0].visits.every(v => v.direction === 'forward') && pFb.items[0].directionPlan.excluded.length === 1 && /TMAP/.test(pFb.items[0].directionPlan.excluded[0].reason)
      && pFb.feasibility.warnings.some(w => /제외/.test(w)), pFb.items[0].directionPlan.excluded[0] && pFb.items[0].directionPlan.excluded[0].reason);
  const fb2 = fb.concat([{ segmentId: bothRec.segmentId, direction: 'forward', cause: 'direction_unreachable', at: '2026-09-16T10:00:00Z', resultId: 'dr-y' }]);
  const pFb2 = CL.buildCollectionPlan({ recommendations: [bothRec, realTop.find(r => r !== bothRec)], region: '강남', planDate: TODAY, now: Date.parse(NOW), order: 'given', directionFeedback: fb2 });
  check('가능한 방향이 없는 항목은 계획에 넣지 않고 "제외 + 이유"로 남긴다', pFb2.excludedItems.length === 1 && !pFb2.items.some(it => it.segmentId === bothRec.segmentId),
    pFb2.excludedItems[0] && pFb2.excludedItems[0].reason);
  const fbFrom = CL.directionFeedbackFromResults([{ resultId: 'dr-z', endedAt: '2026-09-17T01:00:00Z', planAdjustments: { skippedDirections: [{ itemId: 'pi-1', segmentId: 's1', direction: 'backward', cause: 'direction_unreachable' }] } }]);
  check('주행 결과의 planAdjustments(뺀 방향·원인)를 방향 피드백으로 모은다', fbFrom.length === 1 && fbFrom[0].segmentId === 's1' && fbFrom[0].resultId === 'dr-z');
  // 옆 도로 — 계획에 담아 nav-app 이 같은 입력으로 판정
  check('계획에 옆 도로(40m 안 다른 도로 구간)를 담는다 — nav-app·Route Viewer 가 같은 입력으로 판정',
    pReal.items.every(it => it.mustPass.neighborsKnown && Array.isArray(it.mustPass.neighbors) && it.mustPass.judge === CL.PASS_JUDGE_VERSION)
      && CL.validateCollectionPlan(JSON.stringify(pReal)).ok && JSON.stringify(pReal).length < 5 * 1024 * 1024,
    pReal.items.map(it => `${it.title} 옆 도로 ${it.mustPass.neighbors.length}`).join(' · ') + ` · ${Math.round(JSON.stringify(pReal).length / 1024)}KB`);

  // P2-2 계획별 상태 — 증거 없는 단계는 '확인 불가'
  const sdb = new RouteDatabase(freshPath());
  sdb.saveCollectionPlan(p1);
  const stOf = () => sdb.listPlanStatuses().plans.find(x => x.planId === p1.planId);
  const st1 = stOf();
  check('계획만 저장 → "계획 생성", 전달·내보냄은 확인 불가로 표시(추정하지 않음)', st1.stage === 'created'
    && st1.steps.find(s => s.key === 'delivered').state === 'unknown' && st1.steps.find(s => s.key === 'exported').state === 'unknown', st1.label);
  sdb.markPlanExported(p1.planId, p1.planVersion, 'C:/x/collectionplan.json');
  const st2 = stOf();
  check('파일로 내보내도 "전달 완료"가 아니라 "결과 대기 (전달 확인 불가)"', st2.stage === 'waiting' && st2.steps.find(s => s.key === 'delivered').state === 'unknown', st2.label);
  const sfolder = tmpDir('rv-status-');
  let sclock = Date.now() + 60000;
  const sai = new AutoImporter({ db: sdb, parseBuffer: RouteParser.parseBuffer, now: () => sclock, settleMs: 0, minAgeMs: 0 });
  await sai.setFolder(sfolder); await sai.confirmInitial('all');
  const sres = driveResult(p1, { date: DATE, startSec: secOf('17:10'), endSec: good.endSec, resultId: 'dr-20260916-stat0001', sessionId: 'ds-20260916-stat0001' });
  const forged = JSON.parse(JSON.stringify(sres)); forged.summary.distanceKm = 77;
  fs.writeFileSync(path.join(sfolder, 'driveresult_forged.json'), JSON.stringify(forged));
  sclock = Date.now() + 120000; await sai.runOnce('test');
  const st3 = stOf();
  check('계획을 가리키는 결과 파일이 손상돼 못 받으면 "가져오기 실패" (어느 계획인지 연결)', st3.stage === 'import_failed' && st3.failures.length === 1, `${st3.label} · ${st3.failures[0] && st3.failures[0].reason}`);
  fs.writeFileSync(path.join(sfolder, 'driveresult_ok.json'), JSON.stringify(sres));
  sclock = Date.now() + 180000; await sai.runOnce('test');
  const st4 = stOf();
  check('결과가 오면 "결과 수신 · GPS 미검증", 전달은 결과로 확인', st4.stage === 'gps_unverified' && st4.steps.find(s => s.key === 'delivered').state === 'done', st4.label);
  fs.writeFileSync(path.join(sfolder, `주행기록_${DATE}_st.xlsx`), navAppXlsx(good.rows));
  sclock = Date.now() + 240000; await sai.runOnce('test');
  const st5 = stOf();
  check('GPS 원본이 들어오면 "GPS 검증 완료"', st5.stage === 'gps_verified', st5.label);

  // P3 동기화 중인 불완전 JSON 과 실제로 깨진 JSON 을 다르게 안내
  const text5 = JSON.stringify(sres);
  fs.writeFileSync(path.join(sfolder, 'driveresult_half.json'), text5.slice(0, Math.floor(text5.length / 2)));
  sclock = Date.now() + 60000; await sai.runOnce('test');
  const half1 = sdb.listAutoImportFiles(sai.folderKey(sai.config().folder)).find(f => f.name === 'driveresult_half.json');
  check('방금 받은 끝나지 않은 JSON → "동기화 중"(pending · 다음 확인 때 다시 읽음)', half1.status === 'pending' && /동기화 중/.test(half1.reason), half1.reason);
  sclock = Date.now() + 15 * 60000; await sai.runOnce('test');
  const half2 = sdb.listAutoImportFiles(sai.folderKey(sai.config().folder)).find(f => f.name === 'driveresult_half.json');
  check('10분 넘게 그대로면 "JSON 이 깨졌어요 — 다시 보내 주세요"(실패)', half2.status === 'failed' && /깨졌/.test(half2.reason), half2.reason);
  fs.writeFileSync(path.join(sfolder, 'driveresult_half.json'), text5);
  sclock = Date.now() + 16 * 60000; await sai.runOnce('test');
  const half3 = sdb.listAutoImportFiles(sai.folderKey(sai.config().folder)).find(f => f.name === 'driveresult_half.json');
  check('파일이 완성되면 다시 읽어 처리한다 (같은 결과면 중복 없음)', half3.status === 'already' && sdb.listDriveResults({ includeSuperseded: true }).length === 1, half3.status);
  sdb.close();

  section('H. 실현 가능성 — 목표 수집량 · 반복 · 방향 · 대안 (합성 도로)');
  // 엔진: 예전 '편도 최소 6분' 바닥 때문에 짧은 구간이 모두 10회였다 — 이제 길이 ÷ 속도
  const shortRec = recs.find(r => r.lengthM < 300 && r.need.additionalMinutes >= 30);
  check('엔진 반복 = ⌈부족분 ÷ (구간 길이 ÷ 수집 속도)⌉ — 짧은 구간도 고정 10회가 아니다',
    !!shortRec && shortRec.need.passSec === Math.max(5, Math.round(shortRec.lengthM / (shortRec.need.speedKmh / 3.6)))
      && shortRec.need.passes === Math.ceil(shortRec.need.additionalMinutes * 60 / shortRec.need.passSec) && shortRec.need.passes !== 10 && /÷/.test(shortRec.need.basis),
    shortRec && `${Math.round(shortRec.lengthM)}m · ${shortRec.need.basis} · ${shortRec.need.text}`);
  check('추천 점수는 그대로 (반복 계산이 점수를 바꾸지 않음)', recs.every(r => typeof r.score === 'number') && recs.filter(r => r.need.passes > 10).length > 0,
    `10회 넘는 추천 ${recs.filter(r => r.need.passes > 10).length}개 / 전체 ${recs.length}개`);
  const L0 = 37.4800, G0 = 127.0500, KX = 111320 * Math.cos(L0 * Math.PI / 180), KY = 110540;
  const syn = (x0, x1, y) => [[x0, y], [(x0 + x1) / 2, y], [x1, y]].map(([x, yy]) => [Math.round((L0 + yy / KY) * 1e7) / 1e7, Math.round((G0 + x / KX) * 1e7) / 1e7]);
  const synRec = (id, geom, lengthM, need, dir, win, cond) => ({ id: `syn:${id}|weekday|morning_peak|daylight|${dir || 'both'}`, segmentId: 'syn:' + id, displayName: '합성 ' + id,
    roadName: '합성' + id, parentZone: '강남', geometry: geom, lengthM, direction: { id: dir || 'both', label: dir || '양방향' },
    condition: cond || { weekdayType: 'weekday', trafficPeriod: 'morning_peak', lightCondition: 'daylight' }, conditionLabel: '평일 · 출근 피크 · 주간',
    timeWindow: win || { start: '07:00', end: '08:00' }, need: { additionalMinutes: need, targetMinutes: 60, passes: 10, passMinutes: 6, speedKmh: 20 }, current: { collectionMinutes: 60 - need, visitCount: 0 }, score: 80 });
  const rShort = synRec('short', syn(0, 150, 0), 150, 60);
  const rLong = synRec('long', syn(0, 1500, 300), 1500, 30, 'both', { start: '07:00', end: '09:00' });
  const rOtherCond = synRec('othercond', syn(0, 1500, 600), 1500, 30, 'both', null, { weekdayType: 'weekend', trafficPeriod: 'morning_peak', lightCondition: 'daylight' });
  const pH = CL.buildCollectionPlan({ recommendations: [rShort], candidates: [rShort, rLong, rOtherCond], region: '강남', planDate: DATE, now: Date.parse(NOW), order: 'given' });
  const hs = pH.items[0];
  check('① 짧은 구간(150m) · 부족 60분 — 최대 방문으로도 목표 미달 예상 · 부적합 표시 · 몇 번 주행일이 필요한지',
    hs.feasibility.status === 'shortfall' && hs.estimate.unsuitable && hs.estimate.neededPasses === Math.ceil(3600 / hs.estimate.passSec)
      && hs.estimate.plannedPasses <= CL.MAX_PASSES && hs.estimate.shortfallMinutes > 50 && hs.estimate.plansNeeded > 1,
    `편도 ${hs.estimate.passSec}초 · 필요 ${hs.estimate.neededPasses}회 · 계획 ${hs.estimate.plannedPasses}회 · 예상 ${hs.estimate.expectedMinutes}분 · 부족 ${hs.estimate.shortfallMinutes}분 · 약 ${hs.estimate.plansNeeded}번 주행일`);
  check('대안 — 같은 조건(요일·시간대·조도)의 더 긴 구간을 제안 · 다른 조건(주말) 후보는 섞지 않음',
    hs.alternatives.length === 1 && hs.alternatives[0].segmentId === 'syn:long' && hs.alternatives[0].quantityStatus !== 'shortfall',
    hs.alternatives.map(a => `${a.title}: ${a.why}`).join(' / '));
  check('대안의 예상은 원래 항목 예상에 더하지 않는다', hs.estimate.expectedMinutes === Math.round(hs.estimate.plannedPasses * hs.estimate.passSec / 6) / 10);
  const pLong = CL.buildCollectionPlan({ recommendations: [rLong], region: '강남', planDate: DATE, now: Date.parse(NOW), order: 'given',
    directionFeedback: [{ segmentId: 'syn:long', direction: 'forward', cause: 'ok', at: '2026-09-16T00:00:00Z' }, { segmentId: 'syn:long', direction: 'backward', cause: 'ok', at: '2026-09-16T00:00:00Z' }] });
  const hl = pLong.items[0];
  check('② 긴 구간(1.5km) · 부족 30분 · 두 방향 TMAP 확인 — 달성 가능', hl.feasibility.status === 'achievable' && hl.estimate.shortfallMinutes === 0,
    `${hl.feasibility.label} · 편도 ${hl.estimate.passSec}초 · ${hl.estimate.plannedPasses}회 · 예상 ${hl.estimate.expectedMinutes}분`);
  const rCond = synRec('cond', syn(0, 1000, 900), 1000, 50, 'both', { start: '07:00', end: '08:15' });
  const pCond = CL.buildCollectionPlan({ recommendations: [rCond], region: '강남', planDate: DATE, now: Date.parse(NOW), order: 'given',
    directionFeedback: ['forward', 'backward'].map(d => ({ segmentId: 'syn:cond', direction: d, cause: 'ok', at: '2026-09-16T00:00:00Z' })) });
  const hc = pCond.items[0];
  const s30 = hc.estimate.speedSensitivity.find(x => x.speedKmh === 30);
  check('조건부 가능 — 20km/h 가정이면 채우지만 30km/h 로 빨리 달리면 부족 (속도 가정별 예상 표시)',
    hc.feasibility.status === 'conditional' && s30 && s30.shortfallMinutes > 0 && /빨리/.test(hc.feasibility.reasons.join()),
    hc.estimate.speedSensitivity.map(x => `${x.speedKmh}km/h ${x.expectedMinutes}분(부족 ${x.shortfallMinutes})`).join(' · '));
  const pUnk = CL.buildCollectionPlan({ recommendations: [rLong], region: '강남', planDate: DATE, now: Date.parse(NOW), order: 'given' });
  check('⑤ 방향이 확인되지 않은 도로 — 수량은 되어도 "방향 확인 필요" (불가로 단정하지 않음 · 방문은 그대로)',
    pUnk.items[0].feasibility.status === 'direction_unknown' && pUnk.items[0].visits.length > 0 && pUnk.items[0].feasibility.quantityStatus === 'achievable',
    pUnk.items[0].feasibility.reasons.join(' / '));
  // 탐색 결과 파일(routecheck) — 확정·주행 없이도 방향 판단에 들어간다
  const rcDoc = CL.seal({ format: CL.ROUTE_CHECK_FORMAT, schemaVersion: 1, checkId: 'rc-20260917-test01', createdAt: '2026-09-17T00:00:00Z', vehicle: VEHICLE,
    directionChecks: [{ segmentId: 'syn:long', direction: 'forward', result: 'ok', at: '2026-09-17T00:00:00Z' },
      { segmentId: 'syn:long', direction: 'backward', result: 'direction_unreachable', at: '2026-09-17T00:00:00Z' }] });
  const hdb = new RouteDatabase(freshPath());
  check('탐색 결과 파일을 받는다 · 같은 파일 다시는 중복', hdb.saveRouteCheck(JSON.stringify(rcDoc)).status === 'inserted' && hdb.saveRouteCheck(JSON.stringify(rcDoc)).status === 'duplicate');
  const forgedRc = JSON.parse(JSON.stringify(rcDoc)); forgedRc.directionChecks[1].result = 'ok';
  check('손상·위조된 탐색 결과는 받지 않는다', !CL.validateRouteCheck(JSON.stringify(forgedRc)).ok);
  const pRc = CL.buildCollectionPlan({ recommendations: [rLong], region: '강남', planDate: DATE, now: Date.parse(NOW), order: 'given', directionFeedback: hdb.listDirectionFeedback() });
  check('탐색 결과 반영 — 확인된 방향은 "TMAP 경로 확인", 안 되는 방향은 이유와 함께 제외', pRc.items[0].directionPlan.feasibility.forward.status === 'tmap_ok'
    && pRc.items[0].visits.every(v => v.direction === 'forward') && pRc.items[0].directionPlan.excluded.length === 1 && pRc.items[0].feasibility.status !== 'direction_unknown',
    `${pRc.items[0].feasibility.label} · ${pRc.items[0].directionPlan.excluded[0] && pRc.items[0].directionPlan.excluded[0].reason}`);
  hdb.close();
  // ⑦ GPS 인정 시간과 예상 수집량 분리 — 계획의 예상치를 바꿔도 판정(GPS)은 그대로, 예상은 달성으로 저장되지 않는다
  const pSep = JSON.parse(JSON.stringify(p1));
  pSep.items[0].estimate.expectedMinutes = 999; pSep.items[0].estimate.shortfallMinutes = 0;
  const recsSep = good.rows.map((r, i) => ({ ...r, id: i + 1, issueMask: 0 }));
  const e1 = CL.evaluatePlanExecution({ plan: p1, records: recsSep }).items[0], e2 = CL.evaluatePlanExecution({ plan: pSep, records: recsSep }).items[0];
  const eNo = CL.evaluatePlanExecution({ plan: pSep, records: [] }).items[0];
  check('⑦ 예상치는 판정에 쓰지 않는다 — 예상 999분으로 바꿔도 GPS 수집 분·판정 동일 · GPS 없으면 미검증',
    e1.collectedMinutes === e2.collectedMinutes && e1.status === e2.status && eNo.status === 'unverified' && eNo.collectedMinutes === 0 && !('expectedMinutes' in e2),
    `GPS 수집 ${e2.collectedMinutes}분 · 계획 예상 ${pSep.items[0].estimate.expectedMinutes}분(무시) · GPS 없음 → ${eNo.status}`);
  check('계획의 현재 수집 시간은 추천 엔진(GPS 원본 집계)의 값 — 예상과 다른 필드', p1.items[0].target.currentMinutes === p1.items[0].deficit.currentMinutes && p1.items[0].estimate.expectedMinutes !== undefined);
  // ⑨ 같은 계획 재평가 — 예상·실제 인정량이 중복되지 않는다
  const rdb = new RouteDatabase(freshPath());
  rdb.saveCollectionPlan(p1);
  rdb.importRecords(good.rows, { filename: '재평가.xlsx', fileHash: 'reeval-1' });
  rdb.importRecords(good.rows, { filename: '재평가-다시.xlsx', fileHash: 'reeval-2' });
  const rr0 = driveResult(p1, { date: DATE, startSec: secOf('17:10'), endSec: good.endSec, resultId: 'dr-20260916-reev0001', sessionId: 'ds-20260916-reev0001' });
  rdb.saveDriveResult(JSON.stringify(rr0)); rdb.saveDriveResult(JSON.stringify(rr0));
  const ev1 = JSON.stringify(rdb.listDriveResults()[0].evaluation);
  rdb.evaluateDriveResult(rr0.resultId, { force: true }); rdb.evaluateAllDriveResults();
  const ev2 = JSON.stringify(rdb.listDriveResults()[0].evaluation);
  check('⑨ 같은 계획·같은 결과·같은 GPS 를 다시 넣고 다시 평가해도 결과 1건 · 평가 동일 · 기록 중복 없음',
    rdb.listDriveResults({ includeSuperseded: true }).length === 1 && ev1 === ev2 && rdb.db.get('SELECT COUNT(*) AS n FROM driving_records').n === good.rows.length
      && rdb.listPlanStatuses().plans[0].results === 1,
    `GPS ${rdb.db.get('SELECT COUNT(*) AS n FROM driving_records').n}건 · 수집 ${JSON.parse(ev2).items[0].collectedMinutes}분`);
  rdb.close();

  section('F. 기존 기능 회귀');
  const ddb2 = new RouteDatabase(freshPath());
  const folder2 = tmpDir('rv-drive2-');
  const ai2 = new AutoImporter({ db: ddb2, parseBuffer: RouteParser.parseBuffer, settleMs: 0, minAgeMs: 0, now: () => Date.now() + 60000 });
  fs.writeFileSync(path.join(folder2, '주행기록_2026-09-16.xlsx'), navAppXlsx(good.rows));
  await ai2.setFolder(folder2); await ai2.confirmInitial('all');
  check('주행기록 엑셀 자동 가져오기는 그대로 (연계 결과가 없어도)', ddb2.db.get('SELECT COUNT(*) AS n FROM driving_records').n === good.rows.length
    && ddb2.listDriveResults().length === 0);

  console.log(`\n  통과 ${passed} / 실패 ${failed}`);
  if (failed) { console.log('  실패: ' + failures.join(' | ')); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
