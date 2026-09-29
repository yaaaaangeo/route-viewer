// ══════════════════════════════════════════════════════════
//  auto-analysis-view — 자동 분석 화면(추천 주행 탭)
//
//  사용자가 하는 일은 "상위 구역 고르기"와 "결과 보기" 뿐이다.
//  세부 구역을 직접 그릴 필요가 없다 — 지도(HD Map)와 우리 GPS 기록에서 자동으로 만든다.
//
//   · 지도: 자동 세부 구역 경계 · 도로 Segment · 추천 구간(우선순위 색) · 시작/끝 · 진행 방향
//   · 목록: 추천 카드(구간·방향·시간·권장 횟수·현재 수집량·부족 조건·근거·신뢰도)
//   · 보정: 이름 수정 · 유형 변경 · 추천 제외 · 공식 확인 표시 (자동 결과는 그대로 두고 덮어쓴다)
//
//  분석은 캐시된다 — 탭을 옮겼다고 다시 계산하지 않는다(저장소의 revision 이 바뀔 때만).
// ══════════════════════════════════════════════════════════

let autoZoneName = null;          // 지금 분석 중인 상위 구역
let autoAnalysis = null;          // 저장소가 준 분석 결과
let autoRecResult = null;         // 추천 결과
let autoBusy = false;
let autoError = null;
let autoFocusId = null;           // 지도에서 강조 중인 추천
let autoDetailId = null;          // 근거 상세를 펼친 추천
let autoEditId = null;            // 보정 중인 자동 구역
let autoStages = [];

const AUTO_PRIORITY_COLORS = { very_high: '#ff6b6b', high: '#f5a623', medium: '#e3d14a', low: '#7d8798' };
const AUTO_ENOUGH_COLOR = '#3f4b5e';   // 이미 충분히 모은 구간

function autoZoneOptions() {
  return (typeof ACTIVE_ZONE_NAMES !== 'undefined' ? ACTIVE_ZONE_NAMES : []);
}

function setAutoZone(name) {
  autoZoneName = name;
  autoAnalysis = null;
  autoRecResult = null;
  renderAutoAnalysis();
  runAutoAnalysis({ force: false });
}

// ── 지도 POI ──────────────────────────────────────────
// 출처는 (1) 사용자가 "지도 POI 받기"로 받아 둔 OSM 결과 (2) 누적 지도가 이미 받아 둔 아파트 단지 경계뿐.
// 둘 다 없으면 null — 그때 자동 분석은 GPS·HD Map 만으로 판정하고 화면에 "지도 POI 데이터 없음"을 띄운다.
const AUTO_POI_LS_KEY = 'rv.zonePoi.v1';
let autoPoiBusy = false;
let autoPoiError = null;

function readAutoPoiStore() {
  try { return JSON.parse(localStorage.getItem(AUTO_POI_LS_KEY) || '{}') || {}; } catch (_) { return {}; }
}

function autoZonePolygon(zone) {
  return (typeof ZONE_POLYGONS !== 'undefined' && ZONE_POLYGONS && ZONE_POLYGONS[zone]) || null;
}

function autoPoiFor(zone) {
  if (typeof PoiData === 'undefined') return null;
  const poly = autoZonePolygon(zone);
  const key = poly ? PoiData.bboxKey(PoiData.bboxOf(poly)) : null;
  const saved = readAutoPoiStore()[zone];
  // 구역 경계가 바뀌었으면 예전 범위로 받은 POI 는 쓰지 않는다(범위가 다르면 "없음"과 구분할 수 없다)
  const fromOsm = saved && saved.poi && (!key || saved.poi.bboxKey === key) ? saved.poi : null;
  let fromBuildings = null;
  try {
    const cache = typeof loadZoneBuildingsCache === 'function' ? loadZoneBuildingsCache() : null;
    fromBuildings = cache && cache[zone] ? PoiData.fromBuildingCache(cache[zone]) : null;
  } catch (_) { fromBuildings = null; }
  return PoiData.mergePoi([fromOsm, fromBuildings]);
}

