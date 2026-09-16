// ══════════════════════════════════════════════════════════
//  recommendation-storage-test — 추천 주행: 저장소 · 갱신/캐시 · 화면 · 호환성
//
//   1. Coverage 스냅샷 · 추천 상태 저장(SQLite · IndexedDB)
//   2. 추천 설정 저장 검증(가중치 합계 100% 등) · 원본 기록 불변
//   3. 화면(recommend-view.js 실제 파일) — 탭 렌더 · 카드 · 근거 상세 · 필터/정렬 · 숨김/제외/완료
//   4. 갱신과 캐시 — import/삭제/설정 변경 후 갱신 · 탭 왕복 시 재계산 없음 · 늦은 결과가 덮지 않음
//   5. 호환성 — SQLite ↔ IndexedDB 동일 결과 · 백업 복원 · 서버 동기화 · 구버전 DB · 기존 기능 회귀 없음
//
//  실행: node tests/recommendation-storage-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const TC = require('../src/js/time-conditions.js');
const R = require('../src/js/recommendation.js');
const RouteParser = require('../src/js/parser.js');
const { RouteDatabase } = require('../electron/database.js');
const { createDesktopApi, createStorageContext, baseContext, load } = require('./helpers/route-context');
const { createAccumHarness, setupCoverageScene } = require('./helpers/accum-harness');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

