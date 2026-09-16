// ══════════════════════════════════════════════════════════
//  preload.js — 화면(renderer)에 안전하게 노출하는 DB/앱 기능
//
//  contextIsolation 이 켜져 있어서 화면 코드는 Node 를 직접 못 쓴다.
//  여기서 허용한 함수들만 window.routeAPI 로 보인다.
// ══════════════════════════════════════════════════════════
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 메인 프로세스는 {ok, value} / {ok:false, error} 로 답한다.
// 화면에서는 그냥 await 하면 되도록 여기서 풀어준다.
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.ok) throw new Error((res && res.error) || `${channel} 실패`);
  return res.value;
}

contextBridge.exposeInMainWorld('routeAPI', {
  isDesktop: true,

  // ── 저장소 ──
  stats: () => call('db:stats'),
  importRecords: (records, meta) => call('db:importRecords', records, meta),
  listDateSummaries: () => call('db:listDateSummaries'),
  getRecordsByDate: date => call('db:getRecordsByDate', date),
  getOverview: filter => call('db:getOverview', filter),
  getDensityCells: (filter, cell) => call('db:getDensityCells', filter, cell),
  getBounds: filter => call('db:getBounds', filter),
  getVisitedCellKeys: box => call('db:getVisitedCellKeys', box),
  getDistribution: (col, filter) => call('db:getDistribution', col, filter),
  getTimeBucketDistribution: filter => call('db:getTimeBucketDistribution', filter),
  deleteDate: date => call('db:deleteDate', date),
  deleteAll: () => call('db:deleteAll'),
  getZonePolygons: () => call('db:getZonePolygons'),
  saveZonePolygons: polys => call('db:saveZonePolygons', polys),
  listImports: (limit, options) => call('db:listImports', limit, options),
  findImportByFileHash: hash => call('db:findImportByFileHash', hash),
  getImportConflicts: importId => call('db:getImportConflicts', importId),
  listVehicles: () => call('db:listVehicles'),
  saveVehicle: v => call('db:saveVehicle', v),
  setVehicleActive: (name, active) => call('db:setVehicleActive', name, active),
  listZones: () => call('db:listZones'),
  saveZone: z => call('db:saveZone', z),
  setZoneActive: (name, active) => call('db:setZoneActive', name, active),
  getZoneManualCells: name => call('db:getZoneManualCells', name),
  saveZoneManualCells: (name, data) => call('db:saveZoneManualCells', name, data),
  getSettings: () => call('db:getSettings'),
  setSettings: partial => call('db:setSettings', partial),
  // 교통 시간대·조도 분류 기준이 바뀐 뒤 날짜 요약 재분류 — 진행률은 getClassificationStatus 로 본다
  getClassificationStatus: () => call('db:getClassificationStatus'),
  reclassifySummaries: () => call('db:reclassifySummaries'),
  // 추천 주행 — Coverage 스냅샷(누적 지도가 계산하면 저장) · 추천 상태(기간 제외·수집 완료 표시)
  saveCoverageSnapshot: (zone, snap) => call('db:saveCoverageSnapshot', zone, snap),
  listCoverageSnapshots: () => call('db:listCoverageSnapshots'),
  listRecommendationStates: () => call('db:listRecommendationStates'),
  setRecommendationState: (id, state) => call('db:setRecommendationState', id, state),
  // Import 이슈(파일별 이슈 여부·한 줄 메모·확인 상태)와 GPS 레코드 출처 관계
  getImport: id => call('db:getImport', id),
  updateImportIssue: (id, patch) => call('db:updateImportIssue', id, patch),
  listDateImports: date => call('db:listDateImports', date),
  getIssueOverview: filter => call('db:getIssueOverview', filter),
  restoreImports: imports => call('db:restoreImports', imports),
  getCellVisitCounts: (box, cellSizeM) => call('db:getCellVisitCounts', box, cellSizeM),
  getBackupHistory: () => call('db:getBackupHistory'),
  setBackupHistory: h => call('db:setBackupHistory', h),
  buildBackupPayload: () => call('db:buildBackupPayload'),
  restoreBackupPayload: (payload, mode) => call('db:restoreBackupPayload', payload, mode),
  rebuildAllSummaries: () => call('db:rebuildAllSummaries'),

  // ── 앱 ──
  pickRouteFiles: () => call('app:pickRouteFiles'),
  pickBackupFile: () => call('app:pickBackupFile'),
  saveBackupFile: (name, json) => call('app:saveBackupFile', name, json),
  confirm: opts => call('app:confirm', opts),
  info: () => call('app:info'),
  revealDatabase: () => call('app:revealDatabase'),
  checkForUpdates: () => call('app:checkForUpdates'),
  // 누적 지도 캡처 — 지도 영역 좌표와 기본 파일명만 넘긴다. 캡처·저장 위치 선택·쓰기는
  // 메인 프로세스가 하므로 화면 코드는 임의 경로에 파일을 쓸 수 없다.
  captureMap: (rect, defaultName) => call('app:captureMap', rect, defaultName),

  // ── 서버 동기화 ──
  syncGetConfig: () => call('sync:getConfig'),
  syncSetConfig: config => call('sync:setConfig', config),
  syncRun: () => call('sync:run'),

  // ── 메뉴에서 오는 신호 ──
  onMenu: (name, handler) => {
    ipcRenderer.on('menu:' + name, () => handler());
  },
});
