// ══════════════════════════════════════════════════════════
//  update-folder.js — 업데이트 폴더에서 새 버전 찾기 (서버 없이)
//
//  npm.cmd run release 가 release\ 에 새 설치 파일과 latest.yml 을 만들면, 설치된 앱이 그 폴더를 보고
//  "새 버전 3.1.4 가 있어요 · 지금 설치" 를 띄운다. 폴더 기본값은 빌드한 PC 의 route-viewer\release
//  (tools/release.js 가 빌드할 때 package.json 의 updateFolder 로 넣는다). 다른 폴더(예: Google Drive 공유 폴더)로
//  바꾸면 여러 PC 가 같은 설치 파일로 업데이트할 수 있다.
//
//  latest.yml(electron-builder 가 만듦)에서 version · path · sha512 만 읽는다. 설치 전에는 설치 파일의 sha512 를
//  다시 계산해 맞춰 본다 — 아직 복사·동기화 중인 반쪽 파일을 실행하지 않으려고.
//  Electron 을 몰라도 되게 fs 만 쓴다 — tests/update-folder-test.js 가 임시 폴더로 그대로 돌린다.
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// latest.yml 은 단순한 key: value 라 맨 앞 줄(들여쓰기 없는)만 읽으면 된다
function parseLatestYml(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach(line => {
    const m = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line);
    if (!m || !m[2]) return;
    out[m[1]] = m[2].trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  });
  return out;
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// a 가 b 보다 높으면 양수
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function sha512Base64(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('base64')));
  });
}

/**
 * 업데이트 폴더에서 지금 버전보다 높은 설치 파일을 찾는다.
 * @returns {Promise<{status:'newer'|'latest'|'no-folder'|'no-info'|'missing-installer', ...}>}
 */
async function checkUpdateFolder(folder, currentVersion) {
  if (!folder) return { status: 'no-folder', message: '업데이트 폴더가 정해져 있지 않아요.' };
  try {
    const st = await fs.promises.stat(folder);
    if (!st.isDirectory()) throw new Error('폴더가 아니에요');
  } catch (err) {
    return { status: 'no-folder', folder, message: `업데이트 폴더에 접근할 수 없어요 — ${folder}` };
  }
  let info;
  try { info = parseLatestYml(await fs.promises.readFile(path.join(folder, 'latest.yml'), 'utf8')); }
  catch (_) { return { status: 'no-info', folder, message: '업데이트 폴더에 latest.yml 이 없어요(아직 빌드한 적 없음).' }; }
  if (!parseVersion(info.version)) return { status: 'no-info', folder, message: 'latest.yml 을 읽지 못했어요.' };
  if (compareVersions(info.version, currentVersion) <= 0) {
    return { status: 'latest', folder, version: info.version, currentVersion };
  }
  // 설치 파일 없이 앱 폴더(win-unpacked)만 만든 빌드(npm run release 기본) — 호출한 쪽이 findUnpackedApp 으로 앱 폴더를 찾는다
  if (!info.path) {
    return { status: 'missing-installer', folder, version: info.version, currentVersion, installer: null, message: `새 버전 ${info.version} 은 설치 파일 없이 앱 폴더로만 있어요.` };
  }
  // 설치 파일 이름은 폴더 안 파일만 허용한다(latest.yml 에 경로가 섞여 있어도 폴더 밖으로 나가지 않게)
  const installer = path.join(folder, path.basename(info.path));
  try { await fs.promises.access(installer, fs.constants.R_OK); }
  catch (_) { return { status: 'missing-installer', folder, version: info.version, currentVersion, installer, message: `latest.yml 은 ${info.version} 인데 설치 파일이 없어요 — ${path.basename(info.path)}` }; }
  return { status: 'newer', folder, version: info.version, currentVersion, installer, sha512: info.sha512 || '', releaseDate: info.releaseDate || '' };
}

