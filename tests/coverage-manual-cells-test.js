// ══════════════════════════════════════════════════════════
//  coverage-manual-cells-test — 누적 지도 Coverage의 수동 셀 편집과 캐시.
//
//  src/js/accum.js(실제 파일)를 vm으로 로드하고, 저장소는 실제 storage.js →
//  SQLite(RouteDatabase)를 쓴다. 지도(Leaflet)·DOM만 가짜다 (tests/helpers/accum-harness.js).
//
//   A. 수동 셀 — 현재 선택(pending)과 확정 상태(committed) 분리
//   B. 미방문 셀 선택(unvisited)
//   C. Coverage 캐시 — 탭 왕복 재사용 / 무효화 조건 / 늦게 끝난 계산
//
//  실행:  node tests/coverage-manual-cells-test.js
// ══════════════════════════════════════════════════════════
'use strict';

const { createAccumHarness, setupCoverageScene, cellCenter, ZONES, pangyoDrive } = require('./helpers/accum-harness');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(title) { console.log(`\n\x1b[36m${title}\x1b[0m`); }

async function manualCellTests() {
  const h = await createAccumHarness();
  await setupCoverageScene(h);
  await h.eval('enterAccumView()');

  let result = await h.eval("calculateCoverage('판교')");
  const valid = result.cells.filter(c => c.state === 'valid');
  const gpsCells = valid.filter(c => c.rawVisits > 0);
  const emptyCells = valid.filter(c => c.rawVisits === 0);
  check('전제: 판교 도로 칸 중 GPS 방문 칸과 미방문 칸이 모두 있다',
    gpsCells.length > 0 && emptyCells.length >= 4, `방문 ${gpsCells.length} / 미방문 ${emptyCells.length}`);
  const [A, B, C, D] = emptyCells;
  const G = gpsCells[0];

  const zoneGrid = h.eval('zoneGrid');
  const cellKeyOf = h.eval('cellKeyOf');
  const grid = zoneGrid('판교');
  const keysIn = list => list.map(p => cellKeyOf(p[0], p[1], grid.latDeg, grid.lngDeg));
  const at = c => cellCenter(result, c);
  const click = c => { const p = at(c); return h.eval(`toggleManualCellAt(${p.lat},${p.lng})`); };
  const pending = () => h.eval('pendingManualEdits');
  const committed = () => h.eval("committedManualCellsByZone.get('판교')");
  const dbCells = () => h.db.getZoneManualCells('판교');
  const applyText = () => h.el('manual-apply-btn').textContent;
  const saves = () => h.api.calls.saveZoneManualCells || 0;
  const previewCount = () => h.eval('manualCellsLayer.getLayers().length');

  // 과거에 이미 적용해 둔 방문 셀 A
  const pa = at(A);
  await h.eval(`RouteDB.saveZoneManualCells('판교',{excluded:[],visited:[[${pa.lat},${pa.lng}]],unvisited:[]})`);
  await h.eval('renderAccumView()');
  check('전제: 과거에 적용한 방문 셀 A가 확정 상태에 있다', keysIn(committed().visited).join() === A.key);

  // ── A. 현재 선택 초기화 ──────────────────────────────
  section('A. 수동 셀 — 현재 선택(pending)과 확정 상태 분리');
  h.eval("setCellEditMode('visit')");
  const saves0 = saves();
  await click(B);
  await click(C);
  check('새 셀 두 개를 선택하면 pending이 2칸', pending().size === 2);
  check('버튼이 "선택 적용 (2)" — 기존 확정 칸 수가 아니라 이번 선택 수', applyText() === '선택 적용 (2)', applyText());
  check('셀 클릭은 DB 저장을 호출하지 않는다', saves() === saves0);
  check('셀 클릭은 확정 상태를 직접 바꾸지 않는다', keysIn(committed().visited).join() === A.key);
  check('선택한 두 칸이 지도에 미리보기로 표시된다', previewCount() === 2, `${previewCount()}개`);

  const calcBeforeClear = h.calcCount();
  h.eval('clearPendingManualCellSelection()');
  check('"현재 구역 선택 초기화" → 새 선택만 사라진다(pending 0)', pending().size === 0);
  check('… 과거에 적용한 방문 셀 A는 확정 상태에 그대로', keysIn(committed().visited).join() === A.key);
  check('… DB의 방문 셀 A도 그대로', keysIn(dbCells().visited).join() === A.key);
  check('… DB 저장을 호출하지 않는다', saves() === saves0);
  check('… Coverage 전체 재계산을 하지 않는다', h.calcCount() === calcBeforeClear);
  check('… 미리보기가 지워지고 "선택 적용"이 비활성으로 돌아온다',
    previewCount() === 0 && h.el('manual-apply-btn').disabled === true && applyText() === '선택 적용');

  // ── 선택 적용 ────────────────────────────────────────
  await click(B);
  await click(C);
  check('새 셀 두 개만 다시 선택 → "선택 적용 (2)"', applyText() === '선택 적용 (2)', applyText());
  const ok = await h.eval('applyManualCellEdits()');
  check('선택 적용 성공', ok === true);
  check('선택 적용은 DB 저장을 딱 한 번 호출한다', saves() === saves0 + 1, `${saves() - saves0}회`);
  check('적용 후 pending이 비워진다', pending().size === 0);
  check('적용 후 편집 모드가 끝난다', h.eval('cellEditMode') === null);
  const visitedKeys = keysIn(dbCells().visited).sort();
  check('DB 방문 셀 = 과거 A + 새 B, C (A가 중복으로 들어가지 않음)',
    visitedKeys.join() === [A.key, B.key, C.key].sort().join(), visitedKeys.join());
  check('메모리 확정 상태도 DB와 같다', keysIn(committed().visited).sort().join() === visitedKeys.join());
  check('적용 후 이 구역 Coverage를 한 번 다시 계산했다', h.calcCount() === calcBeforeClear + 1);

  h.eval("setCellEditMode('visit')");
  await click(A);
  const onlyEdit = [...pending().values()][0];
  check('이미 방문 확정된 A를 다시 누르면 "해제 예정(none)" — 중복 추가가 아니다',
    pending().size === 1 && onlyEdit.targetState === 'none', JSON.stringify(onlyEdit));
  await click(A);
  check('한 번 더 누르면 변경 없음으로 돌아온다(pending 0)', pending().size === 0);
  const merged = h.eval('mergeManualCellEdits')(
    { visited: [[pa.lat, pa.lng]] },
    new Map([['x', { lat: pa.lat, lng: pa.lng, targetState: 'visited' }]]),
    grid.latDeg, grid.lngDeg);
  check('mergeManualCellEdits: 이미 확정된 칸을 다시 적용해도 한 번만 남는다',
    merged.visited.length === 1 && merged.excluded.length === 0 && merged.unvisited.length === 0);

  // ── 저장 실패 ────────────────────────────────────────
  h.eval("setCellEditMode('exclude')");
  await click(D);
  const dbBefore = JSON.stringify(dbCells());
  const errorsBefore = h.stats.errors.length;
  h.api.failNext.saveZoneManualCells = { times: 1, message: '디스크 쓰기 실패' };
  const okFail = await h.eval('applyManualCellEdits()');
  check('저장 실패 → 선택 적용이 실패로 끝난다', okFail === false);
  check('저장 실패 → 오류 메시지 표시', h.stats.errors.length === errorsBefore + 1, h.stats.errors[h.stats.errors.length - 1]);
  check('저장 실패 → 이번 선택(D 제외)은 그대로 남는다',
    pending().size === 1 && [...pending().values()][0].targetState === 'exclude');
  check('저장 실패 → 확정 상태는 이전 그대로(제외 0, 방문 3)',
    committed().excluded.length === 0 && committed().visited.length === 3);
  check('저장 실패 → DB 변경 없음', JSON.stringify(dbCells()) === dbBefore);
  check('저장 실패 → 다시 적용할 수 있다("선택 적용 (1)" 활성)',
    h.el('manual-apply-btn').disabled === false && applyText() === '선택 적용 (1)', applyText());
  const okRetry = await h.eval('applyManualCellEdits()');
  check('다시 적용하면 성공하고 D가 제외로 저장된다', okRetry === true && keysIn(dbCells().excluded).join() === D.key);

  // ── 한 칸 = 한 상태 ──────────────────────────────────
  const statesOfD = () => { const c = dbCells(); return ['excluded', 'visited', 'unvisited'].map(n => keysIn(c[n]).filter(k => k === D.key).length).join(); };
  h.eval("setCellEditMode('unvisit')");
  await click(D);
  await h.eval('applyManualCellEdits()');
  check('제외였던 D를 미방문으로 적용 → excluded에서 빠지고 unvisited에만', statesOfD() === '0,0,1', statesOfD());
  h.eval("setCellEditMode('visit')");
  await click(D);
  await h.eval('applyManualCellEdits()');
  check('다시 방문으로 적용 → unvisited에서 빠지고 visited에만', statesOfD() === '0,1,0', statesOfD());
  const pd = at(D);
  const tri = h.eval('normalizeManualCellsForGrid')(
    { excluded: [[pd.lat, pd.lng]], visited: [[pd.lat, pd.lng]], unvisited: [[pd.lat, pd.lng]] }, grid.latDeg, grid.lngDeg);
  check('구버전/병합 데이터에서 한 칸이 세 목록에 다 있어도 하나(excluded)만 남긴다',
    tri.excluded.length === 1 && tri.visited.length === 0 && tri.unvisited.length === 0);

  // ── B. 미방문 셀 ─────────────────────────────────────
  section('B. 미방문 셀 선택(unvisited)');
  const summarize = h.eval('summarizeCoverage');
  const tiers = h.eval('depthTiers');
  result = await h.eval("calculateCoverage('판교')");
  let g = result.cells.find(c => c.key === G.key);
  const sumBefore = summarize(result, tiers);
  check('전제: G는 실제 GPS 방문 칸이고 빨간 칸이 아니다',
    g.rawVisits > 0 && g.visits > 0 && !h.eval('coverageCellLayers').has(G.key), JSON.stringify(g));
  const pointsBefore = h.db.getStats().points;

  h.eval("setCellEditMode('unvisit')");
  await click(G);
  check('적용 전 미리보기는 Coverage 수치를 바꾸지 않는다',
    summarize(await h.eval("calculateCoverage('판교')"), tiers).visited === sumBefore.visited);
  await h.eval('applyManualCellEdits()');
  result = await h.eval("calculateCoverage('판교')");
  g = result.cells.find(c => c.key === G.key);
  check('GPS 방문 칸을 unvisited로 지정하면 visits = 0', g.visits === 0 && g.manualState === 'unvisited', JSON.stringify(g));
  check('실제 GPS 방문 횟수(rawVisits)·주행 기록은 지우지 않는다',
    g.rawVisits > 0 && h.db.getStats().points === pointsBefore);
  const redLayer = h.eval('coverageCellLayers').get(G.key);
  check('지도에서 빨간 미방문 칸으로 다시 표시된다', !!redLayer && redLayer.layer.options.fillColor === '#ff6b6b');
  const sumAfter = summarize(result, tiers);
  check('Coverage %에서 미방문 Cell로 집계된다(방문 -1, 미방문 +1, 전체 그대로)',
    sumAfter.total === sumBefore.total && sumAfter.visited === sumBefore.visited - 1 && sumAfter.unvisited === sumBefore.unvisited + 1,
    `방문/미방문 ${sumBefore.visited}/${sumBefore.unvisited} → ${sumAfter.visited}/${sumAfter.unvisited}`);
  check('상세 패널 "미방문 Cell" 수에도 반영된다', h.el('coverage-detail').innerHTML.includes(`미방문 Cell <b>${sumAfter.unvisited}</b>`));

  const calcBeforeDepth = h.calcCount();
  h.eval('showCoverageDepth=true');
  await h.eval('renderAccumView()');
  const depthLayer = h.eval('coverageCellLayers').get(G.key);
  const zeroTier = h.eval('tierForCountJS')(tiers, 0);
  check('Coverage Depth에서도 0회 등급(미수집)으로 표시된다',
    !!depthLayer && zeroTier.label === '미수집' && depthLayer.layer.options.fillColor === zeroTier.color);
  check('Depth 보기 전환은 다시 계산하지 않고 다시 그리기만 한다', h.calcCount() === calcBeforeDepth);
  h.eval('showCoverageDepth=false');
  await h.eval('renderAccumView()');

  h.eval("setCellEditMode('visit')");
  await click(G);
  await h.eval('applyManualCellEdits()');
  const cellsG = dbCells();
  check('visited로 다시 지정하면 unvisited에서 제거된다',
    !keysIn(cellsG.unvisited).includes(G.key) && keysIn(cellsG.visited).includes(G.key));
  result = await h.eval("calculateCoverage('판교')");
  g = result.cells.find(c => c.key === G.key);
  check('… 방문 횟수가 max(1, 실제)로 돌아오고 빨간 칸이 아니다',
    g.visits === Math.max(1, g.rawVisits) && !h.eval('coverageCellLayers').has(G.key));

  h.eval("setCellEditMode('exclude')");
  await click(G);
  await h.eval('applyManualCellEdits()');
  result = await h.eval("calculateCoverage('판교')");
  g = result.cells.find(c => c.key === G.key);
  check('excluded가 가장 먼저 — 제외하면 Coverage 대상(전체 Cell)에서 빠진다',
    g.state === 'manual_exclude' && summarize(result, tiers).total === sumBefore.total - 1);
  const eff = h.eval('effectiveCellVisits');
  check('방문 횟수 우선순위: unvisited→0, visited→max(1,raw), 수동 상태 없음→raw',
    eff(3, 'unvisited') === 0 && eff(0, 'visited') === 1 && eff(4, 'visited') === 4 && eff(2, null) === 2);
}

