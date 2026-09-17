// ══════════════════════════════════════════════════════════
//  subzone-view — 세부 수집 구역 관리 · 세부 추천 카드 · 추천 지도
//
//  추천 탭 안에서 세 가지를 한다.
//    1) 세부 구역 관리 — 지도에서 경계를 찍어 등록하고, 유형·관심 시간대를 정하고, 켜고 끄고 지운다.
//    2) 세부 추천 카드 — "강남" 이 아니라 "테헤란로 업무지구 · 테헤란로 구간 · 평일 퇴근 피크"로.
//    3) 추천 지도 — 세부 구역 경계와 추천 도로 구간, 시작·끝 지점을 우선순위 색으로 보여준다.
//
//  계산은 전부 subzones.js(공간) · recommendation.js(부족도)가 한다 — 여기서는 입력과 표시만 한다.
//  장소·도로 이름은 사용자가 적었거나 지도 데이터에 실제로 있는 것만 쓴다(지어내지 않는다).
// ══════════════════════════════════════════════════════════

let subZoneList = [];            // 등록된 세부 구역(비활성 포함)
let subZoneStats = [];           // 구역별 집계
let subZoneRecResult = null;     // 세부 추천 결과
let subZonePanelOpen = false;    // 관리 패널 열림
let subZoneForm = null;          // 편집 중인 구역(없으면 닫힘)
let subZoneDraft = [];           // 지도에서 찍는 중인 경계 점들
let subZoneDrawing = false;
let subZoneFocusId = null;       // 지도에서 강조 중인 추천
let subZoneBusy = false;

const SUBZONE_PRIORITY_COLORS = {
  very_high: '#ff6b6b', high: '#f5a623', medium: '#e3d14a', low: '#7d8798',
};

// ── 데이터 읽기 ───────────────────────────────────────
async function refreshSubZones(options) {
  const o = options || {};
  try {
    subZoneList = await RouteDB.listSubZones({ includeInactive: true });
  } catch (err) {
    console.warn('[경로뷰어] 세부 구역 목록을 읽지 못했어요:', err);
    subZoneList = [];
  }
  const active = subZoneList.filter(z => z.active !== false);
  if (!active.length) {
    subZoneStats = [];
    subZoneRecResult = null;
    if (!o.quiet) renderSubZoneSection();
    return;
  }
  subZoneBusy = true;
  if (!o.quiet) renderSubZoneSection();
  try {
    // 이슈 데이터 기준은 추천과 같다 — 확인 필요 이슈는 기본적으로 뺀다
    const issueFilter = typeof recommendationIssueFilter === 'function' ? recommendationIssueFilter() : 'clean';
    subZoneStats = await RouteDB.getSubZoneStats(active, { filter: issueFilter === 'all' ? {} : { issueFilter } });
    subZoneRecResult = Recommendation.buildSubZoneRecommendations({
      subZones: active, stats: subZoneStats,
      settings: (recCache && recCache.appSettings) || {},
      now: recommendationClock(), issueFilter,
    });
  } catch (err) {
    console.warn('[경로뷰어] 세부 구역 집계 실패:', err);
    subZoneStats = [];
    subZoneRecResult = null;
  } finally {
    subZoneBusy = false;
  }
  renderSubZoneSection();
}

// ── 관리 패널 ─────────────────────────────────────────
function toggleSubZonePanel() {
  subZonePanelOpen = !subZonePanelOpen;
  if (!subZonePanelOpen) { subZoneForm = null; stopSubZoneDraw(); }
  renderSubZoneSection();
}

function startSubZoneCreate() {
  subZonePanelOpen = true;
  subZoneForm = {
    id: null, name: '', parentZone: (ACTIVE_ZONE_NAMES && ACTIVE_ZONE_NAMES[0]) || '',
    type: 'office_district', note: '', interestPeriods: [], polygon: [],
  };
  subZoneDraft = [];
  renderSubZoneSection();
}

