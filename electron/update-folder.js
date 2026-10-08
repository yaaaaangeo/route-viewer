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
  if (!parseVersion(info.version) || !info.path) return { status: 'no-info', folder, message: 'latest.yml 을 읽지 못했어요.' };
  if (compareVersions(info.version, currentVersion) <= 0) {
    return { status: 'latest', folder, version: info.version, currentVersion };
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

module.exports = { parseLatestYml, compareVersions, checkUpdateFolder, verifyInstaller, sha512Base64 };
