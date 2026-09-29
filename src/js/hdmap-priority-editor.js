// ══════════════════════════════════════════════════════════
//  hdmap-priority-editor — ①~⑫ 구역 경계를 실제 지도에서 직접 그린다
//
//  기본 경계는 협의체 도로 데이터의 간선도로 중앙선으로 만든 블록이다
//  (tools/derive-hdmap-priority-areas.js → src/data/hdmap-priority-areas.json).
//  여기서는 그 경계를 실제 수집 기준에 맞게 고치거나 다시 그린다 — 저장한 경계가 파일보다 우선하고,
//  지우면 파일 경계로 돌아간다.
//
//    참고 이미지(PNG)는 사람이 위치를 확인하라고 있는 것이지 공간 데이터가 아니다.
//    거기서 픽셀을 위경도로 역산하면 그 위에 올라가는 숫자가 전부 거짓이 되므로 하지 않는다.
//    대신 사용자가 그 이미지를 보면서 지도에 직접 찍는다.
//
//  저장되는 좌표는 언제나 WGS84 [위도, 경도] — 주행 기록 GPS 와 같은 좌표계라,
//  저장한 그 자리에서 이미 들어와 있는 기록 전체를 다시 분류할 수 있다(재 import 불필요).
//  검증·정규화는 hdmap-priority.js 한 곳에서 하고 SQLite·IndexedDB 가 같이 쓴다.
//
//  그리기 방식은 누적 지도의 구역 경계 그리기(accum.js startBoundaryDraw)와 같다 —
//  지도를 눌러 꼭짓점을 찍고, 한 점씩 취소하고, 3점 이상이면 저장한다.
// ══════════════════════════════════════════════════════════

let hdmapEditorOpen = false;
let hdmapEditorMap = null;
let hdmapEditorSavedLayer = null;   // 저장된 경계 미리보기
let hdmapEditorDraftLayer = null;   // 그리는 중인 경계
let hdmapEditorAreaNo = 1;          // 처음 열 때 선택된 구역 번호(우선순위와 무관 — 우선순위는 활성 정책)
let hdmapEditorDraft = [];
let hdmapEditorDrawing = false;
let hdmapEditorBusy = false;
let hdmapEditorMsg = null;          // {kind:'ok'|'warn', text}
let hdmapEditorAreas = [];

// 우선순위 색 — 화면 다른 곳과 같은 뜻으로 쓰고, 지도에는 번호·구분 글자도 함께 찍는다
// 단계 색 — 단계는 활성 Priority Policy 에서 온다(구역 번호로 정하지 않는다)
const HDMAP_EDITOR_COLORS = { primary: '#ff6b6b', priority: '#f5a623', secondary: '#e3d14a', normal: '#7d8798', none: '#4d566a' };

function toggleHDMapPriorityEditor() {
  hdmapEditorOpen = !hdmapEditorOpen;
  hdmapEditorMsg = null;
  if (!hdmapEditorOpen) { hdmapEditorDrawing = false; hdmapEditorDraft = []; }
  renderHDMapPriorityEditor();
}

function hdmapEditorArea(no) {
  return hdmapEditorAreas.find(a => a.areaNo === Number(no)) || null;
}

