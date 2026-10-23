'use strict';
// Runs through the existing safe main-process E2E hook, always in temporary userData.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
module.exports = ({ app, mainWindow: win, dbFilePath }) => {
  const root = path.resolve(app.getPath('userData'));
  if (!root.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep)) { app.exit(2); return; }
  win.webContents.once('did-finish-load', async () => {
    try {
      const { dialog, nativeImage } = require('electron');
      const photo = path.join(root, 'loggerd-test.png');
      fs.writeFileSync(photo, nativeImage.createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 }).toPNG());
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [photo, photo] });
      const js = source => win.webContents.executeJavaScript(`(async () => { return (${source}); })()`, true);
      // App startup is asynchronous after did-finish-load; poll only the readiness flag.
      for (let i = 0; i < 100; i++) {
        if (await js("typeof RouteDB !== 'undefined' && RouteDB.kind === 'sqlite' && typeof currentTab !== 'undefined'")) break;
        await new Promise(r => setTimeout(r, 50));
      }
      await js("(async () => { await allowedUsersReady; document.getElementById('login-name-input').value=getAllowedUsers()[0]; await submitLogin(); })()");
      const imported = await js('RouteDB.pickLoggingPhotos()');
      assert.equal(imported[0].state, 'succeeded'); assert.equal(imported[1].duplicate, true);
      await js("(switchTab('data'), renderLoggingRecordsPanel())");
      assert.ok(await js("document.getElementById('logging-records-panel').textContent.includes('Mock')"));
      const cid = await js('(await RouteDB.listLoggingCandidates())[0].id');
      await js(`document.querySelector('[data-logging-action="review"][data-id="${cid}"]').click()`);
      for (let i = 0; i < 100 && !(await js("!!document.getElementById('logging-form')")); i++) await new Promise(r => setTimeout(r, 30));
      await js(`(() => { const f=document.getElementById('logging-form'); f.elements.loggingDate.value='2026-10-21';
        f.elements.sizeValue.value='1.250';f.elements.sizeUnit.value='TB'; f.elements.completion.value='completed';
        f.elements.mockAcknowledged.checked=true; f.requestSubmit(); })()`);
      for (let i = 0; i < 100 && !(await js('(await RouteDB.listLoggingSessions()).length===1')); i++) await new Promise(r => setTimeout(r, 30));
      const saved = await js('(await RouteDB.listLoggingSessions())[0]');
      assert.ok(saved); assert.equal(saved.data.sizeValue, '1.250'); assert.equal(saved.isMock, true);
      assert.equal((await js('RouteDB.getLoggingSession(' + JSON.stringify(saved.id) + ')')).evidence.length, 1);
      assert.equal((await js('RouteDB.getLoggingTotals()')).sessions, 0);
      assert.equal((await js('RouteDB.stats()')).points, 0);
      const original = await js('(await RouteDB.listLoggingAssets())[0].relative_path');
      assert.ok(fs.existsSync(path.join(root, 'logging', original)));
      console.log('PASS Electron native decode/picker → SHA-256 dedup → multi-session Mock → UI review → SQLite/evidence → GPS isolation');
      await js('renderLoggingRecordsPanel()');
      await js(`document.querySelector('[data-logging-action="edit"][data-id="${saved.id}"]').click()`);
      for (let i = 0; i < 100 && !(await js("!!document.getElementById('logging-form')")); i++) await new Promise(r => setTimeout(r, 30));
      await js("document.getElementById('logging-editor').scrollIntoView({block:'start'})");
      await new Promise(r => setTimeout(r, 200)); // Allow the compositor to paint the scrolled form.
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(root, 'logging-review.png'), shot.toPNG());
      await js(`(() => { const f=document.getElementById('logging-form'); f.elements.durationRaw.value='01:02:03';
        f.elements.reason.value='E2E original review'; f.requestSubmit(); })()`);
      for (let i = 0; i < 100 && !(await js(`(await RouteDB.getLoggingSession('${saved.id}')).version===2`)); i++) await new Promise(r => setTimeout(r, 30));
      const edited = await js(`RouteDB.getLoggingSession('${saved.id}')`);
      assert.equal(edited.data.durationSec, 3723); assert.equal(edited.revisions.length, 2);
      console.log('PASS detail UI edits append revision and preserve evidence');
      await js('renderLoggingRecordsPanel()');
      const second = await js('(await RouteDB.listLoggingCandidates())[0].id');
      await js(`document.querySelector('[data-logging-action="review"][data-id="${second}"]').click()`);
      for (let i = 0; i < 100 && !(await js("!!document.getElementById('logging-form')")); i++) await new Promise(r => setTimeout(r, 30));
      await js(`(() => { const f=document.getElementById('logging-form');f.elements.folder.value='${saved.data.folder}';
        f.elements.loggingDate.value='2026-10-21';f.elements.sizeValue.value='1.250';f.elements.sizeUnit.value='TB';
        f.elements.durationRaw.value='01:02:03';f.elements.completion.value='completed';f.elements.mockAcknowledged.checked=true;f.requestSubmit(); })()`);
      for (let i = 0; i < 100 && !(await js("!!document.querySelector('[name=resolution]')")); i++) await new Promise(r => setTimeout(r, 30));
      assert.ok(await js("document.getElementById('logging-conflict').textContent.includes('같은 세션')"));
      await js("(() => {const f=document.getElementById('logging-form');f.elements.resolution.value='attach';f.elements.reason.value='same session reviewed';f.requestSubmit();})()");
      for (let i = 0; i < 100 && !(await js('(await RouteDB.listLoggingCandidates()).length===0')); i++) await new Promise(r => setTimeout(r, 30));
      assert.equal((await js('RouteDB.listLoggingSessions()')).length, 1);
      assert.equal((await js(`RouteDB.getLoggingSession('${saved.id}')`)).evidence.length, 2);
      console.log('PASS duplicate folder UI requires comparison and attaches evidence without double counting');
      console.log('LOGGERD_E2E_SCREENSHOT=' + path.join(root, 'logging-review.png'));
      console.log('LOGGERD_E2E_DB=' + dbFilePath());
      app.exit(0);
    } catch (e) { console.error(e); app.exit(1); }
  });
};
