// ══════════════════════════════════════════════════════════
//  browser-capture-e2e — 브라우저 모드(server.js + IndexedDB)에서 "📷 현재 지도 캡처"가
//  실제로 PNG를 만드는지 검증한다.
//
//  Electron을 그냥 "브라우저"로 쓴다: preload 없는 창으로 http://127.0.0.1:<port>/src/index.html
//  을 열면 window.routeAPI가 없어서 앱이 브라우저 모드(IndexedDB)로 돈다. 캡처는 캔버스 합성
//  경로를 타고, 다운로드는 will-download로 임시 폴더에 받아 픽셀을 검사한다.
//  (배경 지도 타일은 인터넷의 basemaps.cartocdn.com에서 CORS로 받는다 — OSM 공식 타일 서버는
//   앱을 차단해서 "Access blocked" 403 이미지가 온다)
//
//  실행:  npm run test:browser-capture
// ══════════════════════════════════════════════════════════
'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const XLSX_DIR = path.join(ROOT, '주행기록');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function analyzePng(file) {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const buf = img.toBitmap(); // BGRA
  const colors = new Set();
  let red = 0, pink = 0, grayish = 0, samples = 0;
  for (let i = 0; i < buf.length; i += 4 * 7) {
    const b = buf[i], g = buf[i + 1], r = buf[i + 2];
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    if (r > 200 && g < 150 && b < 150) red++;           // Coverage 미방문 칸 #ff6b6b
    if (r > 220 && g < 175 && b > 160 && b < 230) pink++; // 강남 밀도 원 #ff7ab6
    if (Math.max(r, g, b) - Math.min(r, g, b) < 40) grayish++; // 화면처럼 흑백 필터가 걸린 배경
    samples++;
  }
  return { width, height, bytes: fs.statSync(file).size, distinctColors: colors.size, redSamples: red, pinkSamples: pink, grayishRatio: grayish / samples };
}