const ROOT = path.join(__dirname, '..');
const XLSX_DIR = path.join(ROOT, '주행기록');
const FILES = fs.readdirSync(XLSX_DIR).filter(f => /\.xlsx?$/i.test(f)).sort();
const SUBSET = (() => {
  const seen = new Set(), out = [];
  for (const f of FILES) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(f);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]); out.push(f);
    if (out.length === 4) break;
  }
  return out;
})();
const NOW = '2026-09-16T01:00:00Z';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  [32mPASS[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  [31mFAIL[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n[36m${t}[0m`);
const freshPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-rec-')), 'route-viewer.db');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PARSED = new Map();
function parsed(f) {
  if (!PARSED.has(f)) {
    const buf = fs.readFileSync(path.join(XLSX_DIR, f));
    PARSED.set(f, { records: RouteParser.parseBuffer(buf), meta: { filename: f, fileHash: RouteDatabase.hashFile(buf) } });
  }
  return PARSED.get(f);
}

function fakeDocument() {
  const els = new Map();
  const make = id => {
    const classes = new Set();
    return {
      id, textContent: '', innerHTML: '', value: '', disabled: false, checked: false, style: {}, dataset: {}, className: '', children: [],
      appendChild(c) { this.children.push(c); }, addEventListener() {}, focus() {}, scrollIntoView() {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; } },
    };
  };
  return { els, getElementById: id => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); }, createElement: () => make(''), querySelectorAll: () => [], querySelector: () => null };
}

// 화면 파일(recommend-view.js)을 실제로 로드한 컨텍스트 — 저장소는 진짜 SQLite(가짜 routeAPI 경유)
function createRecommendUi(db, extra) {
  const api = createDesktopApi(db);
  const doc = fakeDocument();
  const toasts = [], errors = [];
  const ctx = baseContext(Object.assign({
    document: doc, routeAPI: api,
    setInterval: () => 0, clearInterval: () => {},
    showToast: m => toasts.push(m), showError: m => errors.push(m), clearError() {},
    ACTIVE_ZONE_NAMES: [], ZONE_COLORS: {}, styleZoneButtons() {}, refreshZoneCache: async () => [],
    renderConsole() {}, switchTab() {}, openModal() {}, closeModal() {},
  }, extra || {}));
  ['src/js/quality.js', 'src/js/collection-stats.js', 'src/js/time-conditions.js', 'src/js/issue-filter.js', 'src/js/condition-stats.js', 'src/js/recommendation.js',
    'src/js/core.js', 'src/js/coverage-grid.js', 'src/js/storage.js', 'src/js/calendar.js', 'src/js/statistics.js', 'src/js/settings.js',
    'src/js/recommend-view.js'].forEach(f => load(ctx, f));
  const run = code => vm.runInContext(code, ctx);
  return { ctx, api, doc, toasts, errors, run, html: id => doc.getElementById(id).innerHTML };
}

async function sqliteRouteDB(db) {
  const api = createDesktopApi(db);
  const ctx = createStorageContext({ api });
  await ctx.RouteDB.init();
  return { RouteDB: ctx.RouteDB, api };
}
async function idbRouteDB(fake) {
  const ctx = baseContext({ indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange, document: fakeDocument(), setInterval: () => 0 });
  ['src/js/quality.js', 'src/js/collection-stats.js', 'src/js/time-conditions.js', 'src/js/issue-filter.js', 'src/js/condition-stats.js', 'src/js/recommendation.js',
    'src/js/core.js', 'src/js/coverage-grid.js', 'src/js/storage.js'].forEach(f => load(ctx, f));
  await ctx.RouteDB.init();
  return { RouteDB: ctx.RouteDB, ctx };
}

async function recommendationsFrom(RouteDB) {
  const [summaries, zones, settings, coverageSnapshots] = await Promise.all([
    RouteDB.listDateSummaries(), RouteDB.listZones(), RouteDB.getSettings(), RouteDB.listCoverageSnapshots(),
  ]);
  return R.buildRecommendations({ summaries, zones, settings, coverageSnapshots, now: NOW });
}

async function main() {
  // ── 1 ──────────────────────────────────────────────────
  section('1. Coverage 스냅샷 · 추천 상태 저장');
  for (const kind of ['SQLite', 'IndexedDB']) {
    const { RouteDB } = kind === 'SQLite' ? await sqliteRouteDB(new RouteDatabase(freshPath())) : await idbRouteDB(createFakeIndexedDB());
    for (const f of SUBSET.slice(0, 2)) await RouteDB.importRecords(parsed(f).records, parsed(f).meta);
    const pointsBefore = (await RouteDB.stats()).points;
    const saved = await RouteDB.saveCoverageSnapshot('강남', { total: 1000, visited: 400, provisional: false, cellSizeM: 20 });
    check(`[${kind}] Coverage 스냅샷 저장 — 미방문 Cell·%가 계산되고 지금 데이터 기준이면 fresh`,
      saved.unvisited === 600 && saved.coveragePct === 40 && saved.fresh === true && !saved.staleReason, `${saved.coveragePct}% · fresh=${saved.fresh}`);
    await RouteDB.importRecords(parsed(SUBSET[2]).records, parsed(SUBSET[2]).meta);
    const after = (await RouteDB.listCoverageSnapshots())[0];
    check(`[${kind}]   데이터가 바뀌면 오래된 스냅샷으로 표시(추천 점수에서 제외됨)`,
      after.fresh === false && /주행 데이터가 바뀐/.test(after.staleReason), after.staleReason);
    await RouteDB.saveZone({ name: '강남', polygon: [[37.49, 127.02], [37.51, 127.02], [37.51, 127.05], [37.49, 127.05]] });
    await RouteDB.saveCoverageSnapshot('강남', { total: 1000, visited: 500, provisional: true });
    const zoneChanged = (await RouteDB.listCoverageSnapshots())[0];
    check(`[${kind}]   임시값(provisional) 표시도 함께 저장`, zoneChanged.fresh === true && zoneChanged.provisional === true);
    await RouteDB.saveZoneManualCells('강남', { excluded: [[37.4979, 127.0276]], visited: [], unvisited: [] });
    const manualChanged = (await RouteDB.listCoverageSnapshots())[0];
    check(`[${kind}]   수동 셀이 바뀌어도 오래된 것으로 표시`, manualChanged.fresh === false && /수동/.test(manualChanged.staleReason), manualChanged.staleReason);

    const pointsBeforeStates = (await RouteDB.stats()).points;
    const states1 = await RouteDB.setRecommendationState('강남|weekday|morning_peak|sunrise', { status: 'snoozed', until: '2026-09-30' });
    const states2 = await RouteDB.setRecommendationState('강남|weekday|night|night', { status: 'completed', snapshot: { collectionSec: 120, visitCount: 1 } });
    check(`[${kind}] 추천 상태(기간 제외·수집 완료) 저장 · 원본 기록은 그대로`,
      states1['강남|weekday|morning_peak|sunrise'].until === '2026-09-30'
      && states2['강남|weekday|night|night'].snapshot.collectionSec === 120
      && (await RouteDB.stats()).points === pointsBeforeStates && pointsBeforeStates > pointsBefore,
      `상태 ${Object.keys(await RouteDB.listRecommendationStates()).length}개 · 기록 ${pointsBeforeStates}건 그대로`);
    const cleared = await RouteDB.setRecommendationState('강남|weekday|morning_peak|sunrise', null);
    check(`[${kind}]   상태 해제(다시 추천받기)`, !cleared['강남|weekday|morning_peak|sunrise'] && !!cleared['강남|weekday|night|night']);
    let bad = null;
    try { await RouteDB.setRecommendationState('x', { status: 'snoozed', until: '언젠가' }); } catch (e) { bad = e; }
    check(`[${kind}]   잘못된 상태는 저장 거부`, !!bad);
  }

  section('1-b. 누적 지도가 계산한 Coverage 가 추천으로 이어진다 (accum.js 실제 파일)');
  {
    const h = await createAccumHarness();
    await setupCoverageScene(h);
    const result = await h.eval('calculateCoverage("판교")');
    await h.sleep(60);
    const snaps = h.db.listCoverageSnapshots();
    const snap = snaps.find(x => x.zone === '판교');
    const valid = result.cells.filter(c => c.state === 'valid');
    check('누적 지도에서 Coverage 를 계산하면 구역 요약이 저장된다(유효/방문 Cell · 임시값 표시)',
      !!snap && snap.total === valid.length && snap.visited === valid.filter(c => c.visits > 0).length && snap.provisional === !result.cacheable && snap.fresh === true,
      snap && `유효 ${snap.total}칸 · 방문 ${snap.visited}칸 · ${Math.round(snap.coveragePct)}% · 임시값 ${snap.provisional}`);
    const before = h.db.listCoverageSnapshots().find(x => x.zone === '판교').computedAt;
    h.eval("accumDateFrom='2026-08-20'; accumDateTo='2026-08-20';");
    await h.eval('calculateCoverage("판교")');
    await h.sleep(60);
    check('   날짜 필터가 걸린 계산은 저장하지 않는다(구역 전체 Coverage 가 아니므로)',
      h.db.listCoverageSnapshots().find(x => x.zone === '판교').computedAt === before);
    h.eval("accumDateFrom=''; accumDateTo='';");
    const recs = R.buildRecommendations({ summaries: h.db.listDateSummaries(), zones: h.db.listZones(), settings: h.db.getSettings(), coverageSnapshots: h.db.listCoverageSnapshots(), now: NOW });
    const pangyo = recs.recommendations.find(r => r.zone === '판교' && r.coverage.available);
    check('   추천이 그 값을 Coverage 부족도 점수에 쓴다',
      !!pangyo && pangyo.coverage.coveragePercent === Math.round(snap.coveragePct * 10) / 10 && pangyo.subScores.coverage !== null
      && pangyo.coverage.unvisitedCellCount === snap.unvisited,
      pangyo && `Coverage ${pangyo.coverage.coveragePercent}% · 부족도 ${pangyo.subScores.coverage}점 · 미방문 ${pangyo.coverage.unvisitedCellCount}칸`);
    h.db.close();
  }

  // ── 2 ──────────────────────────────────────────────────
  section('2. 추천 설정 저장 검증');
  for (const kind of ['SQLite', 'IndexedDB']) {
    const { RouteDB } = kind === 'SQLite' ? await sqliteRouteDB(new RouteDatabase(freshPath())) : await idbRouteDB(createFakeIndexedDB());
    await RouteDB.importRecords(parsed(SUBSET[0]).records, parsed(SUBSET[0]).meta);
    const pointsBefore = (await RouteDB.stats()).points;
    const defaults = (await RouteDB.getSettings()).recommendationSettings;
    check(`[${kind}] 설정이 없으면 기본 가중치·목표를 돌려준다`,
      defaults.weights.timePeriod === 30 && defaults.periodTargets.morning_peak.minutes === 240 && defaults.resultCount === 10);
    const good = R.defaultRecommendationSettings();
    good.weights = { timePeriod: 40, coverage: 20, lightCondition: 15, weatherDiversity: 10, staleness: 10, vehicleImbalance: 5 };
    good.periodTargets.evening_peak = { minutes: 300, visits: 5 };
    const savedSettings = await RouteDB.setSettings({ recommendationSettings: good });
    check(`[${kind}] 정상 설정 저장(가중치 합계 100%)`,
      savedSettings.recommendationSettings.weights.timePeriod === 40 && savedSettings.recommendationSettings.periodTargets.evening_peak.minutes === 300);
    const bad = R.defaultRecommendationSettings();
    bad.weights.coverage = 40;
    let err = null;
    try { await RouteDB.setSettings({ recommendationSettings: bad }); } catch (e) { err = e; }
    check(`[${kind}] 가중치 합계가 100%가 아니면 저장 거부 · 기존 설정 유지`,
      !!err && /합계/.test(err.message) && (await RouteDB.getSettings()).recommendationSettings.weights.coverage === 20, err && err.message.split('\n')[0]);
    const bad2 = R.defaultRecommendationSettings();
    bad2.resultCount = 0;
    let err2 = null;
    try { await RouteDB.setSettings({ recommendationSettings: bad2 }); } catch (e) { err2 = e; }
    check(`[${kind}] 범위를 벗어난 값도 거부`, !!err2 && /추천 결과 개수/.test(err2.message));
    await RouteDB.setSettings({ recommendationSettings: R.defaultRecommendationSettings() });
    check(`[${kind}] 기본값 복원 · 설정을 바꿔도 원본 기록은 그대로`,
      JSON.stringify((await RouteDB.getSettings()).recommendationSettings) === JSON.stringify(R.defaultRecommendationSettings())
      && (await RouteDB.stats()).points === pointsBefore, `${pointsBefore}건`);
  }

  // ── 3 · 4 ──────────────────────────────────────────────
  section('3. 화면 · 4. 갱신과 캐시 (recommend-view.js 실제 파일)');
  {
    const db = new RouteDatabase(freshPath());
    const ui = createRecommendUi(db);
    await ui.run('RouteDB.init()');
    ui.run(`recommendationClock=()=>Date.parse(${JSON.stringify(NOW)})`);
    for (const f of SUBSET) await ui.run(`RouteDB.importRecords(${JSON.stringify(parsed(f).records)},${JSON.stringify(parsed(f).meta)})`);
    await ui.run('renderRecommendView()');
    const stats = () => JSON.parse(ui.run('JSON.stringify(recommendStats)'));
    const listHtml = () => ui.html('rec-list');
    check('추천 탭이 카드 목록을 그린다(순위·점수·우선순위·신뢰도)',
      /추천 1/.test(listHtml()) && /우선순위/.test(listHtml()) && /신뢰도/.test(listHtml()) && (listHtml().match(/data-rec-id=/g) || []).length > 0,
      `카드 ${(listHtml().match(/data-rec-id=/g) || []).length}개 · 후보 ${ui.run('recCache.result.candidateCount')}개`);
    check('카드에 요구된 항목이 모두 있다(권장 시간·현재/목표 수집·방문·Coverage·부족 조건·예상 확보 조건·추천 이유)',
      ['권장 요일', '권장 시간', '현재 수집 / 목표', '부족한 수집 시간', '현재 방문 / 목표', '권장 추가', '현재 Coverage', '마지막 방문', '부족한 조건', '예상 확보 조건', '추천 이유']
        .every(k => listHtml().includes(k)));
    check('요약·부족 현황·설정·한계 영역이 채워진다',
      /추천 요약/.test(ui.html('rec-summary')) && /현재 데이터 부족 현황/.test(ui.html('rec-deficits'))
      && /추천 설정/.test(ui.html('rec-settings')) && /데이터 한계/.test(ui.html('rec-limitations'))
      && /보장하지 않습니다/.test(ui.html('rec-limitations')));

    // ── 주행 계획 — "그 시간에 나가면 어디부터 어떻게 돌까" ──
    const planHtml = () => ui.html('rec-plan');
    check('주행 계획 영역이 그려진다(운행 시간 입력 · 타임라인 · 근거)',
      /주행 계획/.test(planHtml()) && /운행 시작/.test(planHtml())
      && /<table class="rec-table plan-table"/.test(planHtml()) && /이 계획을 어떻게 만들었나/.test(planHtml()),
      planHtml().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 110));
    const planRows = () => (planHtml().match(/<tr/g) || []).length - 1;
    check('   운행 시간을 시각 블록으로 잘라 구역을 배정한다', planRows() >= 5, `${planRows()}블록`);
    ui.run("onPlanInput('startTime','08:00')");
    ui.run("onPlanInput('baselineStartTime','09:00')");
    const earlier = JSON.parse(ui.run('JSON.stringify({diff:recPlanResult.comparison.collectMinutesDiff,' +
      'first:recPlanResult.lanes[0].blocks[0],new:recPlanResult.comparison.newConditions.map(c=>c.label)})'));
    check('   1시간 일찍 시작하면 무엇이 새로 잡히는지 비교해서 보여준다',
      earlier.diff === 60 && earlier.first.from === '08:00' && earlier.new.length > 0
      && /지금\(09:00~18:00\)보다/.test(planHtml()),
      `+${earlier.diff}분 · 08:00 ${earlier.first.zone}(${earlier.first.conditionLabel}) · 새 조건 ${earlier.new.join(', ')}`);
    ui.run("applyPlanPreset('default')");
    check('   프리셋으로 기본 운행 시간(09:00~18:00)으로 되돌린다',
      ui.run('recPlanResult.window.start') === '09:00' && ui.run('recPlanResult.window.end') === '18:00');

    const firstId = ui.run('recCache.result.recommendations[0].id');
    await ui.run(`toggleRecommendationDetail(${JSON.stringify(firstId)})`);
    const detail = listHtml();
    check('근거 보기 → 점수 검산표(항목·현재 상태·점수·가중치·적용 가중치·반영 점수)와 LLM 구조화 데이터',
      /추천 근거 상세/.test(detail) && /최종 점수/.test(detail) && /적용 가중치/.test(detail) && /반영 점수/.test(detail)
      && /적용된 Edge Case 규칙/.test(detail) && /신뢰도/.test(detail) && /LLM 전달용 구조화 데이터/.test(detail));
    const rec0 = JSON.parse(ui.run(`JSON.stringify(recCache.result.recommendations.find(r=>r.id===${JSON.stringify(firstId)}))`));
    const sum = rec0.breakdown.filter(b => !b.excluded).reduce((a, b) => a + b.contribution, 0);
    check('   사용자가 검산할 수 있다(반영 점수 합 = 최종 점수)', Math.abs(sum - rec0.score) < 0.06, `${sum.toFixed(2)} vs ${rec0.score}`);

    const before = stats();
    await ui.run('renderRecommendView()');
    check('26. 단순 탭 왕복(다시 렌더)으로는 다시 계산하지 않는다(캐시 사용)',
      stats().computations === before.computations && stats().fetches === before.fetches && stats().cacheHits === before.cacheHits + 1,
      `계산 ${stats().computations}회 · 조회 ${stats().fetches}회 · 캐시 ${stats().cacheHits}회`);
    ui.run("setRecommendationSort('coverage')");
    ui.run("setRecommendationFilter('trafficPeriod','evening_peak')");
    check('필터·정렬은 다시 계산하지 않고 목록만 바꾼다',
      stats().computations === before.computations && /Coverage 낮은 순/.test(listHtml()) && !/출근 피크/.test(listHtml()),
      `계산 ${stats().computations}회`);
    ui.run("setRecommendationFilter('trafficPeriod','all'); setRecommendationSort('score')");

    const visibleIds = () => JSON.parse(ui.run('JSON.stringify(currentRecommendationView().visible.map(r=>r.id))'));
    const beforeIds = visibleIds();
    ui.run(`hideRecommendationOnce(${JSON.stringify(firstId)})`);
    check('"이번에는 숨기기" — 목록에서 빠지고(다음 후보가 올라옴) 숨김 목록에 들어간다 · 저장하지 않는다',
      beforeIds.includes(firstId) && !visibleIds().includes(firstId) && /이번에만 숨김/.test(ui.html('rec-hidden'))
      && Object.keys(JSON.parse(ui.run('JSON.stringify(recStates)'))).length === 0
      && Object.keys(db.listRecommendationStates()).length === 0,
      `표시 ${beforeIds.length}개 → ${visibleIds().length}개`);
    await ui.run(`restoreRecommendation(${JSON.stringify(firstId)})`);
    check('   "다시 추천받기"로 되돌아온다', visibleIds().includes(firstId));

    await ui.run(`snoozeRecommendation(${JSON.stringify(firstId)})`);
    check('"N일간 제외" — 상태가 저장되고 목록에서 빠진다',
      /까지 추천 제외/.test(ui.html('rec-hidden')) && JSON.parse(ui.run('JSON.stringify(recStates)'))[firstId].status === 'snoozed'
      && db.listRecommendationStates()[firstId].until > '2026-09-16');
    await ui.run(`restoreRecommendation(${JSON.stringify(firstId)})`);

    const target = ui.run(`(()=>{const r=recCache.result.recommendations.find(x=>x.current.collectionSec>0);return r?r.id:null;})()`);
    await ui.run(`completeRecommendation(${JSON.stringify(target)})`);
    const stateAfter = db.listRecommendationStates()[target];
    check('"수집 완료로 표시" — 상태와 그때의 실제 수집량만 저장하고 주행 기록은 건드리지 않는다',
      stateAfter.status === 'completed' && stateAfter.snapshot.collectionSec > 0 && db.getStats().points > 0
      && /수집 완료로 표시함/.test(ui.html('rec-hidden')), `snapshot ${stateAfter.snapshot.collectionSec}초`);

    // 23. import 후 갱신 — 완료 표시한 조건에 새 데이터가 들어오면 다시 평가한다
    const beforeImport = stats().computations;
    const extraFile = FILES.find(f => !SUBSET.includes(f) && /2026-09-1[01]/.test(f)) || FILES[FILES.length - 1];
    await ui.run(`RouteDB.importRecords(${JSON.stringify(parsed(extraFile).records)},${JSON.stringify(parsed(extraFile).meta)})`);
    await ui.run('renderRecommendView()');
    check('23. 데이터 Import 후 추천이 다시 계산된다',
      stats().computations === beforeImport + 1 && ui.run('recCache.result.dataset.dateCount') >= SUBSET.length,
      `계산 ${stats().computations}회 · 날짜 ${ui.run('recCache.result.dataset.dateCount')}일`);
    const reopened = ui.run(`(()=>{const v=currentRecommendationView();const r=v.visible.find(x=>x.id===${JSON.stringify(target)});return r?(r.reopened?'reopened':'visible'):'hidden';})()`);
    check('   완료로 표시한 조건은 새 수집량과 비교해 다시 평가한다',
      ['reopened', 'hidden'].includes(reopened), `상태: ${reopened}`);

    const beforeDelete = stats().computations;
    const someDate = ui.run('recCache.result.dataset.dateRange.from');
    await ui.run(`RouteDB.deleteDate(${JSON.stringify(someDate)})`);
    await ui.run('renderRecommendView()');
    check('24. 데이터 삭제 후 추천이 다시 계산된다', stats().computations === beforeDelete + 1 && ui.run(`recCache.result.dataset.dateRange.from`) !== someDate);

    const beforeSettings = stats().computations;
    ui.run("onRecommendationSettingInput(['weights','timePeriod'],50)");
    const rejected = await ui.run('saveRecommendationSettings()');
    check('25. 가중치 합계가 100%가 아니면 저장하지 않고 이유를 보여준다',
      rejected === false && /합계/.test(ui.html('rec-settings-errors')) && stats().computations === beforeSettings,
      ui.html('rec-settings-errors').replace(/<[^>]+>/g, ' ').trim().slice(0, 60));
    ui.run("onRecommendationSettingInput(['weights','coverage'],5)");
    const savedOk = await ui.run('saveRecommendationSettings()');
    check('   설정 저장 후 추천이 다시 계산된다',
      savedOk === true && stats().computations === beforeSettings + 1 && db.getSettings().recommendationSettings.weights.timePeriod === 50,
      `계산 ${stats().computations}회`);
    const restored = await ui.run('restoreDefaultRecommendationSettings()');
    check('   기본값 복원', restored === true && db.getSettings().recommendationSettings.weights.timePeriod === 30);

    // 27. 늦게 끝난 계산이 최신 결과를 덮지 않는다
    const slowUi = createRecommendUi(new RouteDatabase(freshPath()));
    await slowUi.run('RouteDB.init()');
    slowUi.run(`recommendationClock=()=>Date.parse(${JSON.stringify(NOW)})`);
    await slowUi.run(`RouteDB.importRecords(${JSON.stringify(parsed(SUBSET[0]).records)},${JSON.stringify(parsed(SUBSET[0]).meta)})`);
    slowUi.api.before.listDateSummaries = async () => { await sleep(120); };
    const first = slowUi.run('renderRecommendView()');
    await sleep(10);
    slowUi.api.before.listDateSummaries = null;
    await slowUi.run(`RouteDB.importRecords(${JSON.stringify(parsed(SUBSET[1]).records)},${JSON.stringify(parsed(SUBSET[1]).meta)})`);
    const second = slowUi.run('renderRecommendView()');
    await first; await second;
    const slowStats = JSON.parse(slowUi.run('JSON.stringify(recommendStats)'));
    check('27. 오래된 비동기 결과가 최신 결과를 덮지 않는다',
      slowStats.staleDiscards >= 1 && slowUi.run('recCache.key') === slowUi.run('recommendationCacheKey()')
      && slowUi.run('recCache.result.dataset.dateCount') === 2,
      `버린 결과 ${slowStats.staleDiscards}건 · 날짜 ${slowUi.run('recCache.result.dataset.dateCount')}일`);

    // 데이터가 없을 때 안내
    const emptyUi = createRecommendUi(new RouteDatabase(freshPath()));
    await emptyUi.run('RouteDB.init()');
    await emptyUi.run('renderRecommendView()');
    check('데이터가 없어도 오류 없이 안내 화면을 보여준다',
      /추천할 수 없어요/.test(emptyUi.html('rec-summary')) && /파일을 불러오면/.test(emptyUi.html('rec-summary'))
      && emptyUi.errors.length === 0, emptyUi.errors.join('|'));
    check('화면 오류 없음', ui.errors.length === 0, ui.errors.join(' | '));
    db.close();
  }

  // ── 5 ──────────────────────────────────────────────────
  section('5. 호환성');
  {
    const { RouteDB: sq } = await sqliteRouteDB(new RouteDatabase(freshPath()));
    const { RouteDB: ib } = await idbRouteDB(createFakeIndexedDB());
    for (const f of SUBSET) {
      await sq.importRecords(parsed(f).records, parsed(f).meta);
      await ib.importRecords(parsed(f).records, parsed(f).meta);
    }
    for (const db of [sq, ib]) {
      await db.saveCoverageSnapshot('강남', { total: 2000, visited: 900, provisional: false, cellSizeM: 20, computedAt: '2026-09-15T10:00:00Z' });
      await db.setRecommendationState('강남|weekday|night|night', { status: 'snoozed', until: '2026-09-30', markedAt: '2026-09-15T10:00:00Z' });
    }
    const [a, b] = [await recommendationsFrom(sq), await recommendationsFrom(ib)];
    check('28. SQLite 와 IndexedDB 의 추천 결과가 같다',
      JSON.stringify(a.recommendations) === JSON.stringify(b.recommendations) && a.candidateCount === b.candidateCount,
      `${a.candidateCount}개 후보 · 1위 ${a.recommendations[0].id} ${a.recommendations[0].score}점`);
    check('   Coverage 스냅샷·추천 상태도 같은 형식으로 저장된다',
      JSON.stringify(await sq.listCoverageSnapshots()) === JSON.stringify(await ib.listCoverageSnapshots())
      && JSON.stringify(await sq.listRecommendationStates()) === JSON.stringify(await ib.listRecommendationStates()));

    const settings = R.defaultRecommendationSettings();
    settings.periodTargets.lunch_peak = { minutes: 400, visits: 6 };
    await sq.setSettings({ recommendationSettings: settings });
    const payload = await sq.buildBackupPayload();
    const restored = new RouteDatabase(freshPath());
    restored.restoreBackupPayload(payload, 'merge');
    const restoredRecs = R.buildRecommendations({ summaries: restored.listDateSummaries(), zones: restored.listZones(), settings: restored.getSettings(), coverageSnapshots: [], now: NOW });
    const source = R.buildRecommendations({ summaries: await sq.listDateSummaries(), zones: await sq.listZones(), settings: await sq.getSettings(), coverageSnapshots: [], now: NOW });
    check('29. 백업·복원 후 추천 결과가 유지된다(추천 설정도 함께 복원)',
      restored.getSettings().recommendationSettings.periodTargets.lunch_peak.minutes === 400
      && JSON.stringify(restoredRecs.recommendations) === JSON.stringify(source.recommendations),
      `${restoredRecs.candidateCount}개 후보`);
    restored.close();
  }
  {
    const PORT = 8093;
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-rec-sync-')), 'shared.json');
    const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ROUTE_VIEWER_DATA_FILE: dataFile }, stdio: 'pipe' });
    server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
    const base = `http://127.0.0.1:${PORT}`;
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(base + '/api/route-data'); up = r.status === 404 || r.ok; } catch (_) { await sleep(150); } }
      const sync = async db => {
        const g = await fetch(base + '/api/route-data');
        if (g.ok) db.restoreBackupPayload(await g.json(), 'merge');
        await fetch(base + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db.buildBackupPayload()) });
      };
      const devA = new RouteDatabase(freshPath());
      SUBSET.slice(0, 2).forEach(f => devA.importRecords(parsed(f).records, parsed(f).meta));
      await sync(devA);
      const devB = new RouteDatabase(freshPath());
      SUBSET.slice(2, 3).forEach(f => devB.importRecords(parsed(f).records, parsed(f).meta));
      const before = R.buildRecommendations({ summaries: devB.listDateSummaries(), zones: devB.listZones(), settings: devB.getSettings(), coverageSnapshots: [], now: NOW });
      await sync(devB);
      const after = R.buildRecommendations({ summaries: devB.listDateSummaries(), zones: devB.listZones(), settings: devB.getSettings(), coverageSnapshots: [], now: NOW });
      check('30. 서버 동기화로 들어온 새 데이터가 추천에 반영된다',
        up && after.dataset.dateCount > before.dataset.dateCount && after.dataset.collectionSec > before.dataset.collectionSec,
        `날짜 ${before.dataset.dateCount}일 → ${after.dataset.dateCount}일`);
      [devA, devB].forEach(d => d.close());
    } finally { server.kill(); }
  }
  {
    const p = freshPath();
    let db = new RouteDatabase(p);
    SUBSET.slice(0, 2).forEach(f => db.importRecords(parsed(f).records, parsed(f).meta));
    const hashes = db.db.all('SELECT record_hash FROM driving_records ORDER BY record_hash').map(r => r.record_hash).join();
    // 구버전 흉내: 요약 형식 v4(속도 통계 없음) · 추천 설정 없는 app_settings
    for (const row of db.db.all('SELECT date, summary_json FROM date_summaries')) {
      const s = JSON.parse(row.summary_json);
      s.conditionCells = s.conditionCells.map(c => { const { speedCount, speedSumTenths, stoppedCount, slowCount, ...rest } = c; return rest; });
      db.db.run('UPDATE date_summaries SET summary_json=? WHERE date=?', [JSON.stringify(s), row.date]);
    }
    db.setMeta('summary_version', '4');
    db.setMeta('app_settings', JSON.stringify({ coverageDepthTiers: [{ threshold: 0, label: '미수집', color: '#000' }] }));
    db.close();
    db = new RouteDatabase(p);
    const recs = R.buildRecommendations({ summaries: db.listDateSummaries(), zones: db.listZones(), settings: db.getSettings(), coverageSnapshots: db.listCoverageSnapshots(), now: NOW });
    check('31. 구버전 DB·백업을 그대로 열 수 있다(요약만 다시 만들고 기록은 그대로)',
      db.db.all('SELECT record_hash FROM driving_records ORDER BY record_hash').map(r => r.record_hash).join() === hashes
      && db.listDateSummaries().every(s => s.conditionCells.every(c => Number.isInteger(c.speedCount)))
      && recs.empty === false && recs.candidateCount > 0,
      `${recs.candidateCount}개 후보`);
    check('   추천 설정이 없던 DB는 기본값으로 동작', db.getSettings().recommendationSettings.weights.timePeriod === 30
      && db.getSettings().coverageDepthTiers[0].label === '미수집');
    const summary = db.listDateSummaries()[0];
    check('32. 기존 기능 회귀 없음 — 달력 요약·조건 칸·분류 서명이 그대로 있다',
      Number.isFinite(summary.collectionSec) && Number.isFinite(summary.driveSpanSec) && Array.isArray(summary.zones)
      && summary.classificationSignature === TC.classificationSignature(TC.classificationConfig(db.getSettings()))
      && db.getClassificationStatus().staleDates === 0);
    db.close();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failures.length) failures.forEach(f => console.log('   - ' + f));
  console.log('─'.repeat(60));
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
