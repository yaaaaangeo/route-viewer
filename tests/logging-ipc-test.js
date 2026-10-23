'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const { RouteDatabase } = require('../electron/database');
const { registerLoggingIpc } = require('../electron/logging-ipc');
const { createStorageContext } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-logging-ipc-'));
  let db;
  try {
    db = new RouteDatabase(path.join(dir, 'test.db'));
    const handlers = new Map(), emitter = new EventEmitter();
    const webContents = { send: event => emitter.emit(event) }, win = { webContents, isDestroyed: () => false };
    const service = registerLoggingIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, db, root: path.join(dir, 'photos'),
      dialog: { showOpenDialog: async () => ({ canceled: true }) }, nativeImage: {
        createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }),
      }, getWindow: () => win });
    let api;
    const preload = path.resolve(__dirname, '../electron/preload.js'), realRequire = createRequire(preload);
    const ipcRenderer = { invoke: async (name, ...args) => handlers.get(name)({ sender: webContents }, ...args),
      on: (...args) => emitter.on(...args), removeListener: (...args) => emitter.removeListener(...args) };
    vm.runInNewContext(fs.readFileSync(preload, 'utf8'), { require: name => name === 'electron'
      ? { ipcRenderer, contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } } } : realRequire(name) });
    assert.equal((await api.getLoggingCapabilities()).isMock, true);
    assert.deepEqual(await api.pickLoggingPhotos(), []);
    assert.equal((await api.listLoggingSessions()).length, 0);
    const forbidden = await handlers.get('db:listLoggingSessions')({ sender: {} });
    assert.equal(forbidden.errorCode, 'FORBIDDEN');
    console.log('PASS actual preload calls registered IPC; untrusted senders rejected');
    await assert.rejects(api.getLoggingSession('no-such-session'), e => e.code === 'NOT_FOUND');
    let notified = 0; const unsubscribe = api.onLoggingChange(() => notified++);
    webContents.send('logging:changed'); unsubscribe(); webContents.send('logging:changed'); assert.equal(notified, 1);
    console.log('PASS error codes preserved and event unsubscribe works');
    const fake = createFakeIndexedDB(), ctx = createStorageContext(fake);
    await ctx.RouteDB.init();
    assert.equal((await ctx.RouteDB.getLoggingCapabilities()).reasonCode, 'DESKTOP_ONLY');
    await assert.rejects(ctx.RouteDB.listLoggingSessions(), e => e.code === 'UNSUPPORTED_PLATFORM');
    assert.equal(ctx.RouteDB.kind, 'indexeddb'); assert.equal((await ctx.RouteDB.stats()).points, 0);
    console.log('PASS browser explicitly unsupported, existing IndexedDB operational');
    // Use the real desktop backend adapter (stats is outside the logging IPC wrapper).
    const desktop = createStorageContext({ api: { ...api, stats: async () => db.getStats() } });
    await desktop.RouteDB.init();
    assert.equal((await desktop.RouteDB.getLoggingTotals()).sessions, 0);
    console.log('PASS RouteDB desktop backend forwards logging calls');
    const photo = path.join(dir, 'test.png');
    fs.writeFileSync(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    await service.importFiles([photo]);
    const candidate = (await api.listLoggingCandidates())[0], asset = (await api.listLoggingAssets())[0];
    fs.unlinkSync(service.assetPath(asset.relative_path));
    await assert.rejects(api.confirmLoggingCandidate({ candidateId: candidate.id, data: { folder: 'test', loggingDate: '2026-10-21' }, mockAcknowledged: true }), e => e.code === 'ASSET_MISSING');
    assert.equal(db.listLoggingSessions().length, 0); assert.equal(db.getLoggingCandidate(candidate.id).state, 'pending');
    console.log('PASS confirmation rechecks original availability before committing');
  } finally { if (db) db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
