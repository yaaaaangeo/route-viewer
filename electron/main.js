// ══════════════════════════════════════════════════════════
//  main.js — Route Viewer 데스크톱 앱 (Electron 메인 프로세스)
//
//  · 화면은 기존 route-viewer 를 그대로 쓴다 (src/index.html)
//  · 데이터는 사용자 프로필 폴더의 SQLite 파일에 영구 저장한다
//      %APPDATA%\Route Viewer\database\route-viewer.db
//    → 앱을 껐다 켜도, PC를 재부팅해도, 앱을 업데이트해도 남는다.
// ══════════════════════════════════════════════════════════
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { RouteDatabase } = require('./database.js');
const { AutoImporter } = require('./auto-import.js');
const RouteParser = require('../src/js/parser.js');
const MapCapture = require('../src/js/map-capture.js');
const { applyOsmTileUserAgent } = require('./osm-tile-ua.js');

const APP_ID = 'com.navapp.routeviewer';

// 자동 테스트(ROUTE_VIEWER_E2E)는 화면을 조작하며 기록을 넣고 날짜를 지운다 — 실제 주행 DB 를 절대 쓰지 않게,
// userData 가 임시 폴더 안이 아니면(--user-data-dir 을 빠뜨린 경우 등) 여기서 새 임시 폴더로 바꾼다.
if (process.env.ROUTE_VIEWER_E2E) {
  const os = require('os');
  const tmpRoot = path.resolve(os.tmpdir()).toLowerCase();
  if (!path.resolve(app.getPath('userData')).toLowerCase().startsWith(tmpRoot + path.sep)) {
    app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'rv-e2e-')));
  }
}

let mainWindow = null;
let db = null;
let updateCheckIsManual = false;
let autoUpdater = null;
let autoImporter = null;

function dbFilePath() {
  return path.join(app.getPath('userData'), 'database', 'route-viewer.db');
}

function openDatabase() {
  if (db) return db;
  db = new RouteDatabase(dbFilePath());
  return db;
}

function normalizeServerUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// ══════════════════════════════════════════════════════════
//  자동 업데이트 — server.js 를 띄운 주소를 그대로 배포 주소로 쓴다.
//  [데이터 관리] 탭에 입력한 "서버 동기화 주소"/<주소>/updates 에서
//  release/ 폴더(설치 파일 + latest.yml)를 그대로 받아온다.
// ══════════════════════════════════════════════════════════
function configureAutoUpdater() {
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    console.warn('[route-viewer] auto updater disabled:', err);
    autoUpdater = null;
    return;
  }

  autoUpdater.autoDownload = false;

  autoUpdater.on('error', err => {
    console.warn('[route-viewer] 업데이트 확인 실패:', err);
    if (updateCheckIsManual) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '업데이트 확인 실패',
        message: '업데이트 서버에 연결하지 못했어요.',
        detail: String((err && err.message) || err),
        buttons: ['확인'],
      });
    }
    updateCheckIsManual = false;
  });

  autoUpdater.on('update-available', info => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '업데이트 확인',
      message: `새 버전 ${info.version} 이 있어요. 지금 받을까요?`,
      buttons: ['취소', '받기'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    }).then(res => {
      if (res.response === 1) autoUpdater.downloadUpdate();
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (updateCheckIsManual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '업데이트 확인',
        message: '이미 최신 버전이에요.',
        buttons: ['확인'],
      });
    }
    updateCheckIsManual = false;
  });

  autoUpdater.on('download-progress', p => {
    if (mainWindow) mainWindow.setTitle(`경로 뷰어 — 업데이트 받는 중 ${Math.round(p.percent)}%`);
  });

  autoUpdater.on('update-downloaded', () => {
    if (mainWindow) mainWindow.setTitle('경로 뷰어');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '업데이트 준비 완료',
      message: '새 버전을 받았어요. 지금 다시 시작해서 설치할까요?',
      detail: '나중에를 눌러도, 다음에 앱을 다시 시작할 때 자동으로 설치돼요.',
      buttons: ['나중에', '지금 재시작'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    }).then(res => {
      if (res.response === 1) { quitting = true; autoUpdater.quitAndInstall(); }
    });
  });
}