// 사용자가 누를 때만 OSM(Overpass)에서 받는다 — 누적 지도와 같은 조회기(미러·쿨다운)를 쓴다
async function fetchAutoPoi() {
  const zone = autoZoneName || autoZoneOptions()[0] || null;
  const poly = zone ? autoZonePolygon(zone) : null;
  if (!zone || !poly || typeof PoiData === 'undefined' || typeof runOverpassQuery !== 'function') {
    autoPoiError = '구역 경계가 없거나 지도 조회기를 쓸 수 없어 POI 를 받지 못했어요.';
    renderAutoAnalysis();
    return;
  }
  autoPoiBusy = true; autoPoiError = null; renderAutoAnalysis();
  try {
    const bbox = PoiData.bboxOf(poly);
    const data = await runOverpassQuery(PoiData.overpassPoiQuery(bbox));
    const poi = PoiData.parseOverpassPoi(data, { bboxKey: PoiData.bboxKey(bbox) });
    const store = readAutoPoiStore();
    store[zone] = { poi, savedAt: new Date().toISOString() };
    try { localStorage.setItem(AUTO_POI_LS_KEY, JSON.stringify(store)); }
    catch (err) { console.warn('[경로뷰어] POI 캐시 저장 실패(이번 분석에는 씀):', err); }
    showToast(`지도 POI 를 받았어요 — ${AutoSubZones.POI_CATEGORY_IDS.filter(id => (poi[id] || []).length).map(id => `${AutoSubZones.POI_CATEGORY_LABELS[id]} ${poi[id].length}`).join(' · ') || '해당 시설 없음'}`);
  } catch (err) {
    console.warn('[경로뷰어] 지도 POI 조회 실패:', err);
    autoPoiError = `지도 POI 를 받지 못했어요 — POI 없이 분석합니다. (${(err && err.message) || err})`;
  } finally {
    autoPoiBusy = false;
  }
  await runAutoAnalysis({ force: false });
}

// HD Map 우선 구축구역 ①~⑫ — 파일 정의 + 앱에서 그린 경계(사업 우선도 계산용)
async function autoPriorityAreas() {
  if (typeof HDMapPriority === 'undefined') return [];
  let saved = {};
  try { saved = (await RouteDB.getHDMapPriorityPolygons()) || {}; } catch (_) { saved = {}; }
  try { return HDMapPriority.listAreas(null, saved).filter(a => a.hasPolygon); } catch (_) { return []; }
}

// 추천 입력(데이터·설정·필터)이나 POI 가 바뀌었을 때만 다시 묻는다 — 탭 이동만으로는 다시 묻지 않는다
let autoRunKey = null;
function autoInputKey() {
  const zone = autoZoneName || autoZoneOptions()[0] || '';
  const poi = autoPoiFor(zone);
  return JSON.stringify({ zone, rec: (recCache && recCache.key) || null, poi: AutoSubZones.poiRevision(poi) });
}
function ensureAutoAnalysisFresh() {
  if (autoBusy) { renderAutoAnalysis(); return; }
  if (!autoAnalysis || autoRunKey !== autoInputKey()) { runAutoAnalysis({ force: false }); return; }
  renderAutoAnalysis();
}

// 분석 실행 — force 면 캐시를 무시하고 다시 계산한다("자동 분석 새로고침")
async function runAutoAnalysis(options) {
  const o = options || {};
  const zone = autoZoneName || autoZoneOptions()[0] || null;
  if (!zone) { autoError = '활성화된 상위 구역이 없어요. [설정] 탭에서 구역을 켜주세요.'; renderAutoAnalysis(); return; }
  autoZoneName = zone;
  autoBusy = true;
  autoError = null;
  renderAutoAnalysis();
  const runKey = autoInputKey();
  try {
    const issueFilter = typeof recommendationIssueFilter === 'function' ? recommendationIssueFilter() : 'clean';
    const poi = autoPoiFor(zone);
    autoAnalysis = await RouteDB.getAutoAnalysis(zone, { issueFilter, force: !!o.force, poi });
    autoStages = autoAnalysis.stages || [];
    const priorityAreas = await autoPriorityAreas();
    autoRecResult = Recommendation.buildSegmentRecommendations({
      analysis: autoAnalysis,
      segmentStats: autoAnalysis.segmentStats,
      settings: (recCache && recCache.appSettings) || {},
      segmentSettings: ((recCache && recCache.appSettings) || {}).segmentRecommendationSettings,
      priorityAreas,
      // 사업 우선 정책 — 설정 데이터(없으면 구역 데이터 파일로 만든 초기 정책). 엔진이 오늘 날짜로 하나를 고른다
      priorityPolicies: ((recCache && recCache.appSettings) || {}).priorityPolicies,
      priorityAreasMeta: (typeof HDMAP_PRIORITY_AREAS !== 'undefined' && HDMAP_PRIORITY_AREAS) ? { generatedAt: HDMAP_PRIORITY_AREAS.generatedAt || null } : null,
      now: recommendationClock(),
      issueFilter,
    });
    autoRunKey = runKey;
  } catch (err) {
    console.warn('[경로뷰어] 자동 분석 실패:', err);
    autoError = `자동 분석을 하지 못했어요. (${(err && err.message) || err})`;
    autoAnalysis = null;
    autoRecResult = null;
  } finally {
    autoBusy = false;
  }
  renderAutoAnalysis();
  if (typeof renderTodayView === 'function') renderTodayView();
}

