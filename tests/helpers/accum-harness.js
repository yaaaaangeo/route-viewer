// ══════════════════════════════════════════════════════════
//  accum-harness — 누적 지도(src/js/accum.js)를 실제 파일 그대로 Node vm에서
//  돌리기 위한 준비물. 계산/캐시/수동 셀 로직은 진짜 코드를 쓰고, 화면에 닿는
//  부분(Leaflet 지도, DOM)만 가짜로 바꾼다.
//
//   · 저장소: 실제 storage.js(RouteDB) → 가짜 routeAPI → 실제 SQLite RouteDatabase
//   · 도로/건물: Overpass fetch 를 가짜로 — 도로 질의면 구역 bbox 한가운데를
//     가로지르는 도로 하나, 건물 질의면 빈 목록
//   · 탭 전환: app.js 의 switchTab 함수 소스를 그대로 잘라서 로드
// ══════════════════════════════════════════════════════════
'use strict';

const vm = require('vm');
const { readSource, freshDb, createDesktopApi, baseContext, load } = require('./route-context');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeElement(id) {
  const classes = new Set();
  return {
    id, style: {}, dataset: {}, textContent: '', innerHTML: '', innerText: '', value: '', disabled: false,
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
    },
    addEventListener() {}, appendChild() {}, click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    clientWidth: 800, clientHeight: 600, offsetWidth: 160, offsetHeight: 50,
  };
}

function makeLeaflet(stats) {
  function layer(kind, latlngs, options) {
    return {
      kind, latlngs, options: options || {},
      addTo(target) { target.addLayer(this); return this; },
      bindTooltip() { return this; }, bindPopup() { return this; }, on() { return this; },
      bringToFront() {}, setLatLngs(l) { this.latlngs = l; },
      getBounds() { return { latlngs: this.latlngs }; },
    };
  }
  function layerGroup() {
    const layers = new Set();
    return {
      layers,
      addTo() { return this; },
      addLayer(l) { layers.add(l); },
      removeLayer(l) { layers.delete(l); },
      clearLayers() { layers.clear(); },
      getLayers() { return [...layers]; },
    };
  }
  return {
    map() {
      stats.maps++;
      const m = {
        setView() { return m; }, fitBounds(b) { stats.fitBounds++; stats.lastFitBounds = b; return m; },
        invalidateSize() { stats.invalidateSize++; }, on() { return m; },
        addLayer() {}, removeLayer() {}, containerPointToLatLng() { return { lat: 0, lng: 0 }; },
      };
      return m;
    },
    layerGroup,
    polygon: (ll, o) => layer('polygon', ll, o),
    rectangle: (b, o) => layer('rectangle', b, o),
    polyline: (ll, o) => layer('polyline', ll, o),
    circleMarker: (ll, o) => layer('circleMarker', ll, o),
    marker: (ll, o) => layer('marker', ll, o),
    divIcon: o => o,
    latLngBounds: ll => ({ ll }),
    tileLayer: () => layer('tile'),
  };
}

// Overpass 흉내 — 도로 질의에는 bbox 가운데를 동서로 가로지르는 도로 하나를 준다
function makeOverpassFetch(state) {
  return async (_url, opts) => {
    state.fetches++;
    if (state.fail) throw new Error('overpass down (test)');
    const q = String((opts && opts.body) || '');
    const m = q.match(/\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/);
    let elements = [];
    if (/highway/.test(q) && m) {
      const [minLat, minLng, maxLat, maxLng] = m.slice(1).map(Number);
      const mid = (minLat + maxLat) / 2;
      elements = [{ type: 'way', geometry: [{ lat: mid, lon: minLng }, { lat: mid, lon: maxLng }] }];
    }
    return { ok: true, status: 200, json: async () => ({ elements }) };
  };
}

