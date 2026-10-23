'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/js/logging-records');
const { RouteDatabase } = require('../electron/database');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-logging-db-'));
let db;
let checks = 0;
let rowIndex = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
const value = { folder: 'session-01', loggingDate: '2026-10-21', startedTime: '09:30:00', durationRaw: '01:20:03',
  sizeRaw: '1.250 TB', sizeValue: '1.250', sizeUnit: 'TB', fileCount: '42', recordingCount: '2', completion: 'completed' };
function candidate(key, isMock = 1) {
  db.db.run('INSERT INTO logging_candidates(candidate_id,run_id,asset_id,row_index,observation_json,is_mock) VALUES(?,?,?,?,?,?)',
    [key, 'run', 'asset', rowIndex++, JSON.stringify({ fields: value }), isMock]);
}
try {
  check('exact decimal sums and no unapproved conversion', () => {
    assert.equal(L.addDecimals(['0.1', '0.2', '100000000000000000.001']), '100000000000000000.301');
    assert.equal(L.normalize(value).sizeValue, '1.250'); assert.equal(L.normalize(value).sizeBytes, null);
    assert.equal(L.normalize(value).durationSec, 4803);
  });
  check('unknown fields stay null and invalid dates/counts rejected', () => {
    assert.equal(L.normalize({ folder: 'a', loggingDate: '2026-01-01' }).fileCount, null);
    assert.throws(() => L.normalize({ ...value, loggingDate: '2026-02-30' }));
    assert.throws(() => L.normalize({ ...value, fileCount: '-1' }));
  });
  check('disk free is never a session size; multiple observations retained', () => {
    const out = L.validateRecognition({ schemaVersion: 1, sessions: [
      { fields: value, evidence: { sizeValue: { label: '디스크 여유', text: '1.250 TB' } } },
      { fields: value, evidence: { sizeValue: { label: '전체 크기', text: '1.250 TB' } } },
    ] });
    assert.equal(out.sessions.length, 2); assert.equal(out.sessions[0].fields.sizeValue, null);
    assert.equal(out.sessions[1].fields.sizeValue, '1.250');
    const contradictory = L.validateRecognition({ schemaVersion: 1, sessions: [
      { fields: value, evidence: { sizeValue: { label: '전체 크기', text: '디스크 여유 1.250 TB' } } },
    ] });
    assert.equal(contradictory.sessions[0].fields.sizeValue, null);
  });
  db = new RouteDatabase(path.join(dir, 'test.db'));
  check('migration idempotent and existing GPS data survives reopening', () => {
    db.importRecords([{ date: '2026-10-21', time: '09:00:00', lat: 37.5, lng: 127, vehicle: 'test' }]);
    db.close(); db = new RouteDatabase(path.join(dir, 'test.db'));
    assert.equal(db.getRecordsByDate('2026-10-21').length, 1);
    assert.equal(db.getMeta('logging_schema_version'), '1');
  });
  candidate('c1'); let first;
  check('explicit Mock acknowledgment required; confirmation links immutable evidence', () => {
    assert.throws(() => db.confirmLoggingCandidate({ candidateId: 'c1', data: value }), e => e.code === 'MOCK_ACK_REQUIRED');
    first = db.confirmLoggingCandidate({ candidateId: 'c1', data: value, mockAcknowledged: true, actor: 'tester' });
    const detail = db.getLoggingSession(first.id);
    assert.equal(detail.evidence.length, 1); assert.equal(detail.revisions.length, 1);
    assert.equal(detail.evidence[0].observation.fields.sizeValue, '1.250');
  });
  candidate('c2');
  check('duplicate folder blocked and failed review rolls back', () => {
    assert.throws(() => db.confirmLoggingCandidate({ candidateId: 'c2', data: value, mockAcknowledged: true }), e => e.code === 'DUPLICATE_SESSION');
    assert.equal(db.getLoggingCandidate('c2').state, 'pending'); assert.equal(db.listLoggingSessions().length, 1);
  });
  check('conflicting photos require explicit choice; same record counted once', () => {
    assert.throws(() => db.confirmLoggingCandidate({ candidateId: 'c2', data: { ...value, sizeValue: '2' }, mockAcknowledged: true,
      existingId: first.id, expectedVersion: 1, resolution: 'attach', reason: 'test' }), e => e.code === 'FIELD_CONFLICT');
    db.confirmLoggingCandidate({ candidateId: 'c2', data: value, mockAcknowledged: true,
      existingId: first.id, expectedVersion: 1, resolution: 'attach', reason: '같은 세션 확인' });
    assert.equal(db.getLoggingSession(first.id).evidence.length, 2); assert.equal(db.listLoggingSessions().length, 1);
  });
  check('edits have optimistic locking and append-only revision history', () => {
    assert.throws(() => db.updateLoggingSession({ id: first.id, expectedVersion: 1, data: value, reason: '수정' }), e => e.code === 'VERSION_CONFLICT');
    db.updateLoggingSession({ id: first.id, expectedVersion: 2, data: { ...value, sizeValue: '2.50' }, reason: '사진 확인' });
    const d = db.getLoggingSession(first.id); assert.equal(d.version, 3); assert.equal(d.revisions.length, 3);
    assert.equal(d.evidence[0].observation.fields.sizeValue, '1.250');
  });
  check('Mock excluded from real totals, raw units separate, GPS backup unchanged', () => {
    assert.equal(db.getLoggingTotals().sessions, 0);
    assert.equal(db.getLoggingTotals({ includeMock: true }).groups[0].total, '2.50'.replace(/0$/, ''));
    const groups = L.totals([{ data: L.normalize(value) }, { data: L.normalize({ ...value, sizeUnit: 'GB' }) }]);
    assert.equal(groups.filter(g => g.dimension === 'date').length, 2);
    assert.equal(db.buildBackupPayload().loggingSessions, undefined);
    db.deleteAll(); assert.equal(db.listLoggingSessions().length, 1);
  });
  check('real-source unit totals, explicit replace and query columns stay consistent', () => {
    candidate('real-1', 0);
    const d = { ...value, folder: 'real-session', vehicleName: '토레스 1호' };
    const real = db.confirmLoggingCandidate({ candidateId: 'real-1', data: d });
    candidate('real-2', 0);
    db.confirmLoggingCandidate({ candidateId: 'real-2', data: { ...d, sizeValue: '3.00', loggingDate: '2026-10-22' },
      existingId: real.id, expectedVersion: 1, resolution: 'replace', reason: '최종 화면 확인' });
    const row = db.db.get('SELECT logging_date,vehicle_name FROM logging_sessions WHERE logging_session_id=?', [real.id]);
    assert.equal(row.logging_date, '2026-10-22'); assert.equal(row.vehicle_name, '토레스 1호');
    const totals = db.getLoggingTotals(); assert.equal(totals.sessions, 1); assert.equal(totals.groups[0].total, '3');
    assert.equal(totals.normalizedBytes, null);
    assert.equal(db.getLoggingSession(real.id).evidence[0].observation.fields.sizeValue, '1.250');
  });
  check('scope distinguishes folders; unregistered vehicle and mismatched session refused', () => {
    candidate('other-scope');
    db.confirmLoggingCandidate({ candidateId: 'other-scope', data: { ...value, loggerScope: 'second-logger' }, mockAcknowledged: true });
    candidate('invalid-link');
    assert.throws(() => db.confirmLoggingCandidate({ candidateId: 'invalid-link', data: { ...value, vehicleName: 'unknown-car' }, mockAcknowledged: true }), e => e.code === 'VALIDATION');
    assert.throws(() => db.confirmLoggingCandidate({ candidateId: 'invalid-link', data: { ...value, externalSessionId: 'no-such-session' }, mockAcknowledged: true }), e => e.code === 'VALIDATION');
    assert.equal(db.getLoggingCandidate('invalid-link').state, 'pending');
  });
  console.log(`${checks} LOGGERD model/DB checks passed`);
} finally { if (db) db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