// ── 사업 우선도 설정(도로 Segment 추천) ────────────────
let autoSegSettingsForm = null;
function autoSegmentSettings() {
  return Recommendation.segmentSettings(((recCache && recCache.appSettings) || {}).segmentRecommendationSettings);
}
function onAutoProjectInput(path, value) {
  if (!autoSegSettingsForm) autoSegSettingsForm = JSON.parse(JSON.stringify(autoSegmentSettings()));
  const n = String(value).trim() === '' ? NaN : Number(value);
  if (path === 'weight') autoSegSettingsForm.projectPriority.weight = n;
  const v = Recommendation.validateSegmentSettings(autoSegSettingsForm);
  const errEl = document.getElementById('auto-project-errors');
  if (errEl) { errEl.style.display = v.ok ? 'none' : 'block'; errEl.textContent = v.errors.join(' '); }
  const btn = document.getElementById('auto-project-save');
  if (btn) btn.disabled = !v.ok;
}
async function saveAutoProjectSettings(reset) {
  const next = reset ? Recommendation.segmentSettings({ ...autoSegmentSettings(), projectPriority: Recommendation.SEGMENT_DEFAULTS.projectPriority })
    : (autoSegSettingsForm || autoSegmentSettings());
  const v = Recommendation.validateSegmentSettings(next);
  if (!v.ok) return false;
  try { await RouteDB.setSettings({ segmentRecommendationSettings: v.value }); }
  catch (err) { showError(`사업 우선도 설정을 저장하지 못했어요. (${(err && err.message) || err})`); return false; }
  autoSegSettingsForm = null;
  showToast('사업 우선도 설정을 저장했어요. 추천을 다시 계산해요.');
  // 저장 알림(setSettings)이 추천 캐시 키를 올리고, 자동 분석은 그 키가 바뀐 것을 보고 다시 계산한다
  if (typeof renderRecommendView === 'function') await renderRecommendView();
  return true;
}

// ── 사용자 보정 ───────────────────────────────────────
function startAutoEdit(zoneId) { autoEditId = zoneId; renderAutoAnalysis(); }
function cancelAutoEdit() { autoEditId = null; renderAutoAnalysis(); }

async function saveAutoOverride(zoneId, patch) {
  const zone = (autoAnalysis && autoAnalysis.zones || []).find(z => z.id === zoneId);
  if (!zone) return;
  try {
    await RouteDB.saveSubZoneOverride({ id: zoneId, parentZone: zone.parentZone, ...patch });
  } catch (err) {
    showError(`보정을 저장하지 못했어요. (${(err && err.message) || err})`);
    return;
  }
  autoEditId = null;
  await runAutoAnalysis({ force: false });   // 보정은 읽을 때 덮어쓰므로 다시 분석하지 않아도 된다
}

async function submitAutoEdit(zoneId) {
  const name = (document.getElementById('auto-edit-name') || {}).value || '';
  const type = (document.getElementById('auto-edit-type') || {}).value || '';
  const official = !!(document.getElementById('auto-edit-official') || {}).checked;
  await saveAutoOverride(zoneId, { name: name.trim(), semanticType: type, officialVerified: official });
}

async function excludeAutoZone(zoneId, excluded) {
  await saveAutoOverride(zoneId, { excluded: !!excluded });
}

async function clearAutoOverride(zoneId) {
  try { await RouteDB.deleteSubZoneOverride(zoneId); }
  catch (err) { showError(`보정을 지우지 못했어요. (${(err && err.message) || err})`); return; }
  await runAutoAnalysis({ force: false });
}

// ── 지도 ──────────────────────────────────────────────
let autoMap = null, autoZoneLayer = null, autoSegmentLayer = null, autoHighlightLayer = null;

function ensureAutoMap() {
  const el = document.getElementById('auto-map');
  if (!el || typeof L === 'undefined') return null;
  // renderAutoAnalysis 가 #auto-map 을 새로 그리면 예전 지도는 떨어져 나간 요소에 붙어 있다(크기 0) — 새로 만든다
  if (autoMap && autoMap.getContainer() !== el) { try { autoMap.remove(); } catch (_) { /* 무시 */ } autoMap = null; }
  if (autoMap) { setTimeout(() => autoMap.invalidateSize(), 0); return autoMap; }
  autoMap = L.map('auto-map', { zoomControl: true, attributionControl: false })
    .setView([VEHICLE_STORAGE_PLACE.lat, VEHICLE_STORAGE_PLACE.lng], 13);
  addNoKeyOsmTileLayer(autoMap);
  autoZoneLayer = L.layerGroup().addTo(autoMap);
  autoSegmentLayer = L.layerGroup().addTo(autoMap);
  autoHighlightLayer = L.layerGroup().addTo(autoMap);
  setTimeout(() => autoMap.invalidateSize(), 0);
  return autoMap;
}

