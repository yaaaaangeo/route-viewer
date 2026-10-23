'use strict';
const L = require('../src/js/logging-records');
const { LoggingService, safeError } = require('./logging-service');
const DOMAIN_ERRORS = new Set(['VALIDATION', 'NOT_FOUND', 'REVIEW_CONFLICT', 'MOCK_ACK_REQUIRED', 'DUPLICATE_SESSION', 'SOURCE_CONFLICT', 'FIELD_CONFLICT', 'VERSION_CONFLICT']);
function registerLoggingIpc({ ipcMain, db, root, dialog, nativeImage, getWindow }) {
  const service = new LoggingService({ db, root,
    validateImage(bytes) { const image = nativeImage.createFromBuffer(bytes); return image.isEmpty() ? null : image.getSize(); },
    onChange() { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('logging:changed'); },
  });
  function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        const win = getWindow();
        if (!win || event.sender !== win.webContents) return { ok: false, error: '허용되지 않은 요청이에요.', errorCode: 'FORBIDDEN' };
        if (JSON.stringify(args).length > 100000) return { ok: false, error: '요청 크기가 너무 커요.', errorCode: 'VALIDATION' };
        return { ok: true, value: await fn(...args) };
      } catch (e) {
        // Never log request payloads, image text, provider errors or file paths.
        const error = DOMAIN_ERRORS.has(e.code) ? { code: e.code, message: e.message } : safeError(e);
        return { ok: false, error: error.message, errorCode: error.code };
      }
    });
  }
  handle('logging:getCapabilities', () => service.capabilities());
  handle('logging:pickPhotos', async () => {
    const selected = await dialog.showOpenDialog(getWindow(), { title: 'LOGGERD 사진 선택 (Mock 검토 흐름)',
      properties: ['openFile', 'multiSelections'], filters: [{ name: '사진', extensions: ['jpg', 'jpeg', 'png'] }] });
    return selected.canceled ? [] : service.importFiles(selected.filePaths);
  });
  handle('logging:readAsset', assetId => service.readAsset(assetId));
  handle('logging:listJobs', () => service.listJobs());
  handle('logging:retryJob', jobId => service.retryJob(jobId));
  L.METHODS.forEach(method => handle('db:' + method, async (...args) => {
    if (method === 'confirmLoggingCandidate') {
      const candidate = db.getLoggingCandidate(args[0] && args[0].candidateId);
      await service.readAsset(candidate.assetId);
    }
    const result = db[method](...args);
    if (['confirmLoggingCandidate', 'rejectLoggingCandidate', 'updateLoggingSession'].includes(method)) service.emit();
    return result;
  }));
  return service;
}
module.exports = { registerLoggingIpc };