// 컨트롤은 상태가 바뀔 때마다 다시 그리고, 지도는 한 번 만들어 계속 쓴다.
// areas 를 주면(현황판이 다시 그릴 때) 목록을 갱신한다.
function renderHDMapPriorityEditor(areas) {
  if (Array.isArray(areas)) hdmapEditorAreas = areas;
  const box = document.getElementById('hdmap-priority-editor');
  if (!box) return;
  if (!hdmapEditorOpen) { box.innerHTML = ''; box.classList.remove('open'); return; }
  box.classList.add('open');

  const cur = hdmapEditorArea(hdmapEditorAreaNo);
  const options = hdmapEditorAreas.map(a => {
    const state = a.hasPolygon ? '경계 있음 ' + a.polygon.length + '점' : '경계 미설정';
    const sel = a.areaNo === hdmapEditorAreaNo ? ' selected' : '';
    return '<option value="' + a.areaNo + '"' + sel + '>' + a.name + ' ' + a.priorityLabel + ' · ' + state + '</option>';
  }).join('');

  const msg = hdmapEditorMsg
    ? '<div class="ir-note' + (hdmapEditorMsg.kind === 'warn' ? ' warn' : '') + ' hp-ed-msg">'
      + escapeHtml(hdmapEditorMsg.text) + '</div>'
    : '';

  const buttons = hdmapEditorDrawing
    ? '<button class="btn" type="button" id="hdmap-editor-save" onclick="saveHDMapEditorPolygon()"'
      + (hdmapEditorBusy || hdmapEditorDraft.length < 3 ? ' disabled' : '') + '>저장</button>'
      + '<button class="btn ghost" type="button" id="hdmap-editor-undo" onclick="undoHDMapEditorPoint()"'
      + (hdmapEditorDraft.length ? '' : ' disabled') + '>↩ 한 점 취소</button>'
      + '<button class="btn ghost" type="button" onclick="resetHDMapEditorDraft()">초기화</button>'
      + '<button class="btn ghost" type="button" onclick="cancelHDMapEditorDraw()">그리기 취소</button>'
    : '<button class="btn" type="button" onclick="startHDMapEditorDraw()"'
      + (hdmapEditorBusy ? ' disabled' : '') + '>' + (cur && cur.hasPolygon ? '다시 그리기' : '경계 그리기') + '</button>'
      // 지울 수 있는 건 직접 그린 경계뿐이다 — 지우면 기본(도로 데이터) 경계로 돌아간다
      + (cur && cur.polygonSource === 'drawn'
        ? '<button class="btn ghost" type="button" onclick="clearHDMapEditorPolygon()"'
          + (hdmapEditorBusy ? ' disabled' : '') + '>직접 그린 경계 지우기</button>'
        : '');

  box.innerHTML = '<div class="hp-block-title">구역 경계 설정</div>'
    + '<div class="hp-ed-bar">'
    + '<label class="hp-ed-field">지역 <select id="hdmap-editor-area" onchange="setHDMapEditorArea(this.value)"'
    + (hdmapEditorBusy ? ' disabled' : '') + '>' + options + '</select></label>'
    + buttons
    + '<button class="btn ghost hp-ed-close" type="button" onclick="toggleHDMapPriorityEditor()">닫기</button>'
    + '</div>'
    + '<div class="cond-note hp-ed-hint">' + hdmapEditorHintHTML(cur) + '</div>'
    + msg
    + '<div id="hdmap-priority-map" class="hp-ed-map"></div>'
    + '<div class="cond-note">저장하면 WGS84 위경도(주행 기록 GPS 와 같은 좌표계)로 남고, '
    + '<b>이미 들어와 있는 기록 전체</b>를 그 자리에서 다시 분류해 위 현황판에 반영해요 — 다시 불러올 필요 없어요.</div>';

  ensureHDMapEditorMap();
}

function hdmapEditorHintHTML(cur) {
  if (hdmapEditorDrawing) {
    return '지도를 눌러 꼭짓점을 찍으세요. 지금 <b>' + hdmapEditorDraft.length + '개</b> — 3개 이상이면 저장할 수 있어요.';
  }
  if (cur && cur.hasPolygon) {
    const from = cur.polygonSource === 'drawn' ? ' · 직접 그림' : ' · 기본 경계(도로 데이터)';
    return escapeHtml(cur.name) + ' 경계가 저장돼 있어요(' + cur.polygon.length + '점' + from
      + '). 모양을 바꾸려면 <b>다시 그리기</b>를 누르세요.';
  }
  return '위 <b>구역 번호 안내</b> 이미지에서 구역 위치를 확인한 뒤, <b>경계 그리기</b>를 누르고 지도에 꼭짓점을 찍으세요.';
}