function paintAutoMap() {
  if (!autoMap || !autoAnalysis) return;
  autoZoneLayer.clearLayers();
  autoSegmentLayer.clearLayers();
  autoHighlightLayer.clearLayers();

  const recs = (autoRecResult && autoRecResult.recommendations) || [];
  const recBySegment = new Map(recs.map(r => [r.segmentId, r]));
  // 오늘 추천 Top 3 에서 고른 추천은 상세 목록(상위 N개) 밖일 수 있다 — 전체 후보에서 찾는다
  const allRecs = (autoRecResult && (autoRecResult.allRecommendations || autoRecResult.recommendations)) || [];
  const focus = autoFocusId ? allRecs.find(r => r.id === autoFocusId) : null;
  if (focus && !recBySegment.has(focus.segmentId)) recBySegment.set(focus.segmentId, focus);

  // 자동 세부 구역 경계 — 추천이 걸린 구역만(전부 그리면 지도가 뒤덮인다)
  const zoneIds = new Set(recs.map(r => r.subZoneId).concat(focus ? [focus.subZoneId] : []));
  (autoAnalysis.zones || []).filter(z => zoneIds.has(z.id) && z.active !== false).forEach(z => {
    L.polygon(z.polygon, { color: '#4fd8c7', weight: 1, opacity: 0.55, fillOpacity: 0.03, dashArray: '3 5' })
      .bindTooltip(`${z.name} · ${z.semanticLabel}`).addTo(autoZoneLayer);
  });

  // 도로 Segment — 추천된 것은 우선순위 색, 나머지는 "이미 충분" 회색
  (autoAnalysis.segments || []).forEach(seg => {
    const rec = recBySegment.get(seg.id);
    const color = rec ? (AUTO_PRIORITY_COLORS[rec.priority] || '#7d8798') : AUTO_ENOUGH_COLOR;
    const line = L.polyline(seg.geometry, {
      color, weight: rec ? 4 : 1.5, opacity: rec ? 0.9 : 0.35,
    }).addTo(autoSegmentLayer);
    line.bindTooltip(rec
      ? `${seg.label} · ${rec.conditionLabel} · ${rec.direction.label} (추천 ${rec.rank})`
      : `${seg.label} · 지금은 추천 대상 아님`);
    if (rec) line.on('click', () => focusAutoRecommendation(rec.id));
  });

  if (focus) {
    L.polyline(focus.geometry, { color: '#4fd8c7', weight: 7, opacity: 0.95 }).addTo(autoHighlightLayer);
    L.circleMarker([focus.start.lat, focus.start.lng], { radius: 6, color: '#4fd8c7', fillColor: '#4fd8c7', fillOpacity: 1, weight: 1 })
      .bindTooltip(`시작 · ${focus.startLabel}`).addTo(autoHighlightLayer);
    L.circleMarker([focus.end.lat, focus.end.lng], { radius: 6, color: '#0a0e16', fillColor: '#4fd8c7', fillOpacity: 0.7, weight: 2 })
      .bindTooltip(`끝 · ${focus.endLabel} (${focus.direction.label})`).addTo(autoHighlightLayer);
    autoMap.fitBounds(L.polyline(focus.geometry).getBounds(), { padding: [50, 50], maxZoom: 16 });
  } else if ((autoAnalysis.segments || []).length) {
    const all = L.featureGroup((autoAnalysis.segments || []).slice(0, 400).map(s => L.polyline(s.geometry)));
    try { autoMap.fitBounds(all.getBounds(), { padding: [20, 20] }); } catch (_) { /* 좌표가 없으면 그대로 */ }
  }
}

function focusAutoRecommendation(id) {
  autoFocusId = autoFocusId === id ? null : id;
  ensureAutoMap();
  paintAutoMap();
  renderAutoAnalysis();
}

function toggleAutoDetail(id) {
  autoDetailId = autoDetailId === id ? null : id;
  renderAutoAnalysis();
}

