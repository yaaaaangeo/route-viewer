// ══════════════════════════════════════════════════════════
//  auto-import.js — 주행기록 자동 가져오기 (동기화 폴더 감시)
//
//  운전자들이 Google Drive 공유 폴더에 올린 주행기록 엑셀을, 이 PC 의 Google Drive 데스크톱 앱이
//  동기화해 둔 "로컬 폴더"에서 읽어 기존 불러오기와 똑같이 DB 에 병합한다.
//  Drive 웹 주소(https://drive.google.com/...)에는 접속하지 않는다 — 폴더 경로만 받는다.
//
//  동작
//    · 주기적 스캔이 기본이다(기본 60초). 가상 드라이브(Drive 스트리밍 G:)는 파일 감시 이벤트가
//      오지 않거나 늦게 오므로 이벤트에 기대지 않는다.
//    · 하위 폴더까지 .xlsx/.xls/.csv 를 찾는다. Excel 임시 파일(~$…)·숨김 파일은 뺀다.
//    · 크기·수정 시각이 그대로인 이미 처리한 파일은 다시 읽지 않는다(내용 해시도 안 구함).
//    · 새 파일·바뀐 파일은 크기·수정 시각이 안정됐는지 확인한 뒤 읽고, 읽기 전후가 다르면
//      "동기화 중"으로 두고 다음 확인 때 다시 본다.
//    · 내용 지문(SHA-1, 수동 불러오기와 같은 값)이 이미 imports 에 있으면 이름·경로가 달라도
//      "이미 처리"로 끝낸다. 내용이 바뀐 파일은 새 지문이라 다시 병합한다(INSERT OR IGNORE — 기존 기록은
//      지우지 않는다).
//    · 파일마다 따로 try/catch — 한 파일 실패가 다른 파일을 막지 않는다. 처리 이력은 DB 저장이
//      끝난 뒤에만 '반영'으로 적는다.
//    · 날짜 요약은 배치가 끝난 뒤 바뀐 날짜만 한 번씩 다시 만든다(파일마다 반복하지 않는다).
//    · 원본 파일은 읽기만 한다(이동·수정·삭제 없음). 폴더에서 파일이 사라져도 DB 는 그대로 두고
//      처리 이력에 '폴더에 없음'만 표시한다.
//
//  Electron 을 몰라도 되도록 db·parse·fs·시계를 주입받는다 — tests/auto-import-test.js 가
//  임시 폴더와 테스트 DB 로 그대로 돌린다.
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROUTE_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const DEFAULT_INTERVAL_SEC = 60;
const MIN_INTERVAL_SEC = 15;
const MAX_INTERVAL_SEC = 3600;
const AUTO_IMPORTED_BY = '자동 가져오기';
// 처리가 끝난 상태 — 크기·수정 시각이 그대로면 다시 보지 않는다
const SETTLED_STATUSES = new Set(['imported', 'already', 'baseline']);
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information']);

function isRouteFileName(name) {
  const n = String(name || '');
  if (!n || n.startsWith('~$') || n.startsWith('.')) return false;   // Excel 잠금/임시 · 숨김(.~lock, ._mac)
  return ROUTE_EXTENSIONS.has(path.extname(n).toLowerCase());
}

