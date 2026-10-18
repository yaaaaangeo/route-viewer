// ══════════════════════════════════════════════════════════
//  loop-integration-test — Route Viewer × nav-app 전체 순환 (TMAP 호출 없음 · 합성 도로 · 합성 GPS)
//
//  두 저장소의 실제 코드를 이어 돌린다 (코드는 합치지 않는다 — nav-app 은 옆 폴더 ../nav-app/index.html 에서 함수만 읽는다):
//    RV 계획 생성(옆 도로·방향·예상) → nav-app 계획 받기 → 가짜 TMAP(규칙으로 만든 도로 세계) 탐색·필수 구간 검증
//    → 안 되는 방향 빼기 → 확정 → 합성 GPS 주행(잡음·90초 공백·점프·옆길·역주행) → DriveResult + 주행기록 엑셀
//    → RV 자동 가져오기(결과 먼저·중복·재시작) → GPS 원본 재판정 → 계획별 상태 → 방향 피드백 → 다음 계획
//
//  도로 세계 (강남 근처 좌표, 실제 도로 아님):
//    A 양방향 400m · S A 남쪽 30m 나란한 옆길 · B 북쪽으로만 가는 일방통행 · C1/C2 분리 차도(동쪽행 C1, 15m 북쪽 서쪽행 C2)
//    D 정방향 경로가 큰 우회(8km · U턴 5회)로만 나오는 도로
//  실제 TMAP·실제 휴대폰·실제 Drive 를 대신하지 않는다 — 규칙이 서로 맞물리는지 보는 시험이다.
//
//  실행: node tests/loop-integration-test.js   (nav-app 저장소가 옆에 없으면 건너뜀)
// ══════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const XLSX = require('xlsx');
const CL = require('../src/js/collection-loop.js');
const RouteParser = require('../src/js/parser.js');
const { RouteDatabase } = require('../electron/database.js');
const { AutoImporter } = require('../electron/auto-import.js');