// ── 그리기 ────────────────────────────────────────────
function renderAutoAnalysis() {
  const el = document.getElementById('rec-auto');
  if (!el) return;
  const zones = autoZoneOptions();
  const zone = autoZoneName || zones[0] || null;
  const head = `
    <div class="rec-section-title">자동 분석 추천
      <span class="ds-hint">상위 구역만 고르면 도로 구간·세부 구역을 스스로 찾아 추천해요</span>
    </div>
    <div class="plan-form auto-head">
      <label class="rec-filter"><span>분석 구역</span>
        <select onchange="setAutoZone(this.value)">
          ${zones.map(z => `<option value="${escapeHtml(z)}"${z === zone ? ' selected' : ''}>${escapeHtml(z)}</option>`).join('')}
        </select></label>
      <button class="btn ghost" type="button" onclick="runAutoAnalysis({force:true})"${autoBusy ? ' disabled' : ''}>자동 분석 새로고침</button>
      <button class="btn ghost" type="button" onclick="fetchAutoPoi()"${autoBusy || autoPoiBusy ? ' disabled' : ''} title="OpenStreetMap 에서 학교·업무시설·상업시설·병원·시장·역/정류장·아파트 단지를 받아 자동 분류에 씁니다(인터넷 필요)">${autoPoiBusy ? '지도 POI 받는 중…' : '지도 POI 받기(OSM)'}</button>
      ${autoAnalysis ? `<span class="mono auto-meta">분석 ${escapeHtml(formatBackupTime(autoAnalysis.analyzedAt))}
        · 도로 ${fmtNum((autoAnalysis.segments || []).length)}구간 · 자동 구역 ${fmtNum((autoAnalysis.zones || []).length)}개
        · 알고리즘 v${autoAnalysis.version}${autoStages.length ? ` · ${escapeHtml(autoStages.join(' / '))}` : ''}</span>` : ''}
    </div>`;

  if (autoBusy) { el.innerHTML = `${head}<div class="ir-note">지도와 주행 기록을 분석하는 중이에요… (처음 한 번만 오래 걸리고, 다음부터는 저장된 결과를 씁니다)</div>`; return; }
  if (autoError) { el.innerHTML = `${head}<div class="ir-note warn">${escapeHtml(autoError)}</div>`; return; }
  if (!autoAnalysis) {
    el.innerHTML = `${head}<div class="rec-empty"><div class="rec-empty-title">아직 분석하지 않았어요</div>
      <div>“자동 분석 새로고침”을 누르면 이 구역의 도로망과 우리 주행 기록을 분석해 추천을 만들어요.</div></div>`;
    return;
  }

  const recs = ((autoRecResult && autoRecResult.recommendations) || []).slice();
  const allRecs = (autoRecResult && (autoRecResult.allRecommendations || autoRecResult.recommendations)) || [];
  [autoDetailId, autoFocusId].forEach(id => {
    if (!id || recs.some(r => r.id === id)) return;
    const extra = allRecs.find(r => r.id === id);
    if (extra) recs.unshift(extra);
  });
  el.innerHTML = `${head}
    ${dataLevelHTML(autoAnalysis)}
    <div id="auto-map" class="subzone-map"></div>
    ${autoMapLegendHTML()}
    ${recs.length
      ? `<div class="subzone-cards">${recs.map(autoCardHTML).join('')}</div>`
      : '<div class="rec-empty">지금 이 구역에서 더 모아야 할 구간을 찾지 못했어요(모두 목표를 채웠거나 분석할 도로 데이터가 없어요).</div>'}
    <details class="rec-llm"${autoSegSettingsForm ? ' open' : ''}><summary>추천 점수 가중치 · 사업 우선도 · 분석 한계</summary>
      <div class="rec-table-wrap"><table class="rec-table"><thead><tr><th>부족도 항목</th><th>가중치</th></tr></thead><tbody>
        ${Recommendation.SEGMENT_SCORE_KEYS.map(k => `<tr><td>${escapeHtml(Recommendation.SEGMENT_SCORE_LABELS[k])}</td><td class="mono">${(autoRecResult && autoRecResult.weights[k]) || 0}%</td></tr>`).join('')}
      </tbody></table></div>
      ${autoProjectSettingsHTML()}
      <ul>${((autoRecResult && autoRecResult.limitations) || []).map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    </details>`;
  ensureAutoMap();
  paintAutoMap();
}

function dataLevelHTML(analysis) {
  const d = analysis.dataLevels || {};
  const chip = (on, label) => `<span class="auto-level${on ? ' on' : ''}">${on ? '✓' : '—'} ${escapeHtml(label)}</span>`;
  const ps = d.poiSummary || null;
  const poiLabel = d.poi && ps
    ? `지도 POI ${ps.covered.filter(id => id !== 'officialSchoolZones').map(id => `${AutoSubZones.POI_CATEGORY_LABELS[id]} ${ps.counts[id]}`).join('·')}`
    : '지도 POI 데이터 없음';
  const pp = autoRecResult && autoRecResult.projectPriority;
  return `<div class="auto-levels">
    ${chip(d.roadGraph, '도로망(HD Map)')}${chip(d.gps, '주행 기록')}${chip(d.poi, poiLabel)}${chip(d.officialSchoolZones, '공식 어린이보호구역')}${chip(d.coverage, 'Coverage')}${chip(pp && pp.applied, pp && pp.applied ? `사업 우선도 ${pp.weight}% · 정책 ${autoRecResult.policy.policyName}` : (autoRecResult && !autoRecResult.policy ? '적용 정책 없음(사업 우선도 0)' : '사업 우선도 해당 없음'))}
    ${(analysis.notes || []).map(n => `<div class="auto-note">${escapeHtml(n)}</div>`).join('')}
    ${pp && pp.note ? `<div class="auto-note">${escapeHtml(pp.note)}</div>` : ''}
    ${autoPoiError ? `<div class="auto-note subzone-warn">${escapeHtml(autoPoiError)}</div>` : ''}
  </div>`;
}

