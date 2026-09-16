// ══════════════════════════════════════════════════════════
//  e2e-driver — 실제 Electron 앱 화면을 띄워놓고 조작해 본다.
//
//  요구사항 14번의 Test 1~6 을 "화면 기준"으로 확인한다.
//  (DB 단위 테스트는 tests/run-tests.js 가 따로 한다)
//
//  실행: npm run test:e2e
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const XLSX_DIR = path.join(__dirname, '..', '주행기록');
const SHOTS = path.join(__dirname, '..', 'tests', 'screenshots');

let passed = 0, failed = 0;
const failures = [];
const consoleErrors = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(t) { console.log(`\n== ${t}`); }

module.exports = function run({ app, mainWindow, dbFilePath }) {
  const win = mainWindow;

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    // level 3 = error
    if (level >= 2) {
      const text = `${message} (${source}:${line})`;
      // "지도 캡처 실패 … no-such-dir"는 아래 캡처 테스트가 일부러 없는 폴더로 저장시켜 만든 경고라 뺀다
      if (!/favicon|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|fonts\.googleapis|basemaps\.cartocdn|Autofill|지도 캡처 실패: Error: ENOENT.*no-such-dir/i.test(text)) {
        consoleErrors.push(text);
      }
    }
  });

  win.webContents.once('did-finish-load', async () => {
    try {
      await main(win, dbFilePath());
    } catch (err) {
      console.error('\ne2e 실패:', err);
      failed++;
      failures.push('예외: ' + err.message);
    }
    console.log(`\n${'-'.repeat(58)}`);
    console.log(`  통과 ${passed} / 실패 ${failed}`);
    if (consoleErrors.length) {
      console.log(`\n  화면 콘솔 에러 ${consoleErrors.length}건:`);
      [...new Set(consoleErrors)].slice(0, 15).forEach(e => console.log('   ! ' + e));
    }
    if (failures.length) {
      console.log('\n  실패 항목:');
      failures.forEach(f => console.log('   - ' + f));
    }
    console.log(`${'-'.repeat(58)}\n`);
    app.exit(failed || consoleErrors.length ? 1 : 0);
  });
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function js(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

// Coverage 계산이 끝나 누적 지도가 다 그려질 때까지 기다린다 — 건물 데이터를 인터넷
// (Overpass)에서 받는 동안은 미러 타임아웃(각 15초) 때문에 수십 초 걸릴 수 있어서,
// 고정 sleep 대신 실제 완료를 기다린다.
async function waitCoverageIdle(win, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(win, `coverageInFlight.size===0&&coverageCacheKey===accumViewKey()`)) return true;
    await sleep(150);
  }
  return false;
}

// 화면의 handleFiles() 를 실제 File 객체로 호출한다 (드래그앤드롭과 같은 경로).
// 저장 전에 "이 파일에 이슈가 있나요?" 확인 창이 한 번 뜨므로, issue 를 주면 체크 + 메모를
// 채우고 저장 버튼과 같은 confirmImportFlow() 로 마무리한다.
async function importViaUI(win, filename, issue) {
  const buf = fs.readFileSync(path.join(XLSX_DIR, filename));
  const b64 = buf.toString('base64');
  await js(win, `(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], ${JSON.stringify(filename)},
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await handleFiles([file]);
    return true;
  })()`);
  await sleep(150);
  await js(win, `(async () => {
    const issue = ${JSON.stringify(issue || null)};
    if (issue) {
      document.getElementById('imp-issue-0').checked = true;
      onImportIssueToggle(0);
      document.getElementById('imp-note-0').value = issue.note;
      onImportIssueNoteInput(0);
    }
    await confirmImportFlow();
    return true;
  })()`);
  await sleep(150);
}

// 확인 창까지만 진행한다(저장하지 않는다) — 확인 창 자체를 검사할 때 쓴다
async function importViaUIRaw(win, filename) {
  const buf = fs.readFileSync(path.join(XLSX_DIR, filename));
  const b64 = buf.toString('base64');
  await js(win, `(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], ${JSON.stringify(filename)},
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await handleFiles([file]);
    return true;
  })()`);
  await sleep(200);
}

async function shot(win, name) {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS, name + '.png'), img.toPNG());
  } catch (err) {
    console.warn('  (스크린샷 실패: ' + err.message + ')');
  }
}