const NAV = path.join(__dirname, '..', '..', 'nav-app');
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n\x1b[36m${t}\x1b[0m`);
if (!fs.existsSync(path.join(NAV, 'index.html')) || !fs.existsSync(path.join(NAV, 'tests', 'collection_plan.test.js'))) {
  console.log('nav-app 저장소가 옆(../nav-app)에 없어 통합 시험을 건너뜁니다.');
  process.exit(0);
}

/* ── 합성 도로 세계 ── */
const LAT0 = 37.5000, LNG0 = 127.0300, kx = 111320 * Math.cos(LAT0 * Math.PI / 180), ky = 110540;
const LL = (x, y) => [Math.round((LAT0 + y / ky) * 1e7) / 1e7, Math.round((LNG0 + x / kx) * 1e7) / 1e7];
const XY = p => [(p[1] - LNG0) * kx, (p[0] - LAT0) * ky];
const line = (pts) => pts.map(([x, y]) => LL(x, y));
const ROADS = {
  A: line([[0, 0], [100, 0], [200, 0], [300, 0], [400, 0]]),
  S: line([[0, -30], [200, -30], [400, -30]]),
  B: line([[700, 0], [700, 100], [700, 200], [700, 300], [700, 400]]),
  C1: line([[0, 300], [100, 300], [200, 300], [300, 300], [400, 300]]),
  C2: line([[460, 315], [300, 315], [200, 315], [100, 315], [-60, 315]]),   // 반대 차도는 C1 보다 조금 길게 (끝에서 끊기지 않게)
  D: line([[0, 600], [100, 600], [200, 600], [300, 600], [400, 600]]),
};
const SEGS = Object.entries(ROADS).map(([id, g]) => ({ id: 'syn:' + id, roadName: '합성' + id, geometry: g, lengthM: 400 }));
const d2 = (a, b) => Math.hypot(XY(a)[0] - XY(b)[0], XY(a)[1] - XY(b)[1]);
const near = (a, b, m) => d2(a, b) <= (m || 3);

/** 진입점 앞 60m 에서 도로 방향으로 들어오는 꺾은 연결 (직선으로 비스듬히 다가와 대상 도로를 거꾸로 스치지 않게) */
function approachTo(s, g, _tag) {
  const [ax, ay] = XY(g[0]), [bx, by] = XY(g[1]), L = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / L, uy = (by - ay) / L;
  if (d2(s, g[0]) < 5) return [];
  const [sx, sy] = XY(s);   // 북쪽으로 멀리 돌아 진입점 남서쪽에서 들어온다 (다른 시험 도로 위를 지나지 않게)
  return [LL(sx, sy + 500), LL(ax - 300, sy + 500), LL(ax - ux * 60 + uy * 60, ay - uy * 60 - ux * 60), LL(ax - ux * 30, ay - uy * 30)];
}
/** 가짜 TMAP — 요청(출발·도착·경유)을 보고 도로 세계 규칙대로 경로를 만든다. 호출은 모두 센다 */
const calls = [];
function fakeTmap(q) {
  const s = [Number(q.get('startY')), Number(q.get('startX'))], e = [Number(q.get('endY')), Number(q.get('endX'))];
  calls.push({ s, e, pass: q.get('passList') || '', opt: q.get('searchOption') });
  const steps = [];
  const via = (...ps) => ps.filter(p => p.length).reduce((a, p) => a.concat(Array.isArray(p[0]) ? p : [p]), []);
  // 경유점이 없는 요청(진입 이동)은 도로 규칙을 쓰지 않는다 — 아래에서 대상 도로를 피해 돌아간다
  for (const id of (q.get('passList') ? ['A', 'B', 'C1', 'D'] : [])) {
    const g = ROADS[id], rev = g.slice().reverse();
    if (near(e, g[g.length - 1])) {   // 형상 순서 방향 요청
      if (id === 'D') {   // 큰 우회: 남쪽으로 3km 갔다가 U턴 5번
        const loop = line([[0, 600], [0, -1500], [-20, -1500], [-20, 600]]);
        for (let k = 0; k < 5; k++) steps.push({ turnType: 14 });
        return { coords: via(s, loop, g, e), steps };
      }
      return { coords: via(s, approachTo(s, g, 'f'), g, e), steps };
    }
    if (near(e, g[0])) {   // 형상 반대 방향 요청
      if (id === 'B') {     // 일방통행(북쪽으로만) — 동쪽으로 돌아 남쪽 끝으로 가서 북쪽으로 B 를 지나고 다시 돌아온다
        const around = line([[700, 400], [900, 400], [900, -50], [700, -50]]);
        const back = line([[700, 400], [900, 400], [900, 0], [700, 0]]);
        return { coords: via(s, around, g, back, e), steps };
      }
      if (id === 'C1') return { coords: via(s, ROADS.C2, e), steps };   // 서쪽행은 반대 차도 C2 로
      return { coords: via(s, approachTo(s, rev, 'b'), rev, e), steps };
    }
  }
  // 진입 이동 등 — 대상 도로 위를 지나지 않게 동쪽 150m 로 돌아간다 (실제 길찾기처럼)
  const [sx, sy] = XY(s), [ex, ey] = XY(e), L = Math.hypot(ex - sx, ey - sy) || 1, px = (ey - sy) / L * 80, py = -(ex - sx) / L * 80;
  return { coords: [s, LL(sx + px, sy + py), LL(ex + px, ey + py), e], steps };
}

/* ── nav-app 함수 (index.html 에서 읽는다 · 샌드박스) ── */
const HTML = fs.readFileSync(path.join(NAV, 'index.html'), 'utf8');
const TEST = fs.readFileSync(path.join(NAV, 'tests', 'collection_plan.test.js'), 'utf8');
const CONSTS = eval(TEST.match(/const CONSTS = (\[[\s\S]*?\]);/)[1]);
const FUNCS = eval(TEST.match(/const FUNCS = (\[[\s\S]*?\]);/)[1]);
const ROUTES = JSON.parse(fs.readFileSync(path.join(NAV, 'routes.json'), 'utf8'));
function extractFunction(name) {
  const m = HTML.match(new RegExp('(async\\s+)?function ' + name + '\\s*\\('));
  let depth = 0;
  for (let i = HTML.indexOf('{', m.index); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++; else if (HTML[i] === '}' && --depth === 0) return HTML.slice(m.index, i + 1);
  }
  throw new Error(name);
}
function extractConst(name) { const m = HTML.match(new RegExp('const ' + name + '\\s*=\\s*([^;]+);')); return 'const ' + name + ' = ' + m[1] + ';'; }
function makePhone(opts) {
  opts = opts || {};
  const storage = opts.storage || new Map(), clock = opts.clock, downloads = [], alerts = [];
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(clock.t); }
  FakeDate.now = () => clock.t; FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC; FakeDate.prototype = RealDate.prototype;
  const sc = { 강남: {} };
  for (const [key, list] of Object.entries(ROUTES.customLegs)) { const i = key.lastIndexOf('-'); if (key.slice(0, i) === '강남') sc.강남[key.slice(i + 1)] = { name: key, legs: list.map(l => Object.assign({}, l)) }; }
  const src = `
    const APP_VER = 'v4.3.0-int';
    const K = { routePackage: 'nav3-route-package', routeDraft: 'nav3-route-draft', collectionPlan: 'nav3-collection-plan',
                driveSession: 'nav3-drive-session', driveResults: 'nav3-drive-results', routeLimits: 'nav3-route-limits' };
    const TMAP = { routes: 'https://apis.openapi.sk.com/tmap/routes?version=1&format=json' };
    const appKey = 'TEST-KEY'; const vehicle = '토레스 9호차', user = '시험';
    const localStorage = { getItem: k => __st.has(k) ? __st.get(k) : null, setItem: (k, v) => __st.set(k, String(v)), removeItem: k => __st.delete(k) };
    ${CONSTS.map(extractConst).join('\n')}
    const SCENARIOS = __sc; const FIXED_ROUTES = {};
    let ACTIVE_PKG = null, restoringCheckpoint = false, routeImportPreview = null, routeMgrBusy = false, managerOpened = 0;
    let CP_STATE = null, cpImportPreview = null, DR_SESSION = null, drLastSaveAt = 0;
    let loc = '강남', scKey = 'a', legs = [], legIdx = 0, isPlaying = false, progressM = 0, routeGeoM = 0, activeRouteLegId = null;
    const APP_MODE = false; const doneSet = new Set();
    function nearestIndex(){} nearestIndex.lastDistance = 5;
    function appPost(){} function toast(){} function alert(t){ __alerts.push(t); }
    function renderRoutePackageBadge(){} function renderRouteManager(){} function renderChips(){}
    function openRouteManager(keep){ managerOpened++; if (keep !== true) routeImportPreview = null; }
    function downloadBlob(text, name){ __downloads.push({ name, text }); }
    function loadScenario(l, k){ loc = l; scKey = k; legs = (SCENARIOS[l][k] || {}).legs || []; legIdx = 0; }
    async function fetch(url, init){
      const q = new URLSearchParams(String(init.body));
      const r = __tmap(q);
      const cs = r.coords, s = cs[0], e = cs[cs.length - 1];
      const feats = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [s[1], s[0]] }, properties: { index: 0, totalDistance: Math.round(cumulativeMeters(cs).pop()), totalTime: Math.round(cumulativeMeters(cs).pop() / 8), turnType: 200, description: '출발' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: cs.map(p => [p[1], p[0]]) }, properties: { index: 1, distance: 100 } }];
      r.steps.forEach((st, i) => feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [cs[1][1], cs[1][0]] }, properties: { index: 2 + i, turnType: st.turnType, description: '유턴' } }));
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e[1], e[0]] }, properties: { index: 99, turnType: 201, description: '도착' } });
      return { ok: true, status: 200, json: async () => ({ features: feats }) };
    }
    ${FUNCS.map(extractFunction).join('\n')}
    this.api = { receiveRoutePackageText, cpApplyImport, cpSearchAll, cpReadiness, cpVisitLegs, cpToggleSkip, cpToggleSkipDir, cpPlanAdjustments, cpEstimate,
      buildPackageFromPlan, validateRoutePackage, activateRoutePackage, verifyPlanPackage, validateMustPass, routeFor, cumulativeMeters, routePackageHash,
      drSync, drOnFix, drOnPause, drFinalize, buildRouteCheckDoc, cpItemStatus, cpEstimate,
      get cp(){ return CP_STATE; }, get legs(){ return legs; }, get session(){ return DR_SESSION; }, get importPreview(){ return routeImportPreview; },
      set legIdx(v){ legIdx = v; }, set playing(v){ isPlaying = v; }, get playing(){ return isPlaying; },
      set progress(v){ activeRouteLegId = v.legId; routeGeoM = v.geoM; progressM = v.m; }, doneSet };
  `;
  const ctx = { __st: storage, __downloads: downloads, __alerts: alerts, __sc: sc, __tmap: fakeTmap,
    Math, Number, Array, isFinite, String, Object, Set, Map, JSON, Date: FakeDate, URLSearchParams, URL, Promise, Uint32Array,
    crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = 123456 + i; return a; } }, console: { warn() {} } };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return Object.assign(ctx.api, { storage, downloads, alerts, clock });
}

/* ── 주행기록 엑셀 (nav-app 모양) ── */
const pad = n => String(n).padStart(2, '0');
const kstClock = ms => new Date(ms + 9 * 3600e3).toISOString().slice(11, 19);
function navAppXlsx(rows) {
  const aoa = [['차량', '토레스 9호차', '입장시각', rows[0].time], [], ['번호', '날짜', '시각', 'GPS위치', '도로종류', '날씨', '시간대', '장소', '교통밀도', '차량속도(km/h)']];
  rows.forEach((r, i) => aoa.push([i + 1, r.date, r.time, `${r.lat.toFixed(7)}, ${r.lng.toFixed(7)}`, '도심', '맑음', '주간', '강남', '(미측정)', '28']));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '주행기록');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

(async () => {
  const DATE = '2026-10-19';
  const T0 = Date.parse(`${DATE}T07:00:00+09:00`);
  const rec = (id, dir, need) => ({ id: `syn:${id}|weekday|morning_peak|daylight|${dir}`, segmentId: 'syn:' + id, displayName: '합성 ' + id, roadName: '합성' + id, parentZone: '강남',
    geometry: ROADS[id], lengthM: 400, direction: { id: dir, label: dir }, condition: { weekdayType: 'weekday', trafficPeriod: 'morning_peak', lightCondition: 'daylight' },
    timeWindow: { start: '07:00', end: '12:00' }, need: { additionalMinutes: need, targetMinutes: 60, targetVisits: 2, passes: 10, passMinutes: 6 }, current: { collectionMinutes: 0, visitCount: 0 }, score: 80 });

  section('1. Route Viewer — 계획 (옆 도로 · 방향 · 반복 · 예상)');
  const plan = CL.buildCollectionPlan({ recommendations: [rec('A', 'both', 3), rec('B', 'both', 3), rec('C1', 'both', 3), rec('D', 'forward', 2)],
    region: '강남', planDate: DATE, window: { start: '07:00', end: '12:00' }, now: T0 - 3600e3, order: 'given', roadSegments: SEGS, collectionSpeedKmh: 30 });
  const itA = plan.items[0], itC = plan.items[2];
  check('반복은 부족분·구간 길이로 (400m · 30km/h ≈ 48초 → 부족 3분이면 4회)', itA.passes === 4 && itA.visits.map(v => v.direction).join() === 'forward,backward,forward,backward',
    `${itA.passes}회 · ${itA.estimate.note}`);
  check('옆 도로를 계획에 담는다 (A 옆길 S · C1 반대 차도 C2)', itA.mustPass.neighbors.length >= 1 && itC.mustPass.neighbors.length >= 1);
  check('방향 가능 여부는 지도로 단정하지 않는다 ("확인 필요")', plan.items.every(it => ['forward', 'backward'].every(d => it.directionPlan.feasibility[d].status === 'needs_check')));

  section('2. nav-app — 계획 받기 · 가짜 TMAP 탐색 · 필수 구간 검증 (TMAP 실제 호출 없음)');
  const clock = { t: T0 - 1800e3 };
  let phone = makePhone({ clock });
  phone.receiveRoutePackageText(JSON.stringify(plan), 'collectionplan.json'); phone.cpApplyImport();
  const r1 = await phone.cpSearchAll();
  const cands = phone.cp.cands;
  if (process.env.DEBUG_INT) Object.entries(cands).forEach(([k, c]) => console.log('CAND', k, c.cause, c.check && JSON.stringify({ cov: c.check.coverage, any: c.check.coverageAny, pass: c.check.passes, nb: c.check.onNeighbor }), JSON.stringify(c.route.coords.slice(0, 4).map(XY).map(p => p.map(Math.round)))));
  const byItemDir = (item, dir) => phone.cpVisitLegs(phone.cp).filter(v => v.item.itemId === item && v.direction === dir && v.kind === 'collect').map(v => cands[v.legId]);
  const id = n => plan.items.find(it => it.segmentId === 'syn:' + n).itemId;
  check('양방향 도로 A — 두 방향 모두 통과', byItemDir(id('A'), 'forward').concat(byItemDir(id('A'), 'backward')).every(c => c && c.check.ok));
  check('일방통행 B — 형상 반대 방향은 "방향 반대"(반대로만 지남) · 재시도 없이 1번만 호출', byItemDir(id('B'), 'backward').every(c => c && c.cause === 'direction_unreachable' && c.attempts === 1)
    && byItemDir(id('B'), 'forward').every(c => c && c.check.ok), byItemDir(id('B'), 'backward').map(c => c && c.cause).join());
  check('분리 차도 C1 — 서쪽행은 반대 차도 C2 로만 → "옆 도로·반대 차도" · 재시도 없음', byItemDir(id('C1'), 'backward').every(c => c && c.cause === 'parallel_road' && c.attempts === 1),
    byItemDir(id('C1'), 'backward').map(c => c && `${c.cause}·옆 ${c.check.onNeighbor}`).join());
  check('과도한 우회 D — 필수 구간은 지나도 "우회가 너무 큼"으로 확정 막음', byItemDir(id('D'), 'forward').every(c => c && c.check.ok && c.routeCheck.level === 'block' && c.cause === 'route_blocked'),
    byItemDir(id('D'), 'forward').map(c => c && c.routeCheck.reasons.join()).join(' / '));
  check('이 상태로는 확정할 수 없다 (자동 확정·검증 우회 없음)', !phone.cpReadiness(phone.cp).ok);
  let threw = ''; try { phone.buildPackageFromPlan(phone.cp, new Date(clock.t)); } catch (e) { threw = e.message; }
  check('확정 함수도 거부한다', /필수 구간 검증|우회/.test(threw), threw);
  const callsBefore = calls.length;
  await phone.cpSearchAll();
  const again = calls.slice(callsBefore);
  const againDead = again.filter(c => c.pass && (near(c.e, ROADS.B[0]) || near(c.e, ROADS.C1[0])));
  check('전체 탐색을 다시 눌러도 TMAP 을 다시 부르지 않는다 (통과한 방문 · 방향이 안 되는 방문 · 우회 막힘 모두 — 재탐색 버튼으로만)', againDead.length === 0 && again.length === 0,
    `다시 부른 ${again.length}회 (방향이 안 되는 방문 ${againDead.length}회)`);

  // 확정·주행 전에도 탐색 결과를 Route Viewer 로 보낼 수 있다 — nav-app 이 만든 파일을 RV 가 그대로 검증·반영
  const rcDoc = phone.buildRouteCheckDoc(phone.cp, new Date(clock.t));
  const rcv = CL.validateRouteCheck(JSON.stringify(rcDoc));
  const rcDb = new RouteDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-int-rc-')), 'rv.db'));
  rcDb.saveRouteCheck(JSON.stringify(rcDoc));
  const firstPlan = CL.buildCollectionPlan({ recommendations: [rec('A', 'both', 3), rec('B', 'both', 3), rec('C1', 'both', 3)], region: '강남', planDate: DATE, now: T0, order: 'given',
    roadSegments: SEGS, collectionSpeedKmh: 30, directionFeedback: rcDb.listDirectionFeedback() });
  rcDb.close();
  const fA = firstPlan.items.find(it => it.segmentId === 'syn:A'), fB = firstPlan.items.find(it => it.segmentId === 'syn:B'), fC = firstPlan.items.find(it => it.segmentId === 'syn:C1');
  check('탐색 결과 파일(확정·주행 전) → RV 검증 통과 → 다음 계획: A 두 방향 "TMAP 경로 확인", B·C1 형상 반대 제외',
    rcv.ok && fA.directionPlan.feasibility.forward.status === 'tmap_ok' && fA.directionPlan.feasibility.backward.status === 'tmap_ok' && fA.feasibility.status !== 'direction_unknown'
      && fB.directionPlan.excluded.length === 1 && fC.directionPlan.excluded.length === 1,
    `탐색 결과 ${rcDoc.directionChecks.length}건 · A ${fA.feasibility.label} · B 제외 ${fB.directionPlan.excluded.map(e => e.direction)} · C1 제외 ${fC.directionPlan.excluded.map(e => e.direction)}`);
  const stD = phone.cpItemStatus(phone.cp, id('D'), phone.cpEstimate(phone.cp)), stA = phone.cpItemStatus(phone.cp, id('A'), phone.cpEstimate(phone.cp));
  check('nav-app 항목 상태 — 우회 막힘 D 는 "경로 탐색 실패", A 는 실패 아님', stD.status === 'route_failed' && stA.status !== 'route_failed', `D ${stD.label} · A ${stA.label}`);

  section('3. nav-app — 안 되는 방향·항목 빼고 확정 · 주행 (합성 GPS)');
  phone.cpToggleSkipDir(id('B'), 'backward'); phone.cpToggleSkipDir(id('C1'), 'backward'); phone.cpToggleSkip(id('D'));
  await phone.cpSearchAll();
  check('남은 방향만으로 확정 가능', phone.cpReadiness(phone.cp).ok, JSON.stringify(phone.cpReadiness(phone.cp).unverified));
  const adj = phone.cpPlanAdjustments(phone.cp);
  check('뺀 방향과 원인(TMAP 검증)을 남긴다', adj.skippedDirections.some(s => s.segmentId === 'syn:B' && s.direction === 'backward' && s.cause === 'direction_unreachable')
    && adj.skippedDirections.some(s => s.segmentId === 'syn:C1' && s.direction === 'backward' && s.cause === 'parallel_road') && adj.skippedItems.includes(id('D')));
  const pkg = phone.buildPackageFromPlan(phone.cp, new Date(clock.t));
  const pv = phone.validateRoutePackage(pkg, new Date(clock.t));
  check('받는 휴대폰 재검증 — 이 패키지는 다른 휴대폰에서도 통과', phone.verifyPlanPackage(pkg).ok);
  phone.activateRoutePackage(pv, { select: true, silent: true });
  clock.t = T0 + 60e3;
  let seed = 9; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const rows = [];
  const fix = (lat, lng) => { clock.t += 1000; rows.push({ date: DATE, time: kstClock(clock.t), lat, lng }); phone.drOnFix(lat, lng, 5); };
  phone.playing = true; phone.drSync();
  const legsN = phone.legs.length;
  for (let i = 0; i < legsN; i++) {
    phone.legIdx = i; phone.drSync();
    const r = phone.routeFor(phone.legs[i].id), cum = phone.cumulativeMeters(r.coords), total = cum[cum.length - 1];
    let k = 0;
    for (let m = 0; m <= total; m += 8) {
      if (i === 1 && Math.abs(m - total / 2) < 4) clock.t += 90e3;                       // 90초 측위 끊김
      while (k < r.coords.length - 2 && cum[k + 1] < m) k++;
      const a = r.coords[k], b = r.coords[k + 1], t = Math.min(1, (m - cum[k]) / ((cum[k + 1] - cum[k]) || 1));
      phone.progress = { legId: phone.legs[i].id, geoM: total, m };
      if (i === 2 && Math.abs(m - total / 2) < 8) { clock.t += 1000; rows.push({ date: DATE, time: kstClock(clock.t), lat: a[0] + 0.01, lng: a[1] }); }   // 측위 튐
      fix(a[0] + (b[0] - a[0]) * t + rnd() * 6 / ky, a[1] + (b[1] - a[1]) * t + rnd() * 6 / kx);
    }
    phone.doneSet.add(i); phone.drSync();
  }
  // 덤 주행: 옆길 S 를 서→동 · 일방통행 B 를 남쪽으로 역주행(빼 둔 방향)
  for (const g of [ROADS.S, ROADS.B.slice().reverse()]) {
    const cum = phone.cumulativeMeters(g), total = cum[cum.length - 1];
    let k = 0;
    for (let m = 0; m <= total; m += 8) { while (k < g.length - 2 && cum[k + 1] < m) k++; const a = g[k], b = g[k + 1], t = Math.min(1, (m - cum[k]) / ((cum[k + 1] - cum[k]) || 1));
      clock.t += 1000; rows.push({ date: DATE, time: kstClock(clock.t), lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t }); }
  }
  const result = phone.session ? phone.drFinalize('manual_stop') : JSON.parse(phone.storage.get('nav3-drive-results'))[0];
  if (process.env.DEBUG_INT) {
    const sec = t => { const [h, m, x] = t.split(':').map(Number); return h * 3600 + m * 60 + x; };
    for (let i = 1; i < rows.length; i++) { const dt = sec(rows[i].time) - sec(rows[i - 1].time); const dd = d2([rows[i].lat, rows[i].lng], [rows[i - 1].lat, rows[i - 1].lng]);
      if (dt > 0 && dd / dt > 50) console.log('JUMP', i, rows[i - 1].time, rows[i].time, Math.round(dd), 'm'); if (dt <= 0) console.log('DT0', i, rows[i].time); }
    phone.legs.forEach((l, i) => { const r = phone.routeFor(l.id); console.log('LEG', i, l.id, r.coords.length, Math.round(phone.cumulativeMeters(r.coords).pop()), JSON.stringify(r.coords.slice(0, 3).map(XY).map(p => p.map(Math.round)))); });
  }
  check('주행 결과에 계획 ID·세션 ID·뺀 방향이 담긴다', result.plan.planId === plan.planId && /^ds-/.test(result.sessionId) && result.planAdjustments && result.planAdjustments.skippedDirections.length === 2,
    `${result.endReason} · ${result.legs.filter(l => l.status === 'completed').length}/${result.legs.length}`);
  const resultText = JSON.stringify(result);

  section('4. Route Viewer — 자동 가져오기(결과 먼저 · 엑셀 · 중복 · 재시작) · GPS 원본 재판정');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-int-')), 'rv.db');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-int-drive-'));
  let db = new RouteDatabase(dbPath);
  db.saveCollectionPlan(plan); db.markPlanExported(plan.planId, plan.planVersion, 'collectionplan.json');
  let clk = Date.now() + 60000;
  let ai = new AutoImporter({ db, parseBuffer: RouteParser.parseBuffer, now: () => clk, settleMs: 0, minAgeMs: 0 });
  await ai.setFolder(folder); await ai.confirmInitial('all');
  fs.writeFileSync(path.join(folder, `driveresult_${DATE}_9호차_${result.sessionId}.json`), resultText);
  clk = Date.now() + 120000; await ai.runOnce('int');
  const st1 = db.listPlanStatuses().plans[0];
  check('결과만 오면 "결과 수신 · GPS 미검증" — 달성 0', st1.stage === 'gps_unverified' && db.listDriveResults()[0].evaluation.totals.achieved === 0, st1.label);
  fs.writeFileSync(path.join(folder, `주행기록_${DATE}_1200.xlsx`), navAppXlsx(rows));
  clk = Date.now() + 180000; await ai.runOnce('int');
  fs.writeFileSync(path.join(folder, 'driveresult_again.json'), resultText);
  fs.writeFileSync(path.join(folder, `주행기록_${DATE}_1201.xlsx`), navAppXlsx(rows));
  clk = Date.now() + 240000; await ai.runOnce('int');
  const nRec = db.db.get('SELECT COUNT(*) AS n FROM driving_records').n, nRes = db.listDriveResults({ includeSuperseded: true }).length;
  db.close();
  db = new RouteDatabase(dbPath);
  ai = new AutoImporter({ db, parseBuffer: RouteParser.parseBuffer, now: () => clk, settleMs: 0, minAgeMs: 0 });
  clk = Date.now() + 300000; await ai.runOnce('int');
  check('같은 파일 다시·이름 바꿔·재시작 후에도 결과 1건 · GPS 기록 그대로', nRes === 1 && db.listDriveResults({ includeSuperseded: true }).length === 1
    && db.db.get('SELECT COUNT(*) AS n FROM driving_records').n === nRec && nRec === rows.length, `기록 ${nRec}건`);
  const row = db.listDriveResults()[0], ev = row.evaluation;
  if (process.env.DEBUG_INT) {
    const recs = db.getRecordsForResult(result);
    let prev = null, j = 0;
    recs.forEach(r => { if (prev) { const tt = x => { const [h, m, q] = x.split(':').map(Number); return h * 3600 + m * 60 + q; }; const dt = tt(r.time) - tt(prev.time);
      const dd = d2([r.lat, r.lng], [prev.lat, prev.lng]); if (dt > 0 && dd / dt > 50) { j++; if (j < 25) console.log('RVJUMP', prev.time, r.time, Math.round(dd), prev.lat, prev.lng, r.lat, r.lng); return; } } prev = r; });
    console.log('RV records', recs.length, 'jumps', j);
  }
  const evA = ev.items.find(x => x.itemId === id('A')), evB = ev.items.find(x => x.itemId === id('B')), evC = ev.items.find(x => x.itemId === id('C1')), evD = ev.items.find(x => x.itemId === id('D'));
  check('ID 유지 — 계획·패키지·세션이 결과·RV 기록까지', row.planId === plan.planId && row.sessionId === result.sessionId && row.packageId === pkg.packageId);
  check('판정 근거 = 계획에 담긴 옆 도로 (nav-app 과 같은 입력)', ev.roadIndex === 'plan_neighbors' && ev.passJudge === 'nav-app-pass-v1');
  check('A: 90초 공백이 낀 방문은 통과로 세지 않고(일부) · 옆길 S 주행은 A 수집이 아니다', evA.passCount === itA.passes - 1 && evA.partialTraversals >= 1,
    `통과 ${evA.passCount}/${evA.plannedPasses} · 일부 ${evA.partialTraversals} · ${evA.status}`);
  check('B: 뺀 방향(역주행)은 계획 통과로 세지 않는다 — 정방향 방문만', evB.plannedPasses === plan.items[1].visits.filter(v => v.direction === 'forward').length && evB.passCount === evB.plannedPasses,
    `통과 ${evB.passCount}/${evB.plannedPasses} · 방향별 ${JSON.stringify(evB.coverageByDirection)}`);
  check('C1: 반대 차도 C2 를 달린 기록은 C1 수집이 아니다', evC.coverageByDirection.backward === 0, JSON.stringify(evC.coverageByDirection));
  check('D: 뺀 항목은 계획 0회 · 주행 안 함', evD.plannedPasses === 0 && evD.status === 'not_driven', `${evD.status}`);
  check('목표 달성은 GPS 원본으로만 — nav-app 보고(경로 따라감)와 따로 표시', ev.items.every(x => x.routeFollowed && /판정에 쓰지 않음/.test(x.routeFollowed.note)));
  const stEnd = db.listPlanStatuses().plans[0];
  check('계획별 상태: GPS 검증 완료 · 전달은 결과로 확인', stEnd.stage === 'gps_verified' && stEnd.steps.find(s => s.key === 'delivered').state === 'done',
    `${stEnd.label} · GPS ${ev.gpsStatus} 점프 ${ev.gps.jumps} 유효 ${ev.gps.validRatio}%`);

  section('5. 다음 계획 — nav-app 방향 피드백 반영');
  const fb = db.listDirectionFeedback();
  const next = CL.buildCollectionPlan({ recommendations: [rec('B', 'both', 3), rec('C1', 'both', 3)], region: '강남', planDate: DATE, now: T0, order: 'given', roadSegments: SEGS, directionFeedback: fb });
  check('다음 계획은 TMAP 이 안 된 방향(B·C1 형상 반대)을 빼고 이유를 보여 준다', next.items.every(it => it.visits.every(v => v.direction === 'forward') && it.directionPlan.excluded.length === 1),
    next.items.map(it => it.directionPlan.excluded[0] && it.directionPlan.excluded[0].reason).join(' / '));
  check('TMAP 실제 호출 없음 (가짜 TMAP 만)', calls.length > 0, `가짜 TMAP ${calls.length}회`);
  db.close();

  console.log(`\n  통과 ${passed} / 실패 ${failed}`);
  if (failed) { console.log('  실패: ' + failures.join(' · ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