async function createAccumHarness() {
  const stats = { invalidateSize: 0, fitBounds: 0, maps: 0, errors: [], toasts: [], confirms: 0, tabRenders: {} };
  const fetchState = { fetches: 0, fail: false };
  const db = freshDb();
  const api = createDesktopApi(db);
  const elements = new Map();
  const document = {
    getElementById: id => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeElement(''),
  };
  const tab = name => () => { stats.tabRenders[name] = (stats.tabRenders[name] || 0) + 1; };

  const ctx = baseContext({
    document,
    routeAPI: api,
    fetch: makeOverpassFetch(fetchState),
    requestAnimationFrame: fn => setTimeout(fn, 0),
    L: makeLeaflet(stats),
    confirm: () => { stats.confirms++; return true; },
    alert: () => {},
    showError: msg => stats.errors.push(msg),
    showToast: msg => stats.toasts.push(msg),
    clearError: () => {},
    escapeHtml: s => String(s == null ? '' : s),
    fmtNum: n => String(n),
    dstr: d => d.toISOString().slice(0, 10),
    renderFilterButtons: () => {},
    addNoKeyOsmTileLayer: () => {},
    addVehicleStorageMarker: () => {},
    VEHICLE_STORAGE_PLACE: { lat: 37.5, lng: 127.03 },
    renderCalendarGrid: tab('calendar'),
    updateCalStatus: () => {},
    renderStatsView: tab('stats'),
    renderDataView: tab('data'),
    renderSettingsView: tab('settings'),
    updateDropzoneSummary: tab('upload'),
  });
  load(ctx, 'src/js/coverage-grid.js');
  load(ctx, 'src/js/collection-stats.js');
  load(ctx, 'src/js/storage.js');
  load(ctx, 'src/js/map-capture.js');
  load(ctx, 'src/js/accum.js');
  // app.js 전체를 로드하면 시작 절차(startRouteViewer)까지 돌기 때문에 switchTab만 잘라 쓴다
  const switchTabSrc = readSource('src/js/app.js').match(/function switchTab\(tab\)\{[\s\S]*?\r?\n\}\r?\n/);
  if (!switchTabSrc) throw new Error('app.js 에서 switchTab 을 찾지 못했어요');
  vm.runInContext(switchTabSrc[0], ctx, { filename: 'app.js#switchTab' });

  const h = {
    ctx, db, api, stats, fetchState, document,
    eval: code => vm.runInContext(code, ctx),
    el: id => document.getElementById(id),
    sleep,
    // 지금 상태 그대로 누적 지도가 끝까지 그려질 때까지 기다린다
    async waitRendered(timeoutMs = 5000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await sleep(10);
        // 최신 렌더가 끝났고(accumRendering=false) 그린 화면이 지금 상태와 같으면 완료 —
        // 이미 버려진 이전 계산이 뒤에서 아직 돌고 있는 것은 기다리지 않는다
        if (h.eval('!accumRendering&&coverageCacheKey===accumViewKey()')) { await sleep(5); return true; }
      }
      return false;
    },
    calcCount: () => h.eval('coverageStats.calculations'),
  };

  await h.eval('RouteDB.init()');
  return h;
}

// 테스트용 구역 — 판교/시흥 기본 구역 위치에 작은 사각 경계(약 450m×530m)
const ZONES = {
  판교: [[37.3830, 127.1120], [37.3870, 127.1120], [37.3870, 127.1180], [37.3830, 127.1180]],
  시흥: [[37.3430, 126.7270], [37.3470, 126.7270], [37.3470, 126.7330], [37.3430, 126.7330]],
};

// 판교 경계 가운데 도로(lat 37.385) 서쪽 절반을 10초 간격으로 달린 기록
function pangyoDrive(date) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const s = String(i * 10).padStart(2, '0');
    const t = i * 10 < 60 ? `09:00:${s}` : `09:01:${String(i * 10 - 60).padStart(2, '0')}`;
    pts.push({ date, time: t, vehicle: '토레스 1호', zone: '판교', lat: 37.3850, lng: 127.1125 + i * 0.000226 });
  }
  return pts;
}

async function setupCoverageScene(h) {
  await h.eval(`RouteDB.saveZonePolygons(${JSON.stringify(ZONES)})`);
  await h.eval(`RouteDB.importRecords(${JSON.stringify(pangyoDrive('2026-08-20'))},{filename:'pangyo.xlsx'})`);
  await h.eval('loadZonePolygonsFromDb()');
  await h.eval('refreshZoneCache()');
  await h.eval('refreshSettingsCache()');
  h.eval("accumZoneFilter='판교'; showCoverageGaps=true; boundaryEditOpen=true;");
}

// 계산 결과에서 칸 중심 좌표를 구한다
function cellCenter(result, cell) {
  const { latDeg, lngDeg } = result.grid;
  return { lat: (cell.la + 0.5) * latDeg, lng: (cell.lo + 0.5) * lngDeg };
}

module.exports = { createAccumHarness, setupCoverageScene, cellCenter, ZONES, pangyoDrive, sleep };
