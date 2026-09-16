// ══════════════════════════════════════════════════════════
//  main.js — Route Viewer 데스크톱 앱 (Electron 메인 프로세스)
//
//  · 화면은 기존 route-viewer 를 그대로 쓴다 (src/index.html)
//  · 데이터는 사용자 프로필 폴더의 SQLite 파일에 영구 저장한다
//      %APPDATA%\Route Viewer\database\route-viewer.db
//    → 앱을 껐다 켜도, PC를 재부팅해도, 앱을 업데이트해도 남는다.
// ══════════════════════════════════════════════════════════
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { RouteDatabase } = require('./database.js');
const MapCapture = require('../src/js/map-capture.js');
const { applyOsmTileUserAgent } = require('./osm-tile-ua.js');

const APP_ID = 'com.navapp.routeviewer';
let mainWindow = null;
let db = null;
let updateCheckIsManual = false;
let autoUpdater = null;

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
      if (res.response === 1) autoUpdater.quitAndInstall();
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
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
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
  handle('db:listDateImports', date => openDatabase().listDateImports(date));
  handle('db:getIssueOverview', filter => openDatabase().getIssueOverview(filter));
  handle('db:restoreImports', imports => openDatabase().restoreImports(imports));
  handle('db:getCellVisitCounts', (box, cellSizeM) => openDatabase().getCellVisitCounts(box, cellSizeM));
  handle('db:getBackupHistory', () => openDatabase().getBackupHistory());
  handle('db:setBackupHistory', h => openDatabase().setBackupHistory(h));
  handle('db:buildBackupPayload', () => openDatabase().buildBackupPayload());
  handle('db:restoreBackupPayload', (payload, mode) => openDatabase().restoreBackupPayload(payload, mode));
  handle('db:rebuildAllSummaries', () => openDatabase().rebuildAllSummaries());

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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    // 창을 만들기 전에 걸어야 첫 타일 요청부터 적용된다 — 안 걸면 OSM 이 Electron UA 를
    // 차단해서 지도가 "Access blocked" 타일로 덮인다.
    applyOsmTileUserAgent(session.defaultSession, app.getVersion());
    openDatabase();
    registerIpc();
    buildMenu();
    configureAutoUpdater();
    createWindow();

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
    if (db) { db.close(); db = null; }
  });
}
