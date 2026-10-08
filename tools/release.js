// ══════════════════════════════════════════════════════════
//  release.js — 버전 올리기 + 설치 파일 빌드를 한 번에
//
//    npm.cmd run release              3.1.2 → 3.1.3 (patch) 후 빌드
//    npm.cmd run release -- minor     3.1.2 → 3.2.0
//    npm.cmd run release -- major     3.1.2 → 4.0.0
//    npm.cmd run release -- 3.5.0     원하는 버전으로
//    ... -- --no-build                버전만 바꾸고 빌드는 안 함
//    ... -- --dry-run                 무엇이 바뀔지 보여주기만(파일을 고치지 않음)
//
//  바꾸는 곳: package.json · package-lock.json · src/js/core.js(APP_VERSION 배지) · README.md(제목·버전 줄)
//  빌드: electron-builder --win nsis portable --x64 → release\RouteViewer-<버전>-win-x64.exe + 포터블 + latest.yml
//  버전을 올려야 이미 설치된 앱의 자동 업데이트가 새 버전으로 알아본다.
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noBuild = args.includes('--no-build');
const bump = args.find(a => !a.startsWith('--')) || 'patch';

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const cur = pkg.version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur);
if (!m) { console.error(`package.json 버전 형식을 읽지 못했어요: ${cur}`); process.exit(1); }

let next;
if (bump === 'patch') next = `${m[1]}.${m[2]}.${+m[3] + 1}`;
else if (bump === 'minor') next = `${m[1]}.${+m[2] + 1}.0`;
else if (bump === 'major') next = `${+m[1] + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else { console.error(`버전 인자를 모르겠어요: ${bump} (patch | minor | major | 1.2.3)`); process.exit(1); }

const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
if (cmp(next, cur) <= 0) { console.error(`새 버전(${next})이 지금 버전(${cur})보다 높아야 자동 업데이트가 알아봐요.`); process.exit(1); }

// 파일마다 [찾을 패턴, 바꿀 값] — 패턴이 안 맞으면 그 파일은 건너뛰고 알려준다
const esc = s => s.replace(/\./g, '\\.');
const edits = [
  ['package.json', [[new RegExp(`("version":\\s*")${esc(cur)}(")`), `$1${next}$2`]]],
  ['package-lock.json', [[new RegExp(`("name":\\s*"route-viewer",\\s*"version":\\s*")${esc(cur)}(")`, 'g'), `$1${next}$2`]]],
  ['src/js/core.js', [[new RegExp(`(APP_VERSION=')v${esc(cur)}(')`), `$1v${next}$2`]]],
  ['README.md', [
    [new RegExp(`^(# .*?)v${esc(cur)}`, 'm'), `$1v${next}`],
    [new RegExp(`(\\*\\*)${esc(cur)}(\\*\\*)`), `$1${next}$2`],
    [new RegExp(`(APP_VERSION\`도 )v${esc(cur)}`), `$1v${next}`],
  ]],
];

console.log(`버전 ${cur} → ${next}${dryRun ? '  (dry-run: 파일을 고치지 않아요)' : ''}`);
for (const [rel, rules] of edits) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log(`  - ${rel}: 파일 없음, 건너뜀`); continue; }
  let text = fs.readFileSync(p, 'utf8');
  let hits = 0;
  for (const [re, to] of rules) {
    const before = text;
    text = text.replace(re, to);
    if (text !== before) hits++;
  }
  console.log(`  ${hits ? '✓' : '·'} ${rel}${hits ? '' : ' (바꿀 곳 없음)'}`);
  if (hits && !dryRun) fs.writeFileSync(p, text, 'utf8');
}

if (dryRun || noBuild) {
  console.log(dryRun ? '\n(dry-run 이라 빌드하지 않았어요)' : '\n버전만 바꿨어요(--no-build).');
  process.exit(0);
}

console.log('\n빌드 중… (64비트 설치판 + 포터블, 몇 분 걸려요)');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;   // VS Code 터미널이 물려주면 빌드 중 electron 이 node 로 돈다
const builder = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const res = spawnSync(builder, ['--win', 'nsis', 'portable', '--x64', '--publish', 'never'],
  { cwd: ROOT, env, stdio: 'inherit', shell: process.platform === 'win32' });
if (res.status !== 0) {
  console.error(`\n빌드 실패(종료 코드 ${res.status}). 버전 숫자는 이미 ${next} 로 바뀌어 있어요 — 고친 뒤 npm.cmd run dist 로 다시 빌드하면 돼요.`);
  process.exit(res.status || 1);
}
console.log(`\n완료 — release\\RouteViewer-${next}-win-x64.exe (설치판) · release\\RouteViewer-portable-${next}-x64.exe`);
