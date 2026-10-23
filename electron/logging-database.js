'use strict';
// Isolated extension of RouteDatabase. Does not touch GPS/collection-loop tables or backups.
const crypto = require('crypto');
const L = require('../src/js/logging-records');
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS logging_assets (
      asset_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL, file_bytes INTEGER NOT NULL, relative_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logging_jobs (
      job_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, state TEXT NOT NULL,
      recognizer_id TEXT NOT NULL, recognizer_version TEXT NOT NULL, is_mock INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS logging_active_job ON logging_jobs(asset_id) WHERE state IN ('queued','processing');
    CREATE TABLE IF NOT EXISTS logging_recognition_runs (
      run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logging_candidates (
      candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      row_index INTEGER NOT NULL, observation_json TEXT NOT NULL, is_mock INTEGER NOT NULL,
      review_state TEXT NOT NULL DEFAULT 'pending', resolved_session_id TEXT,
      review_reason TEXT, reviewed_by TEXT, reviewed_at TEXT, UNIQUE(run_id,row_index)
    );
    CREATE INDEX IF NOT EXISTS logging_candidates_state ON logging_candidates(review_state);
    CREATE TABLE IF NOT EXISTS logging_sessions (
      logging_session_id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE,
      folder TEXT NOT NULL, logging_date TEXT NOT NULL, vehicle_name TEXT,
      external_session_id TEXT, data_json TEXT NOT NULL, is_mock INTEGER NOT NULL,
      version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS logging_sessions_date ON logging_sessions(logging_date,vehicle_name);
    CREATE TABLE IF NOT EXISTS logging_session_evidence (
      logging_session_id TEXT NOT NULL, candidate_id TEXT NOT NULL UNIQUE, linked_at TEXT NOT NULL,
      PRIMARY KEY(logging_session_id,candidate_id)
    );
    CREATE TABLE IF NOT EXISTS logging_session_revisions (
      revision_id TEXT PRIMARY KEY, logging_session_id TEXT NOT NULL, action TEXT NOT NULL,
      from_version INTEGER NOT NULL, to_version INTEGER NOT NULL,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL,
      actor_name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(logging_session_id,to_version)
    );
  `);
  db.run("INSERT OR REPLACE INTO app_meta(key,value) VALUES('logging_schema_version','1')");
}
function transaction(db, fn) {
  db.run('BEGIN');
  try { const result = fn(); db.run('COMMIT'); return result; }
  catch (e) { db.run('ROLLBACK'); throw e; }
}
function session(row) { return row && { id: row.logging_session_id, version: row.version, isMock: !!row.is_mock,
  createdAt: row.created_at, updatedAt: row.updated_at, data: JSON.parse(row.data_json) }; }
function actor(v) { return typeof v === 'string' ? v.trim().slice(0, 30) : ''; }
function reason(v) { if (typeof v !== 'string' || !v.trim() || v.length > 500) L.fail('VALIDATION', '변경 사유를 입력해주세요(500자 이내).'); return v.trim(); }
function validateLinks(owner, data) {
  if (data.vehicleName && !owner.db.get('SELECT name FROM vehicles WHERE name=?', [data.vehicleName])) L.fail('VALIDATION', '등록된 차량을 선택해주세요.');
  if (data.externalSessionId) {
    const row = owner.db.get('SELECT vehicle FROM drive_results WHERE session_id=? LIMIT 1', [data.externalSessionId]);
    if (!row || !data.vehicleName || row.vehicle !== data.vehicleName) L.fail('VALIDATION', '주행 세션과 차량 연결을 확인해주세요.');
  }
}
function revision(db, sid, action, prev, next, why, user) {
  db.run('INSERT INTO logging_session_revisions VALUES(?,?,?,?,?,?,?,?,?,?)',
    [id(), sid, action, prev ? prev.version : 0, next.version, JSON.stringify(prev ? prev.data : null), JSON.stringify(next.data), why, actor(user), now()]);
}
const methods = {
  listLoggingAssets() { return this.db.all('SELECT * FROM logging_assets ORDER BY created_at DESC'); },
  listLoggingCandidates(filter = {}) {
    const rows = this.db.all(`SELECT * FROM logging_candidates ${filter.state === 'all' ? '' : "WHERE review_state='pending'"} ORDER BY rowid`);
    return rows.map(r => ({ id: r.candidate_id, assetId: r.asset_id, isMock: !!r.is_mock, state: r.review_state,
      sessionId: r.resolved_session_id, observation: JSON.parse(r.observation_json) }));
  },
  getLoggingCandidate(candidateId) {
    const row = this.db.get('SELECT * FROM logging_candidates WHERE candidate_id=?', [candidateId]);
    if (!row) L.fail('NOT_FOUND', '인식 후보를 찾지 못했어요.');
    const observation = JSON.parse(row.observation_json);
    return { id: row.candidate_id, assetId: row.asset_id, isMock: !!row.is_mock, state: row.review_state, observation,
      duplicates: this.db.all('SELECT * FROM logging_sessions WHERE folder=?', [observation.fields.folder || '']).map(session) };
  },
  listLoggingSessions() { return this.db.all('SELECT * FROM logging_sessions ORDER BY logging_date DESC,folder').map(session); },
  getLoggingSession(sid) {
    const item = session(this.db.get('SELECT * FROM logging_sessions WHERE logging_session_id=?', [sid]));
    if (!item) L.fail('NOT_FOUND', '로깅 세션을 찾지 못했어요.');
    return { ...item,
      evidence: this.db.all(`SELECT c.asset_id AS assetId,c.candidate_id AS candidateId,c.observation_json AS observation
        FROM logging_session_evidence e JOIN logging_candidates c ON e.candidate_id=c.candidate_id WHERE e.logging_session_id=?`, [sid])
        .map(r => ({ ...r, observation: JSON.parse(r.observation) })),
      revisions: this.db.all('SELECT * FROM logging_session_revisions WHERE logging_session_id=? ORDER BY to_version', [sid]) };
  },
  confirmLoggingCandidate(input) {
    const data = L.normalize(input.data); validateLinks(this, data);
    return transaction(this.db, () => {
      const candidate = this.db.get('SELECT * FROM logging_candidates WHERE candidate_id=?', [input.candidateId]);
      if (!candidate || candidate.review_state !== 'pending') L.fail('REVIEW_CONFLICT', '이미 처리된 후보예요. 새로고침해주세요.');
      if (candidate.is_mock && input.mockAcknowledged !== true) L.fail('MOCK_ACK_REQUIRED', 'Mock 예시임을 확인해주세요.');
      const key = L.identity(data), existing = session(this.db.get('SELECT * FROM logging_sessions WHERE identity_key=?', [key]));
      let result;
      if (existing) {
        if (input.existingId !== existing.id || input.expectedVersion !== existing.version) L.fail('DUPLICATE_SESSION', '같은 폴더의 세션이 있어요. 기존 기록과 비교해주세요.');
        // A simulated observation cannot silently attach to/overwrite real evidence (or vice versa).
        if (existing.isMock !== !!candidate.is_mock) L.fail('SOURCE_CONFLICT', 'Mock 기록과 실제 인식 기록은 합칠 수 없어요.');
        const changed = L.FIELDS.some(k => JSON.stringify(existing.data[k] ?? null) !== JSON.stringify(data[k] ?? null));
        if (input.resolution !== 'attach' && input.resolution !== 'replace') L.fail('DUPLICATE_SESSION', '중복 처리 방법을 선택해주세요.');
        if (input.resolution === 'attach' && (changed || JSON.stringify(existing.data) !== JSON.stringify(data))) L.fail('FIELD_CONFLICT', '값이 달라요. 확정값을 유지하도록 검토값을 맞추거나 수정으로 저장해주세요.');
        result = input.resolution === 'replace' ? { ...existing, data, version: existing.version + 1 } : { ...existing, version: existing.version + 1 };
        this.db.run('UPDATE logging_sessions SET logging_date=?,vehicle_name=?,external_session_id=?,data_json=?,version=?,updated_at=? WHERE logging_session_id=?',
          [result.data.loggingDate, result.data.vehicleName, result.data.externalSessionId, JSON.stringify(result.data), result.version, now(), existing.id]);
        revision(this.db, existing.id, input.resolution, existing, result, reason(input.reason), input.actor);
      } else {
        if (input.existingId) L.fail('REVIEW_CONFLICT', '중복 대상을 다시 확인해주세요.');
        result = { id: id(), data, version: 1, isMock: !!candidate.is_mock };
        this.db.run('INSERT INTO logging_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          [result.id, key, data.folder, data.loggingDate, data.vehicleName, data.externalSessionId, JSON.stringify(data), candidate.is_mock, 1, now(), now()]);
        revision(this.db, result.id, 'confirm', null, result, '검토 후 확정', input.actor);
      }
      this.db.run('INSERT INTO logging_session_evidence VALUES(?,?,?)', [result.id, candidate.candidate_id, now()]);
      this.db.run("UPDATE logging_candidates SET review_state='accepted',resolved_session_id=?,reviewed_by=?,reviewed_at=? WHERE candidate_id=?", [result.id, actor(input.actor), now(), candidate.candidate_id]);
      return result;
    });
  },
  rejectLoggingCandidate(input) {
    const why = reason(input.reason);
    const row = this.db.get('SELECT review_state FROM logging_candidates WHERE candidate_id=?', [input.candidateId]);
    if (!row || row.review_state !== 'pending') L.fail('REVIEW_CONFLICT', '이미 처리된 후보예요.');
    this.db.run("UPDATE logging_candidates SET review_state='rejected',review_reason=?,reviewed_by=?,reviewed_at=? WHERE candidate_id=?", [why, actor(input.actor), now(), input.candidateId]);
    return true;
  },
  updateLoggingSession(input) {
    const data = L.normalize(input.data); validateLinks(this, data); const why = reason(input.reason);
    return transaction(this.db, () => {
      const prev = session(this.db.get('SELECT * FROM logging_sessions WHERE logging_session_id=?', [input.id]));
      if (!prev) L.fail('NOT_FOUND', '기록을 찾지 못했어요.');
      if (prev.version !== input.expectedVersion) L.fail('VERSION_CONFLICT', '다른 변경이 있어요. 최신 기록을 다시 열어주세요.');
      const duplicate = this.db.get('SELECT logging_session_id FROM logging_sessions WHERE identity_key=? AND logging_session_id<>?', [L.identity(data), prev.id]);
      if (duplicate) L.fail('DUPLICATE_SESSION', '다른 기록과 폴더명이 중복돼요.');
      const next = { ...prev, data, version: prev.version + 1 };
      this.db.run('UPDATE logging_sessions SET identity_key=?,folder=?,logging_date=?,vehicle_name=?,external_session_id=?,data_json=?,version=?,updated_at=? WHERE logging_session_id=?',
        [L.identity(data), data.folder, data.loggingDate, data.vehicleName, data.externalSessionId, JSON.stringify(data), next.version, now(), prev.id]);
      revision(this.db, prev.id, 'edit', prev, next, why, input.actor);
      return next;
    });
  },
  getLoggingTotals(options = {}) {
    const rows = this.listLoggingSessions().filter(r => options.includeMock === true || !r.isMock);
    return { sessions: rows.length, completed: rows.filter(r => r.data.completion === 'completed').length,
      mockSessions: this.db.get('SELECT COUNT(*) AS n FROM logging_sessions WHERE is_mock=1').n,
      normalizedBytes: null, unitBasis: 'unknown', groups: L.totals(rows) };
  },
};
module.exports = { migrate, methods };
