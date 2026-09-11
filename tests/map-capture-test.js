// ══════════════════════════════════════════════════════════
//  map-capture-test — "📷 현재 지도 캡처"
//
//   A. src/js/map-capture.js — 안전한 파일명 · 기본 파일명 규칙 · 캡처 영역 계산
//   B. accum.js 캡처 흐름 — 버튼 활성 조건, IPC 요청(좌표·파일명), 취소/실패,
//      중복 클릭, pending 제외, 숨긴 UI 복원, 날짜 변경 직후 최신 결과만
//      (IPC 응답은 가짜 routeAPI.captureMap — 실제 PNG 생성은 E2E가 검증)
//
//  실행:  node tests/map-capture-test.js
// ══════════════════════════════════════════════════════════
'use strict';

const MapCapture = require('../src/js/map-capture.js');
const { createAccumHarness, setupCoverageScene, cellCenter } = require('./helpers/accum-harness');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(title) { console.log(`\n\x1b[36m${title}\x1b[0m`); }
const throws = fn => { try { fn(); return false; } catch (_) { return true; } };

function unitTests() {
  section('A. 파일명 · 캡처 영역');
  const now = new Date(2026, 8, 11, 14, 25, 30);
  const covName = MapCapture.buildCaptureFileName({ zone: '강남', dateFrom: '', dateTo: '', mode: 'Coverage' }, now);
  check('기본 파일명: 전체 기간 Coverage', covName === 'RouteViewer_강남_전체기간_Coverage_20260911_142530.png', covName);
  const densName = MapCapture.buildCaptureFileName({ zone: '판교', dateFrom: '2026-09-01', dateTo: '2026-09-05', mode: 'Density' }, now);
  check('기본 파일명: 기간 Density', densName === 'RouteViewer_판교_20260901-20260905_Density_20260911_142530.png', densName);
  check('기간 표기: 하루 / 시작일만 / 종료일만',
    MapCapture.dateRangeLabel('2026-09-01', '2026-09-01') === '20260901' &&
    MapCapture.dateRangeLabel('2026-09-01', '') === '20260901부터' &&
    MapCapture.dateRangeLabel('', '2026-09-05') === '20260905까지');
  const unsafe = MapCapture.safeCaptureFileName('Route<Viewer>_강남/서초:*?"|_\u0001x.png');
  check('파일명에 쓸 수 없는 문자(\\ / : * ? " < > | 제어문자) 제거', unsafe === 'RouteViewer_강남서초_x.png', unsafe);
  const traversal = MapCapture.safeCaptureFileName('..\\..\\Windows\\evil');
  check('경로 조작 문자열도 파일명 하나로만 남는다', !/[\\/]/.test(traversal) && !traversal.startsWith('.') && traversal.endsWith('.png'), traversal);
  check('예약 이름·빈 이름·긴 이름 처리',
    MapCapture.safeCaptureFileName('CON') === '_CON.png' &&
    MapCapture.safeCaptureFileName('') === 'RouteViewer_map.png' &&
    MapCapture.safeCaptureFileName('a'.repeat(300)).length === 124);
  const r1 = MapCapture.normalizeCaptureRect({ x: 10.4, y: 20.6, width: 800.2, height: 600.5 }, 1, { width: 1280, height: 900 });
  check('영역 좌표를 정수 픽셀로(밖으로 넉넉히)', JSON.stringify(r1) === JSON.stringify({ x: 10, y: 20, width: 801, height: 602 }), JSON.stringify(r1));
  const r2 = MapCapture.normalizeCaptureRect({ x: 100, y: 50, width: 400, height: 300 }, 1.25, { width: 2000, height: 2000 });
  check('페이지 확대 배율(zoomFactor) 반영', JSON.stringify(r2) === JSON.stringify({ x: 125, y: 62, width: 500, height: 376 }), JSON.stringify(r2));
  const r3 = MapCapture.normalizeCaptureRect({ x: 1000, y: 700, width: 800, height: 600 }, 1, { width: 1280, height: 900 });
  check('창 밖으로 나간 부분은 잘라낸다', r3.width === 280 && r3.height === 200, JSON.stringify(r3));
  check('잘못된 좌표·크기 0·화면 밖 영역은 거부',
    throws(() => MapCapture.normalizeCaptureRect({ x: NaN, y: 0, width: 1, height: 1 })) &&
    throws(() => MapCapture.normalizeCaptureRect({ x: 0, y: 0, width: 0, height: 10 })) &&
    throws(() => MapCapture.normalizeCaptureRect({ x: 2000, y: 0, width: 100, height: 100 }, 1, { width: 1280, height: 900 })));
}