// 설치 직전 확인 — 파일이 latest.yml 의 sha512 와 같아야 실행한다(복사·동기화 중인 파일 방지)
async function verifyInstaller(update) {
  if (!update || !update.installer) return { ok: false, message: '설치 파일 정보가 없어요.' };
  if (!update.sha512) return { ok: true, unverified: true };
  let actual;
  try { actual = await sha512Base64(update.installer); }
  catch (err) { return { ok: false, message: `설치 파일을 읽지 못했어요 — ${err.message}` }; }
  if (actual !== update.sha512) return { ok: false, message: '설치 파일이 아직 다 복사되지 않았거나 손상됐어요. 잠시 뒤 다시 시도해주세요.' };
  return { ok: true };
}

// ── 설치 프로그램 없이 업데이트(앱 폴더 복사) ─────────────────
// Windows 11 "스마트 앱 컨트롤"은 서명 없는 NSIS 설치 프로그램을 막는다(실행 자체가 안 됨). 앱 본체(Electron 실행 파일)는
// 막히지 않으므로, 빌드된 앱 폴더(release\win-unpacked)를 설치 위치에 그대로 복사해서 업데이트한다.
// 복사본의 버전(resources\app\package.json, 예전 빌드는 resources\app.asar\package.json)이 latest.yml 과 같아야 쓴다
// — 빌드 중이거나 다른 버전이면 안 쓴다.
// readJson 은 Electron 메인에서는 asar 안을 읽을 수 있는 fs 를, 테스트에서는 평범한 폴더를 읽는다.
function findUnpackedApp(update, exeName, readJson) {
  if (!update || !update.folder) return null;
  const dir = path.join(update.folder, 'win-unpacked');
  if (!fs.existsSync(path.join(dir, exeName))) return null;
  const read = readJson || (p => JSON.parse(fs.readFileSync(p, 'utf8')));
  let pkg = null;
  for (const sub of ['app', 'app.asar']) {
    try { pkg = read(path.join(dir, 'resources', sub, 'package.json')); break; } catch (_) { /* 다음 후보 */ }
  }
  return pkg && compareVersions(pkg.version, update.version) === 0 ? dir : null;
}

// 앱이 끝난 뒤 복사하고 다시 여는 cmd 한 줄. Windows 기본 도구(cmd·ping·robocopy)만 쓰고 스크립트 파일을 만들지 않는다.
//  · ping 으로 3초 기다림(분리 실행이라 timeout 명령은 입력이 없어 바로 끝난다)
//  · robocopy /E — 덮어쓰기만 하고 설치 폴더에만 있는 파일(제거 프로그램 등)은 지우지 않는다. 잠겨 있으면 1초 간격으로 다시 시도
//  · 앱 코드(resources\app)는 /MIR 로 맞춰서 새 버전에서 지운 파일이 남지 않게 한다
//  · 예전 빌드의 resources\app.asar 가 남아 있으면 Electron 이 그쪽을 먼저 읽으므로 지운다(asar 없는 빌드로 바뀐 3.1.5~)
//  · 끝나면 새 버전을 띄운다
//  · relaunchArgs: 다시 띄울 때 넘길 인자(예: --user-data-dir=… — 다른 데이터 폴더로 실행 중이었으면 그대로 이어서)
function copyUpdateCommand(srcDir, destDir, exePath, relaunchArgs) {
  const q = s => `"${String(s).replace(/"/g, '')}"`;
  const args = (relaunchArgs || []).map(q).join(' ');
  const rc = '/R:30 /W:1 /NFL /NDL /NJH /NJS /NP >nul';
  const srcApp = path.join(srcDir, 'resources', 'app');
  const dstRes = path.join(destDir, 'resources');
  const asarCleanup = fs.existsSync(srcApp)
    ? ` & robocopy ${q(srcApp)} ${q(path.join(dstRes, 'app'))} /MIR ${rc} & del /f /q ${q(path.join(dstRes, 'app.asar'))} >nul 2>&1 & rmdir /s /q ${q(path.join(dstRes, 'app.asar.unpacked'))} >nul 2>&1`
    : '';
  return `ping -n 4 127.0.0.1 >nul & robocopy ${q(srcDir)} ${q(destDir)} /E ${rc}${asarCleanup} & start "" ${q(exePath)}${args ? ' ' + args : ''}`;
}

module.exports = { parseLatestYml, compareVersions, checkUpdateFolder, verifyInstaller, sha512Base64, findUnpackedApp, copyUpdateCommand };