function autoProjectSettingsHTML() {
  const f = autoSegSettingsForm || autoSegmentSettings();
  const pp = f.projectPriority;
  const pol = autoRecResult && autoRecResult.policy;
  const num = (path, value, attrs) => `<input type="number" class="depth-threshold-input mono rec-input" value="${escapeHtml(Number.isFinite(value) ? value : '')}" ${attrs || ''} oninput="onAutoProjectInput('${path}',this.value)"/>`;
  return `<div class="dist-card auto-project-settings"><div class="dc-title">사업 우선도(HD Map 우선 구축구역) — 부족도 점수의 보조</div>
      <div class="settings-row depth-tier-row"><span class="settings-row-name">사업 우선도 비중(%) · 부족도 ${Number.isFinite(pp.weight) ? 100 - pp.weight : '—'}%</span>${num('weight', pp.weight, 'min="0" max="50" step="1"')}</div>
      <div class="settings-row depth-tier-row"><span class="settings-row-name">오늘 적용 정책</span><span>${escapeHtml(pol ? pol.policyName : '없음(사업 우선도 0)')}${pol ? ` <span class="rec-muted mono">${escapeHtml(pol.summary)}</span>` : ''}</span></div>
      <div class="plan-zone-hint">최종 점수 = Data Need Score × (100 − 비중)% + Project Priority × 비중%. 구역별 우선도(0~100)와 적용 기간은 [설정] 탭 "HD Map 우선 수집 정책"에서 바꿔요. 이 조건을 이미 목표만큼 모은 구간은 사업 우선도를 더하지 않아요.</div>
      <div id="auto-project-errors" class="ir-note warn" style="display:none;margin:0;"></div>
      <div class="settings-actions">
        <button class="btn" type="button" id="auto-project-save" onclick="saveAutoProjectSettings(false)">저장</button>
        <button class="btn ghost" type="button" onclick="saveAutoProjectSettings(true)">기본값 복원</button>
        <button class="btn ghost" type="button" onclick="switchTab('settings');setTimeout(()=>{const e=document.getElementById('settings-priority-policy');if(e&&e.scrollIntoView)e.scrollIntoView({block:'start'});},200)">정책 관리(설정 탭)</button>
      </div>
    </div>`;
}

function autoMapLegendHTML() {
  return `<div class="auto-legend">
    ${Object.entries({ very_high: '매우 높음', high: '높음', medium: '보통', low: '낮음' })
      .map(([k, label]) => `<span class="auto-legend-item"><i style="background:${AUTO_PRIORITY_COLORS[k]}"></i>${label}</span>`).join('')}
    <span class="auto-legend-item"><i style="background:${AUTO_ENOUGH_COLOR}"></i>추천 대상 아님</span>
    <span class="auto-legend-item"><i style="background:#4fd8c7"></i>선택한 추천 구간(시작 ● · 끝 ◎)</span>
  </div>`;
}