function ensureHDMapEditorMap() {
  const el = document.getElementById('hdmap-priority-map');
  if (!el || typeof L === 'undefined') return;
  // 컨트롤을 다시 그리면 지도 div 도 새로 만들어진다 — 옛 지도는 버리고 새 div 에 다시 만든다
  if (hdmapEditorMap && hdmapEditorMap.getContainer() !== el) {
    hdmapEditorMap.remove();
    hdmapEditorMap = null;
  }
  if (!hdmapEditorMap) {
    const center = (typeof ZONE_CENTERS !== 'undefined' && ZONE_CENTERS && ZONE_CENTERS['강남']) || [37.505, 127.045];
    hdmapEditorMap = L.map(el, { zoomSnap: 0.5, zoomDelta: 0.5 }).setView(center, 13);
    if (typeof addNoKeyOsmTileLayer === 'function') addNoKeyOsmTileLayer(hdmapEditorMap);
    hdmapEditorSavedLayer = L.layerGroup().addTo(hdmapEditorMap);
    hdmapEditorDraftLayer = L.layerGroup().addTo(hdmapEditorMap);
    hdmapEditorMap.on('click', onHDMapEditorMapClick);
  }
  // 숨어 있다가 보이게 된 지도는 크기를 다시 재야 타일이 맞게 깔린다
  setTimeout(() => { if (hdmapEditorMap) hdmapEditorMap.invalidateSize(); }, 0);
  drawHDMapEditorLayers();
}

function onHDMapEditorMapClick(e) {
  if (!hdmapEditorDrawing) return;
  hdmapEditorDraft.push([e.latlng.lat, e.latlng.lng]);
  drawHDMapEditorLayers();
  updateHDMapEditorDrawBar();
}

// 점을 찍을 때마다 전체를 다시 그리면 지도가 새로 만들어져 시점이 튄다 — 버튼·안내만 갱신한다
function updateHDMapEditorDrawBar() {
  if (!hdmapEditorDrawing) return;
  const save = document.getElementById('hdmap-editor-save');
  const undo = document.getElementById('hdmap-editor-undo');
  const hint = document.querySelector('#hdmap-priority-editor .hp-ed-hint');
  if (save) save.disabled = hdmapEditorBusy || hdmapEditorDraft.length < 3;
  if (undo) undo.disabled = !hdmapEditorDraft.length;
  if (hint) hint.innerHTML = hdmapEditorHintHTML(hdmapEditorArea(hdmapEditorAreaNo));
}

