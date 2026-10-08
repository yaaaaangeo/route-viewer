// ══════════════════════════════════════════════════════════
//  auto-import-e2e — 실제 Electron 화면에서 자동 가져오기 반영 경로를 확인한다.
//
//  ⚠ 실제 주행 DB(%APPDATA%\Route Viewer)를 건드리지 않도록 userData 를 임시 폴더로 바꾼 뒤
//    electron/main.js 를 불러온다. 감시 폴더도 임시 폴더다.
//
//    1) 앱 시작 시 확인 → 기존 파일 반영 → 달력 날짜 색인·처리 현황에 보인다
//    2) 날짜 상세(차량 탭)를 열어 둔 채 새 파일이 들어와도 선택한 날짜·차량이 그대로다
//    3) 데이터 관리 패널에 "새 파일 N개 반영 / 이미 처리 N개 / 실패 N개"와 "검토 전"이 보인다
//
//  실행: npx electron tests/auto-import-e2e.js
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { app } = require('electron');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-autoimport-e2e-'));
const USER_DATA = path.join(TMP, 'userData');
const DRIVE = path.join(TMP, 'drive');
fs.mkdirSync(DRIVE, { recursive: true });
app.setPath('userData', USER_DATA);

function routeXlsx(vehicle, date, startMin, count, latBase) {
  const rows = [['차량', vehicle, '이름', '테스트'], [],
    ['번호', '날짜', '시각', 'GPS위치', '도로종류', '날씨', '시간대', '장소', '교통밀도', '차량속도(km/h)']];
  for (let i = 0; i < count; i++) {
    const m = startMin + i;
    const t = `${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
    rows.push([i + 1, date, t, `${(latBase + i * 0.0003).toFixed(6)}, ${(127.03 + i * 0.0003).toFixed(6)}`, '일반', '맑음', '주간', '강남구', '보통', 30]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function writeOld(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  const t = new Date(Date.now() - 60000);
  fs.utimesSync(file, t, t);
}

// 시작 전에 테스트 DB 에 폴더 연결(전체 가져오기)을 미리 해 둔다 — 대화상자 없이 시작 시 확인을 본다
writeOld(path.join(DRIVE, 'a.xlsx'), routeXlsx('토레스 1호차', '2026-10-01', 0, 10, 37.50));
writeOld(path.join(DRIVE, 'sub', 'b.xlsx'), routeXlsx('토레스 2호차', '2026-10-01', 0, 10, 37.51));
writeOld(path.join(DRIVE, 'bad.xlsx'), Buffer.from('not an excel'));
{
  const { RouteDatabase } = require('../electron/database.js');
  const db = new RouteDatabase(path.join(USER_DATA, 'database', 'route-viewer.db'));
  db.setAutoImportConfig({ folder: DRIVE, enabled: true, initialMode: 'all', connectedAt: new Date().toISOString() });
  db.close();
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// main.js 가 require(ROUTE_VIEWER_E2E) 로 이 모듈의 드라이버를 부른다
process.env.ROUTE_VIEWER_E2E = __filename;
module.exports = ({ mainWindow, dbFilePath }) => {
    const win = mainWindow;
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    win.webContents.once('did-finish-load', async () => {
      const js = code => win.webContents.executeJavaScript(code);
      const waitFor = async (code, ms = 20000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await js(code)) return true; await sleep(250); }
        return false;
      };
      try {
        check('테스트 DB 사용(실제 DB 아님)', dbFilePath().startsWith(USER_DATA), dbFilePath());
        // 1) 시작 시 확인
        const ok = await waitFor("typeof dateSummaryIndex!=='undefined'&&dateSummaryIndex.has('2026-10-01')");
        check('앱 시작 시 확인 → 달력 날짜 색인에 반영', ok);
        const toast = await js("document.getElementById('toast').textContent");
        check('반영 알림 표시', /새 파일 2개 반영/.test(toast), toast);
        // 0) 접근 권한 — 저장된 명단이 없으면 기본 명단, 명단에 없는 이름은 못 들어온다
        await waitFor("!document.getElementById('login-screen').classList.contains('hidden')");
        await js("document.getElementById('login-name-input').value='홍길동';submitLogin()");
        await sleep(300);
        check('명단에 없는 이름은 거부', await js("!document.getElementById('login-screen').classList.contains('hidden')&&document.getElementById('login-error').style.display==='block'"));
        await js("document.getElementById('login-name-input').value=' 양은규 ';submitLogin()");
        await sleep(300);
        check('명단 이름으로 로그인', await js("document.getElementById('login-screen').classList.contains('hidden')&&currentUserName()==='양은규'"));
        await js("switchTab('settings')");
        await sleep(500);
        await js("document.getElementById('settings-user-input').value='홍길동';addAllowedUserFromInput()");
        await sleep(400);
        const saved = await js('RouteDB.getSettings().then(s=>s.allowedUsers)');
        check('설정에서 권한 추가 → DB 저장', JSON.stringify(saved) === JSON.stringify(['양은규', '홍길동']), JSON.stringify(saved));
        check('설정 화면 명단 표시', /홍길동/.test(await js("document.getElementById('settings-user-list').innerText")));
        await js("logoutUser();document.getElementById('login-name-input').value='홍길동';submitLogin()");
        await sleep(300);
        check('추가한 이름으로 로그인', await js("currentUserName()==='홍길동'"));
        await js("saveAllowedUsers(['양은규'])");
        await sleep(400);
        check('권한 해제하면 바로 로그인 화면(해제된 이름)', await js("!document.getElementById('login-screen').classList.contains('hidden')&&currentUserName()===''"));
        await js("document.getElementById('login-name-input').value='양은규';submitLogin()");
        await sleep(300);
        await js("switchTab('calendar')");
        await sleep(300);
        const badge = await js("document.getElementById('cp-drive').innerText");
        check('달력에 Google Drive 몇 월 며칠까지 표시', /2026년 10월 1일 주행분까지/.test(badge), badge);
        // 2) 날짜 상세 + 차량 탭을 열어 둔 채 새 파일
        await js("openDayDetail('2026-10-01')");
        await sleep(800);
        await js("selectDayVehicleTab('veh:토레스 2호차')");
        writeOld(path.join(DRIVE, 'c.xlsx'), routeXlsx('토레스 3호차', '2026-10-02', 0, 8, 37.52));
        await js('window.routeAPI.autoImportRunNow()');
        const ok2 = await waitFor("dateSummaryIndex.has('2026-10-02')");
        check('새 파일 → 달력 색인 갱신', ok2);
        const sel = await js("({date:document.getElementById('chip-filename').textContent,tab:daySummaryTab,console:document.getElementById('console').style.display})");
        check('보고 있던 날짜·차량 유지', sel.date === '2026-10-01' && sel.tab === 'veh:토레스 2호차' && sel.console !== 'none', JSON.stringify(sel));
        // 3) 데이터 관리 패널
        await js("switchTab('data')");
        await waitFor("document.querySelector('#auto-import-panel .ai-summary')!==null");
        const panel = await js("document.getElementById('auto-import-panel').innerText");
        check('패널에 Drive 마지막 날짜(새 파일 반영 후 갱신)', /2026년 10월 2일 주행분까지/.test(panel), panel.split('\n').find(l => /주행분까지/.test(l)));
        check('처리 현황 문구', /새 파일 1개 반영 \/ 이미 처리 2개 \/ 실패 1개/.test(panel), panel.split('\n').find(l => /반영/.test(l)));
        check('파일별 이력·검토 전 표시', /c\.xlsx/.test(panel) && /검토 전/.test(panel) && /bad\.xlsx/.test(panel));
        check('실패 재시도 버튼', /실패 파일 다시 시도/.test(panel));
        const issueAdmin = await js("document.getElementById('data-issue-admin').innerText");
        check('이슈 관리에 "자동 · 검토 전"(이슈 없음 확인으로 표시 안 함)', /자동 · 검토 전/.test(issueAdmin));
        await js("document.getElementById('login-screen').classList.add('hidden');document.getElementById('auto-import-panel').scrollIntoView()");
        await sleep(400);
        await win.webContents.capturePage().then(img => fs.writeFileSync(path.join(TMP, 'data-view.png'), img.toPNG()));
        console.log('  screenshot:', path.join(TMP, 'data-view.png'));
        check('화면 콘솔 에러 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
      } catch (err) {
        check('예외 없음', false, err && err.stack);
      }
      console.log(`\n${passed} passed, ${failed} failed`);
      app.exit(failed ? 1 : 0);
    });
};

require('../electron/main.js');