function autoCardHTML(r) {
  const color = AUTO_PRIORITY_COLORS[r.priority] || '#7d8798';
  const zone = (autoAnalysis.zones || []).find(z => z.id === r.subZoneId) || {};
  const open = autoDetailId === r.id;
  const editing = autoEditId === r.subZoneId;
  return `
    <div class="subzone-card auto-card${autoFocusId === r.id ? ' focus' : ''}" style="border-left-color:${color}">
      <div class="subzone-card-head">
        <span class="subzone-rank">추천 ${r.rank}</span>
        <span class="rec-badge" style="color:${color};border-color:${color}">${escapeHtml(r.priorityLabel)}</span>
        <span class="subzone-path">${escapeHtml(r.parentZone)} → <b>${escapeHtml(r.subZoneName)}</b>
          <span class="subzone-chip type">${escapeHtml(r.semanticLabel)}</span>
          <span class="rec-badge rec-today-wd">${escapeHtml(r.weekdayLabel || '')}</span>
          ${r.projectPriority && r.projectPriority.level ? `<span class="subzone-chip src hp-${escapeHtml(r.projectPriority.level)}" title="${escapeHtml(r.projectPriority.basis)}">${escapeHtml(r.projectPriority.label)}${r.projectPriority.applied ? '' : ' · 목표 달성'}</span>` : ''}
          ${zone.override ? '<span class="subzone-chip src">사용자 보정</span>' : '<span class="subzone-chip src">자동</span>'}</span>
        <span style="flex:1;"></span>
        <span class="mono subzone-score">점수 ${r.score}</span>
        <button class="btn ghost" type="button" onclick="focusAutoRecommendation('${escapeHtml(r.id)}')">지도</button>
        <button class="btn ghost" type="button" onclick="toggleAutoDetail('${escapeHtml(r.id)}')">${open ? '근거 닫기' : '근거 보기'}</button>
      </div>
      <div class="subzone-card-grid">
        <div><span class="subzone-k">추천 구간</span><span class="subzone-v">${escapeHtml(r.displayName || r.segmentLabel)} <span class="rec-cond">${r.lengthKm}km · ${escapeHtml(r.startLabel)} → ${escapeHtml(r.endLabel)}</span></span></div>
        <div><span class="subzone-k">권장 방향</span><span class="subzone-v">${escapeHtml(r.direction.label)}${r.direction.confident ? '' : ' <span class="subzone-warn">(방향 확인 불가)</span>'}</span></div>
        <div><span class="subzone-k">권장 조건</span><span class="subzone-v">${escapeHtml(r.conditionLabel)}</span></div>
        <div><span class="subzone-k">권장 시간</span><span class="subzone-v mono">${escapeHtml(r.timeWindow.text)}${r.timeWindow.note ? ` <span class="rec-cond">${escapeHtml(r.timeWindow.note)}</span>` : ''}</span></div>
        <div><span class="subzone-k">권장 수집</span><span class="subzone-v">${escapeHtml(r.need.text)}</span></div>
        <div><span class="subzone-k">현재 수집</span><span class="subzone-v mono">${fmtNum(r.current.collectionMinutes)}분 / 목표 ${fmtNum(r.targets.minutes)}분${
          r.current.coveragePercent != null ? ` · 구간 Coverage ${r.current.coveragePercent}%` : ''}${
          r.current.daysSinceLastVisit != null ? ` · 마지막 ${r.current.daysSinceLastVisit}일 전` : ' · 이 조건 기록 없음'}</span></div>
      </div>
      <div class="subzone-reason">${escapeHtml(r.reason)}</div>
      ${r.expects.length ? `<div class="subzone-expects">${r.expects.map(e => `<span class="rec-chip">${escapeHtml(e)}</span>`).join('')}</div>` : ''}
      ${r.safetyNote ? `<div class="ir-note warn subzone-safety">${escapeHtml(r.safetyNote)}</div>` : ''}
      <div class="subzone-foot">
        <span>신뢰도 ${escapeHtml(r.confidence.label)} · ${escapeHtml(r.confidence.reasons.map(x => x.text).join(' · '))}</span>
        <span>근거 ${escapeHtml(r.dataSources.join(' / '))}</span>
        <span class="rec-disclaimer-inline">${escapeHtml(r.edgeCaseDisclaimer)}</span>
      </div>
      ${open ? autoDetailHTML(r, zone) : ''}
      ${editing ? autoEditHTML(zone) : ''}
    </div>`;
}

function autoDetailHTML(r, zone) {
  return `
    <div class="rec-detail">
      ${autoCompositionHTML(r)}
      <div class="rec-detail-title">부족도 점수 검산 (데이터가 없는 항목은 빼고 남은 가중치로 다시 나눔 · 적용 가중치 ${r.availableWeight}%)</div>
      <div class="rec-table-wrap">
        <table class="rec-table"><thead><tr><th>항목</th><th>현재 상태</th><th>점수</th><th>가중치</th><th>반영</th></tr></thead>
          <tbody>${r.breakdown.map(b => `<tr${b.excluded ? ' class="rec-excluded"' : ''}>
            <td>${escapeHtml(b.label)}</td><td>${escapeHtml(b.current)}</td>
            <td class="mono">${b.excluded ? '—' : b.value}</td><td class="mono">${b.weight}%</td>
            <td class="mono">${b.excluded ? '제외' : b.contribution}</td></tr>`).join('')}
          </tbody></table>
      </div>
      <div class="rec-detail-grid">
        <div><b>자동 분류 근거</b><ul>${(r.classificationBasis || []).map(b => `<li>${escapeHtml(b)}</li>`).join('') || '<li>근거 없음(유형 확인 불가)</li>'}</ul></div>
        <div><b>이름 근거</b><div>${escapeHtml(r.nameBasis || '—')}</div>
          <b>구간 표시</b><div>${escapeHtml(r.displayName || r.segmentLabel)} — ${escapeHtml(r.displayBasis || '')}</div>
          <b>구간 ID</b><div class="mono rec-muted">${escapeHtml(r.segmentId)}</div>
          <b>장소 근거 수준</b><div>${escapeHtml((r.evidence && r.evidence.label) || '—')} · ${escapeHtml(((r.evidence && r.evidence.reasons) || []).join(', '))}</div>
          ${r.relevanceReason ? `<div class="subzone-warn">${escapeHtml(r.relevanceReason)}</div>` : ''}
          ${r.weekdayBasis ? `<b>${escapeHtml(r.weekdayLabel || '')} 후보 근거</b><div>${escapeHtml(r.weekdayBasis)}</div>` : ''}
        </div>
      </div>
      <div class="issue-item-actions">
        <button class="btn ghost" type="button" onclick="startAutoEdit('${escapeHtml(r.subZoneId)}')">자동 분류 수정</button>
        <button class="btn ghost" type="button" onclick="excludeAutoZone('${escapeHtml(r.subZoneId)}',true)">추천에서 제외</button>
        ${zone.override ? `<button class="btn ghost" type="button" onclick="clearAutoOverride('${escapeHtml(r.subZoneId)}')">보정 되돌리기</button>` : ''}
      </div>
    </div>`;
}