function startSubZoneEdit(id) {
  const z = subZoneList.find(x => x.id === id);
  if (!z) return;
  subZonePanelOpen = true;
  subZoneForm = {
    id: z.id, name: z.name, parentZone: z.parentZone, type: z.type, note: z.note || '',
    interestPeriods: (z.interestPeriods || []).slice(), polygon: (z.polygon || []).slice(),
  };
  subZoneDraft = (z.polygon || []).slice();
  renderSubZoneSection();
  focusSubZoneOnMap(z.id);
}

function cancelSubZoneForm() {
  subZoneForm = null;
  stopSubZoneDraw();
  renderSubZoneSection();
}

function onSubZoneFormInput(field, value) {
  if (!subZoneForm) return;
  subZoneForm[field] = value;
  if (field === 'type' || field === 'parentZone') renderSubZoneSection();
}

function toggleSubZonePeriod(periodId, on) {
  if (!subZoneForm) return;
  const set = new Set(subZoneForm.interestPeriods || []);
  if (on) set.add(periodId); else set.delete(periodId);
  subZoneForm.interestPeriods = [...set];
}

async function saveSubZoneForm() {
  if (!subZoneForm) return;
  const payload = {
    ...subZoneForm,
    polygon: subZoneDraft.length >= 3 ? subZoneDraft : subZoneForm.polygon,
    sourceType: 'manual',
  };
  try {
    await RouteDB.saveSubZone(payload);
  } catch (err) {
    const list = (err && err.errors) || [String((err && err.message) || err)];
    const box = document.getElementById('subzone-form-error');
    if (box) { box.innerHTML = list.map(escapeHtml).join('<br/>'); box.style.display = 'block'; }
    return;
  }
  subZoneForm = null;
  stopSubZoneDraw();
  await refreshSubZones();
}

async function toggleSubZoneActive(id, active) {
  try { await RouteDB.setSubZoneActive(id, active); }
  catch (err) { showError(`세부 구역 상태를 바꾸지 못했어요. (${(err && err.message) || err})`); return; }
  await refreshSubZones();
}

async function deleteSubZone(id) {
  const z = subZoneList.find(x => x.id === id);
  if (!z) return;
  const ok = window.routeAPI && window.routeAPI.isDesktop
    ? await window.routeAPI.confirm({ message: `세부 구역 "${z.name}"을(를) 지울까요?`, detail: 'GPS 기록은 지워지지 않아요. 이 구역의 추천만 사라집니다.' })
    : confirm(`세부 구역 "${z.name}"을(를) 지울까요? GPS 기록은 지워지지 않아요.`);
  if (!ok) return;
  try { await RouteDB.deleteSubZone(id); }
  catch (err) { showError(`세부 구역을 지우지 못했어요. (${(err && err.message) || err})`); return; }
  await refreshSubZones();
}

// ── 지도에서 경계 찍기 ────────────────────────────────
function startSubZoneDraw() {
  subZoneDrawing = true;
  subZoneDraft = [];
  ensureSubZoneMap();
  renderSubZoneSection();
}
function stopSubZoneDraw() { subZoneDrawing = false; paintSubZoneMap(); }
function undoSubZoneDraftPoint() { subZoneDraft.pop(); paintSubZoneMap(); renderSubZoneSection(); }
function finishSubZoneDraw() {
  subZoneDrawing = false;
  if (subZoneForm && subZoneDraft.length >= 3) subZoneForm.polygon = subZoneDraft.slice();
  renderSubZoneSection();
}

// ── 지도 ──────────────────────────────────────────────
let subZoneMap = null, subZoneLayer = null, subZoneRoadLayer = null, subZoneDraftLayer = null;