// Drive 웹 주소나 URL 은 폴더로 받지 않는다
function looksLikeUrl(value) {
  const s = String(value || '').trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /drive\.google\.com/i.test(s);
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function errText(err) {
  if (!err) return '알 수 없는 오류';
  const code = err.code ? ` (${err.code})` : '';
  return `${err.message || String(err)}${code && !String(err.message || '').includes(err.code) ? code : ''}`;
}

const READ_ERROR_HINTS = {
  EBUSY: '다른 프로그램이 파일을 쓰는 중이에요',
  EPERM: '파일에 접근할 권한이 없어요(동기화 중일 수 있어요)',
  EACCES: '파일에 접근할 권한이 없어요',
  ENOENT: '파일이 사라졌어요(이름이 바뀌었거나 동기화 중)',
  EIO: '드라이브에서 파일을 내려받지 못했어요',
};

class AutoImporter {
  /**
   * @param {object} o
   * @param {RouteDatabase} o.db
   * @param {(buf: Buffer) => object[]} o.parseBuffer  RouteParser.parseBuffer
   * @param {(result) => void} [o.onBatch]   새로 반영한 파일이 있을 때(화면 갱신용)
   * @param {(status) => void} [o.onStatus]  확인 시작·끝(처리 현황 표시용)
   */
  constructor(o) {
    this.db = o.db;
    this.parseBuffer = o.parseBuffer;
    this.fs = o.fs || fs.promises;
    this.now = o.now || (() => Date.now());
    this.settleMs = o.settleMs != null ? o.settleMs : 1500;   // 같은 스캔 안에서 크기·시각을 두 번 재는 간격
    this.minAgeMs = o.minAgeMs != null ? o.minAgeMs : 3000;   // 방금 쓰인 파일은 한 번 더 기다린다
    this.initialDelayMs = o.initialDelayMs != null ? o.initialDelayMs : 3000;
    this.caseInsensitive = o.caseInsensitive != null ? o.caseInsensitive : process.platform === 'win32';
    this.onBatch = o.onBatch || (() => {});
    this.onStatus = o.onStatus || (() => {});
    this.sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this._running = null;
    this._timer = null;
    this._started = false;
  }

  // ── 설정 ──────────────────────────────────────────────
  config() {
    const c = this.db.getAutoImportConfig();
    return {
      folder: c.folder || '',
      enabled: !!c.enabled,
      initialMode: c.initialMode || null,       // null(아직 안 정함) | 'all' | 'new'
      intervalSec: Number(c.intervalSec) > 0 ? Number(c.intervalSec) : DEFAULT_INTERVAL_SEC,
      connectedAt: c.connectedAt || null,
      lastCheckAt: c.lastCheckAt || null,
      lastResult: c.lastResult || null,
    };
  }

  pathKey(fullPath) {
    const p = path.resolve(fullPath);
    return this.caseInsensitive ? p.toLowerCase() : p;
  }

  folderKey(folder) { return folder ? this.pathKey(folder) : ''; }

  // 폴더 연결(또는 변경) — 최초 연결 결정(전체/새 파일만)을 다시 받도록 initialMode 를 비운다
  async setFolder(folder) {
    const raw = String(folder || '').trim();
    if (!raw) throw new Error('폴더를 선택해주세요.');
    if (looksLikeUrl(raw)) {
      throw new Error('Google Drive 웹 주소는 쓸 수 없어요. Google Drive 데스크톱 앱이 동기화한 PC 의 폴더(예: G:\\공유 드라이브\\…)를 선택해주세요.');
    }
    if (!path.isAbsolute(raw)) throw new Error('전체 경로의 폴더를 선택해주세요.');
    let st;
    try { st = await this.fs.stat(raw); } catch (err) { throw new Error(`폴더에 접근할 수 없어요. (${errText(err)})`); }
    if (!st.isDirectory()) throw new Error('파일이 아니라 폴더를 선택해주세요.');
    const resolved = path.resolve(raw);
    const prev = this.config();
    const same = prev.folder && this.folderKey(prev.folder) === this.folderKey(resolved);
    this.db.setAutoImportConfig({
      folder: resolved,
      enabled: same ? prev.enabled : true,
      initialMode: same ? prev.initialMode : null,
      connectedAt: same ? prev.connectedAt : new Date(this.now()).toISOString(),
      lastResult: same ? prev.lastResult : null,
    });
    const preview = await this.preview();
    this._reschedule();
    return preview;
  }

  // 확인 간격(초) — 너무 잦거나 드물지 않게 15초~1시간으로 자른다. 바로 다음 확인부터 적용.
  setIntervalSec(sec) {
    const n = Math.round(Number(sec));
    if (!Number.isFinite(n)) throw new Error('확인 간격을 숫자로 골라주세요.');
    this.db.setAutoImportConfig({ intervalSec: Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, n)) });
    this._reschedule();
    return this.status();
  }

  setEnabled(on) {
    this.db.setAutoImportConfig({ enabled: !!on });
    this._reschedule();
    if (on) this._schedule(0);
    return this.status();
  }

  // 최초 연결 때 보여줄 대상 파일 수(내용은 읽지 않는다)
  async preview() {
    const cfg = this.config();
    if (!cfg.folder) return { folder: '', fileCount: 0 };
    const { files, errors } = await this._walk(cfg.folder);
    let known = 0;
    files.forEach(f => {
      const row = this.db.getAutoImportFile(this.pathKey(f.fullPath));
      if (row && SETTLED_STATUSES.has(row.status)) known++;
    });
    return { folder: cfg.folder, fileCount: files.length, knownCount: known, walkErrors: errors.length };
  }

  // 최초 연결 결정 — 'all': 지금 있는 파일까지 전부 가져온다 · 'new': 지금 있는 파일은 기준선으로 두고
  // 이후 새로 생기거나 바뀐 파일만 가져온다
  async confirmInitial(mode) {
    if (mode !== 'all' && mode !== 'new') throw new Error('가져오기 방식을 골라주세요.');
    const cfg = this.config();
    if (!cfg.folder) throw new Error('먼저 폴더를 선택해주세요.');
    if (mode === 'new') {
      const { files } = await this._walk(cfg.folder);
      const at = new Date(this.now()).toISOString();
      const folderKey = this.folderKey(cfg.folder);
      files.forEach(f => {
        const key = this.pathKey(f.fullPath);
        const row = this.db.getAutoImportFile(key);
        if (row && SETTLED_STATUSES.has(row.status)) return;
        this.db.saveAutoImportFile({
          path_key: key, folder: folderKey, rel_path: f.relPath, name: f.name, size: f.size, mtime_ms: f.mtimeMs,
          status: 'baseline', reason: '최초 연결 때 "새 파일만"을 골라 건너뛴 파일', first_seen_at: at, last_seen_at: at, missing: 0,
        });
      });
    }
    this.db.setAutoImportConfig({ initialMode: mode, enabled: true });
    this._reschedule();
    return this.runOnce('initial');
  }

  // 최초 연결 때 건너뛴 과거 파일을 나중에라도 가져오고 싶을 때
  async importBaseline() {
    const cfg = this.config();
    if (!cfg.folder) throw new Error('먼저 폴더를 선택해주세요.');
    this.db.db.run("UPDATE auto_import_files SET status = 'queued', reason = '' WHERE folder = ? AND status = 'baseline'",
      [this.folderKey(cfg.folder)]);
    return this.runOnce('baseline');
  }

  async retryFailed(pathKeys) {
    const cfg = this.config();
    if (!cfg.folder) throw new Error('먼저 폴더를 선택해주세요.');
    this.db.requestAutoImportRetry(this.folderKey(cfg.folder), pathKeys);
    return this.runOnce('retry');
  }

  status() {
    const cfg = this.config();
    const folderKey = this.folderKey(cfg.folder);
    return {
      ...cfg,
      running: !!this._running,
      needsDecision: !!cfg.folder && !cfg.initialMode,
      counts: cfg.folder ? this.db.autoImportCounts(folderKey) : null,
      latest: cfg.folder ? this.db.autoImportLatest(folderKey) : null,
      reviewPending: this.db.countPendingReview(),
      files: cfg.folder ? this.db.listAutoImportFiles(folderKey).map(publicRow) : [],
    };
  }

  // ── 타이머 ────────────────────────────────────────────
  start() {
    this._started = true;
    this._recoverPendingSummaries();
    this._schedule(this.initialDelayMs);
  }

  stop() {
    this._started = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _reschedule() {
    if (!this._started) return;
    this._schedule(this.config().intervalSec * 1000);
  }

  _schedule(ms) {
    if (!this._started) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(async () => {
      this._timer = null;
      const cfg = this.config();
      if (cfg.enabled && cfg.folder) {
        try { await this.runOnce('timer'); } catch (err) { console.warn('[auto-import] 확인 실패:', err); }
      }
      this._schedule(this.config().intervalSec * 1000);
    }, Math.max(0, ms));
    if (this._timer.unref) this._timer.unref();
  }

  // ── 한 번 확인 — 동시에 두 번 돌지 않는다(돌고 있으면 그 결과를 같이 기다린다) ──
  runOnce(reason = 'manual') {
    if (this._running) return this._running;
    this._running = (async () => {
      this.onStatus({ running: true });
      try {
        return await this._scan(reason);
      } finally {
        this._running = null;
        this.onStatus({ running: false });
      }
    })();
    return this._running;
  }

  async _scan(reason) {
    const cfg = this.config();
    const at = new Date(this.now()).toISOString();
    if (!cfg.folder) return { ok: false, reason, at, message: '폴더가 설정되지 않았어요.' };

    // 폴더 접근 확인 — 안 되면 DB 는 그대로 두고 상태만 남긴다
    try {
      const st = await this.fs.stat(cfg.folder);
      if (!st.isDirectory()) throw Object.assign(new Error('폴더가 아니에요'), { code: 'ENOTDIR' });
    } catch (err) {
      const result = { ok: false, reason, at, folderError: `폴더에 접근할 수 없어요 — ${errText(err)}. Google Drive 앱이 켜져 있고 로그인돼 있는지 확인해주세요. 기존 기록은 그대로 있어요.` };
      this.db.setAutoImportConfig({ lastCheckAt: at, lastResult: result });
      return result;
    }

    if (!cfg.initialMode) {
      const p = await this.preview();
      const result = { ok: true, reason, at, needsDecision: true, fileCount: p.fileCount };
      this.db.setAutoImportConfig({ lastCheckAt: at, lastResult: result });
      return result;
    }

    const folderKey = this.folderKey(cfg.folder);
    const { files, errors: walkErrors } = await this._walk(cfg.folder);
    const seenKeys = [];
    const candidates = [];
    for (const f of files) {
      const key = this.pathKey(f.fullPath);
      seenKeys.push(key);
      const row = this.db.getAutoImportFile(key);
      const unchanged = row && Number(row.size) === f.size && Number(row.mtime_ms) === f.mtimeMs;
      if (unchanged && SETTLED_STATUSES.has(row.status)) {
        if (row.missing || row.rel_path !== f.relPath) this.db.saveAutoImportFile({ path_key: key, missing: 0, rel_path: f.relPath, last_seen_at: at });
        continue;
      }
      // 읽을 수 없는 내용(엑셀이 아님·좌표 없음)은 파일이 바뀌거나 [다시 시도]를 누를 때까지 다시 읽지 않는다
      if (unchanged && row.status === 'failed' && !row.retryable && !row.retry_requested) continue;
      candidates.push({ ...f, key, row });
    }
    this.db.markAutoImportSeen(folderKey, seenKeys);

    // 크기·수정 시각이 멈췄는지 — 잠깐 기다렸다 한 번 더 잰다(새 파일이 있을 때만)
    if (candidates.length && this.settleMs > 0) await this.sleep(this.settleMs);

    const imported = [];
    const touchedDates = new Set();
    let pendingNow = 0, failedNow = 0, alreadyNow = 0;
    for (const c of candidates) {
      const base = {
        path_key: c.key, folder: folderKey, rel_path: c.relPath, name: c.name,
        first_seen_at: (c.row && c.row.first_seen_at) || at, last_seen_at: at, missing: 0,
      };
      const outcome = await this._processFile(c, base, at);
      if (outcome.status === 'imported') {
        imported.push(outcome.result);
        outcome.result.dates.forEach(d => touchedDates.add(d));
        this._addPendingSummaryDates(outcome.result.dates);
      } else if (outcome.status === 'pending') pendingNow++;
      else if (outcome.status === 'failed') failedNow++;
      else if (outcome.status === 'already') alreadyNow++;
      // 큰 폴더를 처음 훑을 때도 IPC·화면이 멈추지 않게 파일 사이에 한 번씩 양보한다
      await new Promise(r => setImmediate(r));
    }

    // 배치가 끝난 뒤 바뀐 날짜의 요약만 한 번씩 다시 만든다
    const dates = touchedDates.size ? this.db.rebuildDateSummaries([...touchedDates]) : [];
    this._clearPendingSummaryDates();

    const counts = this.db.autoImportCounts(folderKey);
    const result = {
      ok: true, reason, at,
      newImported: imported.length,
      // 지금 폴더에 있는 파일 중 이번에 새로 넣은 것을 뺀 "이미 처리"(예전 반영 + 같은 내용이라 건너뜀)
      alreadyProcessed: Math.max(0, counts.imported + counts.already - imported.length),
      alreadyThisRun: alreadyNow,
      failed: counts.failed,
      failedThisRun: failedNow,
      pending: counts.pending,
      pendingThisRun: pendingNow,
      baseline: counts.baseline,
      missing: counts.missing,
      fileCount: files.length,
      walkErrors: walkErrors.slice(0, 5),
      dates,
      vehicles: [...new Set(imported.flatMap(r => r.vehicles))].sort(),
      insertedRecords: imported.reduce((a, r) => a + r.inserted, 0),
      files: imported,
    };
    this.db.setAutoImportConfig({ lastCheckAt: at, lastResult: { ...result, files: undefined } });
    if (imported.length) {
      try { this.onBatch(result); } catch (err) { console.warn('[auto-import] onBatch 실패:', err); }
    }
    return result;
  }

  async _processFile(c, base, at) {
    const attempts = ((c.row && c.row.attempts) || 0) + 1;
    const save = (status, extra) => {
      this.db.saveAutoImportFile({ ...base, status, retry_requested: 0, ...extra });
      return status;
    };
    const pending = (reason, st) => ({
      status: save('pending', { reason, size: st.size, mtime_ms: st.mtimeMs, retryable: 1 }),
    });

    // 1) 안정성 — 기다린 뒤 다시 잰 값이 같아야 하고, 방금 쓰인 파일이면 다음 확인으로 미룬다
    let st2;
    try { st2 = await this.fs.stat(c.fullPath); } catch (err) {
      return { status: save('failed', { reason: readReason(err), retryable: 1, attempts, size: c.size, mtime_ms: c.mtimeMs }) };
    }
    if (st2.size !== c.size || st2.mtimeMs !== c.mtimeMs) return pending('동기화 중 — 크기·수정 시각이 아직 바뀌고 있어요', st2);
    if (this.now() - st2.mtimeMs < this.minAgeMs) return pending('동기화 중 — 방금 바뀐 파일이라 다음 확인 때 읽어요', st2);
    if (st2.size === 0) {
      // 업로드 중인 자리표시자일 수 있다 — 한 번 더 같은 상태로 보이면 빈 파일로 본다
      const sawEmptyBefore = c.row && c.row.status === 'pending' && Number(c.row.size) === 0 && Number(c.row.mtime_ms) === st2.mtimeMs;
      if (!sawEmptyBefore) return pending('동기화 중 — 아직 내용이 없어요', st2);
      return { status: save('failed', { reason: '빈 파일이에요', retryable: 0, attempts, size: 0, mtime_ms: st2.mtimeMs }) };
    }

    // 2) 읽기 — 읽는 동안 바뀌었으면 다음에 다시
    let buf;
    try { buf = await this.fs.readFile(c.fullPath); } catch (err) {
      return { status: save('failed', { reason: readReason(err), retryable: 1, attempts, size: st2.size, mtime_ms: st2.mtimeMs }) };
    }
    let st3;
    try { st3 = await this.fs.stat(c.fullPath); } catch (err) { st3 = null; }
    if (!st3 || st3.size !== st2.size || st3.mtimeMs !== st2.mtimeMs || buf.length !== st2.size) {
      return pending('동기화 중 — 읽는 동안 파일이 바뀌었어요', st3 || st2);
    }
    const hash = sha1(buf);
    const fileBase = { size: st2.size, mtime_ms: st2.mtimeMs, content_hash: hash, attempts };

    // 3) 같은 내용을 이미 넣었나(수동·자동 모두) — 이름이 바뀌었거나 다시 올린 파일
    const prior = this.db.findProcessedFileHash(hash);
    if (prior) {
      const im = this.db.getImport(prior.importId) || {};
      return {
        status: save('already', {
          ...fileBase, reason: '', retryable: 0, import_id: prior.importId, duplicate_of: prior.filename || '',
          dates: im.dates || '', vehicles: im.vehicle || '', total_records: im.total || 0, inserted: 0,
          duplicates: im.total || 0, processed_at: at,
        }),
      };
    }

    // 4) 파싱 — 기존 파서 그대로
    let records;
    try { records = this.parseBuffer(buf); } catch (err) {
      return { status: save('failed', { ...fileBase, reason: `엑셀을 읽지 못했어요 — ${errText(err)}`, retryable: 0 }) };
    }
    if (!records || !records.length) {
      return { status: save('failed', { ...fileBase, reason: 'GPS 좌표를 찾지 못했어요 (nav-app "오늘 기록 다운로드" 파일인지 확인)', retryable: 0 }) };
    }

    // 5) 저장 — 기존 importRecords(레코드 해시 중복 제거·출처 관계). 확인 팝업 없이 "검토 전"으로 넣는다
    let res;
    try {
      res = this.db.importRecords(records, {
        filename: c.name, fileHash: hash, importedBy: AUTO_IMPORTED_BY,
        importSource: 'auto', needsReview: true, hasIssue: false, deferSummaries: true,
      });
    } catch (err) {
      return { status: save('failed', { ...fileBase, reason: `저장하지 못했어요 — ${errText(err)}`, retryable: 1 }) };
    }
    const vehicles = [...new Set(records.map(r => r.vehicle).filter(Boolean))].sort();
    save('imported', {
      ...fileBase, reason: '', retryable: 0, import_id: res.importId, duplicate_of: '',
      dates: res.dates.join(','), vehicles: vehicles.join(','), total_records: res.total,
      inserted: res.inserted, duplicates: res.duplicates, processed_at: at,
    });
    return {
      status: 'imported',
      result: { name: c.name, relPath: c.relPath, importId: res.importId, dates: res.dates, vehicles, total: res.total, inserted: res.inserted, duplicates: res.duplicates },
    };
  }

  // 배치 도중 앱이 꺼져도 날짜 요약이 빠지지 않게, 미뤄 둔 날짜를 적어 뒀다가 다음 시작 때 채운다
  _addPendingSummaryDates(dates) {
    const cur = this._pendingSummaryDates();
    dates.forEach(d => cur.add(d));
    this.db.setMeta('auto_import_pending_summary_dates', JSON.stringify([...cur]));
  }
  _pendingSummaryDates() {
    try { return new Set(JSON.parse(this.db.getMeta('auto_import_pending_summary_dates', '[]')) || []); } catch (_) { return new Set(); }
  }
  _clearPendingSummaryDates() { this.db.setMeta('auto_import_pending_summary_dates', '[]'); }
  _recoverPendingSummaries() {
    const dates = [...this._pendingSummaryDates()];
    if (dates.length) { this.db.rebuildDateSummaries(dates); this._clearPendingSummaryDates(); }
    return dates;
  }

  // 하위 폴더까지 훑는다. 하위 폴더 하나를 못 읽어도 나머지는 계속 본다.
  async _walk(root) {
    const files = [];
    const errors = [];
    const visit = async (dir, depth) => {
      if (depth > 24) return;
      let entries;
      try { entries = await this.fs.readdir(dir, { withFileTypes: true }); } catch (err) {
        if (dir === root) throw err;
        errors.push({ path: dir, reason: errText(err) });
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink && e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;   // .tmp.drivedownload 등
          await visit(full, depth + 1);
        } else if (e.isFile() && isRouteFileName(e.name)) {
          try {
            const st = await this.fs.stat(full);
            files.push({ fullPath: full, relPath: path.relative(root, full), name: e.name, size: st.size, mtimeMs: st.mtimeMs });
          } catch (err) {
            errors.push({ path: full, reason: errText(err) });
          }
        }
      }
    };
    try { await visit(root, 0); } catch (err) { errors.push({ path: root, reason: errText(err) }); }
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { files, errors };
  }
}