// 최종 점수가 어떻게 나왔는지 — 부족도(중심) + 사업 우선도(보조)
function autoCompositionHTML(r) {
  const c = r.scoreComposition;
  if (!c) return '';
  const p = c.project;
  const pol = c.policy;
  return `<div class="rec-detail-title">최종 점수 구성</div>
    <div class="pp-score-line">Data Need Score <b class="mono">${c.dataNeedScore != null ? c.dataNeedScore : c.deficitScore}</b>
      · 사업 우선도 <b class="mono">${c.projectPriorityScore != null ? c.projectPriorityScore : 0}</b>
      · Final Score <b class="mono">${c.final}</b>
      · 적용 정책: <b>${escapeHtml(pol ? pol.policyName : '없음')}</b>${pol && pol.updatedAt ? ` <span class="rec-muted">(정책 수정 ${escapeHtml(formatBackupTime(pol.updatedAt))})</span>` : ''}</div>
    <div class="mono rec-check">${escapeHtml(c.formula)}</div>
    <div class="rec-table-wrap"><table class="rec-table"><thead><tr><th>구성</th><th>값</th><th>비중</th><th>반영</th><th>근거</th></tr></thead><tbody>
      <tr><td>Data Need Score(데이터 부족도)</td><td class="mono">${c.deficitScore}</td><td class="mono">${c.deficitWeight}%</td><td class="mono">${c.deficitContribution}</td>
        <td>부족도 가중합 ${c.rawDeficitScore}${c.relevance !== 1 ? ` × 관련도 ${c.relevance}` : ''}</td></tr>
      ${p ? `<tr${p.applied ? '' : ' class="rec-excluded"'}><td>Project Priority(사업 우선도)</td><td class="mono">${p.value}</td><td class="mono">${p.weight}%</td><td class="mono">${p.applied ? p.contribution : '제외'}</td>
        <td>${escapeHtml(p.label)} — ${escapeHtml(p.basis)}${p.applied ? '' : ` · ${escapeHtml(p.skippedReason)}`}</td></tr>`
        : `<tr class="rec-excluded"><td>Project Priority(사업 우선도)</td><td class="mono">0</td><td colspan="3">${pol ? '해당 없음(우선 구축구역 경계 없음 또는 이 분석 범위 밖)' : '오늘 적용되는 사업 우선 정책이 없어 0 — 데이터 부족도만 사용'}</td></tr>`}
    </tbody></table></div>`;
}

function autoEditHTML(zone) {
  const types = Object.keys(AutoSubZones.SEMANTIC_TYPES);
  return `
    <div class="subzone-form">
      <div class="plan-form">
        <label class="rec-filter"><span>이름</span>
          <input type="text" id="auto-edit-name" maxlength="60" value="${escapeHtml(zone.name || '')}"/></label>
        <label class="rec-filter"><span>유형</span>
          <select id="auto-edit-type">
            ${types.map(t => `<option value="${t}"${t === zone.semanticType ? ' selected' : ''}>${escapeHtml(AutoSubZones.semanticLabel(t))}</option>`).join('')}
          </select></label>
        <label class="imp-check"><input type="checkbox" id="auto-edit-official" ${zone.officialVerified ? 'checked' : ''}/>
          <span>공식 데이터로 확인함</span></label>
      </div>
      <div class="issue-item-actions">
        <button class="btn" type="button" onclick="submitAutoEdit('${escapeHtml(zone.id)}')">보정 저장</button>
        <button class="btn ghost" type="button" onclick="cancelAutoEdit()">취소</button>
      </div>
      <div class="plan-zone-hint">보정은 따로 저장돼서 자동 분석을 다시 해도 유지됩니다(자동 결과 원본은 그대로 남습니다).</div>
    </div>`;
}