app.whenReady().then(async () => {
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-browser-capture-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'pipe',
  });
  server.stderr.on('data', d => console.error('[server]', String(d)));
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(BASE + '/src/index.html')).ok; } catch (_) { /* 아직 안 떴음 */ }
      if (!up) await sleep(150);
    }
    check('브라우저 모드 서버(server.js)가 뜬다', up);

    const win = new BrowserWindow({ width: 1280, height: 900, show: true, webPreferences: { partition: 'rv-browser-capture-' + Date.now() } });
    let waiting = null;
    win.webContents.session.on('will-download', (_e, item) => {
      const file = path.join(dlDir, item.getFilename());
      item.setSavePath(file);
      item.once('done', (_ev, state) => { if (waiting) { waiting({ file, state }); waiting = null; } });
    });
    const nextDownload = () => new Promise(resolve => { waiting = resolve; setTimeout(() => resolve(null), 30000); });
    const js = code => win.webContents.executeJavaScript(code, true);
    const waitIdle = async (ms = 150000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await js(`!accumRendering&&coverageCacheKey===accumViewKey()`)) return true;
        await sleep(200);
      }
      return false;
    };

    await win.loadURL(`${BASE}/src/index.html`);
    await sleep(800);
    check('preload 없이 열면 브라우저 모드(IndexedDB)로 돈다', await js(`!window.routeAPI && RouteDB.kind==='indexeddb'`));
    await js(`document.getElementById('login-name-input').value='양은규'; updateLoginButton(); submitLogin();`);
    for (const f of ['주행기록_2026-08-24 4.xlsx', 'TalkFile_주행기록_2026-08-25 2.xlsx.xlsx']) {
      const b64 = fs.readFileSync(path.join(XLSX_DIR, f)).toString('base64');
      await js(`(async()=>{const bin=atob(${JSON.stringify(b64)});const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);await handleFiles([new File([u],${JSON.stringify(f)})]);closeModal();return 1;})()`);
    }
    // 달력 맨 위 "전체 데이터 수집 현황" — 브라우저 모드(IndexedDB 날짜 요약)에서도 같은 규칙으로 표시
    await js(`switchTab('calendar')`);
    const cpBrowser = await js(`({
      first:document.getElementById('calendar-view').firstElementChild.id,
      collected:document.querySelector('#cp-body .cp-collected').textContent,
      expected:fmtNum(Math.round(CollectionStats.summarizeCollection([...dateSummaryIndex.values()]).totalSec/60)),
      text:document.getElementById('cp-body').innerText.replace(/\\s+/g,' ')})`);
    check('브라우저 모드(IndexedDB)에서도 달력 맨 위 수집 현황 = 날짜 요약 유효 수집 시간 합',
      cpBrowser.first === 'collection-progress' && cpBrowser.collected === cpBrowser.expected && cpBrowser.collected !== '0', cpBrowser.text);
    // 이 테스트는 다운로드 경로를 검증한다(파일 저장 창은 자동화할 수 없어 단위 테스트에서 검증)
    await js(`window.showSaveFilePicker = undefined; switchTab('accum')`);
    await sleep(300);
    await waitIdle();
    check('브라우저 모드에서도 캡처 버튼이 활성', await js(`mapCaptureMode()==='browser' && !document.getElementById('accum-capture-btn').disabled`),
      await js(`document.getElementById('accum-capture-btn').title`));
    const mapRect = await js(`(()=>{const r=document.getElementById('accum-map').getBoundingClientRect();return {w:r.width,h:r.height,dpr:window.devicePixelRatio};})()`);

    // ── 밀도 지도 ──
    const dl1 = nextDownload();
    const dens = await js(`captureAccumMap()`);
    const d1 = await dl1;
    check('밀도 지도 캡처 → PNG 다운로드', dens.status === 'saved' && dens.mode === 'browser' && dens.savedVia === 'download' &&
      d1 && d1.state === 'completed' && fs.statSync(d1.file).size > 0,
      JSON.stringify({ status: dens.status, error: dens.error, tiles: dens.tiles, layers: dens.layers, file: d1 && path.basename(d1.file) }));
    check('합성에 배경 타일과 Canvas Layer가 쓰였다', dens.tiles > 0 && dens.layers > 0, `타일 ${dens.tiles}장 · Canvas Layer ${dens.layers}개`);
    if (d1 && d1.state === 'completed') {
      const a = analyzePng(d1.file);
      check('파일명 규칙(강남·전체기간·Density)', /^RouteViewer_강남_전체기간_Density_\d{8}_\d{6}\.png$/.test(path.basename(d1.file)), path.basename(d1.file));
      check('이미지 크기 = 지도 영역 × 화면 배율', Math.abs(a.width - Math.round(mapRect.w * mapRect.dpr)) <= 2 && Math.abs(a.height - Math.round(mapRect.h * mapRect.dpr)) <= 2,
        `${a.width}x${a.height} (지도 ${Math.round(mapRect.w)}x${Math.round(mapRect.h)} × ${mapRect.dpr})`);
      check('배경 지도 타일이 들어 있다(CORS로 받아 캔버스가 오염되지 않음)', a.distinctColors > 30, `${a.distinctColors}색`);
      check('밀도 원(강남 분홍)이 들어 있다', a.pinkSamples > 20, `분홍 샘플 ${a.pinkSamples}`);
      check('배경 지도 색이 화면과 같다(타일 흑백 CSS filter 반영 — 대부분 무채색)', a.grayishRatio > 0.6,
        `무채색 비율 ${(a.grayishRatio * 100).toFixed(0)}%`);
      console.log('  캡처 파일(브라우저 · Density): ' + d1.file);
    }

    // ── Coverage Map + 날짜 ──
    await js(`ZONE_POLYGONS['강남']=[[37.492,127.020],[37.535,127.020],[37.535,127.055],[37.492,127.055]]; saveZonePolygonsToStorage(); toggleCoverageGaps();`);
    await sleep(300);
    await waitIdle();
    await js(`setAccumDateRange('2026-08-25','2026-08-25')`);
    await sleep(200);
    await waitIdle();
    const dl2 = nextDownload();
    const cov = await js(`captureAccumMap()`);
    const d2 = await dl2;
    check('Coverage Map 캡처 → PNG 다운로드(파일명에 날짜·Coverage)',
      cov.status === 'saved' && d2 && d2.state === 'completed' && /^RouteViewer_강남_20260825_Coverage_\d{8}_\d{6}\.png$/.test(path.basename(d2.file)),
      JSON.stringify({ status: cov.status, error: cov.error, file: d2 && path.basename(d2.file) }));
    if (d2 && d2.state === 'completed') {
      const a = analyzePng(d2.file);
      check('빨간 미방문 칸과 배경 타일이 들어 있다', a.redSamples > 20 && a.distinctColors > 30, `빨간 샘플 ${a.redSamples} · ${a.distinctColors}색 · ${a.width}x${a.height}`);
      console.log('  캡처 파일(브라우저 · Coverage): ' + d2.file);
    }
    check('캡처 후 버튼 다시 활성 · 오류 표시 없음',
      !(await js(`document.getElementById('accum-capture-btn').disabled`)) &&
      (await js(`getComputedStyle(document.getElementById('error-box')).display`)) === 'none');
  } catch (err) {
    failed++;
    failures.push('예외: ' + err.message);
    console.error(err);
  } finally {
    server.kill();
    console.log(`\n${'-'.repeat(58)}`);
    console.log(`  통과 ${passed} / 실패 ${failed}`);
    failures.forEach(f => console.log('   - ' + f));
    console.log(`${'-'.repeat(58)}\n`);
    app.exit(failed ? 1 : 0);
  }
});