function ensureSubZoneMap() {
  const el = document.getElementById('subzone-map');
  if (!el || typeof L === 'undefined') return null;
  if (subZoneMap) { setTimeout(() => subZoneMap.invalidateSize(), 0); return subZoneMap; }
  subZoneMap = L.map('subzone-map', { zoomControl: true, attributionControl: false })
    .setView([VEHICLE_STORAGE_PLACE.lat, VEHICLE_STORAGE_PLACE.lng], 13);
  addNoKeyOsmTileLayer(subZoneMap);
  subZoneLayer = L.layerGroup().addTo(subZoneMap);
  subZoneRoadLayer = L.layerGroup().addTo(subZoneMap);
  subZoneDraftLayer = L.layerGroup().addTo(subZoneMap);
  subZoneMap.on('click', e => {
    if (!subZoneDrawing) return;
    subZoneDraft.push([e.latlng.lat, e.latlng.lng]);
    paintSubZoneMap();
    renderSubZoneSection();
  });
  setTimeout(() => subZoneMap.invalidateSize(), 0);
  return subZoneMap;
}

function paintSubZoneMap() {
  if (!subZoneMap) return;
  subZoneLayer.clearLayers();
  subZoneRoadLayer.clearLayers();
  subZoneDraftLayer.clearLayers();

  subZoneList.filter(z => z.active !== false && (z.polygon || []).length >= 3).forEach(z => {
    L.polygon(z.polygon, { color: '#4fd8c7', weight: 1.5, opacity: 0.8, fillOpacity: 0.05, dashArray: '4 4' })
      .bindTooltip(`${z.name} · ${SubZones.placeTypeLabel(z.type)}`)
      .addTo(subZoneLayer);
  });

  const recs = (subZoneRecResult && subZoneRecResult.recommendations) || [];
  const focus = subZoneFocusId ? recs.find(r => r.id === subZoneFocusId) : null;
  const shown = focus ? [focus] : recs.slice(0, 5);
  shown.forEach(rec => {
    const color = SUBZONE_PRIORITY_COLORS[rec.priority] || '#7d8798';
    rec.roads.slice(0, focus ? 3 : 1).forEach((road, i) => {
      const seg = (subZoneStats.find(s => s.id === rec.subZoneId) || { roads: [] }).roads.find(r => r.roadId === road.roadId);
      const chunks = seg && seg.geometryChunks ? seg.geometryChunks : null;
      if (road.start && road.end) {
        L.polyline([[road.start.lat, road.start.lng], [road.end.lat, road.end.lng]], {
          color, weight: i === 0 ? 5 : 3, opacity: focus ? 0.95 : 0.7, dashArray: i === 0 ? null : '6 6',
        }).bindTooltip(`${rec.subZoneName} · ${road.name} · ${rec.conditionLabel}`).addTo(subZoneRoadLayer);
        L.circleMarker([road.start.lat, road.start.lng], { radius: 5, color, fillColor: color, fillOpacity: 1, weight: 1 })
          .bindTooltip(`시작 · ${road.name}`).addTo(subZoneRoadLayer);
        L.circleMarker([road.end.lat, road.end.lng], { radius: 5, color: '#0a0e16', fillColor: color, fillOpacity: 0.6, weight: 2 })
          .bindTooltip(`끝 · ${road.name} (${road.recommendedDirection.label})`).addTo(subZoneRoadLayer);
      }
      void chunks;
    });
  });

  if (subZoneDraft.length) {
    if (subZoneDraft.length >= 3) L.polygon(subZoneDraft, { color: '#f5a623', weight: 2, fillOpacity: 0.08 }).addTo(subZoneDraftLayer);
    else L.polyline(subZoneDraft, { color: '#f5a623', weight: 2 }).addTo(subZoneDraftLayer);
    subZoneDraft.forEach(p => L.circleMarker(p, { radius: 4, color: '#f5a623', fillColor: '#f5a623', fillOpacity: 1, weight: 1 }).addTo(subZoneDraftLayer));
  }

  if (focus && focus.roads.length && focus.roads[0].start) {
    const r = focus.roads[0];
    subZoneMap.fitBounds(L.latLngBounds([[r.start.lat, r.start.lng], [r.end.lat, r.end.lng]]), { padding: [40, 40], maxZoom: 15 });
  }
}

