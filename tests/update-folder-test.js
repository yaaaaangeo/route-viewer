// ══════════════════════════════════════════════════════════
//  update-folder-test — 업데이트 폴더에서 새 버전 찾기(electron/update-folder.js)
//  임시 폴더에 가짜 latest.yml · 설치 파일을 만들어 확인한다(실제 release 폴더는 건드리지 않음).
//  실행: node tests/update-folder-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const UF = require('../electron/update-folder.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-update-'));
const installerBytes = crypto.randomBytes(4096);
const sha = crypto.createHash('sha512').update(installerBytes).digest('base64');
const yml = (version, file, sha512) => `version: ${version}
files:
  - url: ${file}
    sha512: ${sha512}
    size: ${installerBytes.length}
path: ${file}
sha512: ${sha512}
releaseDate: '2026-10-09T01:00:00.000Z'
`;

(async () => {
  check('버전 비교', UF.compareVersions('3.1.4', '3.1.3') > 0 && UF.compareVersions('3.1.3', '3.1.3') === 0
    && UF.compareVersions('3.2.0', '3.10.0') < 0 && UF.compareVersions('v4.0.0', '3.9.9') > 0);
  const parsed = UF.parseLatestYml(yml('3.1.4', 'RouteViewer-3.1.4-win-x64.exe', sha));
  check('latest.yml 읽기(들여쓴 files 목록은 무시)', parsed.version === '3.1.4' && parsed.path === 'RouteViewer-3.1.4-win-x64.exe'
    && parsed.sha512 === sha && parsed.releaseDate === '2026-10-09T01:00:00.000Z', JSON.stringify(parsed));

  check('폴더 없음', (await UF.checkUpdateFolder(path.join(TMP, 'nope'), '3.1.3')).status === 'no-folder');
  check('폴더 미지정', (await UF.checkUpdateFolder('', '3.1.3')).status === 'no-folder');
  check('latest.yml 없음(아직 빌드 전)', (await UF.checkUpdateFolder(TMP, '3.1.3')).status === 'no-info');

  fs.writeFileSync(path.join(TMP, 'latest.yml'), yml('3.1.3', 'RouteViewer-3.1.3-win-x64.exe', sha));
  check('같은 버전이면 최신', (await UF.checkUpdateFolder(TMP, '3.1.3')).status === 'latest');
  check('폴더 버전이 더 낮아도 최신(내려가지 않음)', (await UF.checkUpdateFolder(TMP, '3.2.0')).status === 'latest');

  fs.writeFileSync(path.join(TMP, 'latest.yml'), yml('3.1.4', 'RouteViewer-3.1.4-win-x64.exe', sha));
  check('새 버전인데 설치 파일이 없으면 알려줌', (await UF.checkUpdateFolder(TMP, '3.1.3')).status === 'missing-installer');

  fs.writeFileSync(path.join(TMP, 'RouteViewer-3.1.4-win-x64.exe'), installerBytes.subarray(0, 1000));   // 복사 중인 반쪽 파일
  const u = await UF.checkUpdateFolder(TMP, '3.1.3');
  check('새 버전 찾기', u.status === 'newer' && u.version === '3.1.4' && u.currentVersion === '3.1.3'
    && u.installer === path.join(TMP, 'RouteViewer-3.1.4-win-x64.exe'), JSON.stringify(u));
  const half = await UF.verifyInstaller(u);
  check('복사가 덜 된 설치 파일은 실행 안 함(sha512 불일치)', !half.ok && /다 복사되지 않았거나/.test(half.message), half.message);
  fs.writeFileSync(path.join(TMP, 'RouteViewer-3.1.4-win-x64.exe'), installerBytes);
  check('완전한 설치 파일은 통과', (await UF.verifyInstaller(u)).ok === true);

  // latest.yml 에 폴더 밖 경로가 적혀 있어도 폴더 안 파일만 본다
  fs.writeFileSync(path.join(TMP, 'latest.yml'), yml('3.1.5', '..\\..\\evil.exe', sha));
  const evil = await UF.checkUpdateFolder(TMP, '3.1.3');
  check('설치 파일은 업데이트 폴더 안에서만', path.dirname(evil.installer || path.join(TMP, 'x')) === TMP, evil.installer);

  fs.writeFileSync(path.join(TMP, 'latest.yml'), "version: 3.1.6\nappFolder: win-unpacked\nreleaseDate: '2026-10-09T02:00:00.000Z'\n");
  const uDir = await UF.checkUpdateFolder(TMP, '3.1.4');
  check('앱 폴더만 있는 빌드(npm run release 기본)의 latest.yml', uDir.status === 'missing-installer' && uDir.version === '3.1.6' && uDir.installer === null, JSON.stringify(uDir));

  // ── 설치 프로그램 없이(앱 폴더 복사) — 스마트 앱 컨트롤 대비 ──
  fs.writeFileSync(path.join(TMP, 'latest.yml'), yml('3.1.5', 'RouteViewer-3.1.5-win-x64.exe', sha));
  const u5 = await UF.checkUpdateFolder(TMP, '3.1.4');
  check('설치 파일이 없어도 버전 정보는 읽힘', u5.status === 'missing-installer' && u5.version === '3.1.5');
  check('앱 폴더(win-unpacked)가 없으면 복사 업데이트 불가', UF.findUnpackedApp(u5, 'Route Viewer.exe') === null);
  const unpacked = path.join(TMP, 'win-unpacked');
  fs.mkdirSync(path.join(unpacked, 'resources', 'app'), { recursive: true });   // asar 없는 빌드(3.1.5~)
  fs.writeFileSync(path.join(unpacked, 'Route Viewer.exe'), 'exe-v315');
  fs.writeFileSync(path.join(unpacked, 'resources', 'app', 'package.json'), JSON.stringify({ version: '3.1.4' }));
  check('앱 폴더 버전이 latest.yml 과 다르면(빌드 중 등) 쓰지 않음', UF.findUnpackedApp(u5, 'Route Viewer.exe') === null);
  fs.writeFileSync(path.join(unpacked, 'resources', 'app', 'package.json'), JSON.stringify({ version: '3.1.5' }));
  check('같은 버전 앱 폴더를 찾음', UF.findUnpackedApp(u5, 'Route Viewer.exe') === unpacked);

  if (process.platform === 'win32') {
    // 실제 cmd · robocopy 로 복사해 본다 — 덮어쓰기 · 새 파일 추가 · 설치 폴더에만 있는 파일(제거 프로그램)은 유지
    const dest = path.join(TMP, 'installed app');
    fs.mkdirSync(path.join(dest, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'Route Viewer.exe'), 'exe-v314');
    fs.writeFileSync(path.join(dest, 'Uninstall Route Viewer.exe'), 'uninstaller');
    fs.writeFileSync(path.join(dest, 'resources', 'app.asar'), 'old asar');                   // 예전(3.1.4 이하) 빌드
    fs.mkdirSync(path.join(dest, 'resources', 'app.asar.unpacked'), { recursive: true });
    fs.mkdirSync(path.join(dest, 'resources', 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'resources', 'app', 'src', 'removed-in-new-version.js'), 'old');
    const exeToStart = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'hostname.exe');
    const cmdLine = UF.copyUpdateCommand(unpacked, dest, exeToStart);
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' });
    check('복사 명령 실행', r.status === 0 || r.status === 1, `exit ${r.status}`);
    check('실행 파일을 새 버전으로 덮어씀', fs.readFileSync(path.join(dest, 'Route Viewer.exe'), 'utf8') === 'exe-v315');
    check('새 앱 코드 복사(resources\\app)', JSON.parse(fs.readFileSync(path.join(dest, 'resources', 'app', 'package.json'), 'utf8')).version === '3.1.5');
    check('예전 빌드의 app.asar · app.asar.unpacked 정리(남아 있으면 Electron 이 그쪽을 읽음)',
      !fs.existsSync(path.join(dest, 'resources', 'app.asar')) && !fs.existsSync(path.join(dest, 'resources', 'app.asar.unpacked')));
    check('새 버전에서 지운 앱 코드 파일은 남지 않음', !fs.existsSync(path.join(dest, 'resources', 'app', 'src', 'removed-in-new-version.js')));
    check('설치 폴더에만 있던 제거 프로그램은 지우지 않음', fs.existsSync(path.join(dest, 'Uninstall Route Viewer.exe')));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
