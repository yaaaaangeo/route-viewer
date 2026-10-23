'use strict';
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const L = require('../src/js/logging-records');
const { assertRecognizer, MockLoggingRecognizer } = require('./logging-recognizer');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40 * 1000 * 1000;
const SAFE_ERRORS = {
  INVALID_IMAGE: 'JPEG 또는 PNG 사진을 선택해주세요.', IMAGE_TOO_LARGE: '사진 크기 또는 해상도 제한을 넘었어요.',
  ENOSPC: '원본을 보관할 저장 공간이 부족해요.', ASSET_MISSING: '보관한 원본 사진을 찾지 못했어요.',
  ASSET_CORRUPT: '보관한 원본 사진의 무결성을 확인하지 못했어요.', INVALID_RESPONSE: '인식 결과 형식을 확인하지 못했어요.',
  INTERRUPTED: '앱 종료로 작업이 중단됐어요. 재시도해주세요.',
};
function safeError(error) {
  const code = error && SAFE_ERRORS[error.code] ? error.code : 'LOGGING_FAILED';
  return { code, message: SAFE_ERRORS[code] || '사진 처리를 완료하지 못했어요. 다시 시도해주세요.' };
}
function typeOf(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'];
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'jpg'];
  L.fail('INVALID_IMAGE', SAFE_ERRORS.INVALID_IMAGE);
}
class LoggingService {
  constructor({ db, root, validateImage, recognizer = new MockLoggingRecognizer(), onChange = () => {} }) {
    this.db = db; this.root = path.resolve(root); this.validateImage = validateImage;
    this.recognizer = assertRecognizer(recognizer); this.onChange = onChange; this.running = new Map();
    // Jobs are never resumed blindly (a future provider may charge per request).
    db.db.run("UPDATE logging_jobs SET state='failed',error_code='INTERRUPTED',updated_at=? WHERE state IN ('queued','processing')", [new Date().toISOString()]);
  }
  capabilities() {
    return { supported: true, recognizer: this.recognizer.id, isMock: this.recognizer.isMock,
      maxBytes: MAX_BYTES, maxPixels: MAX_PIXELS, formats: ['JPEG', 'PNG'], byteConversion: false };
  }
  assetPath(relative) {
    if (!/^originals\/[a-f0-9]{64}\.(png|jpg)$/.test(relative)) L.fail('ASSET_CORRUPT', SAFE_ERRORS.ASSET_CORRUPT);
    return path.join(this.root, ...relative.split('/'));
  }
  async importFiles(paths) {
    if (!Array.isArray(paths) || paths.length > 50) L.fail('VALIDATION', '사진은 한 번에 50장까지 선택해주세요.');
    const results = [];
    for (const file of paths) {
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) L.fail('INVALID_IMAGE', SAFE_ERRORS.INVALID_IMAGE);
        if (stat.size > MAX_BYTES) L.fail('IMAGE_TOO_LARGE', SAFE_ERRORS.IMAGE_TOO_LARGE);
        const bytes = await fs.readFile(file);
        if (bytes.length > MAX_BYTES) L.fail('IMAGE_TOO_LARGE', SAFE_ERRORS.IMAGE_TOO_LARGE);
        const [mime, ext] = typeOf(bytes);
        const size = await this.validateImage(bytes);
        if (!size || size.width < 1 || size.height < 1) L.fail('INVALID_IMAGE', SAFE_ERRORS.INVALID_IMAGE);
        if (size.width * size.height > MAX_PIXELS) L.fail('IMAGE_TOO_LARGE', SAFE_ERRORS.IMAGE_TOO_LARGE);
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        const prev = this.db.db.get('SELECT * FROM logging_assets WHERE sha256=?', [sha]);
        const relative = `originals/${sha}.${ext}`, destination = this.assetPath(relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        // Atomic file creation. A crash can leave an unreferenced original, never a partial original.
        let present;
        try { present = await fs.readFile(destination); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (present && !present.equals(bytes)) L.fail('ASSET_CORRUPT', SAFE_ERRORS.ASSET_CORRUPT);
        if (!present) {
          const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
          try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, destination); }
          finally { await fs.unlink(temporary).catch(() => {}); }
        }
        if (prev) { results.push({ assetId: prev.asset_id, duplicate: true }); continue; }
        const assetId = crypto.randomUUID();
        this.db.db.run('INSERT INTO logging_assets VALUES(?,?,?,?,?,?,?)',
          [assetId, sha, path.basename(file), mime, bytes.length, relative, new Date().toISOString()]);
        // create row before awaiting recognition; all UI results remain pending human review.
        const job = await this.recognize(assetId);
        results.push({ assetId, duplicate: false, ...job });
      } catch (e) { results.push({ error: safeError(e) }); }
    }
    this.emit();
    return results;
  }
  emit() { try { this.onChange(); } catch (_) { /* A UI notification must not roll back persisted work. */ } }
  listJobs() {
    return this.db.db.all('SELECT * FROM logging_jobs ORDER BY created_at DESC').map(r => ({ id: r.job_id, assetId: r.asset_id,
      state: r.state, recognizer: r.recognizer_id, isMock: !!r.is_mock, error: r.error_code ? safeError({ code: r.error_code }) : null }));
  }
  async readAsset(assetId) {
    const asset = this.db.db.get('SELECT * FROM logging_assets WHERE asset_id=?', [assetId]);
    if (!asset) L.fail('ASSET_MISSING', SAFE_ERRORS.ASSET_MISSING);
    let bytes;
    try { bytes = await fs.readFile(this.assetPath(asset.relative_path)); } catch (_) { L.fail('ASSET_MISSING', SAFE_ERRORS.ASSET_MISSING); }
    if (bytes.length > MAX_BYTES || crypto.createHash('sha256').update(bytes).digest('hex') !== asset.sha256) L.fail('ASSET_CORRUPT', SAFE_ERRORS.ASSET_CORRUPT);
    return { mimeType: asset.mime_type, bytes };
  }
  recognize(assetId) {
    if (this.running.has(assetId)) return this.running.get(assetId);
    const promise = this.runRecognition(assetId).finally(() => this.running.delete(assetId));
    this.running.set(assetId, promise); return promise;
  }
  async runRecognition(assetId) {
    const jobId = crypto.randomUUID(), at = new Date().toISOString();
    const asset = this.db.db.get('SELECT * FROM logging_assets WHERE asset_id=?', [assetId]);
    if (!asset) L.fail('ASSET_MISSING', SAFE_ERRORS.ASSET_MISSING);
    this.db.db.run('INSERT INTO logging_jobs VALUES(?,?,?,?,?,?,1,NULL,?,?)',
      [jobId, assetId, 'processing', this.recognizer.id, this.recognizer.version, this.recognizer.isMock ? 1 : 0, at, at]);
    this.emit();
    try {
      const { bytes, mimeType } = await this.readAsset(assetId);
      const response = await this.recognizer.recognize({ imageBytes: bytes, mimeType, sha256: asset.sha256 });
      // Store only the allowlisted contract; provider headers/credentials are never persisted.
      const clean = L.validateRecognition(response);
      if (JSON.stringify(clean).length > 1000000) L.fail('INVALID_RESPONSE', SAFE_ERRORS.INVALID_RESPONSE);
      const runId = crypto.randomUUID();
      this.db.db.run('BEGIN');
      try {
        this.db.db.run('INSERT INTO logging_recognition_runs VALUES(?,?,?,?,?)', [runId, jobId, assetId, JSON.stringify(clean), at]);
        clean.sessions.forEach((observation, index) => this.db.db.run(`INSERT INTO logging_candidates
          (candidate_id,run_id,asset_id,row_index,observation_json,is_mock) VALUES(?,?,?,?,?,?)`,
        [crypto.randomUUID(), runId, assetId, index, JSON.stringify(observation), this.recognizer.isMock ? 1 : 0]));
        this.db.db.run("UPDATE logging_jobs SET state='succeeded',updated_at=? WHERE job_id=?", [new Date().toISOString(), jobId]);
        this.db.db.run('COMMIT');
      } catch (e) { this.db.db.run('ROLLBACK'); throw e; }
      return { jobId, state: 'succeeded', candidates: clean.sessions.length };
    } catch (e) {
      const error = safeError(e);
      this.db.db.run("UPDATE logging_jobs SET state='failed',error_code=?,updated_at=? WHERE job_id=?", [error.code, new Date().toISOString(), jobId]);
      return { jobId, state: 'failed', error };
    } finally { this.emit(); }
  }
  async retryJob(jobId) {
    const job = this.db.db.get('SELECT * FROM logging_jobs WHERE job_id=?', [jobId]);
    if (!job || job.state !== 'failed') L.fail('VALIDATION', '실패한 작업만 재시도할 수 있어요.');
    return this.recognize(job.asset_id);
  }
}
module.exports = { LoggingService, safeError, MAX_BYTES };
