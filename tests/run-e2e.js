// ══════════════════════════════════════════════════════════
//  run-e2e — 화면 E2E 실행기 (npm run test:e2e / npm run test:e2e:auto-import)
//
//  · 매번 새 임시 userData 폴더에서 앱을 띄운다 — 실제 주행 DB(%APPDATA%\Route Viewer)는 건드리지 않는다
//    (main.js·e2e-driver.js 에도 같은 안전장치가 있다)
//  · VS Code 터미널이 물려주는 ELECTRON_RUN_AS_NODE 를 지워서 electron 이 창으로 뜨게 한다
//
//  실행: node tests/run-e2e.js            → tests/e2e-driver.js
//        node tests/run-e2e.js auto-import → tests/auto-import-e2e.js
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const electron = require('electron');   // devDependency — electron.exe 경로
const which = process.argv[2] || 'main';

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

let args;
if (which === 'auto-import') {
  args = [path.join(__dirname, 'auto-import-e2e.js')];
} else {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-e2e-'));
  env.ROUTE_VIEWER_E2E = path.join(__dirname, 'e2e-driver.js');
  args = [ROOT, `--user-data-dir=${userData}`];
  console.log(`userData: ${userData}`);
}

const child = spawn(electron, args, { cwd: ROOT, env, stdio: 'inherit' });
child.on('exit', code => {
  console.log(`=== e2e exit: ${code} ===`);
  process.exit(code == null ? 1 : code);
});
