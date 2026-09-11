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

  section('C. 브라우저 모드 — 캔버스 합성 캡처');
  delete h.api.captureMap;
  h.eval('updateCaptureButton()');
  check('IPC(captureMap)도 캔버스도 없는 환경이면 버튼 비활성 + 미지원 안내',
    h.eval('mapCaptureMode()') === null && btn().disabled === true && /지원하지 않아요/.test(btn().title), btn().title);
  const errBefore = h.stats.errors.length;
  const unsupported = await capture();
  check('… 눌러도 미지원 안내만 한다', unsupported.status === 'unsupported' && h.stats.errors.length === errBefore + 1);

  // 가짜 브라우저 환경: canvas/toBlob, 지도 DOM(배경 타일 <img>, Leaflet Canvas Layer), 다운로드 링크
  const drawn = [];
  const anchors = [];
  let taint = false;
  let blobInfo = null;
  const fakeCtx = {
    scale() {}, fillRect() {}, fillText() {},
    measureText: t => ({ width: String(t).length * 6 }),
    drawImage: (el, x, y, w, hh) => drawn.push({ id: el.id, x, y, w, h: hh, alpha: fakeCtx.globalAlpha, filter: fakeCtx.filter }),
  };
  const origCreate = h.document.createElement;
  h.document.createElement = tag => {
    if (tag === 'canvas') {
      return {
        width: 0, height: 0,
        getContext: () => fakeCtx,
        toBlob(cb, type) {
          if (taint) { const e = new Error('tainted'); e.name = 'SecurityError'; throw e; }
          blobInfo = { width: this.width, height: this.height, type, previewLayers: h.eval('manualCellsLayer.getLayers().length') };
          cb({ size: 2048, type });
        },
      };
    }
    if (tag === 'a') { const a = { style: {}, click() { anchors.push({ href: a.href, download: a.download }); } }; return a; }
    return origCreate(tag);
  };
  h.document.body = { appendChild() {}, removeChild() {} };
  h.ctx.URL = { createObjectURL: () => 'blob:route-viewer/1', revokeObjectURL() {} };
  h.ctx.devicePixelRatio = 2;
  h.ctx.getComputedStyle = el => el._style || { visibility: 'visible', display: 'block', opacity: '1', backgroundColor: 'rgb(221, 221, 221)' };
  const domEl = (id, tagName, left, top, width, height, extra) => ({
    id, tagName, complete: true, naturalWidth: 256,
    getBoundingClientRect: () => ({ left, top, width, height }), ...extra,
  });
  const mapEl = h.el('accum-map');
  // 줌 단계별 타일 묶음 — 지금 단계(z-index 19)가 문서에서는 먼저, 이전 단계(17, 확대된 채 남은 타일)가 뒤에 있다
  const TILE_FILTER = 'grayscale(0.85) brightness(1.06) contrast(0.92)';
  const tilePane = { _style: { visibility: 'visible', display: 'block', opacity: '1', filter: TILE_FILTER } };
  const tileContainer = (z, imgs) => ({ style: { zIndex: String(z) }, querySelectorAll: () => imgs, closest: sel => (sel === '.leaflet-tile-pane' ? tilePane : null) });
  const currentLevel = tileContainer(19, [
    domEl('tile-a', 'IMG', -56, -100, 256, 256),
    domEl('tile-b', 'IMG', 200, -100, 256, 256),
    domEl('tile-fading', 'IMG', 200, 156, 256, 256, { _style: { visibility: 'visible', display: 'block', opacity: '0.3' } }),
    domEl('tile-loading', 'IMG', 456, -100, 256, 256, { complete: false, naturalWidth: 0 }),
    domEl('tile-hidden', 'IMG', 456, 156, 256, 256, { _style: { visibility: 'hidden', display: 'block', opacity: '1' } }),
    domEl('tile-outside', 'IMG', 900, 0, 256, 256),
  ]);
  const oldLevel = tileContainer(17, [domEl('old-level-tile', 'IMG', -300, -300, 1024, 1024)]);
  mapEl.querySelectorAll = sel => (String(sel).includes('tile-container') ? [currentLevel, oldLevel]
    : String(sel).includes('canvas') ? [domEl('vector-canvas', 'CANVAS', -80, -60, 960, 720)] : []);
  mapEl.querySelector = sel => (String(sel).includes('attribution') ? { textContent: '© OpenStreetMap contributors' } : null);
  h.eval('updateCaptureButton()');
  check('캔버스 PNG를 만들 수 있는 브라우저면 캡처 버튼 활성(브라우저 모드)',
    h.eval('mapCaptureMode()') === 'browser' && btn().disabled === false, btn().title);

  const capturesBefore = captures.length;
  const brSaved = await capture();
  check('브라우저 모드 캡처 → PNG를 다운로드로 저장(파일명 규칙 동일)',
    brSaved.status === 'saved' && brSaved.mode === 'browser' && brSaved.savedVia === 'download' &&
    anchors.length === 1 && anchors[0].download === brSaved.fileName && anchors[0].href.startsWith('blob:') &&
    /^RouteViewer_판교_전체기간_Coverage_\d{8}_\d{6}\.png$/.test(brSaved.fileName) && blobInfo.type === 'image/png', JSON.stringify(brSaved));
  check('… 데스크톱 IPC(captureMap)는 부르지 않는다', captures.length === capturesBefore);
  check('이전 줌 단계 타일 → 지금 단계 타일 → Canvas Layer 순서로(z-index 기준), 지도 왼쪽 위 기준 위치·크기로 그린다',
    drawn.map(d => d.id).join() === 'old-level-tile,tile-a,tile-b,tile-fading,vector-canvas' &&
    drawn[1].x === -56 && drawn[1].y === -100 && drawn[4].x === -80 && drawn[4].w === 960 && drawn[4].h === 720, JSON.stringify(drawn));
  check('타일 페이드인 투명도는 쓰지 않는다(흐릿하게 겹치지 않게 — 묶음 투명도 1로 그림)',
    drawn.find(d => d.id === 'tile-fading').alpha === 1);
  check('배경 타일에는 화면과 같은 CSS filter(흑백·밝기)를 걸고, Canvas Layer에는 걸지 않는다',
    drawn.filter(d => d.id !== 'vector-canvas').every(d => d.filter === TILE_FILTER) &&
    drawn.find(d => d.id === 'vector-canvas').filter === 'none', JSON.stringify(drawn.map(d => [d.id, d.filter])));
  check('아직 못 받은 타일·숨긴 요소·지도 밖 요소는 그리지 않는다', !drawn.some(d => /loading|hidden|outside/.test(d.id)));
  check('화면 배율(devicePixelRatio 2)만큼 선명한 크기(800x600 → 1600x1200)', blobInfo.width === 1600 && blobInfo.height === 1200, JSON.stringify(blobInfo));

  h.eval("cellEditMode='visit'");
  await h.eval(`toggleManualCellAt(${p.lat},${p.lng})`);
  drawn.length = 0;
  const brPending = await capture();
  check('브라우저 모드도 적용 전 선택(pending) 미리보기를 빼고 합성한 뒤 되돌린다',
    brPending.status === 'saved' && blobInfo.previewLayers === 0 && h.eval('manualCellsLayer.getLayers().length') === 1);
  h.eval('clearPendingManualCellSelection()');

  const pickerCalls = [];
  h.ctx.showSaveFilePicker = async opts => {
    pickerCalls.push(opts);
    return { name: 'my-map.png', createWritable: async () => ({ write: async b => { pickerCalls.push({ wrote: b.size }); }, close: async () => {} }) };
  };
  const viaPicker = await capture();
  check('파일 저장 창(showSaveFilePicker)을 지원하면 위치·이름을 골라 저장',
    viaPicker.status === 'saved' && viaPicker.savedVia === 'picker' && viaPicker.filePath === 'my-map.png' &&
    pickerCalls[0].suggestedName === viaPicker.fileName && pickerCalls[1].wrote === 2048, JSON.stringify(viaPicker));
  const errNow = h.stats.errors.length;
  h.ctx.showSaveFilePicker = async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; };
  const pickCancel = await capture();
  check('저장 창에서 취소 → canceled(오류로 표시 안 함)', pickCancel.status === 'canceled' && h.stats.errors.length === errNow);
  h.ctx.showSaveFilePicker = async () => { const e = new Error('no user activation'); e.name = 'NotAllowedError'; throw e; };
  const anchorsBefore = anchors.length;
  const fallback = await capture();
  check('저장 창을 띄울 수 없으면(사용자 동작 만료 등) 다운로드로 대신 저장',
    fallback.status === 'saved' && fallback.savedVia === 'download' && anchors.length === anchorsBefore + 1);
  delete h.ctx.showSaveFilePicker;
  taint = true;
  const tainted = await capture();
  check('타일 CORS가 막혀 캔버스가 오염되면 원인(CORS)을 알려준다',
    tainted.status === 'error' && /CORS/.test(h.stats.errors[h.stats.errors.length - 1]), h.stats.errors[h.stats.errors.length - 1]);
  taint = false;
  check('… 실패 후에도 UI 복원 + 버튼 다시 사용 가능', btn().disabled === false && h.eval('mapCaptureInFlight') === false);
  h.document.createElement = origCreate;
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