function drawHDMapEditorLayers() {
  if (!hdmapEditorMap) return;
  hdmapEditorSavedLayer.clearLayers();
  hdmapEditorDraftLayer.clearLayers();

  // 저장된 경계 — 고른 구역은 진하게, 나머지는 옅게. 겹치는지 눈으로 보라고 함께 그린다.
  hdmapEditorAreas.forEach(a => {
    if (!a.hasPolygon) return;
    const selected = a.areaNo === hdmapEditorAreaNo;
    if (selected && hdmapEditorDrawing) return;   // 다시 그리는 중이면 옛 모양은 감춘다
    const color = HDMAP_EDITOR_COLORS[a.priority] || '#7d8798';
    L.polygon(a.polygon, {
      color: color, weight: selected ? 3 : 1.5, opacity: selected ? 1 : 0.55,
      fillOpacity: selected ? 0.16 : 0.05,
    }).bindTooltip(a.name + ' ' + a.priorityLabel, { permanent: true, direction: 'center', className: 'hp-ed-label' })
      .addTo(hdmapEditorSavedLayer);
  });

  if (!hdmapEditorDraft.length) return;
  const cur = hdmapEditorArea(hdmapEditorAreaNo);
  const color = HDMAP_EDITOR_COLORS[(cur && cur.priority) || 'none'];
  if (hdmapEditorDraft.length >= 3) {
    L.polygon(hdmapEditorDraft, { color: color, weight: 3, fillOpacity: 0.15, dashArray: '6,6' }).addTo(hdmapEditorDraftLayer);
  } else if (hdmapEditorDraft.length === 2) {
    L.polyline(hdmapEditorDraft, { color: color, weight: 3, dashArray: '6,6' }).addTo(hdmapEditorDraftLayer);
  }
  hdmapEditorDraft.forEach((p, i) => {
    L.circleMarker(p, { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
      .bindTooltip(String(i + 1), { direction: 'top' }).addTo(hdmapEditorDraftLayer);
  });
}

function setHDMapEditorArea(no) {
  hdmapEditorAreaNo = Number(no);
  hdmapEditorDrawing = false;
  hdmapEditorDraft = [];
  hdmapEditorMsg = null;
  renderHDMapPriorityEditor();
  // 이미 그려 둔 구역을 고르면 그 자리로 지도를 옮겨 준다
  const a = hdmapEditorArea(hdmapEditorAreaNo);
  if (a && a.hasPolygon && hdmapEditorMap) {
    hdmapEditorMap.fitBounds(L.polygon(a.polygon).getBounds(), { padding: [30, 30] });
  }
}

function startHDMapEditorDraw() {
  const a = hdmapEditorArea(hdmapEditorAreaNo);
  hdmapEditorDrawing = true;
  // 이미 있는 경계는 그대로 불러온다 — 고칠 때 처음부터 다시 찍지 않아도 된다(수정)
  hdmapEditorDraft = a && a.hasPolygon ? a.polygon.map(p => [p[0], p[1]]) : [];
  hdmapEditorMsg = null;
  renderHDMapPriorityEditor();
}

function cancelHDMapEditorDraw() {
  hdmapEditorDrawing = false;
  hdmapEditorDraft = [];
  hdmapEditorMsg = null;
  renderHDMapPriorityEditor();
}

function undoHDMapEditorPoint() {
  hdmapEditorDraft.pop();
  drawHDMapEditorLayers();
  updateHDMapEditorDrawBar();
}

function resetHDMapEditorDraft() {
  hdmapEditorDraft = [];
  drawHDMapEditorLayers();
  updateHDMapEditorDrawBar();
}

async function saveHDMapEditorPolygon() {
  const v = HDMapPriority.normalizeAreaPolygon(hdmapEditorAreaNo, hdmapEditorDraft);
  if (!v.ok) {
    hdmapEditorMsg = { kind: 'warn', text: v.errors.join(' ') };
    renderHDMapPriorityEditor();
    return;
  }
  const name = (hdmapEditorArea(v.value.areaNo) || {}).name || String(v.value.areaNo);
  hdmapEditorBusy = true;
  renderHDMapPriorityEditor();
  try {
    await RouteDB.saveHDMapPriorityPolygon(v.value.areaNo, v.value.polygon);
    hdmapEditorDrawing = false;
    hdmapEditorDraft = [];
    hdmapEditorMsg = { kind: 'ok', text: name + ' 경계를 저장했어요(' + v.value.polygon.length + '점). 이미 들어와 있는 기록 전체로 다시 셌어요.' };
  } catch (err) {
    console.warn('[경로뷰어] 구역 경계 저장 실패:', err);
    hdmapEditorMsg = { kind: 'warn', text: '저장하지 못했어요. (' + (err && err.message ? err.message : err) + ')' };
  } finally {
    hdmapEditorBusy = false;
  }
  refreshHDMapPriority();   // 캐시를 버리고 기존 기록 전체로 다시 집계한다
}

async function clearHDMapEditorPolygon() {
  const a = hdmapEditorArea(hdmapEditorAreaNo);
  if (!a) return;
  if (typeof confirmDialog === 'function') {
    const ok = await confirmDialog({
      title: '구역 경계 지우기',
      message: a.name + ' 구역의 경계를 지울까요?',
      detail: '주행 기록은 지워지지 않아요. 기본 경계(도로 데이터)가 있으면 그 경계로 돌아가고, 없으면 "경계 미설정"이 되어 평균·비중 계산에서 빠집니다.',
      confirmLabel: '지우기', danger: true,
    });
    if (!ok) return;
  }
  hdmapEditorBusy = true;
  renderHDMapPriorityEditor();
  try {
    await RouteDB.saveHDMapPriorityPolygon(a.areaNo, null);
    hdmapEditorDrawing = false;
    hdmapEditorDraft = [];
    hdmapEditorMsg = { kind: 'ok', text: a.name + ' 경계를 지웠어요.' };
  } catch (err) {
    console.warn('[경로뷰어] 구역 경계 삭제 실패:', err);
    hdmapEditorMsg = { kind: 'warn', text: '지우지 못했어요. (' + (err && err.message ? err.message : err) + ')' };
  } finally {
    hdmapEditorBusy = false;
  }
  refreshHDMapPriority();
}