function focusSubZoneOnMap(idOrRecId) {
  const rec = (subZoneRecResult && subZoneRecResult.recommendations || []).find(r => r.id === idOrRecId);
  subZoneFocusId = rec ? rec.id : null;
  ensureSubZoneMap();
  if (!rec) {
    const z = subZoneList.find(x => x.id === idOrRecId);
    if (z && (z.polygon || []).length >= 3 && subZoneMap) {
      subZoneMap.fitBounds(L.polygon(z.polygon).getBounds(), { padding: [30, 30], maxZoom: 15 });
    }
  }
  paintSubZoneMap();
  renderSubZoneSection();
}

// ── 그리기 ────────────────────────────────────────────
function renderSubZoneSection() {
  const el = document.getElementById('rec-subzones');
  if (!el) return;
  const active = subZoneList.filter(z => z.active !== false);
  el.innerHTML = `
    <div class="rec-section-title">세부 구역 추천
      <span class="ds-hint">상위 구역 → 세부 수집 구역 → 실제 도로 구간까지</span>
      <button class="btn ghost subzone-manage-btn" type="button" onclick="toggleSubZonePanel()">${subZonePanelOpen ? '관리 닫기' : '세부 구역 관리'}</button>
    </div>
    ${subZonePanelOpen ? subZonePanelHTML() : ''}
    <div id="subzone-map" class="subzone-map"${active.length || subZonePanelOpen ? '' : ' style="display:none;"'}></div>
    ${subZoneListHTML(active)}`;
  if (active.length || subZonePanelOpen) { ensureSubZoneMap(); paintSubZoneMap(); }
}

function subZonePanelHTML() {
  const zones = (typeof ACTIVE_ZONE_NAMES !== 'undefined' ? ACTIVE_ZONE_NAMES : []);
  const rows = subZoneList.length ? subZoneList.map(z => `
    <div class="subzone-row${z.active === false ? ' off' : ''}">
      <span class="subzone-row-name">${escapeHtml(z.name)}</span>
      <span class="subzone-chip">${escapeHtml(z.parentZone)}</span>
      <span class="subzone-chip type">${escapeHtml(SubZones.placeTypeLabel(z.type))}</span>
      <span class="subzone-chip src">${escapeHtml(SubZones.SOURCE_LABELS[z.sourceType] || '직접 등록')}</span>
      <span class="subzone-row-actions">
        <button class="btn ghost" type="button" onclick="focusSubZoneOnMap('${escapeHtml(z.id)}')">지도</button>
        <button class="btn ghost" type="button" onclick="startSubZoneEdit('${escapeHtml(z.id)}')">수정</button>
        <button class="btn ghost" type="button" onclick="toggleSubZoneActive('${escapeHtml(z.id)}',${z.active === false})">${z.active === false ? '켜기' : '끄기'}</button>
        <button class="btn ghost" type="button" onclick="deleteSubZone('${escapeHtml(z.id)}')">삭제</button>
      </span>
    </div>`).join('') : '<div class="dc-empty">아직 등록한 세부 구역이 없어요. 아래 “새 세부 구역”으로 지도에서 경계를 찍어 등록하세요.</div>';

  const form = subZoneForm ? `
    <div class="subzone-form">
      <div class="plan-form">
        <label class="rec-filter"><span>이름</span>
          <input type="text" value="${escapeHtml(subZoneForm.name)}" maxlength="60" placeholder="예: 테헤란로 업무지구"
                 oninput="onSubZoneFormInput('name',this.value)"/></label>
        <label class="rec-filter"><span>상위 구역</span>
          <select onchange="onSubZoneFormInput('parentZone',this.value)">
            ${zones.map(z => `<option value="${escapeHtml(z)}"${z === subZoneForm.parentZone ? ' selected' : ''}>${escapeHtml(z)}</option>`).join('')}
          </select></label>
        <label class="rec-filter"><span>장소 유형</span>
          <select onchange="onSubZoneFormInput('type',this.value)">
            ${SubZones.PLACE_TYPE_IDS.map(t => `<option value="${t}"${t === subZoneForm.type ? ' selected' : ''}>${escapeHtml(SubZones.placeTypeLabel(t))}</option>`).join('')}
          </select></label>
      </div>
      <div class="subzone-periods">
        <span class="plan-zone-hint">관심 시간대(고르지 않으면 장소 유형의 후보 시간대를 씁니다 — ${escapeHtml(
          (SubZones.PLACE_TYPES[subZoneForm.type] || { candidateTimes: [] }).candidateTimes.map(p => TimeConditions.TRAFFIC_PERIOD_LABELS[p]).join(', ') || '없음')})</span>
        ${TimeConditions.TRAFFIC_PERIOD_IDS.map(p => `
          <label class="plan-zone${(subZoneForm.interestPeriods || []).includes(p) ? ' on' : ''}">
            <input type="checkbox" ${(subZoneForm.interestPeriods || []).includes(p) ? 'checked' : ''} onchange="toggleSubZonePeriod('${p}',this.checked)"/>
            <span>${escapeHtml(TimeConditions.TRAFFIC_PERIOD_LABELS[p])}</span></label>`).join('')}
      </div>
      <div class="plan-form">
        <label class="rec-filter" style="flex:1;"><span>메모</span>
          <input type="text" value="${escapeHtml(subZoneForm.note)}" maxlength="300" placeholder="왜 이 구역이 중요한지"
                 oninput="onSubZoneFormInput('note',this.value)"/></label>
      </div>
      <div class="subzone-draw">
        <span class="mono">경계 ${subZoneDraft.length || (subZoneForm.polygon || []).length}점</span>
        ${subZoneDrawing
          ? `<button class="btn" type="button" onclick="finishSubZoneDraw()">그리기 끝</button>
             <button class="btn ghost" type="button" onclick="undoSubZoneDraftPoint()">한 점 취소</button>
             <span class="plan-zone-hint">지도를 클릭해 경계를 3점 이상 찍어주세요</span>`
          : `<button class="btn ghost" type="button" onclick="startSubZoneDraw()">지도에서 경계 그리기</button>`}
      </div>
      <div class="imp-err" id="subzone-form-error"></div>
      <div class="issue-item-actions">
        <button class="btn" type="button" onclick="saveSubZoneForm()">저장</button>
        <button class="btn ghost" type="button" onclick="cancelSubZoneForm()">취소</button>
      </div>
    </div>` : `<div class="issue-item-actions"><button class="btn ghost" type="button" onclick="startSubZoneCreate()">+ 새 세부 구역</button></div>`;

  return `<div class="subzone-panel">
    <div class="subzone-panel-title">세부 구역 관리 <span class="ds-hint">직접 등록한 구역만 추천에 씁니다 — 지도 전체를 자동으로 나누지 않아요</span></div>
    <div class="subzone-rows">${rows}</div>
    ${form}
  </div>`;
}