async function cacheTests() {
  const h = await createAccumHarness();
  await setupCoverageScene(h);
  const visitQueries = () => h.api.calls.getCellVisitCounts || 0;

  section('C. Coverage 캐시 — 탭 왕복');
  // 첫 진입 도중에 탭을 빠르게 왔다 갔다 해도 계산은 한 번만
  h.eval("switchTab('accum')");
  h.eval("switchTab('stats')");
  h.eval("switchTab('accum')");
  await h.waitRendered();
  check('누적 지도 최초 진입(빠른 탭 왕복 포함) 시 Coverage 계산 1회', h.calcCount() === 1, `${h.calcCount()}회`);
  check('… DB 방문 집계 조회도 1회', visitQueries() === 1, `${visitQueries()}회`);

  await h.sleep(90); // 첫 진입 때 걸어둔 지도 크기 재기(60ms 타이머)가 끝난 뒤부터 센다
  const rendersBefore = h.eval('coverageStats.renders');
  const overviewBefore = h.api.calls.getOverview;
  const resizeBefore = h.stats.invalidateSize;
  const layersBefore = h.eval('coverageLayer.getLayers()');
  h.eval("switchTab('stats')");
  h.eval("switchTab('calendar')");
  h.eval("switchTab('accum')");
  await h.sleep(90);
  const layersAfter = h.eval('coverageLayer.getLayers()');
  check('다른 탭으로 갔다가 돌아와도 계산 횟수가 늘지 않는다', h.calcCount() === 1, `${h.calcCount()}회`);
  check('… 다시 그리지도 않는다(렌더·DB 조회 없음)',
    h.eval('coverageStats.renders') === rendersBefore && h.api.calls.getOverview === overviewBefore && visitQueries() === 1);
  check('… 기존 지도 Layer를 그대로 유지한다',
    layersBefore.length > 0 && layersAfter.length === layersBefore.length && layersAfter.every((l, i) => l === layersBefore[i]));
  check('… invalidateSize()만 수행된다', h.stats.invalidateSize === resizeBefore + 1, `${h.stats.invalidateSize - resizeBefore}회`);
  check('… 누적 지도 화면은 다시 보인다', h.el('accum-view').style.display === 'flex');

  section('C. Coverage 캐시 — 무효화 조건');
  let n = h.calcCount();
  h.eval("setAccumDateRange('2026-08-01','2026-08-31')");
  await h.waitRendered();
  check('날짜 필터 변경 → 재계산', h.calcCount() === n + 1);
  h.eval('clearAccumDateFilter()');
  await h.waitRendered();
  check('날짜 필터를 되돌리면 이전 결과를 캐시에서 재사용', h.calcCount() === n + 1);

  n = h.calcCount();
  h.eval("setAccumZone('시흥')");
  await h.waitRendered();
  check('구역 변경 → 재계산', h.calcCount() === n + 1);
  h.eval("setAccumZone('판교')");
  await h.waitRendered();
  check('원래 구역으로 돌아오면 캐시 재사용', h.calcCount() === n + 1);

  n = h.calcCount();
  const moved = ZONES.판교.map(([la, lo], i) => (i === 2 ? [la + 0.0005, lo] : [la, lo]));
  h.eval(`boundaryDrawZone='판교'; boundaryDraftPts=${JSON.stringify(moved)}; finishBoundaryDraw();`);
  await h.waitRendered();
  check('구역 경계 수정 → 재계산', h.calcCount() === n + 1);
  check('… 무효화 사유 = boundary(판교)',
    h.eval('lastCoverageInvalidation.reason') === 'boundary' && h.eval('lastCoverageInvalidation.zone') === '판교');

  n = h.calcCount();
  const res = await h.eval("calculateCoverage('판교')");
  const target = res.cells.find(c => c.state === 'valid');
  const tp = cellCenter(res, target);
  h.eval("setCellEditMode('exclude')");
  await h.eval(`toggleManualCellAt(${tp.lat},${tp.lng})`);
  await h.eval('applyManualCellEdits()');
  check('셀 적용 → 판교 재계산', h.calcCount() === n + 1);
  check('… 무효화 대상은 판교 한 구역뿐',
    h.eval('lastCoverageInvalidation.zone') === '판교' && h.eval('lastCoverageInvalidation.reason') === 'manual-cells');
  h.eval("setAccumZone('시흥')");
  await h.waitRendered();
  check('… 다른 구역(시흥)은 캐시 그대로(재계산 없음)', h.calcCount() === n + 1);
  h.eval("setAccumZone('판교')");
  await h.waitRendered();
  check('… 판교로 돌아와도 방금 계산한 결과를 재사용', h.calcCount() === n + 1);

  await h.eval('RouteDB.setBackupHistory([])');
  check('데이터와 무관한 저장(백업 기록)은 캐시를 무효화하지 않는다', h.eval('coverageDirty') === false);

  const reenter = async () => { h.eval("switchTab('stats')"); h.eval("switchTab('accum')"); await h.waitRendered(); };
  const dataCases = [
    ['주행기록 import', `RouteDB.importRecords(${JSON.stringify(pangyoDrive('2026-08-21'))},{filename:'more.xlsx'})`, 'importRecords'],
    ['날짜 삭제', "RouteDB.deleteDate('2026-08-21')", 'deleteDate'],
    ['백업 복원', "RouteDB.buildBackupPayload().then(p=>RouteDB.restoreBackupPayload(p,'merge'))", 'restore'],
    ['서버 동기화', "RouteDB.notifyChange('sync',[])", 'sync'],
  ];
  for (const [label, code, reason] of dataCases) {
    n = h.calcCount();
    await h.eval(code);
    check(`${label} → Coverage 캐시 무효화(${reason})`,
      h.eval('coverageDirty') === true && h.eval('lastCoverageInvalidation.reason') === reason && h.eval('coverageCache.size') === 0);
    await reenter();
    check(`… 누적 지도에 돌아오면 다시 계산`, h.calcCount() === n + 1, `${h.calcCount() - n}회`);
  }
  const rendersBeforeWipe = h.eval('coverageStats.renders');
  await h.eval('RouteDB.deleteAll()');
  check('전체 삭제 → Coverage 캐시 무효화(deleteAll)', h.eval('lastCoverageInvalidation.reason') === 'deleteAll' && h.eval('coverageDirty') === true);
  await reenter();
  check('… 돌아오면 다시 그려서 예전 Coverage가 남지 않는다',
    h.eval('coverageStats.renders') === rendersBeforeWipe + 1 && h.eval('coverageLayer.getLayers().length') === 0);

  section('C. 빠른 전환 중 늦게 끝난 계산');
  await h.eval(`RouteDB.importRecords(${JSON.stringify(pangyoDrive('2026-08-22'))},{filename:'again.xlsx'})`);
  let release;
  const gate = new Promise(r => { release = r; });
  h.api.before.getCellVisitCounts = async ([box]) => { if (box.minLat > 37.38 && box.minLat < 37.39) await gate; };
  h.eval("accumZoneFilter='판교'");
  const slowRender = h.eval('renderAccumView()'); // 판교 계산이 gate에서 멈춘다
  await h.sleep(40);
  h.eval("setAccumZone('시흥')");
  await h.waitRendered();
  release();
  await slowRender;
  await h.sleep(20);
  delete h.api.before.getCellVisitCounts;
  const outlines = h.eval('coverageLayer.getLayers()').filter(l => l.kind === 'polygon').map(l => JSON.stringify(l.latlngs));
  check('늦게 끝난 판교 계산이 최신 화면(시흥)을 덮지 않는다 — 선택 구역 유지', h.eval('accumZoneFilter') === '시흥');
  check('… 지도에는 시흥 경계만 그려져 있다', outlines.length === 1 && outlines[0] === JSON.stringify(ZONES.시흥), outlines.join(' | '));
  check('… 상세 패널도 시흥',
    h.el('coverage-detail').innerHTML.includes('시흥 Coverage') && !h.el('coverage-detail').innerHTML.includes('판교 Coverage'));
  check('… 화면 키가 현재 상태와 일치(재사용 가능)', h.eval('coverageCacheKey===accumViewKey()'));

  section('C. Coverage 판정용 지도 데이터');
  h.fetchState.fail = true; // Overpass가 죽어 있음
  n = h.calcCount();
  const movedSiheung = ZONES.시흥.map(([la, lo], i) => (i === 2 ? [la + 0.0004, lo] : [la, lo]));
  h.eval(`boundaryDrawZone='시흥'; boundaryDraftPts=${JSON.stringify(movedSiheung)}; finishBoundaryDraw();`);
  await h.sleep(200);
  check('도로/건물 데이터를 못 받으면 대체값 결과는 임시 — 화면이 "최신 아님"으로 남는다',
    h.calcCount() === n + 1 && h.eval('coverageDirty') === true && h.eval('isZoneMapDataDegraded')('시흥') === true);
  h.eval('showCoverageDepth=true');
  await h.eval('renderAccumView()');
  h.eval('showCoverageDepth=false');
  await h.eval('renderAccumView()');
  check('… 같은 화면 안의 다시 그리기(Depth 토글)는 임시 결과를 재사용(매번 다시 받지 않음)', h.calcCount() === n + 1);
  // 미러가 전부 실패한 뒤에는 한동안 Overpass 를 아예 부르지 않는다 —
  // 예전엔 미러 4개를 15초씩 기다리는 걸 탭에 들어올 때마다 반복해서 화면이 몇 분씩 멈췄다.
  {
    const fetchesBefore = h.fetchState.fetches;
    await reenter();
    check('지도 데이터 서버가 막혀 있으면 한동안 다시 부르지 않는다(탭마다 기다리지 않게)',
      h.fetchState.fetches === fetchesBefore, `추가 호출 ${h.fetchState.fetches - fetchesBefore}회`);
    check('… 왜 대체값으로 그렸는지 화면에 알려준다',
      /지도\(도로·건물\) 데이터를 못 받아/.test(h.eval('defaultCoverageHint()')),
      h.eval('defaultCoverageHint()').slice(-60));
  }

  h.fetchState.fail = false;
  // 미러가 전부 실패하면 한동안 다시 시도하지 않는다(탭에 들어올 때마다 수십 초씩 기다리지 않게).
  // 여기서는 "사용자가 커버리지 갭 보기를 다시 눌렀다" = 지금 다시 시도로 보고 쿨다운을 푼다.
  h.eval('resetOverpassCooldown()');
  await reenter();
  check('… 지도 데이터를 받을 수 있게 되면 다음 진입 때 다시 계산하고 그 결과는 캐시한다',
    // +3 = 처음 실패 계산 · 쿨다운 확인용 재진입 계산 · 지금 성공 계산
    h.calcCount() === n + 3 && h.eval('coverageDirty') === false && h.eval('isZoneMapDataDegraded')('시흥') === false,
    `계산 ${h.calcCount() - n}회 · dirty=${h.eval('coverageDirty')}`);
}

async function main() {
  await manualCellTests();
  await cacheTests();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failed) {
    console.log('\n  실패 항목:');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log(`${'─'.repeat(60)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
