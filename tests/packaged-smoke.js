// 패키징된 앱(release/win-unpacked)에서도 SQLite(WASM)와 화면이 제대로 도는지 확인.
// asar 안에 들어간 뒤 .wasm 로드나 경로가 깨지는 일이 흔해서 따로 본다.
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];
const consoleErrors = [];

// 패키징된 앱은 GUI라 stdout이 콘솔에 안 붙는다 → 결과를 파일로 남긴다
const LOG = process.env.ROUTE_VIEWER_SMOKE_LOG || path.join(__dirname, 'packaged-smoke.log');
try { fs.writeFileSync(LOG, ''); } catch (_) { /* 무시 */ }
function log(line) {
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch (_) { /* 무시 */ }
}

function check(name, cond, detail) {
  if (cond) { passed++; log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = function run({ app, mainWindow, dbFilePath }) {
  const win = mainWindow;
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) {
      const text = `${message} (${source}:${line})`;
      if (!/favicon|ERR_|fonts\.googleapis|basemaps\.cartocdn|Autofill|Security Warning/i.test(text)) {
        consoleErrors.push(text);
      }
    }
  });

  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    try {
      await sleep(1200);
      log('== 패키징된 앱 스모크 테스트');

      check('앱 버전', /^\d+\.\d+\.\d+$/.test(app.getVersion()), app.getVersion());
      check('asar 로 패키징됨', app.getAppPath().endsWith('app.asar'), app.getAppPath());

      // 로그인 통과
      await js(`(()=>{document.getElementById('login-name-input').value='양은규';updateLoginButton();submitLogin();return true;})()`);
      check('로그인 화면 통과',
        await js(`document.getElementById('login-screen').classList.contains('hidden')`));

      check('저장소가 SQLite 로 연결됨',
        (await js(`document.getElementById('storage-badge').textContent`)) === 'SQLite');
      check('DB 파일이 만들어짐', fs.existsSync(dbFilePath()), dbFilePath());

      // 실제 엑셀 import — 파일은 앱 밖(개발 폴더)에서 읽는다
      const xlsx = path.join(__dirname, '..', '주행기록', '주행기록_2026-08-12.xlsx');
      const b64 = fs.readFileSync(xlsx).toString('base64');
      await js(`(async()=>{
        const bin=atob(${JSON.stringify(b64)});
        const bytes=new Uint8Array(bin.length);
        for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        await handleFiles([new File([bytes],'주행기록_2026-08-12.xlsx')]);
        return true;
      })()`);
      await sleep(600);

      const stats = await js(`(async()=>await RouteDB.stats())()`);
      check('패키징된 앱에서 import 성공', stats.points === 16 && stats.days === 1,
        `${stats.days}일 / ${stats.points}포인트`);
      check('SQLite 파일에 기록됨', stats.dbBytes > 0, `${(stats.dbBytes / 1024).toFixed(0)} KB`);

      // 두 번째 import — 중복 제거가 패키징 후에도 동작하는지
      await js(`closeModal()`);
      await js(`(async()=>{
        const bin=atob(${JSON.stringify(b64)});
        const bytes=new Uint8Array(bin.length);
        for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        await handleFiles([new File([bytes],'주행기록_2026-08-12.xlsx')]);
        return true;
      })()`);
      await sleep(600);
      const stats2 = await js(`(async()=>await RouteDB.stats())()`);
      check('중복 제거 동작', stats2.points === 16, `${stats2.points}포인트`);
      await js(`closeModal()`);

      // 화면들이 그려지는지
      await js(`switchTab('calendar')`); await sleep(300);
      check('달력이 그려짐',
        (await js(`document.querySelectorAll('#cal-grid .cal-cell.has-data').length`)) === 1);
      await js(`switchTab('accum')`); await sleep(900);
      check('누적 지도가 그려짐', (await js(`accumCells.length`)) > 0,
        `${await js(`accumCells.length`)}칸`);
      await js(`switchTab('stats')`); await sleep(700);
      check('통계가 그려짐',
        (await js(`document.querySelectorAll('#dist-grid .dist-card').length`)) >= 5);
      await js(`switchTab('data')`); await sleep(500);
      check('데이터 관리가 그려짐',
        (await js(`document.querySelectorAll('#data-date-list .dm-row').length`)) === 1);
      await js(`switchTab('settings')`); await sleep(500);
      check('설정 탭(차량/지역 관리)이 asar 패키지에서도 그려짐',
        (await js(`document.getElementById('settings-vehicle-list').innerText`)).includes('토레스 1호'));
      await js(`switchTab('calendar'); openDayDetail('2026-08-12')`); await sleep(500);
      check('일자 요약(거리·기록수·주행시간)이 asar 패키지에서도 그려짐',
        (await js(`document.getElementById('day-summary').innerText`)).includes('주행 거리'));

      try {
        fs.mkdirSync(path.join(__dirname, 'screenshots'), { recursive: true });
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'screenshots', '11-packaged.png'), img.toPNG());
      } catch (_) { /* 캡처 실패는 테스트 실패가 아님 */ }
    } catch (err) {
      failed++; failures.push('예외: ' + err.message);
      log('  예외: ' + (err && err.stack || err));
    }

    log(`  통과 ${passed} / 실패 ${failed}`);
    if (consoleErrors.length) {
      log('  화면 콘솔 에러:');
      [...new Set(consoleErrors)].slice(0, 10).forEach(e => log('   ! ' + e));
    }
    failures.forEach(f => log('   - ' + f));
    app.exit(failed || consoleErrors.length ? 1 : 0);
  });
};
