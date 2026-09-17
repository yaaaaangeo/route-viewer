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

// 분석 실행 — force 면 캐시를 무시하고 다시 계산한다("자동 분석 새로고침")
async function runAutoAnalysis(options) {
  const o = options || {};
  const zone = autoZoneName || autoZoneOptions()[0] || null;
  if (!zone) { autoError = '활성화된 상위 구역이 없어요. [설정] 탭에서 구역을 켜주세요.'; renderAutoAnalysis(); return; }
  autoZoneName = zone;
  autoBusy = true;
  autoError = null;
  renderAutoAnalysis();
  try {
    const issueFilter = typeof recommendationIssueFilter === 'function' ? recommendationIssueFilter() : 'clean';
    autoAnalysis = await RouteDB.getAutoAnalysis(zone, { issueFilter, force: !!o.force });
    autoStages = autoAnalysis.stages || [];
    autoRecResult = Recommendation.buildSegmentRecommendations({
      analysis: autoAnalysis,
      segmentStats: autoAnalysis.segmentStats,
      settings: (recCache && recCache.appSettings) || {},
      segmentSettings: ((recCache && recCache.appSettings) || {}).segmentRecommendationSettings,
      now: recommendationClock(),
      issueFilter,
    });
  } catch (err) {
    console.warn('[경로뷰어] 자동 분석 실패:', err);
    autoError = `자동 분석을 하지 못했어요. (${(err && err.message) || err})`;
    autoAnalysis = null;
    autoRecResult = null;
  } finally {
    autoBusy = false;
  }
  renderAutoAnalysis();
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
  const focus = autoFocusId ? recs.find(r => r.id === autoFocusId) : null;

  // 자동 세부 구역 경계 — 추천이 걸린 구역만(전부 그리면 지도가 뒤덮인다)
  const zoneIds = new Set(recs.map(r => r.subZoneId));
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

  const recs = (autoRecResult && autoRecResult.recommendations) || [];
  el.innerHTML = `${head}
    ${dataLevelHTML(autoAnalysis)}
    <div id="auto-map" class="subzone-map"></div>
    ${autoMapLegendHTML()}
    ${recs.length
      ? `<div class="subzone-cards">${recs.map(autoCardHTML).join('')}</div>`
      : '<div class="rec-empty">지금 이 구역에서 더 모아야 할 구간을 찾지 못했어요(모두 목표를 채웠거나 분석할 도로 데이터가 없어요).</div>'}
    <details class="rec-llm"><summary>추천 점수 가중치 · 분석 한계</summary>
      <div class="rec-table-wrap"><table class="rec-table"><thead><tr><th>항목</th><th>가중치</th></tr></thead><tbody>
        ${Recommendation.SEGMENT_SCORE_KEYS.map(k => `<tr><td>${escapeHtml(Recommendation.SEGMENT_SCORE_LABELS[k])}</td><td class="mono">${(autoRecResult && autoRecResult.weights[k]) || 0}%</td></tr>`).join('')}
      </tbody></table></div>
      <ul>${((autoRecResult && autoRecResult.limitations) || []).map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    </details>`;
  ensureAutoMap();
  paintAutoMap();
}

function dataLevelHTML(analysis) {
  const d = analysis.dataLevels || {};
  const chip = (on, label) => `<span class="auto-level${on ? ' on' : ''}">${on ? '✓' : '—'} ${escapeHtml(label)}</span>`;
  return `<div class="auto-levels">
    ${chip(d.roadGraph, '도로망(HD Map)')}${chip(d.gps, '주행 기록')}${chip(d.poi, '지도 POI')}${chip(d.officialSchoolZones, '공식 어린이보호구역')}${chip(d.coverage, 'Coverage')}
    ${(analysis.notes || []).map(n => `<div class="auto-note">${escapeHtml(n)}</div>`).join('')}
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
          ${zone.override ? '<span class="subzone-chip src">사용자 보정</span>' : '<span class="subzone-chip src">자동</span>'}</span>
        <span style="flex:1;"></span>
        <span class="mono subzone-score">점수 ${r.score}</span>
        <button class="btn ghost" type="button" onclick="focusAutoRecommendation('${escapeHtml(r.id)}')">지도</button>
        <button class="btn ghost" type="button" onclick="toggleAutoDetail('${escapeHtml(r.id)}')">${open ? '근거 닫기' : '근거 보기'}</button>
      </div>
      <div class="subzone-card-grid">
        <div><span class="subzone-k">추천 구간</span><span class="subzone-v">${escapeHtml(r.segmentLabel)} <span class="rec-cond">${r.lengthKm}km · ${escapeHtml(r.startLabel)} → ${escapeHtml(r.endLabel)}</span></span></div>
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
      <div class="rec-detail-title">추천 점수 검산 (데이터가 없는 항목은 빼고 남은 가중치로 다시 나눔 · 적용 가중치 ${r.availableWeight}%)</div>
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
          <b>장소 근거 수준</b><div>${escapeHtml((r.evidence && r.evidence.label) || '—')} · ${escapeHtml(((r.evidence && r.evidence.reasons) || []).join(', '))}</div>
          ${r.relevanceReason ? `<div class="subzone-warn">${escapeHtml(r.relevanceReason)}</div>` : ''}
        </div>
      </div>
      <div class="issue-item-actions">
        <button class="btn ghost" type="button" onclick="startAutoEdit('${escapeHtml(r.subZoneId)}')">자동 분류 수정</button>
        <button class="btn ghost" type="button" onclick="excludeAutoZone('${escapeHtml(r.subZoneId)}',true)">추천에서 제외</button>
        ${zone.override ? `<button class="btn ghost" type="button" onclick="clearAutoOverride('${escapeHtml(r.subZoneId)}')">보정 되돌리기</button>` : ''}
      </div>
    </div>`;
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