async function triggerUpdateCheck(manual) {
  if (!autoUpdater) {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '업데이트 확인',
        message: '이 실행 환경에서는 자동 업데이트 모듈을 사용할 수 없어요.',
        buttons: ['확인'],
      });
    }
    return;
  }
  if (!app.isPackaged) {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '업데이트 확인',
        message: '설치된 앱이 아니라 개발 모드로 실행 중이라 업데이트를 확인할 수 없어요.',
        buttons: ['확인'],
      });
    }
    return;
  }
  const cfg = openDatabase().getSyncConfig();
  const base = normalizeServerUrl(cfg.serverUrl);
  if (!base) {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '업데이트 확인',
        message: '먼저 [데이터 관리] 탭에서 서버 동기화 주소를 입력해주세요.',
        detail: '같은 주소에서 새 버전도 함께 확인해요.',
        buttons: ['확인'],
      });
    }
    return;
  }
  updateCheckIsManual = !!manual;
  autoUpdater.setFeedURL({ provider: 'generic', url: `${base}/updates` });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn('[route-viewer] 업데이트 확인 실패:', err);
  }
}

// ══════════════════════════════════════════════════════════
//  주행기록 자동 가져오기 — Google Drive 데스크톱 앱이 동기화한 로컬 폴더를 주기적으로 훑는다.
//  처리는 메인 프로세스에서 하고(화면이 꺼져 있어도 같은 DB), 새로 반영한 게 있으면 화면에 알린다.
// ══════════════════════════════════════════════════════════
function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function getAutoImporter() {
  if (autoImporter) return autoImporter;
  autoImporter = new AutoImporter({
    db: openDatabase(),
    parseBuffer: RouteParser.parseBuffer,
    onBatch: result => sendToWindow('autoImport:changed', result),
    onStatus: () => sendToWindow('autoImport:status', autoImporter.status()),
  });
  return autoImporter;
}

// ══════════════════════════════════════════════════════════
//  데스크톱 실행 옵션 — Windows 시작 시 자동 실행 · 창을 닫으면 트레이로 숨기기
//  자동 가져오기는 앱이 켜져 있어야 돈다. 창을 닫아도 트레이에 남아 있으면 계속 확인한다.
//  · 로그인 시 자동 실행은 설치판에서만 등록한다(개발 실행은 electron.exe 를 등록하게 되므로)
//  · 자동 실행으로 켜질 때는 --hidden 으로 창 없이 트레이에서 시작한다
// ══════════════════════════════════════════════════════════
const START_HIDDEN_ARG = '--hidden';
const startHidden = process.argv.includes(START_HIDDEN_ARG);
let tray = null;
let quitting = false;
let trayHintShown = false;

function iconPath() { return path.join(__dirname, '..', 'build', 'icon.ico'); }

function storedDesktopPrefs() {
  try { return { closeToTray: false, ...JSON.parse(openDatabase().getMeta('desktop_prefs', '{}')) }; }
  catch (_) { return { closeToTray: false }; }
}

function getDesktopPrefs() {
  const login = app.isPackaged ? app.getLoginItemSettings({ args: [START_HIDDEN_ARG] }) : null;
  return {
    closeToTray: !!storedDesktopPrefs().closeToTray,
    openAtLogin: !!(login && login.openAtLogin),
    canOpenAtLogin: app.isPackaged,
  };
}

function setDesktopPrefs(patch) {
  const p = patch || {};
  if ('closeToTray' in p) {
    openDatabase().setMeta('desktop_prefs', JSON.stringify({ ...storedDesktopPrefs(), closeToTray: !!p.closeToTray }));
    if (p.closeToTray) ensureTray(); else if (mainWindow && mainWindow.isVisible()) destroyTray();
  }
  if ('openAtLogin' in p) {
    if (!app.isPackaged) throw new Error('Windows 시작 시 자동 실행은 설치한 앱에서만 켤 수 있어요.');
    app.setLoginItemSettings({ openAtLogin: !!p.openAtLogin, args: [START_HIDDEN_ARG] });
    // 자동 실행으로 켜지면 창 없이 트레이에서 시작하므로, 창을 닫아도 꺼지지 않게 트레이 옵션도 같이 켠다
    if (p.openAtLogin && !storedDesktopPrefs().closeToTray) setDesktopPrefs({ closeToTray: true });
  }
  return getDesktopPrefs();
}

function showMainWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray() {
  if (tray) return tray;
  let image = nativeImage.createFromPath(iconPath());
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('경로 뷰어 — 주행기록 자동 가져오기 중');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '경로 뷰어 열기', click: showMainWindow },
    { label: '지금 확인 (자동 가져오기)', click: () => { getAutoImporter().runOnce('manual').catch(() => {}); } },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
  return tray;
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

// ── 창 ────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0a0e16',
    show: false,
    title: '경로 뷰어',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 로그인 자동 실행(--hidden)으로 켜진 첫 창은 보이지 않게 둔다 — 트레이에서 열 수 있다
  const hideFirst = startHidden && !tray;
  mainWindow.once('ready-to-show', () => { if (!hideFirst) mainWindow.show(); });

  // 트레이로 숨기기가 켜져 있으면 [X] 는 앱을 끄지 않고 창만 숨긴다(자동 가져오기는 계속).
  // 메뉴 [종료] · 트레이 [종료] · 업데이트 설치는 before-quit 으로 quitting 이 켜져 그대로 닫힌다.
  mainWindow.on('close', e => {
    if (quitting || !storedDesktopPrefs().closeToTray) return;
    e.preventDefault();
    mainWindow.hide();
    ensureTray();
    if (!trayHintShown && tray && tray.displayBalloon) {
      trayHintShown = true;
      tray.displayBalloon({ iconType: 'info', title: '경로 뷰어는 계속 실행 중이에요',
        content: '트레이에서 주행기록 자동 가져오기를 계속해요. 완전히 끄려면 트레이 아이콘 › 종료.' });
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // 외부 링크는 기본 브라우저로 — 앱 창이 지도 타일 사이트로 날아가지 않게
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const template = [
    {
      label: '파일',
      submenu: [
        {
          label: '주행기록 파일 불러오기…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow && mainWindow.webContents.send('menu:open-files'),
        },
        { type: 'separator' },
        {
          label: '백업 저장…',
          click: () => mainWindow && mainWindow.webContents.send('menu:export-backup'),
        },
        {
          label: '백업 복구…',
          click: () => mainWindow && mainWindow.webContents.send('menu:import-backup'),
        },
        { type: 'separator' },
        {
          label: '데이터 폴더 열기',
          click: () => shell.showItemInFolder(dbFilePath()),
        },
        { type: 'separator' },
        { role: 'quit', label: '종료' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로고침' },
        { role: 'toggleDevTools', label: '개발자 도구' },
        { type: 'separator' },
        { role: 'resetZoom', label: '기본 크기' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
      ],
    },
    {
      label: '데이터',
      submenu: [
        {
          label: '데이터 관리 (날짜별 삭제)',
          click: () => mainWindow && mainWindow.webContents.send('menu:open-data-manager'),
        },
      ],
    },
    {
      label: '도움말',
      submenu: [
        {
          label: '업데이트 확인',
          click: () => triggerUpdateCheck(true),
        },
        { type: 'separator' },
        {
          label: 'Route Viewer 정보',
          click: () => {
            const stats = openDatabase().getStats();
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Route Viewer 정보',
              message: `경로 뷰어 v${app.getVersion()}`,
              detail:
                `저장된 날짜 ${stats.days}일\n` +
                `GPS 포인트 ${stats.points.toLocaleString('ko-KR')}개\n` +
                `Import 이력 ${stats.imports}건\n\n` +
                `데이터베이스\n${stats.dbPath}\n` +
                `(${(stats.dbBytes / 1024 / 1024).toFixed(1)} MB)`,
              buttons: ['확인'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC — 화면(renderer)이 부르는 DB 기능들 ───────────
function handle(channel, fn) {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      console.error(`[route-viewer] ${channel} 실패:`, err);
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

function registerIpc() {
  handle('db:stats', () => openDatabase().getStats());
  handle('db:importRecords', (records, meta) => openDatabase().importRecords(records, meta));
  handle('db:listDateSummaries', () => openDatabase().listDateSummaries());
  handle('db:getRecordsByDate', date => openDatabase().getRecordsByDate(date));
  handle('db:getOverview', filter => openDatabase().getOverview(filter));
  handle('db:getDensityCells', (filter, cell) => openDatabase().getDensityCells(filter, cell));
  handle('db:getStatsBundle', (filter, options) => openDatabase().getStatsBundle(filter, options));
  handle('db:listSubZones', options => openDatabase().listSubZones(options));
  handle('db:getSubZone', id => openDatabase().getSubZone(id));
  handle('db:saveSubZone', subZone => openDatabase().saveSubZone(subZone));
  handle('db:setSubZoneActive', (id, active) => openDatabase().setSubZoneActive(id, active));
  handle('db:deleteSubZone', id => openDatabase().deleteSubZone(id));
  handle('db:getSubZoneStats', (subZones, options) => openDatabase().getSubZoneStats(subZones, options));
  handle('db:getHDMapPriorityPolygons', () => openDatabase().getHDMapPriorityPolygons());
  handle('db:saveHDMapPriorityPolygon', (areaNo, polygon) => openDatabase().saveHDMapPriorityPolygon(areaNo, polygon));
  handle('db:getAutoAnalysis', (parentZone, options) => openDatabase().getAutoAnalysis(parentZone, options));
  handle('db:listSubZoneOverrides', parentZone => openDatabase().listSubZoneOverrides(parentZone));
  handle('db:saveSubZoneOverride', override => openDatabase().saveSubZoneOverride(override));
  handle('db:deleteSubZoneOverride', id => openDatabase().deleteSubZoneOverride(id));
  handle('db:getAccumBundle', (filter, cell) => openDatabase().getAccumBundle(filter, cell));
  handle('db:getBounds', filter => openDatabase().getBounds(filter));
  handle('db:getVisitedCellKeys', box => openDatabase().getVisitedCellKeys(box));
  handle('db:getDistribution', (col, filter) => openDatabase().getDistribution(col, filter));
  handle('db:getTimeBucketDistribution', filter => openDatabase().getTimeBucketDistribution(filter));
  handle('db:deleteDate', date => openDatabase().deleteDate(date));
  handle('db:deleteAll', () => openDatabase().deleteAll());
  handle('db:getZonePolygons', () => openDatabase().getZonePolygons());
  handle('db:saveZonePolygons', polys => openDatabase().saveZonePolygons(polys));
  handle('db:listImports', (limit, options) => openDatabase().listImports(limit, options));
  handle('db:findImportByFileHash', hash => openDatabase().findImportByFileHash(hash));
  handle('db:getImportConflicts', importId => openDatabase().getImportConflicts(importId));
  handle('db:listVehicles', () => openDatabase().listVehicles());
  handle('db:saveVehicle', v => openDatabase().saveVehicle(v));
  handle('db:setVehicleActive', (name, active) => openDatabase().setVehicleActive(name, active));
  handle('db:listZones', () => openDatabase().listZones());
  handle('db:saveZone', z => openDatabase().saveZone(z));
  handle('db:setZoneActive', (name, active) => openDatabase().setZoneActive(name, active));
  handle('db:getZoneManualCells', name => openDatabase().getZoneManualCells(name));
  handle('db:saveZoneManualCells', (name, data) => openDatabase().saveZoneManualCells(name, data));
  handle('db:getSettings', () => openDatabase().getSettings());
  handle('db:setSettings', partial => openDatabase().setSettings(partial));
  handle('db:getClassificationStatus', () => openDatabase().getClassificationStatus());
  handle('db:reclassifySummaries', () => openDatabase().reclassifySummaries());
  handle('db:saveCoverageSnapshot', (zone, snap) => openDatabase().saveCoverageSnapshot(zone, snap));
  handle('db:listCoverageSnapshots', () => openDatabase().listCoverageSnapshots());
  handle('db:listRecommendationStates', () => openDatabase().listRecommendationStates());
  handle('db:setRecommendationState', (id, state) => openDatabase().setRecommendationState(id, state));
  handle('db:getImport', id => openDatabase().getImport(id));
  handle('db:updateImportIssue', (id, patch) => openDatabase().updateImportIssue(id, patch));
  handle('db:reviewAllPendingImports', () => openDatabase().reviewAllPendingImports());
  handle('db:listDateImports', date => openDatabase().listDateImports(date));
  handle('db:getIssueOverview', filter => openDatabase().getIssueOverview(filter));
  handle('db:restoreImports', imports => openDatabase().restoreImports(imports));
  handle('db:getCellVisitCounts', (box, cellSizeM) => openDatabase().getCellVisitCounts(box, cellSizeM));
  handle('db:getBackupHistory', () => openDatabase().getBackupHistory());
  handle('db:setBackupHistory', h => openDatabase().setBackupHistory(h));
  handle('db:buildBackupPayload', () => openDatabase().buildBackupPayload());
  handle('db:restoreBackupPayload', (payload, mode) => openDatabase().restoreBackupPayload(payload, mode));
  handle('db:rebuildAllSummaries', () => openDatabase().rebuildAllSummaries());
  // 개인용 Career Log — 로컬 SQLite 에만 저장(백업·서버 동기화 대상 아님)
  handle('db:listCareerItems', kind => openDatabase().listCareerItems(kind));
  handle('db:saveCareerItem', (kind, item) => openDatabase().saveCareerItem(kind, item));
  handle('db:deleteCareerItem', (kind, id) => openDatabase().deleteCareerItem(kind, id));

  // 파일 선택 다이얼로그 — 메뉴/버튼에서 부르면 실제 경로를 읽어 넘겨준다
  handle('app:pickRouteFiles', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '주행기록 파일 선택',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '주행기록', extensions: ['xlsx', 'xls', 'csv'] }],
    });
    if (res.canceled) return [];
    return res.filePaths.map(p => ({
      name: path.basename(p),
      path: p,
      buffer: fs.readFileSync(p),
    }));
  });

  handle('app:pickBackupFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '백업 파일 선택',
      properties: ['openFile'],
      filters: [{ name: '백업 JSON', extensions: ['json'] }],
    });
    if (res.canceled) return null;
    return { name: path.basename(res.filePaths[0]), text: fs.readFileSync(res.filePaths[0], 'utf8') };
  });

  handle('app:saveBackupFile', async (defaultName, json) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '백업 저장',
      defaultPath: defaultName,
      filters: [{ name: '백업 JSON', extensions: ['json'] }],
    });
    if (res.canceled) return null;
    fs.writeFileSync(res.filePath, json, 'utf8');
    return res.filePath;
  });

  // Career Log Export(JSON/CSV/Markdown) — 사용자가 고른 로컬 경로에만 쓴다(네트워크 전송 없음)
  const TEXT_FILE_FILTERS = {
    json: { name: 'JSON', extensions: ['json'] },
    csv: { name: 'CSV', extensions: ['csv'] },
    md: { name: 'Markdown', extensions: ['md'] },
  };
  handle('app:saveTextFile', async (defaultName, text, format) => {
    const filter = TEXT_FILE_FILTERS[format];
    if (!filter) throw new Error('저장할 수 없는 파일 형식이에요.');
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '파일로 저장',
      defaultPath: path.join(app.getPath('documents'), path.basename(String(defaultName || `export.${format}`))),
      filters: [filter],
    });
    if (res.canceled || !res.filePath) return null;
    const ext = '.' + filter.extensions[0];
    const filePath = res.filePath.toLowerCase().endsWith(ext) ? res.filePath : res.filePath + ext;
    fs.writeFileSync(filePath, String(text || ''), 'utf8');
    return filePath;
  });

  handle('app:confirm', async opts => {
    const res = await dialog.showMessageBox(mainWindow, {
      type: opts.type || 'warning',
      title: opts.title || '확인',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: opts.buttons || ['취소', '확인'],
      defaultId: opts.defaultId != null ? opts.defaultId : 0,
      cancelId: opts.cancelId != null ? opts.cancelId : 0,
      noLink: true,
    });
    return res.response;
  });

  handle('app:info', () => ({
    version: app.getVersion(),
    dbPath: dbFilePath(),
    userData: app.getPath('userData'),
  }));

  handle('app:revealDatabase', () => { shell.showItemInFolder(dbFilePath()); return true; });
  handle('app:getDesktopPrefs', () => getDesktopPrefs());
  handle('app:setDesktopPrefs', patch => setDesktopPrefs(patch));
  handle('app:checkForUpdates', () => triggerUpdateCheck(true));

  // ── 누적 지도 캡처 ─────────────────────────────────────
  // 화면이 넘긴 지도 영역(CSS px)만 webContents.capturePage()로 찍는다 — 화면에 실제로
  // 그려진 픽셀을 그대로 가져오므로 외부 지도 타일(CORS)·Leaflet Canvas Layer도 빠지지 않는다.
  // 저장 대화상자보다 먼저 찍어서 대화상자가 이미지에 들어가지 않게 한다.
  // 반환: {canceled:true} | {canceled:false, filePath, width, height, bytes}
  handle('app:captureMap', async (rect, defaultName) => {
    if (!mainWindow) throw new Error('앱 창이 없어요.');
    const wc = mainWindow.webContents;
    const [viewWidth, viewHeight] = mainWindow.getContentSize();
    const area = MapCapture.normalizeCaptureRect(rect, wc.getZoomFactor(), { width: viewWidth, height: viewHeight });
    const image = await wc.capturePage(area);
    if (!image || image.isEmpty()) throw new Error('지도 화면을 캡처하지 못했어요.');
    const png = image.toPNG();
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '현재 지도 캡처 저장',
      defaultPath: path.join(app.getPath('pictures'), MapCapture.safeCaptureFileName(defaultName)),
      filters: [{ name: 'PNG 이미지', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const filePath = /\.png$/i.test(res.filePath) ? res.filePath : res.filePath + '.png';
    await fs.promises.writeFile(filePath, png);
    const size = image.getSize();
    return { canceled: false, filePath, width: size.width, height: size.height, bytes: png.length };
  });

  // ── 주행기록 자동 가져오기 ─────────────────────────────
  handle('autoImport:getStatus', () => getAutoImporter().status());
  // 폴더는 선택 대화상자로만 받는다(Drive 웹 주소를 붙여 넣는 경로가 없다). 고른 뒤 최초 연결 미리보기를 돌려준다.
  handle('autoImport:pickFolder', async () => {
    const cur = getAutoImporter().config().folder;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '주행기록 자동 가져오기 폴더 선택 (Google Drive 동기화 폴더)',
      defaultPath: cur || undefined,
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const preview = await getAutoImporter().setFolder(res.filePaths[0]);
    return { preview, status: getAutoImporter().status() };
  });
  handle('autoImport:confirmInitial', mode => getAutoImporter().confirmInitial(mode));
  handle('autoImport:preview', () => getAutoImporter().preview());
  handle('autoImport:setEnabled', on => getAutoImporter().setEnabled(on));
  handle('autoImport:setInterval', sec => getAutoImporter().setIntervalSec(sec));
  handle('autoImport:runNow', () => getAutoImporter().runOnce('manual'));
  handle('autoImport:retry', pathKeys => getAutoImporter().retryFailed(pathKeys));
  handle('autoImport:importBaseline', () => getAutoImporter().importBaseline());
  handle('autoImport:revealFolder', () => {
    const folder = getAutoImporter().config().folder;
    if (folder) shell.openPath(folder);
    return !!folder;
  });

  // ══════════════════════════════════════════════════════
  //  서버 동기화 — server.js 를 하나 띄워두면 여러 데스크톱 앱이
  //  같은 주소로 "지금 동기화"를 눌러 서로의 기록을 합칠 수 있다.
  //
  //  1) 서버에 있는 기록을 받아 내 DB에 merge (기존 restoreBackupPayload 재사용)
  //  2) 방금 병합된 내 DB 전체를 서버로 올림 — 서버도 merge 해서 저장하므로
  //     반복 실행해도, 순서가 엇갈려도 데이터가 지워지거나 부풀지 않는다.
  // ══════════════════════════════════════════════════════
  handle('sync:getConfig', () => openDatabase().getSyncConfig());
  handle('sync:setConfig', config => openDatabase().setSyncConfig(config));

  handle('sync:run', async () => {
    const database = openDatabase();
    const cfg = database.getSyncConfig();
    const base = normalizeServerUrl(cfg.serverUrl);
    if (!base) throw new Error('서버 주소를 먼저 입력해주세요.');

    const headers = {};
    if (cfg.token) headers['X-Route-Viewer-Token'] = cfg.token;

    let pulled = { total: 0, inserted: 0, duplicates: 0, dates: [] };
    const getRes = await fetch(`${base}/api/route-data`, { headers });
    if (getRes.status === 404) {
      // 서버에 아직 아무 기록도 없음 — 내려받을 게 없을 뿐 오류는 아니다
    } else if (!getRes.ok) {
      throw new Error(`서버에서 불러오지 못했어요 (HTTP ${getRes.status})`);
    } else {
      const remote = await getRes.json();
      pulled = database.restoreBackupPayload(remote, 'merge');
    }

    const payload = database.buildBackupPayload();
    const putRes = await fetch(`${base}/api/route-data`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const putText = await putRes.text();
    let putJson = null;
    try { putJson = putText ? JSON.parse(putText) : null; } catch (_) { /* 응답이 JSON이 아니면 무시 */ }
    if (!putRes.ok) {
      throw new Error((putJson && putJson.error) || `서버에 올리지 못했어요 (HTTP ${putRes.status})`);
    }

    const syncedAt = new Date().toISOString();
    database.setSyncConfig({ ...cfg, lastSyncAt: syncedAt });

    return {
      pulled,
      pushedInserted: putJson && putJson.inserted,
      pushedDuplicates: putJson && putJson.duplicates,
      syncedAt,
      stats: database.getStats(),
    };
  });
}

// ── 앱 수명주기 ───────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 이미 켜져 있으면(트레이에 숨어 있어도) 그 창을 앞으로 꺼낸다
  app.on('second-instance', () => showMainWindow());

  app.on('before-quit', () => { quitting = true; });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    // 창을 만들기 전에 걸어야 첫 타일 요청부터 적용된다 — 안 걸면 OSM 이 Electron UA 를
    // 차단해서 지도가 "Access blocked" 타일로 덮인다.
    applyOsmTileUserAgent(session.defaultSession, app.getVersion());
    openDatabase();
    registerIpc();
    buildMenu();
    configureAutoUpdater();
    // 로그인 자동 실행으로 숨겨서 켜졌거나 트레이 옵션이 켜져 있으면 트레이 아이콘을 먼저 둔다
    if (startHidden || storedDesktopPrefs().closeToTray) ensureTray();
    createWindow();

    // 자동 가져오기 — 화면이 다 뜬 뒤 첫 확인(앱 시작 시), 이후 설정 간격(기본 60초)마다.
    // 화면이 먼저 DB 를 읽고 변경 알림을 받을 준비가 된 다음에 돌도록 did-finish-load 를 기다린다.
    mainWindow.webContents.once('did-finish-load', () => getAutoImporter().start());

    // 시작하고 몇 초 뒤 조용히 한 번 확인 — 주소가 설정돼 있을 때만, 실패해도 알림 없음
    setTimeout(() => triggerUpdateCheck(false).catch(() => {}), 4000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // 자동 테스트용 훅 — 평소에는 아무 일도 하지 않는다.
    // tests/e2e.js 가 ROUTE_VIEWER_E2E 에 드라이버 경로를 넣고 실행한다.
    if (process.env.ROUTE_VIEWER_E2E) {
      require(process.env.ROUTE_VIEWER_E2E)({ app, mainWindow, dbFilePath });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // node-sqlite3-wasm 은 수동으로 닫아줘야 한다
  app.on('will-quit', () => {
    destroyTray();
    if (autoImporter) { autoImporter.stop(); autoImporter = null; }
    if (db) { db.close(); db = null; }
  });
}
