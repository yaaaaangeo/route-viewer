'use strict';
const L = require('../src/js/logging-records');

// Provider adapters must return this contract. No credentials cross the renderer boundary.
function assertRecognizer(recognizer) {
  if (!recognizer || typeof recognizer.id !== 'string' || typeof recognizer.version !== 'string' ||
      typeof recognizer.isMock !== 'boolean' || typeof recognizer.recognize !== 'function') {
    L.fail('INVALID_RECOGNIZER', '인식기 인터페이스가 올바르지 않아요.');
  }
  return recognizer;
}
class MockLoggingRecognizer {
  constructor(fixture) { this.id = 'mock'; this.version = '1'; this.isMock = true; this.fixture = fixture; }
  async recognize({ sha256 }) {
    if (this.fixture) return structuredClone(this.fixture);
    // Deliberately synthetic: never pretend to read a photo or infer its date/size.
    return { schemaVersion: 1, sessions: [1, 2].map(n => ({
      fields: { folder: `MOCK-${sha256.slice(0, 8)}-${n}`, completion: 'unknown' }, evidence: {},
    })) };
  }
}
module.exports = { assertRecognizer, MockLoggingRecognizer };