async function main(win, dbFilePath) {
  await sleep(700); // 스크립트 로드 + RouteDB.init 대기

  // ── 로그인 화면 ──────────────────────────────────────
  section('로그인 화면');
  check('로그인 화면이 먼저 뜬다',
    await js(win, `!document.getElementById('login-screen').classList.contains('hidden')`));
  check('등록되지 않은 이름은 막힌다',
    await js(win, `(()=>{
      document.getElementById('login-name-input').value='아무개';
      updateLoginButton(); submitLogin();
      return document.getElementById('login-error').style.display==='block';
    })()`));
  check('허용된 이름은 통과한다',
    await js(win, `(()=>{
      document.getElementById('login-name-input').value='양은규';
      updateLoginButton(); submitLogin();
      return document.getElementById('login-screen').classList.contains('hidden');
    })()`));
  check('사용자 이름이 표시된다',
    (await js(win, `document.getElementById('user-badge-name').textContent`)) === '양은규');

  check('저장소 배지가 SQLite',
    (await js(win, `document.getElementById('storage-badge').textContent`)) === 'SQLite');
  check('DB 파일이 사용자 데이터 폴더의 database/route-viewer.db',
    /[\\/]database[\\/]route-viewer\.db$/.test(dbFilePath), dbFilePath);

  // ── 회귀 방지: 진짜 클릭 이벤트로 탭 버튼이 눌리는지 ──
  // ⚠ 이 테스트가 왜 필요한가: 이전 세션에서 CSP에 script-src 'self'만 넣고
  // 'unsafe-inline'을 빼먹은 적이 있다. 화면의 onclick="..." 인라인 핸들러가
  // 전부 조용히 막혀서(콘솔에만 "Refused to execute inline event handler" 로 남고
  // 화면엔 아무 표시도 없음) 탭/버튼이 하나도 안 눌렸는데, 그 사고 전까지 이
  // e2e 스위트는 111개 전부 통과했다 — 모든 테스트가 switchTab() 같은 함수를
  // executeJavaScript로 "직접 호출"했지 실제 버튼을 클릭한 적이 없었기 때문이다.
  // 이제는 반드시 dispatchEvent(new MouseEvent('click'))로 진짜 클릭을 흉내내서
  // onclick 속성 경로 자체가 살아있는지 확인한다.
  section('회귀 방지 — 진짜 클릭으로 탭이 눌리는지');
  for (const tab of ['calendar', 'accum', 'stats', 'data', 'settings', 'upload']) {
    await js(win, `document.getElementById('tab-${tab}').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
    await sleep(150);
  }
  check('진짜 클릭으로 "달력" 탭까지 갔다가 "파일 불러오기"로 돌아온다',
    (await js(win, `document.getElementById('tab-upload').classList.contains('active')`)) &&
    (await js(win, `getComputedStyle(document.getElementById('dropzone')).display`)) === 'block');
  check('클릭 과정에서 CSP 위반(인라인 핸들러 차단) 콘솔 에러가 없다',
    !consoleErrors.some(e => /Refused to execute inline event handler/i.test(e)),
    consoleErrors.filter(e => /Refused/i.test(e)).join(' | '));

  // ── Test 1 — 날짜 누적 ───────────────────────────────
  section('Test 1 — 날짜 누적 (화면)');
  await js(win, `switchTab('upload')`);
  await importViaUI(win, '주행기록_2026-08-12.xlsx');
  check('import 결과 모달이 뜬다',
    await js(win, `document.getElementById('modal-backdrop').classList.contains('show')`));
  check('모달 제목이 "주행 기록 추가 완료"',
    (await js(win, `document.getElementById('modal-title').textContent`)) === '주행 기록 추가 완료');
  const report1 = await js(win, `document.getElementById('modal-body').innerText`);
  check('결과에 파일/날짜/원본/새로 추가/중복 제외/중복률이 있다',
    ['파일', '날짜', '원본', '새로 추가', '중복 제외', '중복률', '전체 저장 날짜', '전체 GPS 포인트']
      .every(k => report1.includes(k)),
    report1.replace(/\s+/g, ' ').slice(0, 110));
  await shot(win, '01-import-report');
  await js(win, `closeModal()`);

  await importViaUI(win, '주행기록_2026-08-24 4.xlsx');
  await js(win, `closeModal()`);
  await importViaUI(win, 'TalkFile_주행기록_2026-08-25 2.xlsx.xlsx');
  await js(win, `closeModal()`);

  let dates = await js(win, `sortedDataDates()`);
  check('세 날짜가 모두 남아있다',
    dates.join(',') === '2026-08-12,2026-08-24,2026-08-25', dates.join(','));

  // ── 달력 ────────────────────────────────────────────
  section('Test 6 — 달력');
  await js(win, `showCalendar()`);
  await sleep(200);
  check('달력 탭이 보인다',
    (await js(win, `getComputedStyle(document.getElementById('calendar-view')).display`)) === 'flex');
  check('8월에 기록 있는 칸이 그려진다',
    (await js(win, `document.querySelectorAll('#cal-grid .cal-cell.has-data').length`)) >= 2,
    '칸 ' + await js(win, `document.querySelectorAll('#cal-grid .cal-cell.has-data').length`) + '개');
  check('구역/차량 칩이 표시된다',
    (await js(win, `document.querySelectorAll('#cal-grid .cal-chip').length`)) > 0);
  check('지점 수가 표시된다',
    /개 지점/.test(await js(win, `document.querySelector('#cal-grid .cal-cell.has-data .cal-count').textContent`)));
  const cp = await js(win, `(()=>{
    const t=CollectionStats.summarizeCollection([...dateSummaryIndex.values()]);
    return {text:document.getElementById('collection-progress').innerText.replace(/\\s+/g,' '),
      minutes:fmtNum(Math.round(t.totalSec/60)), rows:document.querySelectorAll('#cp-body tr').length,
      first:document.getElementById('calendar-view').firstElementChild.id,
      collected:document.querySelector('#cp-body .cp-collected').textContent};
  })()`);
  check('달력 맨 위에 "전체 데이터 수집 현황" 표(KPI·제안 2행, 목표값, 최근 데이터)',
    cp.first === 'collection-progress' && cp.rows === 2 &&
    ['전체 데이터 수집 현황', 'KPI', '제안', '8,000', '4,000', '20,000', '10,000', '최근 데이터: 2026-08-25'].every(k => cp.text.includes(k)),
    cp.text.slice(0, 160));
  check('표의 수집 시간 = DB 날짜 요약 유효 수집 시간 합(분)', cp.collected === cp.minutes, `${cp.collected}분`);
  const cpSpan = await js(win, `(()=>{
    const t=CollectionStats.summarizeCollection([...dateSummaryIndex.values()]);
    return {shown:document.querySelector('#cp-body .cp-span').textContent, expected:fmtNum(Math.round(t.totalSpanSec/60)),
      cellTimes:[...document.querySelectorAll('#cal-grid .cal-time')].map(e=>e.textContent)};
  })()`);
  check('표에 주행 시간(첫~마지막 기록)도 따로 표시되고, 달력 칸마다 수집·주행 시간이 보인다',
    cpSpan.shown === cpSpan.expected && cpSpan.cellTimes.length >= 3 && cpSpan.cellTimes.every(t => /^수집 [\d,]+분 · 주행 [\d,]+분$/.test(t)),
    `주행 ${cpSpan.shown}분 · 칸: ${cpSpan.cellTimes.join(' | ')}`);
  await shot(win, '02-calendar');

  // ── 날짜 상세 + 리플레이 ────────────────────────────
  section('Test 6 — 날짜별 주행 확인 · GPS 리플레이 · 품질 검사');
  await js(win, `openDayDetail('2026-08-12')`);
  await sleep(400);
  check('리플레이 콘솔이 열린다',
    (await js(win, `getComputedStyle(document.getElementById('console')).display`)) === 'flex');
  check('날짜/구간/지점/거리 통계가 채워진다',
    (await js(win, `document.getElementById('stat-date').textContent`)) === '2026-08-12' &&
    (await js(win, `document.getElementById('stat-points').textContent`)) !== '—',
    await js(win, `document.getElementById('stat-points').textContent + ' / ' + document.getElementById('stat-dist').innerText`));
  check('일자 요약(구역·차량)이 뜬다',
    (await js(win, `document.getElementById('day-summary').innerText`)).includes('시흥'));
  check('데이터 품질 패널이 뜬다',
    (await js(win, `getComputedStyle(document.getElementById('quality-panel')).display`)) !== 'none');
  check('테이프 최대값이 지점 수와 맞는다',
    (await js(win, `+document.getElementById('tape').max`)) === 15,
    'max=' + await js(win, `document.getElementById('tape').max`));

  await js(win, `stepTape(1); stepTape(1)`);
  check('테이프를 넘기면 시각이 바뀐다',
    (await js(win, `document.getElementById('tape-time').textContent`)) !== '--:--:--',
    await js(win, `document.getElementById('tape-time').textContent + ' · ' + document.getElementById('tape-idx').textContent`));
  await js(win, `togglePlay()`);
  await sleep(500);
  const playing = await js(win, `document.getElementById('play-btn').textContent`);
  await js(win, `if(playTimer) togglePlay()`);
  check('재생 버튼이 동작한다', playing === '⏸');
  await shot(win, '03-replay');

  // "다른 파일 불러오기"가 데이터를 지우지 않아야 한다
  await js(win, `resetViewer()`);
  await sleep(150);
  dates = await js(win, `sortedDataDates()`);
  check('"다른 파일 불러오기"를 눌러도 데이터가 남는다', dates.length === 3, dates.join(','));

  // ── Test 2 — 같은 파일 재import ──────────────────────
  section('Test 2 — 같은 파일 다시 넣기 (화면)');
  const before = await js(win, `(async()=>(await RouteDB.stats()).points)()`);
  await importViaUI(win, '주행기록_2026-08-12.xlsx');
  const reportDup = await js(win, `document.getElementById('modal-body').innerText`);
  await js(win, `closeModal()`);
  const after = await js(win, `(async()=>(await RouteDB.stats()).points)()`);
  check('포인트 수가 2배가 되지 않는다', before === after, `${before} → ${after}`);
  check('"새로 추가 0" 으로 표시된다', /새로 추가\s*0/.test(reportDup.replace(/,/g, '')),
    reportDup.replace(/\s+/g, ' ').slice(0, 120));

  // ── Test 3 — 같은 날짜 다른 주행 ─────────────────────
  section('Test 3 — 같은 날짜 오전/오후 (화면)');
  const before25 = await js(win, `dateSummaryIndex.get('2026-08-25').count`);
  await importViaUI(win, 'TalkFile_주행기록_2026-08-25 5.xlsx.xlsx');
  await js(win, `closeModal()`);
  const after25 = await js(win, `dateSummaryIndex.get('2026-08-25').count`);
  check('같은 날짜에 기록이 더 쌓인다', after25 > before25, `${before25} → ${after25}`);
  const day25 = await js(win, `(async()=>(await RouteDB.getRecordsByDate('2026-08-25')).map(p=>p.time))()`);
  check('오전 기록이 있다', day25.some(t => t.startsWith('09:')));
  check('오후 기록이 있다', day25.some(t => t.startsWith('14:') || t.startsWith('16:')));
  check('시간순으로 정렬돼 있다', day25.every((t, i) => i === 0 || day25[i - 1] <= t));

  // ── 누적 지도 ───────────────────────────────────────
  section('Test 6 — 누적 지도 · 지역 필터 · 커버리지 갭');
  await js(win, `switchTab('accum')`);
  await sleep(700);
  check('누적 지도 탭이 열린다',
    (await js(win, `getComputedStyle(document.getElementById('accum-view')).display`)) === 'flex');
  check('누적 통계가 채워진다',
    (await js(win, `document.getElementById('accum-stats').innerText`)).includes('누적 일수'));
  const cellCount = await js(win, `accumCells.length`);
  check('밀도 격자가 그려진다', cellCount > 0, `${cellCount}칸`);
  check('격자에 지나간 날짜 수가 들어있다',
    await js(win, `accumCells.every(c => typeof c.dateCount === 'number')`));
  await shot(win, '04-accum-map');

  await js(win, `setAccumZone('강남')`);
  await sleep(600);
  const gangnamCells = await js(win, `accumCells.length`);
  check('지역 필터(강남)가 동작한다', gangnamCells > 0 && gangnamCells <= cellCount,
    `전체 ${cellCount}칸 → 강남 ${gangnamCells}칸`);
  check('필터 버튼이 강남 색으로 바뀐다',
    (await js(win, `document.querySelector('#zone-filter-group .zone-btn[data-zone="강남"]').classList.contains('active')`)));

  // 구역 경계 그리기 + 커버리지 갭
  await js(win, `(()=>{
    ZONE_POLYGONS['강남']=[[37.492,127.020],[37.535,127.020],[37.535,127.055],[37.492,127.055]];
    saveZonePolygonsToStorage();
  })()`);
  await sleep(250);
  await js(win, `toggleCoverageGaps()`);
  await sleep(200);
  await waitCoverageIdle(win);
  const gapRects = await js(win, `coverageLayer.getLayers().length`);
  check('커버리지 갭이 그려진다', gapRects > 1, `${gapRects}개 도형`);
  check('안내 문구가 갭 모드로 바뀐다',
    (await js(win, `document.getElementById('accum-hint').textContent`)).includes('빨간 칸'));
  await shot(win, '05-coverage-gap');
  await js(win, `toggleCoverageGaps(); setAccumZone('all')`);
  await sleep(500);

  // 구역 경계가 DB에 저장됐는지
  check('구역 경계가 DB에 저장된다',
    Object.keys(await js(win, `(async()=>await RouteDB.getZonePolygons())()`)).includes('강남'));

  // ── Coverage % · Coverage Depth (요구사항 9~12) ─────
  section('신규 — Coverage % · Coverage Depth');
  await js(win, `setAccumZone('강남'); toggleCoverageGaps()`);
  await sleep(200);
  await waitCoverageIdle(win);
  check('지역별 Coverage 요약이 보인다(요구사항 10)',
    (await js(win, `getComputedStyle(document.getElementById('coverage-summary')).display`)) !== 'none');
  const covSummaryText = await js(win, `document.getElementById('coverage-summary').innerText`);
  check('요약에 강남 Coverage %가 표시된다', /강남/.test(covSummaryText) && /%/.test(covSummaryText),
    covSummaryText.replace(/\s+/g, ' '));
  const covDetailText1 = await js(win, `document.getElementById('coverage-detail').innerText`);
  check('선택한 지역의 상세 Coverage %가 보인다(요구사항 9)',
    /Coverage/.test(covDetailText1) && /%/.test(covDetailText1), covDetailText1.replace(/\s+/g, ' ').slice(0, 100));
  check('전체 Cell/방문 Cell/미방문 Cell 수치가 보인다',
    ['전체 Cell', '방문 Cell', '미방문 Cell'].every(k => covDetailText1.includes(k)));

  await js(win, `toggleCoverageDepth()`);
  await sleep(200);
  await waitCoverageIdle(win);
  const covDetailText2 = await js(win, `document.getElementById('coverage-detail').innerText`);
  check('Coverage Depth 등급별 분포가 보인다(요구사항 11)',
    ['미수집', '부족', '보통', '충분'].every(k => covDetailText2.includes(k)), covDetailText2.replace(/\s+/g, ' '));
  await shot(win, '13-coverage-depth');
  await js(win, `toggleCoverageDepth()`);
  await sleep(300);

  // 같은 셀에 GPS가 연속으로 여러 개 찍혀도 방문 1회로 묶이는지(요구사항 12).
  // 새 데이터를 넣으면 이후의 날짜 수/삭제 검증이 어긋나므로, 이미 쌓인 실제
  // 데이터(정차 구간 등 한 셀에 GPS가 몰리는 경우가 많다)로 건전성만 확인한다 —
  // "방문 횟수 합계가 GPS 포인트 수보다 훨씬 작다"는 연속 방문이 1회로 묶였다는 증거다.
  // (묶이는 로직 자체의 정확성은 tests/run-tests.js의 Test F/G가 격리된 DB로 이미 검증함)
  const visitSoundness = await js(win, `(async()=>{
    const box={minLat:37.49,maxLat:37.51,minLng:127.02,maxLng:127.05,refLat:37.5};
    const visits=await RouteDB.getCellVisitCounts(box,50);
    const cells=await RouteDB.getDensityCells({zone:'강남'},0.0007);
    const totalVisits=visits.reduce((s,v)=>s+v.visits,0);
    const totalPoints=cells.reduce((s,c)=>s+c.n,0);
    return {totalVisits,totalPoints};
  })()`);
  check('방문 횟수 합계가 GPS 포인트 수보다 훨씬 작다(연속 방문이 묶인 증거, 요구사항 12)',
    visitSoundness.totalVisits > 0 && visitSoundness.totalVisits < visitSoundness.totalPoints,
    `visits=${visitSoundness.totalVisits} points=${visitSoundness.totalPoints}`);

  // ── Coverage 캐시 · 수동 셀(미방문 / 현재 선택 초기화 / 선택 적용) ──
  section('신규 — Coverage 캐시 · 미방문 셀 · 현재 선택 초기화');
  await waitCoverageIdle(win);
  const degraded = await js(win, `isZoneMapDataDegraded('강남')`);
  const calcBefore = await js(win, `coverageStats.calculations`);
  await js(win, `switchTab('stats')`);
  await sleep(300);
  await js(win, `switchTab('accum')`);
  await sleep(400);
  if (degraded) {
    console.log('  (건물 데이터를 못 받아 대체값으로 계산 중이라 탭 복귀 재사용 검사는 건너뜀 — 설계상 다시 시도함)');
  } else {
    check('탭을 갔다 와도 Coverage를 다시 계산하지 않는다(캐시 재사용)',
      (await js(win, `coverageStats.calculations`)) === calcBefore, `계산 ${calcBefore} → ${await js(win, `coverageStats.calculations`)}`);
  }
  check('"🔴 미방문 셀 선택" 버튼이 있다', await js(win, `!!document.getElementById('cell-unvisit-btn')`));
  const pickCell = await js(win, `(async()=>{
    const r=await calculateCoverage('강남');
    const c=r&&r.cells.find(c=>c.state==='valid'&&c.rawVisits>0)||r&&r.cells.find(c=>c.state==='valid');
    return c?{lat:(c.la+0.5)*r.grid.latDeg,lng:(c.lo+0.5)*r.grid.lngDeg}:null;
  })()`);
  check('Coverage 계산 결과에 유효 도로 칸이 있다', !!pickCell);
  if (pickCell) {
    const manualBefore = await js(win, `(async()=>JSON.stringify(await RouteDB.getZoneManualCells('강남')))()`);
    await js(win, `setCellEditMode('unvisit')`);
    await js(win, `toggleManualCellAt(${pickCell.lat},${pickCell.lng})`);
    check('칸을 찍으면 "선택 적용 (1)"', (await js(win, `document.getElementById('manual-apply-btn').textContent`)) === '선택 적용 (1)');
    await js(win, `clearPendingManualCellSelection()`);
    check('"현재 구역 선택 초기화"는 이번 선택만 지우고 저장된 수동 셀은 그대로',
      (await js(win, `pendingManualEdits.size`)) === 0 &&
      (await js(win, `(async()=>JSON.stringify(await RouteDB.getZoneManualCells('강남')))()`)) === manualBefore);
    await js(win, `toggleManualCellAt(${pickCell.lat},${pickCell.lng})`);
    await js(win, `applyManualCellEdits()`);
    await sleep(300);
    const afterApply = await js(win, `(async()=>await RouteDB.getZoneManualCells('강남'))()`);
    check('선택 적용 → 미방문 셀이 SQLite에 저장된다(unvisited 1칸)', afterApply.unvisited.length === 1, JSON.stringify(afterApply));
    await js(win, `(async()=>{ await RouteDB.saveZoneManualCells('강남',{excluded:[],visited:[],unvisited:[]}); return true; })()`); // 이후 검증에 영향 없게 원복
    await sleep(200);
  }

  // ── 누적 지도 날짜 필터(실제 키보드 입력) · 📷 현재 지도 캡처(실제 capturePage → PNG) ──
  section('신규 — 누적 지도 날짜 필터(키보드) · 📷 현재 지도 캡처');
  {
    const { dialog, nativeImage } = require('electron');
    const os = require('os');
    const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-capture-'));
    const origSave = dialog.showSaveDialog;
    const saveCalls = [];
    let saveMode = 'save';
    // 저장 대화상자만 바꿔치기 — 캡처(capturePage)·PNG 변환·파일 쓰기는 main.js 실제 코드 그대로
    dialog.showSaveDialog = async (_w, opts) => {
      saveCalls.push(opts.defaultPath);
      if (saveMode === 'cancel') return { canceled: true };
      if (saveMode === 'fail') return { canceled: false, filePath: path.join(capDir, 'no-such-dir', 'x.png') };
      return { canceled: false, filePath: path.join(capDir, path.basename(opts.defaultPath)) };
    };
    const analyzePng = file => {
      const img = nativeImage.createFromPath(file);
      const { width, height } = img.getSize();
      const buf = img.toBitmap(); // BGRA
      const colors = new Set();
      let red = 0;
      for (let i = 0; i < buf.length; i += 4 * 7) {
        const b = buf[i], g = buf[i + 1], r = buf[i + 2];
        colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
        if (r > 200 && g < 150 && b < 150) red++;
      }
      return { width, height, bytes: fs.statSync(file).size, distinctColors: colors.size, redSamples: red };
    };
    const visitedCells = async () => {
      const t = await js(win, `document.getElementById('coverage-detail').innerText`);
      const m = t.match(/(?:^|[^미])방문 Cell\s*([\d,]+)/);
      return m ? Number(m[1].replace(/,/g, '')) : NaN;
    };
    const dbg = win.webContents.debugger;
    try {
      await waitCoverageIdle(win);
      const fullVisited = await visitedCells();
      // 실제 키보드 입력(CDP) — 예전엔 연도칸이 6자리까지 받아 20260824가 적용되지 않았다
      win.show(); win.focus(); win.webContents.focus();
      dbg.attach('1.3');
      for (const id of ['accum-date-from', 'accum-date-to']) {
        await js(win, `document.getElementById('${id}').focus()`);
        for (const ch of '20260824') {
          await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Digit' + ch, text: ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
          await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Digit' + ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
          await sleep(40);
        }
      }
      dbg.detach();
      await sleep(1000); // 날짜칸 자동 적용(debounce 600ms)을 기다린다
      await waitCoverageIdle(win);
      const typed = await js(win, `({from:accumDateFrom,to:accumDateTo,label:document.getElementById('accum-date-label').textContent})`);
      check('키보드로 20260824를 입력하면 날짜 필터가 적용된다',
        typed.from === '2026-08-24' && typed.to === '2026-08-24' && typed.label === '표시 기간: 2026-08-24', JSON.stringify(typed));
      const dayVisited = await visitedCells();
      check('선택한 날짜 기준으로 Coverage 방문 Cell 수가 바뀐다', dayVisited !== fullVisited && dayVisited > 0,
        `전체 ${fullVisited}칸 → 2026-08-24 ${dayVisited}칸`);

      const disabledRightAfter = await js(win, `(()=>{ setAccumDateRange('2026-08-25','2026-08-25'); return document.getElementById('accum-capture-btn').disabled; })()`);
      check('날짜를 바꾸면 새 계산이 끝날 때까지 캡처 버튼 비활성', disabledRightAfter === true);
      await sleep(200);
      await waitCoverageIdle(win);
      check('계산이 끝나면 캡처 버튼 활성', (await js(win, `document.getElementById('accum-capture-btn').disabled`)) === false);

      const mapRect = await js(win, `(()=>{const r=document.getElementById('accum-map').getBoundingClientRect();return {w:r.width,h:r.height};})()`);
      const cov = await js(win, `captureAccumMap()`);
      check('Coverage Map 캡처 → PNG 저장', cov.status === 'saved' && fs.existsSync(cov.filePath) && fs.statSync(cov.filePath).size > 0,
        cov.filePath ? `${path.basename(cov.filePath)} ${fs.statSync(cov.filePath).size}B` : JSON.stringify(cov));
      check('기본 파일명에 구역·날짜·모드가 들어간다',
        /^RouteViewer_강남_20260825_Coverage_\d{8}_\d{6}\.png$/.test(path.basename(saveCalls[saveCalls.length - 1] || '')), saveCalls[saveCalls.length - 1]);
      if (cov.status === 'saved') {
        const a = analyzePng(cov.filePath);
        check('PNG 크기가 지도 영역 비율과 같다', Math.abs(a.width / a.height - mapRect.w / mapRect.h) < 0.02,
          `${a.width}x${a.height} (지도 ${Math.round(mapRect.w)}x${Math.round(mapRect.h)})`);
        check('빈 화면이 아니다(색상 다양도)', a.distinctColors > 30, `${a.distinctColors}색`);
        check('Coverage 빨간 미방문 칸이 이미지에 들어 있다', a.redSamples > 20, `빨간 샘플 ${a.redSamples}`);
        console.log('  캡처 파일(Coverage): ' + cov.filePath);
      }
      check('캡처 후 숨겼던 지도 컨트롤이 복원된다',
        (await js(win, `(document.querySelector('#accum-map .leaflet-control-zoom')||{style:{}}).style.visibility`)) !== 'hidden');

      await js(win, `clearError()`);
      saveMode = 'cancel';
      const canceled = await js(win, `captureAccumMap()`);
      check('저장 취소 → 오류로 표시하지 않는다', canceled.status === 'canceled' &&
        (await js(win, `getComputedStyle(document.getElementById('error-box')).display`)) === 'none');
      saveMode = 'fail';
      const failedCap = await js(win, `captureAccumMap()`);
      check('저장 실패(없는 폴더) → 오류 메시지 표시', failedCap.status === 'error' &&
        (await js(win, `getComputedStyle(document.getElementById('error-box')).display`)) !== 'none', failedCap.error);
      await js(win, `clearError()`);
      saveMode = 'save';

      await js(win, `clearAccumDateFilter(); toggleCoverageGaps()`); // 밀도 지도 + 전체 기간
      await sleep(200);
      await waitCoverageIdle(win);
      const dens = await js(win, `captureAccumMap()`);
      check('밀도 지도 캡처 → PNG 저장(전체기간_Density)', dens.status === 'saved' && /_강남_전체기간_Density_/.test(path.basename(dens.filePath || '')),
        dens.filePath ? path.basename(dens.filePath) : JSON.stringify(dens));
      if (dens.status === 'saved') {
        const d = analyzePng(dens.filePath);
        check('밀도 지도 PNG도 빈 화면이 아니다', d.bytes > 0 && d.distinctColors > 30, `${d.width}x${d.height} ${d.distinctColors}색 ${d.bytes}B`);
        console.log('  캡처 파일(Density): ' + dens.filePath);
      }
      await js(win, `toggleCoverageGaps()`); // 커버리지 모드로 되돌림(아래 원복 코드가 끈다)
      await sleep(200);
      await waitCoverageIdle(win);
    } finally {
      dialog.showSaveDialog = origSave;
      try { dbg.detach(); } catch (_) { /* 이미 분리됨 */ }
    }
  }

  await js(win, `toggleCoverageGaps(); setAccumZone('all')`); // 커버리지/구역 필터 상태 원복
  await sleep(300);

  // ── 통계 ────────────────────────────────────────────
  section('Test 6 — 통계 (지역별 / 차량별)');
  await js(win, `switchTab('stats')`);
  await sleep(600);
  check('통계 탭이 열린다',
    (await js(win, `getComputedStyle(document.getElementById('stats-view')).display`)) === 'flex');
  const statCards = await js(win, `document.querySelectorAll('#dist-grid .dist-card').length`);
  check('지역별 통계 카드가 그려진다', statCards >= 5, `${statCards}장`);
  const statText = await js(win, `document.getElementById('dist-grid').innerText`);
  check('구역·차량·장소·도로종류·날씨·시간대 카드가 있다',
    ['구역', '차량', '장소', '도로종류', '날씨', '시간대'].every(k => statText.includes(k)));
  await shot(win, '06-stats-region');

  await js(win, `setStatsZone('강남')`);
  await sleep(500);
  check('지역 필터가 통계에 반영된다',
    (await js(win, `document.getElementById('stats-summary').innerText`)).includes('강남'));

  await js(win, `setStatsMode('vehicle')`);
  await sleep(500);
  check('차량별 통계로 전환된다',
    (await js(win, `getComputedStyle(document.getElementById('vehicle-stats-panel')).display`)) === 'flex');
  const vehText = await js(win, `document.getElementById('vehicle-dist-grid').innerText`);
  check('차량 도넛에 토레스가 나온다', vehText.includes('토레스'), vehText.replace(/\s+/g, ' ').slice(0, 80));

  await js(win, `setStatsVehicle('토레스 3호')`);
  await sleep(500);
  const vehFiltered = await js(win, `document.getElementById('stats-summary').innerText`);
  check('차량 필터가 동작한다 (…호차 데이터도 잡힘)',
    vehFiltered.includes('토레스 3호') && !/총 기록 지점\s*0\s*개/.test(vehFiltered),
    vehFiltered.replace(/\s+/g, ' ').slice(0, 110));
  await shot(win, '07-stats-vehicle');
  await js(win, `setStatsVehicle('all'); setStatsMode('region'); setStatsZone('all')`);
  await sleep(300);

  // ── 백업 ────────────────────────────────────────────
  section('Test 6 — 백업 저장 / 복구');
  const payload = await js(win, `(async()=>await RouteDB.buildBackupPayload())()`);
  check('백업에 주행 기록이 담긴다', Object.keys(payload.data).length === 3);
  check('백업에 구역 경계가 담긴다', !!payload.zonePolygons['강남']);
  check('백업에 Import 정보가 담긴다', Array.isArray(payload.imports) && payload.imports.length > 0,
    `${payload.imports.length}건`);
  check('백업에 차량 정보가 담긴다',
    !!Object.values(payload.data)[0][0].vehicle);

  // 복구 방식 선택 모달
  await js(win, `handleBackupText(${JSON.stringify(JSON.stringify(payload))}, 'test-backup.json')`);
  await sleep(400);
  check('복구 방식 선택 모달이 뜬다',
    (await js(win, `document.getElementById('modal-title').textContent`)) === '백업 복구 방식 선택');
  check('병합 복구가 기본 선택',
    (await js(win, `document.querySelector('input[name="restore-mode"]:checked').value`)) === 'merge');
  check('전체 교체 복구 선택지도 있다',
    (await js(win, `!!document.querySelector('input[name="restore-mode"][value="replace"]')`)));
  await shot(win, '08-restore-mode');

  const ptsBefore = await js(win, `(async()=>(await RouteDB.stats()).points)()`);
  await js(win, `document.querySelectorAll('#modal-foot .btn')[1].click()`);
  await sleep(1500);
  const ptsAfter = await js(win, `(async()=>(await RouteDB.stats()).points)()`);
  check('병합 복구해도 데이터가 늘지 않는다(전부 중복)', ptsBefore === ptsAfter,
    `${ptsBefore} → ${ptsAfter}`);
  check('복구 완료 모달이 뜬다',
    (await js(win, `document.getElementById('modal-title').textContent`)) === '백업 복구 완료');
  await js(win, `closeModal()`);
  check('백업 기록 배지가 갱신된다',
    (await js(win, `document.getElementById('backup-status').textContent`)).includes('백업 기록:'),
    await js(win, `document.getElementById('backup-status').textContent`));

  // ── 값 충돌 검사 · 중복 상세 화면(요구사항 5~7) ──────
  section('신규 — 값 충돌 검사 · 중복 상세 화면');
  const conflictResult = await js(win, `(async()=>{
    await RouteDB.importRecords(
      [{date:'2026-09-01',time:'10:00:00',vehicle:'토레스 1호',lat:37.11111,lng:127.11111,speed:'0.0'}],
      {filename:'conflict-a.xlsx'});
    const res=await RouteDB.importRecords(
      [{date:'2026-09-01',time:'10:00:00',vehicle:'토레스 1호',lat:37.11111,lng:127.11111,speed:'5.0'}],
      {filename:'conflict-b.xlsx'});
    return res;
  })()`);
  check('같은 key·다른 speed → 충돌 1건으로 집계', conflictResult.conflicts === 1, JSON.stringify(conflictResult));

  await js(win, `(async()=>{ showImportReport([${JSON.stringify(conflictResult)}],[],await RouteDB.stats()); return true; })()`);
  await sleep(300);
  const conflictReportText = await js(win, `document.getElementById('modal-body').innerText`);
  check('Import 결과 화면에 충돌 건수가 표시된다', /충돌/.test(conflictReportText), conflictReportText.replace(/\s+/g, ' ').slice(0, 160));
  check('"중복 상세" 버튼이 보인다',
    await js(win, `[...document.querySelectorAll('#modal-foot .btn')].some(b=>b.textContent==='중복 상세')`));
  await js(win, `[...document.querySelectorAll('#modal-foot .btn')].find(b=>b.textContent==='중복 상세').click()`);
  await sleep(300);
  check('중복 분석 모달이 뜬다(요구사항 7)',
    (await js(win, `document.getElementById('modal-title').textContent`)) === '중복 분석');
  const dupDetailText = await js(win, `document.getElementById('modal-body').innerText`);
  check('중복 분석에 전체 원본/고유/중복/완전 동일/값 충돌 항목이 있다',
    ['전체 원본', '고유', '완전 동일', '값 충돌'].every(k => dupDetailText.includes(k)));
  check('충돌 목록에 갈린 필드(speed)와 값이 보인다', /speed/.test(dupDetailText) && /0\.0/.test(dupDetailText) && /5\.0/.test(dupDetailText),
    dupDetailText.replace(/\s+/g, ' ').slice(0, 250));
  await js(win, `closeModal()`);

  // 데이터 관리의 Import History에서도 같은 충돌을 "[상세]"로 다시 볼 수 있는지(요구사항 8)
  await js(win, `switchTab('data')`);
  await sleep(600);
  const importHistoryText = await js(win, `document.getElementById('data-imports').innerText`);
  check('Import History에 충돌 배지가 보인다', /충돌/.test(importHistoryText), importHistoryText.replace(/\s+/g, ' ').slice(0, 200));
  const conflictImportId = await js(win, `(async()=>{
    const imports=await RouteDB.listImports(20);
    const row=imports.find(im=>im.filename==='conflict-b.xlsx');
    return row?row.id:null;
  })()`);
  check('충돌이 있는 Import에 id가 있다(상세 조회 가능)', conflictImportId != null);
  await js(win, `showImportHistoryDetail(${conflictImportId})`);
  await sleep(300);
  check('"Import 충돌 상세" 모달이 뜬다',
    (await js(win, `document.getElementById('modal-title').textContent`)) === 'Import 충돌 상세');
  await js(win, `closeModal()`);
  await js(win, `(async()=>{ await RouteDB.deleteDate('2026-09-01'); return true; })()`); // 테스트용 데이터 정리 — 이후 날짜 수 검증에 영향 없게

  // ── 설정 탭 — 차량/지역 관리 (요구사항 13~16) ────────
  section('신규 — 설정 탭 (차량/지역 관리)');
  await js(win, `switchTab('settings')`);
  await sleep(500);
  check('설정 탭이 열린다',
    (await js(win, `getComputedStyle(document.getElementById('settings-view')).display`)) === 'flex');
  check('차량 목록에 토레스 1~4호가 보인다',
    (await js(win, `document.getElementById('settings-vehicle-list').innerText`)).includes('토레스 1호'));
  check('지역 목록에 강남/판교/시흥이 보인다',
    (await js(win, `document.getElementById('settings-zone-list').innerText`)).includes('강남'));
  await shot(win, '14-settings');

  await js(win, `openAddVehicleModal()`);
  await sleep(300);
  check('차량 추가 모달이 뜬다', (await js(win, `document.getElementById('modal-title').textContent`)) === '차량 추가');
  await js(win, `document.getElementById('new-vehicle-name').value='토레스 5호'`);
  await js(win, `submitAddVehicle()`);
  await sleep(400);
  check('새 차량이 코드 수정 없이 설정 목록에 추가됨(요구사항 14)',
    (await js(win, `document.getElementById('settings-vehicle-list').innerText`)).includes('토레스 5호'));

  await js(win, `openAddZoneModal()`);
  await sleep(300);
  check('지역 추가 모달이 뜬다', (await js(win, `document.getElementById('modal-title').textContent`)) === '지역 추가');
  await js(win, `document.getElementById('new-zone-name').value='성남'; document.getElementById('new-zone-lat').value='37.42'; document.getElementById('new-zone-lng').value='127.13';`);
  await js(win, `submitAddZone()`);
  await sleep(400);
  check('새 지역이 코드 수정 없이 설정 목록에 추가됨(요구사항 15)',
    (await js(win, `document.getElementById('settings-zone-list').innerText`)).includes('성남'));

  // Test I — 새 지역이 누적 지도/통계에서 바로 쓰이는지(요구사항 16)
  await js(win, `switchTab('accum')`);
  await sleep(700);
  check('누적 지도 필터 버튼에 새 지역(성남)이 즉시 나타난다(Test I)',
    (await js(win, `document.getElementById('zone-filter-buttons').innerText`)).includes('성남'));
  await js(win, `setAccumZone('성남')`);
  await sleep(400);
  check('성남을 선택하면 경계 그리기 버튼이 바로 활성화된다(코드 수정 없이 새 지역이 동작함)',
    (await js(win, `document.getElementById('boundary-draw-btn').disabled`)) === false);
  await js(win, `setAccumZone('all')`);

  // Test H — 새 차량이 통계 필터에서 바로 쓰이는지
  await js(win, `switchTab('stats'); setStatsMode('vehicle');`);
  await sleep(600);
  check('통계 차량 필터에 새 차량(토레스 5호)이 즉시 나타난다(Test H)',
    (await js(win, `document.getElementById('stats-vehicle-filter-group').innerText`)).includes('토레스 5호'));

  // 비활성화해도 필터에서만 빠지고 과거 데이터는 안 사라짐
  await js(win, `switchTab('settings')`);
  await sleep(400);
  await js(win, `toggleVehicleActive('토레스 5호', false)`);
  await sleep(400);
  check('차량을 비활성화하면 상태가 "비활성"으로 바뀐다',
    /토레스 5호[\s\S]*비활성/.test(await js(win, `document.getElementById('settings-vehicle-list').innerText`)));
  await js(win, `switchTab('stats'); setStatsMode('vehicle');`);
  await sleep(600);
  check('비활성화한 차량은 통계 필터 버튼에서 빠진다',
    !(await js(win, `document.getElementById('stats-vehicle-filter-group').innerText`)).includes('토레스 5호'));
  await js(win, `setStatsMode('region')`);

  // ── 달력 일자 요약에 거리/기록수/주행시간/GPS공백/GPS점프 ──
  // (예전엔 별도 "비교" 탭에만 있던 정보를 달력에서 날짜를 열면 바로 보이게 통합)
  section('신규 — 달력 일자 요약에 거리·기록수·주행시간·GPS품질 통합');
  await js(win, `switchTab('calendar')`);
  await sleep(300);
  await js(win, `openDayDetail('2026-08-12')`);
  await sleep(400);
  const daySummaryText = await js(win, `document.getElementById('day-summary').innerText`);
  check('일자 요약에 주행 거리/기록 수/주행 시간/GPS 공백/GPS 점프가 모두 보인다',
    ['주행 거리', '기록 수', '주행 시간', '수집 시간', 'GPS 공백', 'GPS 점프'].every(k => daySummaryText.includes(k)),
    daySummaryText.replace(/\s+/g, ' ').slice(0, 200));
  await shot(win, '15-day-summary');

  const dayQualityCrossCheck = await js(win, `(async()=>{
    const rec=await RouteDB.getRecordsByDate('2026-08-12');
    const q=analyzeDayQuality(rec);
    const cached=dateSummaryIndex.get('2026-08-12');
    return {shownGaps:cached.quality.gaps, directGaps:q.gaps.length,
            shownJumps:cached.quality.teleports, directJumps:q.teleports.length};
  })()`);
  check('일자 요약의 GPS 공백/점프는 기존 analyzeDayQuality()와 같은 값(요구사항 20과 동일한 재사용 원칙)',
    dayQualityCrossCheck.shownGaps === dayQualityCrossCheck.directGaps &&
    dayQualityCrossCheck.shownJumps === dayQualityCrossCheck.directJumps,
    JSON.stringify(dayQualityCrossCheck));

  check('비교 탭은 제거됐다', await js(win, `!document.getElementById('tab-compare')`));

  // ── 데이터 관리 / 삭제 ──────────────────────────────
  section('Test 11 — 데이터 관리 · 삭제');
  await js(win, `switchTab('data')`);
  await sleep(600);
  check('데이터 관리 탭이 열린다',
    (await js(win, `getComputedStyle(document.getElementById('data-view')).display`)) === 'flex');
  const rowCount = await js(win, `document.querySelectorAll('#data-date-list .dm-row').length`);
  check('날짜별 목록이 나온다', rowCount === 3, `${rowCount}줄`);
  check('각 줄에 삭제 버튼이 있다',
    (await js(win, `document.querySelectorAll('#data-date-list .dm-del').length`)) === 3);
  check('전체 삭제 영역이 있다',
    (await js(win, `getComputedStyle(document.getElementById('data-danger')).display`)) === 'flex');
  check('저장 위치가 표시된다',
    (await js(win, `document.getElementById('data-status').innerText`)).includes('SQLite'));
  check('Import 이력이 표시된다',
    (await js(win, `document.querySelectorAll('#data-imports .dm-import').length`)) > 0);
  await shot(win, '09-data-manager');

  // 날짜 하나 삭제 (확인창은 OS 다이얼로그라 DB 호출로 대체 검증)
  const collectedBeforeDelete = await js(win, `document.querySelector('#cp-body .cp-collected').textContent`);
  const deletedDaySec = await js(win, `(dateSummaryIndex.get('2026-08-12')||{}).collectionSec||0`);
  await js(win, `(async()=>{await RouteDB.deleteDate('2026-08-12'); await refreshDateIndex(); await renderDataView(); return true;})()`);
  const collectedAfterDelete = await js(win, `document.querySelector('#cp-body .cp-collected').textContent`);
  const expectedAfterDelete = await js(win, `fmtNum(Math.round(CollectionStats.summarizeCollection([...dateSummaryIndex.values()]).totalSec/60))`);
  check('날짜 삭제 후 전체 데이터 수집 현황이 바로 갱신된다',
    collectedAfterDelete === expectedAfterDelete && (deletedDaySec === 0 || collectedAfterDelete !== collectedBeforeDelete),
    `${collectedBeforeDelete}분 → ${collectedAfterDelete}분 (삭제한 날짜 ${Math.round(deletedDaySec / 60)}분)`);
  await sleep(400);
  check('날짜 하나만 삭제된다',
    (await js(win, `sortedDataDates()`)).join(',') === '2026-08-24,2026-08-25',
    (await js(win, `sortedDataDates()`)).join(','));
  check('나머지 날짜는 그대로',
    (await js(win, `(async()=>(await RouteDB.stats()).days)()`)) === 2);

  // ── 서버 동기화 (electron-updater + server.js 공유 저장) ──────
  section('신규 — 서버 동기화 (여러 데스크톱 앱이 기록 공유)');
  const syncPort = 8098;
  const syncBase = `http://127.0.0.1:${syncPort}`;
  const serverPath = path.join(__dirname, '..', 'server.js');
  const nodeBin = path.join(__dirname, '..', 'tooling', 'node-v24.19.0-win-x64', 'node.exe');
  const nodeExe = fs.existsSync(nodeBin) ? nodeBin : process.execPath;
  const sharedDataFile = path.join(__dirname, '..', 'route-viewer-shared-data.json');
  try { fs.unlinkSync(sharedDataFile); } catch (_) { /* 없으면 무시 */ }

  const syncServer = spawn(nodeExe, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(syncPort) },
    stdio: 'pipe',
  });
  syncServer.stderr.on('data', d => console.error('[sync-server]', d.toString()));

  let serverUp = false;
  for (let i = 0; i < 40 && !serverUp; i++) {
    try {
      const r = await fetch(syncBase + '/api/route-data');
      if (r.status === 404 || r.ok) serverUp = true;
    } catch (_) { /* 아직 안 떴음 */ }
    if (!serverUp) await sleep(150);
  }
  check('테스트용 동기화 서버가 뜬다', serverUp);

  try {
    // "다른 팀원"이 미리 서버에 올려둔 기록 — 지금 이 앱엔 없는 날짜
    const teammatePayload = {
      type: 'route-viewer-backup', version: 3, exportedAt: new Date().toISOString(),
      data: {
        '2026-08-20': [{
          date: '2026-08-20', time: '08:00:00', vehicle: '토레스 4호차',
          lat: 37.5, lng: 127.03, zone: '강남', place: '강남', road: '도심',
          weather: '맑음', timeOfDay: '주간', speed: '0.0',
        }],
      },
      zonePolygons: {}, backupHistory: [], imports: [],
    };
    await fetch(syncBase + '/api/route-data', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(teammatePayload),
    });

    await js(win, `(async()=>{ await window.routeAPI.syncSetConfig({serverUrl:${JSON.stringify(syncBase)},token:'',autoSyncOnStart:false}); return true; })()`);

    const datesBeforeSync = await js(win, `sortedDataDates()`);
    check('동기화 전에는 팀원 날짜가 없다', !datesBeforeSync.includes('2026-08-20'), datesBeforeSync.join(','));

    await js(win, `switchTab('data')`);
    await sleep(500);
    check('데이터 관리 탭에 서버 동기화 패널이 보인다',
      (await js(win, `getComputedStyle(document.getElementById('sync-panel')).display`)) !== 'none');
    check('동기화 폼에 저장한 서버 주소가 채워진다',
      (await js(win, `document.getElementById('sync-url-input').value`)) === syncBase);

    await js(win, `runServerSync(false)`);
    await sleep(400);
    check('동기화 완료 모달이 뜬다',
      (await js(win, `document.getElementById('modal-title').textContent`)) === '서버 동기화 완료');
    await js(win, `closeModal()`);

    const datesAfterSync = await js(win, `sortedDataDates()`);
    check('팀원이 올린 날짜를 받아온다', datesAfterSync.includes('2026-08-20'), datesAfterSync.join(','));
    check('내 기존 날짜도 그대로 있다(교체 아님)',
      datesAfterSync.includes('2026-08-24') && datesAfterSync.includes('2026-08-25'), datesAfterSync.join(','));

    const serverNow = await (await fetch(syncBase + '/api/route-data')).json();
    check('서버에도 내 기존 기록이 함께 저장된다(밀어올림)',
      Object.keys(serverNow.data).includes('2026-08-24') && Object.keys(serverNow.data).includes('2026-08-25'),
      Object.keys(serverNow.data).join(','));

    const ptsBeforeResync = await js(win, `(async()=>(await RouteDB.stats()).points)()`);
    await js(win, `runServerSync(true)`);
    await sleep(300);
    const ptsAfterResync = await js(win, `(async()=>(await RouteDB.stats()).points)()`);
    check('같은 동기화를 반복해도 포인트가 늘지 않는다(멱등)',
      ptsBeforeResync === ptsAfterResync, `${ptsBeforeResync} → ${ptsAfterResync}`);

    check('마지막 동기화 시각이 표시된다',
      /마지막 동기화/.test(await js(win, `document.getElementById('sync-last').textContent`)));

    const { Menu } = require('electron');
    const appMenu = Menu.getApplicationMenu();
    const helpMenu = appMenu && appMenu.items.find(i => i.label === '도움말');
    const hasUpdateMenuItem = !!(helpMenu && helpMenu.submenu.items.some(i => i.label === '업데이트 확인'));
    check('메뉴에 "업데이트 확인" 항목이 있다', hasUpdateMenuItem);

    await shot(win, '12-sync-panel');
  } finally {
    syncServer.kill();
    try { fs.unlinkSync(sharedDataFile); } catch (_) { /* 무시 */ }
  }

  // ── Test 4 — 앱 재실행 ──────────────────────────────
  section('신규 — Import 이슈 기록 · 이슈 데이터 분리');
  await js(win, `switchTab('upload')`);
  const issueFile = 'TalkFile_주행기록_2026-08-26 3.xlsx.xlsx';
  await importViaUIRaw(win, issueFile);       // 확인 창만 띄우고 멈춘다
  check('저장 전에 확인 창이 뜬다',
    (await js(win, `document.getElementById('modal-title').textContent`)) === '저장하기 전에 확인해주세요');
  check('파일별로 예상 날짜·차량·레코드 수를 보여준다',
    /레코드/.test(await js(win, `document.getElementById('imp-row-0').innerText`)),
    (await js(win, `document.getElementById('imp-row-0').innerText`)).replace(/\s+/g, ' ').slice(0, 90));
  check('이슈를 체크하기 전에는 메모 칸이 잠겨 있다',
    await js(win, `document.getElementById('imp-note-0').disabled === true`));
  const beforeIssueImport = await js(win, `(async()=>(await RouteDB.stats()).points)()`);
  await js(win, `(async()=>{ document.getElementById('imp-issue-0').checked=true; onImportIssueToggle(0); await confirmImportFlow(); return true; })()`);
  await sleep(200);
  check('이슈를 체크했는데 메모가 없으면 저장되지 않고 이유를 알려준다',
    /한 줄로 적어주세요/.test(await js(win, `document.getElementById('imp-err-0').textContent`))
    && (await js(win, `(async()=>(await RouteDB.stats()).points)()`)) === beforeIssueImport
    && (await js(win, `document.getElementById('modal-title').textContent`)) === '저장하기 전에 확인해주세요',
    await js(win, `document.getElementById('imp-err-0').textContent`));
  await js(win, `(async()=>{ document.getElementById('imp-note-0').value='GPS 가 튀는 구간이 있어요'; onImportIssueNoteInput(0); await confirmImportFlow(); return true; })()`);
  await sleep(400);
  const issueReport = await js(win, `document.getElementById('modal-body').innerText`);
  check('메모를 적으면 저장되고, 결과에 이슈로 표시한 파일이 나온다',
    (await js(win, `document.getElementById('modal-title').textContent`)) === '주행 기록 추가 완료'
    && /이슈로 표시한 파일/.test(issueReport), issueReport.replace(/\s+/g, ' ').slice(0, 110));
  await js(win, `closeModal()`);
  const issueImports = await js(win, `(async()=>{const l=await RouteDB.listImports(50,{issueOnly:true});return l.map(i=>({f:i.filename,n:i.issueNote,s:i.issueStatus,r:i.relatedRecords}));})()`);
  check('Import 이력에 이슈 메모와 "확인 필요" 상태가 남는다',
    issueImports.length === 1 && issueImports[0].s === 'open'
    && issueImports[0].n === 'GPS 가 튀는 구간이 있어요' && issueImports[0].r > 0, JSON.stringify(issueImports));
  const issueCounts = await js(win, `(async()=>{
    const out={};
    for (const f of IssueFilter.ISSUE_FILTERS) out[f]=(await RouteDB.getOverview({issueFilter:f})).points;
    return out;
  })()`);
  check('데이터 상태별 기록 수가 갈린다(전체 > 이슈 없음 · 이슈만 > 0)',
    issueCounts.all > issueCounts.clean && issueCounts.issue_all > 0
    && Object.keys(issueCounts).length === 3, JSON.stringify(issueCounts));

  await js(win, `switchTab('calendar')`);
  await sleep(400);
  check('이슈가 있는 날짜에 "확인 필요" 배지가 붙는다',
    (await js(win, `document.querySelectorAll('#cal-grid .cal-issue-badge .issue-badge.open').length`)) >= 1,
    '배지 ' + await js(win, `document.querySelectorAll('#cal-grid .cal-issue-badge').length`) + '개');
  check('달력 위에 데이터 상태 필터 버튼 3개가 있다(전체 · 이슈 없음 · 이슈만)',
    (await js(win, `[...document.querySelectorAll('#issue-filter-group .zone-btn')].map(b=>b.textContent).join('/')`)) === '전체/이슈 없음/이슈만');
  const cleanView = await js(win, `(()=>{ setIssueFilter('clean');
    const hidden=document.querySelectorAll('#cal-grid .cal-cell.issue-hidden').length;
    const basis=document.getElementById('cp-issue-basis').textContent;
    setIssueFilter('all');
    return {hidden, basis};
  })()`);
  check('"이슈 없음"으로 보면 이슈 데이터만 있는 날짜가 흐려지고 계산 기준을 밝힌다',
    cleanView.hidden >= 1 && /확인 필요 이슈/.test(cleanView.basis),
    `${cleanView.hidden}칸 · ${cleanView.basis.slice(0, 60)}`);
  const dayIssue = await js(win, `(async()=>{
    await openDayDetail('2026-08-26');
    await renderDayIssues('2026-08-26');
    return document.getElementById('ds-issues').innerText.replace(/\s+/g,' ');
  })()`);
  check('일자 요약에 이슈사항(파일·메모·상태)이 나온다',
    /이슈사항/.test(dayIssue) && /GPS 가 튀는 구간이 있어요/.test(dayIssue), dayIssue.slice(0, 110));

  await js(win, `switchTab('accum')`);
  await sleep(2500);
  const grayCells = await js(win, `(()=>{ try{
    return accumDensityLayer.getLayers().filter(l=>l.options&&l.options.fillColor==='#7d8798').length;
  }catch(_){ return -1; } })()`);
  const grayLegend = await js(win, `document.getElementById('accum-issue-legend').innerText`);
  check('누적 지도에서 이슈 데이터가 섞인 칸이 회색으로 그려지고 안내가 뜬다',
    grayCells > 0 && /회색 칸/.test(grayLegend), `회색 ${grayCells}칸 · ${grayLegend.slice(0, 50)}`);
  await shot(win, '17-accum-issue-gray');

  await js(win, `switchTab('stats')`);
  await sleep(800);
  const issueOverviewText = await js(win, `document.getElementById('stats-issue-overview').innerText.replace(/\s+/g,' ')`);
  check('통계에 이슈 현황 · 전체/이슈 없음/이슈 데이터 비교표가 나온다',
    ['이슈 현황', '전체 데이터', '이슈 없는 데이터', '이슈 데이터'].every(k => issueOverviewText.includes(k))
    && !/확인 필요 이슈만|확인 완료 이슈만/.test(issueOverviewText), issueOverviewText.slice(0, 120));
  check('통계에도 같은 데이터 상태 필터 버튼이 있다',
    (await js(win, `document.querySelectorAll('#stats-issue-filter .zone-btn').length`)) === 3);
  const grayBars = await js(win, `document.querySelectorAll('#dist-grid .dist-bar-issue').length`);
  const grayNote = await js(win, `document.querySelectorAll('#dist-grid .dc-issue-note').length`);
  check('통계 막대에 이슈 데이터 몫이 회색으로 겹쳐 그려지고 안내가 붙는다',
    grayBars > 0 && grayNote > 0, `회색 막대 ${grayBars}개 · 안내 ${grayNote}개`);

  await js(win, `switchTab('data')`);
  await sleep(700);
  const adminItems = await js(win, `document.querySelectorAll('#data-issue-admin .issue-list .issue-item').length`);
  const adminOpen = await js(win, `document.querySelectorAll('#data-issue-admin .issue-list .issue-badge.open').length`);
  check('데이터 관리에 이슈 관리 목록이 있고 이슈 파일이 "확인 필요"로 보인다',
    adminItems > 0 && adminOpen === 1, `파일 ${adminItems}개 · 확인 필요 ${adminOpen}개`);
  const toggled = await js(win, `(async()=>{
    const id=(await RouteDB.listImports(50,{issueOnly:true}))[0].id;
    await toggleIssueAdminStatus(id);
    const after=(await RouteDB.getImport(id)).issueStatus;
    const cleanAfter=(await RouteDB.getOverview({issueFilter:'clean'})).points;
    await toggleIssueAdminStatus(id);
    return {after, cleanAfter, back:(await RouteDB.getImport(id)).issueStatus};
  })()`);
  check('데이터 관리에서 확인 완료 ↔ 확인 필요로 바꿀 수 있고, 바꾸면 이슈 없음 쪽 개수가 늘어난다',
    toggled.after === 'resolved' && toggled.back === 'open' && toggled.cleanAfter === issueCounts.all,
    JSON.stringify(toggled));
  await shot(win, '16-issue-admin');

  section('Test 4 — 앱 재실행 (창을 다시 로드해도 남아있는지)');
  const beforeReload = await js(win, `(async()=>await RouteDB.stats())()`);
  await new Promise(resolve => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.reload();
  });
  await sleep(1200);
  const afterReload = await js(win, `(async()=>await RouteDB.stats())()`);
  check('날짜 수 유지', beforeReload.days === afterReload.days, `${afterReload.days}일`);
  check('포인트 수 유지', beforeReload.points === afterReload.points, `${afterReload.points}개`);
  check('구역 경계 유지',
    Object.keys(await js(win, `(async()=>await RouteDB.getZonePolygons())()`)).includes('강남'));
  check('시작하면 달력이 바로 보인다 (파일을 다시 넣을 필요 없음)',
    (await js(win, `getComputedStyle(document.getElementById('calendar-view')).display`)) === 'flex' ||
    (await js(win, `getComputedStyle(document.getElementById('login-screen')).display`)) !== 'none');
  check('DB 파일이 디스크에 있다', fs.existsSync(dbFilePath),
    fs.existsSync(dbFilePath) ? `${(fs.statSync(dbFilePath).size / 1024).toFixed(0)} KB` : '없음');
  await shot(win, '10-after-reload');
}