function subZoneListHTML(active) {
  if (!active.length) {
    return `<div class="rec-empty"><div class="rec-empty-title">세부 구역이 아직 없어요</div>
      <div>“세부 구역 관리”에서 테헤란로 업무지구처럼 실제로 수집할 생활권을 등록하면,
      그 구역의 도로 구간·요일·시간대·방향까지 구체적으로 추천해 드려요.</div></div>`;
  }
  if (subZoneBusy) return '<div class="ir-note">세부 구역 수집 현황을 계산하는 중이에요…</div>';
  const recs = (subZoneRecResult && subZoneRecResult.recommendations) || [];
  if (!recs.length) return '<div class="rec-empty">등록된 세부 구역에서 추천할 조건을 찾지 못했어요(관심 시간대를 골라보세요).</div>';
  return `<div class="subzone-cards">${recs.slice(0, 8).map(subZoneCardHTML).join('')}</div>
    <details class="rec-llm"><summary>세부 추천을 어떻게 만들었나 · 한계</summary>
      <ul>${(subZoneRecResult.limitations || []).map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    </details>`;
}

function subZoneCardHTML(r) {
  const color = SUBZONE_PRIORITY_COLORS[r.priority] || '#7d8798';
  const road = r.roads[0] || null;
  const roadLine = r.roads.length
    ? r.roads.map(x => `${escapeHtml(x.name)}${x.lengthKm ? ` ${x.lengthKm}km` : ''}`).join(' · ')
    : '도로 구간 확인 불가';
  return `
    <div class="subzone-card${subZoneFocusId === r.id ? ' focus' : ''}" style="border-left-color:${color}">
      <div class="subzone-card-head">
        <span class="subzone-rank">추천 ${r.rank}</span>
        <span class="rec-badge" style="color:${color};border-color:${color}">${escapeHtml(r.priorityLabel)}</span>
        <span class="subzone-path">${escapeHtml(r.parentZone)} → <b>${escapeHtml(r.subZoneName)}</b> <span class="subzone-chip type">${escapeHtml(r.placeTypeLabel)}</span></span>
        <span style="flex:1;"></span>
        <span class="mono subzone-score">점수 ${r.score}</span>
        <button class="btn ghost" type="button" onclick="focusSubZoneOnMap('${escapeHtml(r.id)}')">지도에서 보기</button>
      </div>
      <div class="subzone-card-grid">
        <div><span class="subzone-k">추천 구간</span><span class="subzone-v">${roadLine}</span></div>
        <div><span class="subzone-k">권장 방향</span><span class="subzone-v">${road ? escapeHtml(road.recommendedDirection.label) : '—'}</span></div>
        <div><span class="subzone-k">권장 조건</span><span class="subzone-v">${escapeHtml(r.conditionLabel)}</span></div>
        <div><span class="subzone-k">권장 시간</span><span class="subzone-v mono">${escapeHtml(r.timeWindow.text)}${r.timeWindow.note ? ` <span class="rec-cond">${escapeHtml(r.timeWindow.note)}</span>` : ''}</span></div>
        <div><span class="subzone-k">권장 수집</span><span class="subzone-v">${escapeHtml(r.need.directionPlan)} · 약 ${fmtNum(r.need.estimatedMinutesThisStage)}분</span></div>
        <div><span class="subzone-k">현재 데이터</span><span class="subzone-v mono">수집 ${fmtNum(r.current.collectionMinutes)}분 · 방문 ${fmtNum(r.current.visitCount)}회 · ${r.current.daysSinceLastVisit == null ? '이 조건 기록 없음' : `마지막 ${r.current.daysSinceLastVisit}일 전`}</span></div>
      </div>
      <div class="subzone-reason">${escapeHtml(subZoneReasonText(r))}</div>
      <div class="subzone-expects">${r.expects.map(e => `<span class="rec-chip">${escapeHtml(e)}</span>`).join('')}</div>
      ${r.safetyNote ? `<div class="ir-note warn subzone-safety">${escapeHtml(r.safetyNote)}</div>` : ''}
      <div class="subzone-foot">
        <span>장소 근거 ${escapeHtml(r.evidence.label)} · ${escapeHtml(r.evidence.reasons.join(', ') || '근거 없음')}</span>
        ${road && !road.directionConfidence.ok ? `<span class="subzone-warn">${escapeHtml(road.directionConfidence.reason)}</span>` : ''}
        ${r.roadNote ? `<span class="subzone-warn">${escapeHtml(r.roadNote)}</span>` : ''}
        <span class="rec-disclaimer-inline">${escapeHtml(r.edgeCaseDisclaimer)}</span>
      </div>
    </div>`;
}

function subZoneReasonText(r) {
  const parts = [];
  const worst = r.breakdown.slice().sort((a, b) => b.value - a.value)[0];
  parts.push(`${r.subZoneName}의 ${r.conditionLabel} 수집은 ${r.current.collectionMinutes}분(목표 ${r.targets.minutes}분) · 방문 ${r.current.visitCount}회(목표 ${r.targets.visits}회)입니다.`);
  if (worst) parts.push(`가장 부족한 항목은 ${worst.label}(${worst.value}점 — ${worst.current})입니다.`);
  if (r.current.subZoneTotalMinutes) parts.push(`이 구역 전체 수집은 ${r.current.subZoneTotalMinutes}분이라, 구역은 다녔지만 이 조건만 비어 있습니다.`);
  return parts.join(' ');
}
