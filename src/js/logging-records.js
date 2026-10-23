// LOGGERD domain rules shared by Node and the renderer. No OCR/provider dependencies.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LoggingRecords = factory();
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const FIELDS = ['folder', 'loggingDate', 'startedTime', 'durationRaw', 'sizeRaw', 'sizeValue', 'sizeUnit', 'fileCount', 'recordingCount', 'completion'];
  const METHODS = ['listLoggingAssets', 'listLoggingCandidates', 'getLoggingCandidate', 'confirmLoggingCandidate',
    'rejectLoggingCandidate', 'listLoggingSessions', 'getLoggingSession', 'updateLoggingSession', 'getLoggingTotals'];
  function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
  function str(v, max = 300) {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || v.length > max) fail('VALIDATION', '문자열 형식을 확인해주세요.');
    return v.trim() || null;
  }
  function count(v) {
    if (v == null || v === '') return null;
    if (!/^\d+$/.test(String(v)) || !Number.isSafeInteger(Number(v))) fail('VALIDATION', '개수는 0 이상의 정수여야 해요.');
    return Number(v);
  }
  function date(v) {
    const s = str(v, 10);
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s + 'T00:00:00Z')) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) {
      fail('VALIDATION', '실제 로깅 날짜(YYYY-MM-DD)를 입력해주세요.');
    }
    return s;
  }
  function duration(raw) {
    if (!raw) return null;
    const m = /^(\d{1,5}):([0-5]\d):([0-5]\d)$/.exec(raw);
    if (!m) fail('VALIDATION', '녹화 시간은 HH:MM:SS로 입력해주세요. 알 수 없으면 비워두세요.');
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  function normalize(input) {
    if (!input || typeof input !== 'object') fail('VALIDATION', '기록 값이 필요해요.');
    const folder = str(input.folder);
    if (!folder) fail('VALIDATION', '세션 폴더명을 확인해주세요.');
    const startedTime = str(input.startedTime, 8);
    if (startedTime && !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(startedTime)) fail('VALIDATION', '시작 시각은 HH:MM:SS로 입력해주세요.');
    const durationRaw = str(input.durationRaw, 40);
    const sizeValue = str(input.sizeValue, 40), sizeUnit = str(input.sizeUnit, 8);
    if (sizeValue && !/^\d+(\.\d{1,12})?$/.test(sizeValue)) fail('VALIDATION', '용량 숫자를 확인해주세요.');
    if (sizeUnit && !['GB', 'TB', 'GiB', 'TiB'].includes(sizeUnit)) fail('VALIDATION', '용량 단위를 확인해주세요.');
    if (!!sizeValue !== !!sizeUnit) fail('VALIDATION', '용량 숫자와 단위를 함께 입력하거나 모두 비워두세요.');
    const completion = str(input.completion, 20) || 'unknown';
    if (!['completed', 'recording', 'incomplete', 'failed', 'unknown'].includes(completion)) fail('VALIDATION', '완료 상태가 올바르지 않아요.');
    return { folder, loggingDate: date(input.loggingDate), startedTime, durationRaw, durationSec: duration(durationRaw),
      sizeRaw: str(input.sizeRaw, 100), sizeValue, sizeUnit,
      // LOGGERD GB/TB semantics have not been verified. Never infer a byte conversion.
      sizeBasis: 'unknown', sizeBytes: null,
      fileCount: count(input.fileCount), recordingCount: count(input.recordingCount), completion,
      loggerScope: str(input.loggerScope), vehicleName: str(input.vehicleName), externalSessionId: str(input.externalSessionId, 100) };
  }
  function identity(v) { return JSON.stringify([v.loggerScope || '', v.folder.normalize('NFC')]); }
  function validateRecognition(result) {
    if (!result || result.schemaVersion !== 1 || !Array.isArray(result.sessions) || result.sessions.length > 100) fail('INVALID_RESPONSE', '인식 응답 형식이 올바르지 않아요.');
    return { schemaVersion: 1, sessions: result.sessions.map(s => {
      if (!s || !s.fields || typeof s.fields !== 'object') fail('INVALID_RESPONSE', '세션 인식 필드가 없어요.');
      const fields = {};
      FIELDS.forEach(k => { const v = s.fields[k]; fields[k] = v == null ? null : str(String(v), 300); });
      const evidence = {};
      FIELDS.forEach(k => {
        const e = s.evidence && s.evidence[k];
        if (e) evidence[k] = { label: str(e.label, 100), text: str(e.text, 300) };
      });
      const warnings = [];
      // A numeric token elsewhere on the page is never a session size.
      const sizeEvidence = evidence.sizeValue;
      const diskFree = /디스크\s*여유|남은\s*(공간|용량)/.test([fields.sizeRaw, sizeEvidence && sizeEvidence.label, sizeEvidence && sizeEvidence.text].filter(Boolean).join(' '));
      if ((fields.sizeValue || fields.sizeRaw || fields.sizeUnit) && (!sizeEvidence || sizeEvidence.label !== '전체 크기' || diskFree)) {
        fields.sizeValue = fields.sizeUnit = fields.sizeRaw = null;
        warnings.push('전체 크기 라벨을 확인할 수 없어 용량을 비웠어요.');
      }
      return { fields, evidence, warnings };
    }) };
  }
  // Exact decimal addition; unlike Number(), this retains all displayed decimal digits.
  function addDecimals(values) {
    let sum = 0n, scale = 0;
    for (const value of values) {
      const [a, b = ''] = value.split('.');
      const n = BigInt(a + b);
      if (b.length > scale) { sum *= 10n ** BigInt(b.length - scale); scale = b.length; }
      sum += n * 10n ** BigInt(scale - b.length);
    }
    if (!scale) return String(sum);
    const s = String(sum).padStart(scale + 1, '0');
    return (s.slice(0, -scale) + '.' + s.slice(-scale)).replace(/\.?0+$/, '');
  }
  function totals(rows) {
    const groups = new Map();
    for (const r of rows) {
      if (r.data.completion !== 'completed') continue;
      const d = r.data;
      for (const [dimension, key] of [['date', d.loggingDate], ['vehicle', d.vehicleName || '미연결']]) {
        const id = JSON.stringify([dimension, key, d.sizeUnit || '미상']);
        if (!groups.has(id)) groups.set(id, { dimension, key, unit: d.sizeUnit, sessions: 0, values: [] });
        const g = groups.get(id); g.sessions++; if (d.sizeValue != null) g.values.push(d.sizeValue);
      }
    }
    return [...groups.values()].map(({ values, ...g }) => ({ ...g, knownSizes: values.length, total: values.length ? addDecimals(values) : null }));
  }
  return { FIELDS, METHODS, normalize, identity, validateRecognition, totals, addDecimals, fail };
}));