async function flowTests() {
  const h = await createAccumHarness();
  const captures = [];
  let mode = 'save';
  const pendingKey = { key: null };
  const captureImpl = async (rect, name) => {
    captures.push({
      rect, name,
      inFlightDisabled: h.el('accum-capture-btn').disabled,
      previewLayers: h.eval('manualCellsLayer?manualCellsLayer.getLayers().length:0'),
      tooltipVisibility: h.el('accum-tooltip').style.visibility,
      loadingVisibility: h.el('coverage-loading').style.visibility,
      pendingCellVisible: pendingKey.key ? h.eval(`(coverageCellLayers.get('${pendingKey.key}')||{}).visible`) : null,
    });
    await h.sleep(20);
    if (mode === 'cancel') return { canceled: true };
    if (mode === 'fail') throw new Error('디스크가 가득 찼어요');
    return { canceled: false, filePath: 'C:\\captures\\' + name, width: 800, height: 600, bytes: 4321 };
  };
  h.api.captureMap = captureImpl;
  // 캡처 동안 숨겨야 하는 화면 요소 두 개를 가짜 DOM에서 찾을 수 있게
  h.document.querySelectorAll = sel => (String(sel).includes('#accum-tooltip') ? [h.el('accum-tooltip'), h.el('coverage-loading')] : []);
  const capture = () => h.eval('captureAccumMap()');
  const btn = () => h.el('accum-capture-btn');

  section('B. 캡처 버튼 · 로딩 중 방지');
  h.eval('updateCaptureButton()');
  check('지도를 한 번도 그리기 전에는 캡처 버튼 비활성', btn().disabled === true, btn().title);
  const early = await capture();
  check('… 눌러도 캡처하지 않는다(not-ready)', early.status === 'not-ready' && captures.length === 0);

  await setupCoverageScene(h);
  h.eval('showCoverageGaps=false');
  const renderP = h.eval('renderAccumView()');
  check('지도를 그리는 중에는 캡처 버튼 비활성', btn().disabled === true);
  const during = await capture();
  check('… 그리는 중 캡처 요청은 거절', during.status === 'not-ready' && captures.length === 0);
  await renderP;
  check('다 그려지면 캡처 버튼 활성', btn().disabled === false && btn().textContent === '📷 현재 지도 캡처', btn().title);

  section('B. 밀도 지도 캡처 → IPC 요청/응답');
  const resizeBefore = h.stats.invalidateSize;
  const errorsBefore = h.stats.errors.length;
  const saved = await capture();
  const c0 = captures[0];
  check('캡처 버튼 → routeAPI.captureMap(IPC) 1회 호출', saved.status === 'saved' && captures.length === 1, JSON.stringify(saved));
  check('지도 DOM 영역 좌표를 넘긴다(getBoundingClientRect)', JSON.stringify(c0.rect) === JSON.stringify({ x: 0, y: 0, width: 800, height: 600 }), JSON.stringify(c0.rect));
  check('기본 파일명: 구역·전체기간·Density·시각', /^RouteViewer_판교_전체기간_Density_\d{8}_\d{6}\.png$/.test(c0.name), c0.name);
  check('캡처 직전 accumMap.invalidateSize() 실행', h.stats.invalidateSize > resizeBefore);
  check('캡처 중에는 버튼이 비활성(중복 클릭 방지)', c0.inFlightDisabled === true);
  check('캡처 중에는 호버 툴팁·로딩 표시를 숨긴다', c0.tooltipVisibility === 'hidden' && c0.loadingVisibility === 'hidden');
  check('캡처 후 숨겼던 UI 복원 + 버튼 다시 활성',
    h.el('accum-tooltip').style.visibility !== 'hidden' && h.el('coverage-loading').style.visibility !== 'hidden' && btn().disabled === false);
  check('성공하면 저장 경로를 Toast로 알린다', h.stats.toasts.some(t => t.includes('C:\\captures\\' + c0.name)));
  check('성공은 오류로 표시하지 않는다', h.stats.errors.length === errorsBefore);

  const [dup1, dup2] = await Promise.all([capture(), capture()]);
  check('연달아 두 번 눌러도 한 번만 캡처(두 번째는 busy)', dup1.status === 'saved' && dup2.status === 'busy' && captures.length === 2);

  section('B. 저장 취소 · 저장 실패');
  mode = 'cancel';
  const canceled = await capture();
  check('저장 취소 → canceled, 오류 메시지 없음, 취소 안내 Toast',
    canceled.status === 'canceled' && h.stats.errors.length === errorsBefore && h.stats.toasts[h.stats.toasts.length - 1].includes('취소'));
  mode = 'fail';
  const failedRes = await capture();
  check('저장 실패 → 오류 메시지 표시', failedRes.status === 'error' && h.stats.errors.length === errorsBefore + 1 &&
    h.stats.errors[h.stats.errors.length - 1].includes('디스크가 가득 찼어요'), h.stats.errors[h.stats.errors.length - 1]);
  check('저장 실패 후에도 숨긴 UI 복원 + 버튼 다시 사용 가능',
    h.el('accum-tooltip').style.visibility !== 'hidden' && btn().disabled === false && h.eval('mapCaptureInFlight') === false);
  mode = 'save';

  section('B. 날짜 변경 직후 · Coverage · pending');
  h.eval("setAccumDateRange('2026-08-20','2026-08-20')");
  const rightAfter = await capture();
  check('날짜를 바꾼 직후(새 계산 전)에는 캡처하지 않는다', rightAfter.status === 'not-ready');
  await h.waitRendered();
  const afterDate = await capture();
  check('새 계산이 끝난 뒤 캡처 → 파일명에 새 날짜 반영', afterDate.status === 'saved' && afterDate.fileName.includes('_판교_20260820_Density_'), afterDate.fileName);
  h.eval('clearAccumDateFilter()');
  await h.waitRendered();

  h.eval('showCoverageGaps=true');
  await h.eval('renderAccumView()');
  const cov = await capture();
  check('Coverage Map 캡처 → 파일명 Coverage', cov.status === 'saved' && /_전체기간_Coverage_/.test(cov.fileName), cov.fileName);
  h.eval('showCoverageDepth=true');
  await h.eval('renderAccumView()');
  const depth = await capture();
  check('Coverage Depth 캡처 → 파일명 CoverageDepth', /_CoverageDepth_/.test(depth.fileName), depth.fileName);
  h.eval('showCoverageDepth=false');
  await h.eval('renderAccumView()');

  const result = await h.eval("calculateCoverage('판교')");
  const target = result.cells.find(c => c.state === 'valid' && c.visits === 0);
  const p = cellCenter(result, target);
  pendingKey.key = target.key;
  h.eval("setCellEditMode('visit')");
  await h.eval(`toggleManualCellAt(${p.lat},${p.lng})`);
  check('전제: 적용 전 선택 1칸이 미리보기로 떠 있고 밑의 빨간 칸은 숨겨져 있다',
    h.eval('pendingManualEdits.size') === 1 && h.eval('manualCellsLayer.getLayers().length') === 1 &&
    h.eval(`coverageCellLayers.get('${target.key}').visible`) === false);
  const withPending = await capture();
  const cp = captures[captures.length - 1];
  check('캡처에는 pending 미리보기가 빠지고 적용 완료 상태(원래 빨간 칸)만 들어간다',
    withPending.status === 'saved' && cp.previewLayers === 0 && cp.pendingCellVisible === true);
  check('캡처 후 pending 선택과 미리보기는 그대로 돌아온다',
    h.eval('pendingManualEdits.size') === 1 && h.eval('manualCellsLayer.getLayers().length') === 1 &&
    h.eval(`coverageCellLayers.get('${target.key}').visible`) === false);
  h.eval('clearPendingManualCellSelection()');

  section('B. 브라우저 모드');
  delete h.api.captureMap;
  h.eval('updateCaptureButton()');
  check('captureMap API가 없으면(브라우저 모드) 버튼 비활성 + 안내', btn().disabled === true && btn().title.includes('데스크톱'), btn().title);
  const errBefore = h.stats.errors.length;
  const unsupported = await capture();
  check('… 눌러도 미지원 안내만 한다', unsupported.status === 'unsupported' && h.stats.errors.length === errBefore + 1);
  h.api.captureMap = captureImpl;
}

async function main() {
  unitTests();
  await flowTests();
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