function readReason(err) {
  const hint = err && READ_ERROR_HINTS[err.code];
  return `읽기 실패 — ${hint || errText(err)}. 다음 확인 때 다시 시도해요`;
}

// 화면에 넘길 처리 이력 한 줄
function publicRow(r) {
  return {
    pathKey: r.path_key,
    name: r.name,
    relPath: r.rel_path,
    status: r.status,
    reason: r.reason,
    retryable: !!r.retryable,
    retryRequested: !!r.retry_requested,
    attempts: r.attempts || 0,
    importId: r.import_id,
    duplicateOf: r.duplicate_of || '',
    dates: r.dates ? String(r.dates).split(',').filter(Boolean) : [],
    vehicles: r.vehicles ? String(r.vehicles).split(',').filter(Boolean) : [],
    total: r.total_records || 0,
    inserted: r.inserted || 0,
    duplicates: r.duplicates || 0,
    firstSeenAt: r.first_seen_at || null,
    processedAt: r.processed_at || null,
    lastSeenAt: r.last_seen_at || null,
    missing: !!r.missing,
    needsReview: !!r.needs_review,
    hasIssue: !!r.has_issue,
    issueStatus: r.has_issue ? (r.issue_status || 'open') : null,
  };
}

module.exports = { AutoImporter, isRouteFileName, looksLikeUrl, AUTO_IMPORTED_BY, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC };
