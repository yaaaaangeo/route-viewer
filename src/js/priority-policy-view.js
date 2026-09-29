// ══════════════════════════════════════════════════════════
//  priority-policy-view — 설정 탭 "HD Map 우선 수집 정책(Priority Policy)"
//
//  사업 요청이 바뀌면 코드를 고치지 않고 여기서 정책만 바꾼다.
//    · 정책 = 이름 · 적용 기간 · 구역별 우선도(0~100, 단계 프리셋 최우선100/우선70/보조40/일반0 또는 직접 입력)
//    · 추천 주행은 "오늘(한국 날짜)에 적용되는 정책" 하나를 자동으로 쓴다(겹치면 시작일이 늦은 정책).
//    · 정책은 삭제하지 않는다 — 끝난 정책은 종료일로 닫고, 수정하면 이전 버전이 변경 이력으로 남는다.
//  저장은 RouteDB.setSettings({priorityPolicies}) — 저장소가 검증·보존·이력을 처리하고,
//  저장 알림으로 추천 캐시가 무효화되어 새 점수로 다시 계산된다(recommend-view.js).
// ══════════════════════════════════════════════════════════

let ppPolicies = [];          // 저장된(또는 초기) 정책 목록
let ppSaved = false;          // 저장소에 정책을 저장한 적이 있는가(없으면 지금 목록은 초기 정책)
let ppDraft = null;           // 편집 중인 정책
let ppHistoryOpen = new Set();

function ppAreas() {
  try { return typeof HDMapPriority !== 'undefined' ? HDMapPriority.listAreas() : []; } catch (_) { return []; }
}
function ppMeta() {
  return (typeof HDMAP_PRIORITY_AREAS !== 'undefined' && HDMAP_PRIORITY_AREAS) ? { generatedAt: HDMAP_PRIORITY_AREAS.generatedAt || null } : null;
}
const ppToday = () => Recommendation.kstDate(typeof recommendationClock === 'function' ? recommendationClock() : Date.now());

// ══════════════════════════════════════════════════════════
//  앱 전체의 "활성 정책" — 설정 탭 배지 · 통계 우선지역 · 경력 기록이 모두 여기서 읽는다.
//  (추천 엔진은 같은 설정값 settings.priorityPolicies 를 받아 같은 PriorityPolicy.resolveActive 로 고른다)
//  정책이 저장되면(setSettings·백업 복원·동기화) 무효화하고, 구독한 화면에 알려 즉시 다시 그리게 한다.
//  정책이 바뀌어도 GPS 집계·도로망·POI 분석은 다시 하지 않는다 — 각 화면이 묶음만 다시 만든다.
// ══════════════════════════════════════════════════════════
let ppActiveState = null;               // {date, saved, policies, policy, fingerprint}
const ppListeners = [];

async function getActivePriorityPolicy(force) {
  const date = ppToday();
  if (!force && ppActiveState && ppActiveState.date === date) return ppActiveState;
  let settings = {};
  try { settings = (await RouteDB.getSettings()) || {}; } catch (_) { settings = {}; }
  const { policies, policy } = PriorityPolicy.resolveActive(settings.priorityPolicies, ppAreas(), ppMeta(), date);
  ppActiveState = { date, saved: Array.isArray(settings.priorityPolicies), policies, policy, fingerprint: PriorityPolicy.fingerprint(policies) };
  return ppActiveState;
}

// 정책이 바뀌면 부를 함수를 등록한다(fn(state)) — 무거운 재계산 없이 다시 그리기만 할 것
function onPriorityPolicyChange(fn) { if (typeof fn === 'function') ppListeners.push(fn); }

async function notifyPriorityPolicyChanged() {
  ppActiveState = null;
  const st = await getActivePriorityPolicy(true);
  ppListeners.forEach(fn => { try { fn(st); } catch (err) { console.warn('[경로뷰어] 정책 변경 반영 실패:', err); } });
}

if (typeof RouteDB !== 'undefined' && RouteDB && typeof RouteDB.onChange === 'function') {
  RouteDB.onChange(evt => {
    const m = evt && evt.method, p = ((evt && evt.args) || [])[0] || {};
    if ((m === 'setSettings' && 'priorityPolicies' in p) || m === 'restoreBackupPayload' || m === 'sync') notifyPriorityPolicyChanged();
  });
}

async function loadPriorityPolicies() {
  const st = await getActivePriorityPolicy();
  ppSaved = st.saved;
  ppPolicies = st.policies;
  return ppPolicies;
}

async function renderPriorityPolicySettings() {
  const el = document.getElementById('settings-priority-policy');
  if (!el || typeof PriorityPolicy === 'undefined') return;
  await loadPriorityPolicies();
  const today = ppToday();
  const active = PriorityPolicy.activePolicy(ppPolicies, today);
  const overlaps = PriorityPolicy.overlaps(ppPolicies);
  const sorted = ppPolicies.slice().sort((a, b) => String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const row = p => {
    const isActive = active && active.policyId === p.policyId;
    const ended = p.effectiveTo && p.effectiveTo < today;
    const future = p.effectiveFrom && p.effectiveFrom > today;
    const status = isActive ? '<span class="settings-row-status active">오늘 적용 중</span>'
      : ended ? '<span class="settings-row-status inactive">종료</span>'
        : future ? '<span class="settings-row-status inactive">예정</span>'
          : '<span class="settings-row-status inactive">대기(겹친 정책에 밀림)</span>';
    const idArg = escapeHtml(JSON.stringify(p.policyId));
    const hist = p.history || [];
    return `<div class="pp-row${isActive ? ' on' : ''}" data-policy-id="${escapeHtml(p.policyId)}">
      <div class="pp-row-head">
        <b>${escapeHtml(p.policyName)}</b> ${status}
        ${p.source === 'seed' ? `<span class="subzone-chip src">초기 정책 · ${escapeHtml(PriorityPolicy.sourceText(p))}</span>` : ''}
        <span class="mono pp-period">${escapeHtml(PriorityPolicy.periodText(p))}</span>
        <span style="flex:1"></span>
        <button class="btn ghost settings-row-btn" type="button" onclick="editPriorityPolicy(${idArg})">수정</button>
        <button class="btn ghost settings-row-btn" type="button" onclick="copyPriorityPolicy(${idArg})">복제해 새 정책</button>
        ${!ended ? `<button class="btn ghost settings-row-btn" type="button" onclick="endPriorityPolicy(${idArg})">어제까지로 종료</button>` : ''}
      </div>
      <div class="pp-summary mono">${escapeHtml(PriorityPolicy.summarize(p))}</div>
      <div class="rec-muted">수정 ${escapeHtml(p.updatedAt ? formatBackupTime(p.updatedAt) : '—')}${hist.length ? ` · <a href="#" onclick="togglePolicyHistory(${idArg});return false;">변경 이력 ${hist.length}건</a>` : ''}</div>
      ${ppHistoryOpen.has(p.policyId) ? `<ul class="rec-facts">${hist.slice().reverse().map(h => `<li class="mono">${escapeHtml(h.updatedAt ? formatBackupTime(h.updatedAt) : '초기')}까지: ${escapeHtml(h.policyName)} · ${escapeHtml(PriorityPolicy.periodText(h))} · ${escapeHtml(PriorityPolicy.summarize(h))}</li>`).join('')}</ul>` : ''}
    </div>`;
  };
  el.innerHTML = `
    <div class="pp-active ir-note" style="margin:0;">오늘(${escapeHtml(today)}) 적용 정책: <b>${escapeHtml(active ? active.policyName : '없음')}</b>
      ${active ? ` — ${escapeHtml(PriorityPolicy.summarize(active))} <span class="rec-muted">(${escapeHtml(PriorityPolicy.sourceText(active))})</span>` : ' — 모든 구역 비우선(사업 우선도 0), 데이터 부족도만으로 추천해요.'}
      ${!ppSaved ? '<br/>아직 저장한 정책이 없어 <b>초기 정책</b>(출처: 기존 HD Map 우선구역 설정 — hdmap-priority-areas.json 의 우선순위)을 쓰고 있어요. 수정해 저장하면 그때부터 설정 데이터로 관리돼요.' : ''}
      <br/><span class="rec-muted">단계: 100 최우선 · 70~99 우선 · 40~69 보조 · 1~39 일반 · 0 비우선 — 추천·설정·통계가 모두 이 기준을 씁니다.</span></div>
    ${overlaps.length ? `<div class="ir-note warn" style="margin:0;">기간이 겹치는 정책: ${overlaps.map(([a, b]) => `${escapeHtml(a)} ↔ ${escapeHtml(b)}`).join(', ')} — 겹치는 날에는 시작일이 늦은 정책을 써요.</div>` : ''}
    <div class="pp-list">${sorted.map(row).join('') || '<div class="dm-empty">정책이 없어요.</div>'}</div>
    <div class="settings-actions"><button class="btn ghost" type="button" onclick="newPriorityPolicy()">+ 새 정책</button></div>
    ${ppDraft ? priorityPolicyFormHTML() : ''}`;
}

function togglePolicyHistory(id) {
  if (ppHistoryOpen.has(id)) ppHistoryOpen.delete(id); else ppHistoryOpen.add(id);
  renderPriorityPolicySettings();
}

function newPriorityPolicy() {
  const base = PriorityPolicy.activePolicy(ppPolicies, ppToday());
  ppDraft = { policyId: null, policyName: '', effectiveFrom: ppToday(), effectiveTo: '', areaPriorities: { ...((base && base.areaPriorities) || {}) } };
  renderPriorityPolicySettings();
}
function copyPriorityPolicy(id) {
  const p = ppPolicies.find(x => x.policyId === id);
  if (!p) return;
  ppDraft = { policyId: null, policyName: `${p.policyName} (복사)`, effectiveFrom: ppToday(), effectiveTo: '', areaPriorities: { ...p.areaPriorities } };
  renderPriorityPolicySettings();
}
function editPriorityPolicy(id) {
  const p = ppPolicies.find(x => x.policyId === id);
  if (!p) return;
  ppDraft = JSON.parse(JSON.stringify(p));
  ppDraft.effectiveFrom = ppDraft.effectiveFrom || '';
  ppDraft.effectiveTo = ppDraft.effectiveTo || '';
  renderPriorityPolicySettings();
}
function cancelPriorityPolicy() { ppDraft = null; renderPriorityPolicySettings(); }

function priorityPolicyFormHTML() {
  const d = ppDraft;
  const areas = ppAreas();
  const nos = areas.length ? areas.map(a => a.areaNo) : Array.from({ length: 12 }, (_, i) => i + 1);
  const rows = nos.map(no => {
    const v = d.areaPriorities[String(no)];
    const val = v == null ? 0 : v;
    const preset = PriorityPolicy.presetOfValue(val);
    return `<div class="settings-row depth-tier-row pp-area-row">
      <span class="settings-row-name">${escapeHtml(PriorityPolicy.circledNo(no))}</span>
      <select id="pp-preset-${no}" onchange="onPolicyPreset(${no},this.value)">
        ${PriorityPolicy.PRESETS.map(p => `<option value="${p.id}"${preset && preset.id === p.id ? ' selected' : ''}>${escapeHtml(p.label)} ${p.value}</option>`).join('')}
        <option value="custom"${preset ? '' : ' selected'}>직접 입력</option>
      </select>
      <input type="number" class="depth-threshold-input mono rec-input" id="pp-area-${no}" min="0" max="100" step="1" value="${escapeHtml(val)}" oninput="onPolicyValue(${no},this.value)"/>
    </div>`;
  }).join('');
  return `<div class="dist-card pp-form">
    <div class="dc-title">${d.policyId ? '정책 수정 — 저장하면 이전 버전은 변경 이력으로 남아요' : '새 정책'}</div>
    <div class="plan-form">
      <label class="rec-filter"><span>정책 이름</span><input type="text" id="pp-name" maxlength="80" value="${escapeHtml(d.policyName)}" oninput="ppDraft.policyName=this.value" placeholder="예: 2026-10 우선 수집 요청"/></label>
      <label class="rec-filter"><span>시작일</span><input type="date" id="pp-from" value="${escapeHtml(d.effectiveFrom || '')}" onchange="ppDraft.effectiveFrom=this.value"/></label>
      <label class="rec-filter"><span>종료일(비우면 계속)</span><input type="date" id="pp-to" value="${escapeHtml(d.effectiveTo || '')}" onchange="ppDraft.effectiveTo=this.value"/></label>
    </div>
    <div class="pp-areas">${rows}</div>
    <div class="plan-zone-hint">단계: 최우선 100 · 우선 70 · 보조 40 · 일반 0 — 숫자를 0~100으로 직접 바꿀 수도 있어요. 사업 우선도는 추천 점수의 보조 항목(기본 20%)이라, 데이터가 충분한 구역을 1위로 만들지는 않아요.</div>
    <div id="pp-errors" class="ir-note warn" style="display:none;margin:0;"></div>
    <div class="settings-actions">
      <button class="btn" type="button" onclick="savePriorityPolicy()">저장</button>
      <button class="btn ghost" type="button" onclick="cancelPriorityPolicy()">취소</button>
    </div>
  </div>`;
}

// 단계 선택과 숫자 칸은 늘 같은 값을 보여준다 — 숫자가 프리셋 값이 아니면 "직접 입력"
function syncPolicyPreset(no) {
  const sel = document.getElementById(`pp-preset-${no}`);
  if (!sel) return;
  const preset = PriorityPolicy.presetOfValue(ppDraft.areaPriorities[String(no)] === '' ? 0 : ppDraft.areaPriorities[String(no)]);
  sel.value = preset ? preset.id : 'custom';
}
function onPolicyPreset(no, presetId) {
  const p = PriorityPolicy.presetById(presetId);
  if (!p) return;   // 직접 입력 — 숫자 칸을 그대로 둔다
  ppDraft.areaPriorities[String(no)] = p.value;
  const input = document.getElementById(`pp-area-${no}`);
  if (input) input.value = p.value;
  syncPolicyPreset(no);
}
function onPolicyValue(no, value) {
  ppDraft.areaPriorities[String(no)] = String(value).trim() === '' ? '' : Number(value);
  const input = document.getElementById(`pp-area-${no}`);
  if (input && String(input.value) !== String(value)) input.value = value;
  syncPolicyPreset(no);
}

async function savePolicyList(list, successText) {
  try {
    await RouteDB.setSettings({ priorityPolicies: list });
  } catch (err) {
    const errs = (err && err.errors) || [String((err && err.message) || err)];
    const el = document.getElementById('pp-errors');
    if (el) { el.style.display = 'block'; el.innerHTML = errs.map(escapeHtml).join('<br/>'); }
    else showError(errs.join(' '));
    return false;
  }
  showToast(successText);
  return true;
}

async function savePriorityPolicy() {
  if (!ppDraft) return;
  const draft = { ...ppDraft, effectiveFrom: ppDraft.effectiveFrom || null, effectiveTo: ppDraft.effectiveTo || null };
  const v = PriorityPolicy.normalizePolicy(draft);
  if (!v.ok) {
    const el = document.getElementById('pp-errors');
    if (el) { el.style.display = 'block'; el.innerHTML = v.errors.map(escapeHtml).join('<br/>'); }
    return;
  }
  const list = ppPolicies.filter(p => p.policyId !== draft.policyId).concat([draft.policyId ? draft : v.value]);
  if (await savePolicyList(list, `"${v.value.policyName}" 정책을 저장했어요. 추천을 새 정책으로 다시 계산해요.`)) {
    ppDraft = null;
    await renderPriorityPolicySettings();
  }
}

async function endPriorityPolicy(id) {
  const p = ppPolicies.find(x => x.policyId === id);
  if (!p) return;
  const d = new Date(Date.parse(`${ppToday()}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (p.effectiveFrom && p.effectiveFrom > d) { showError('아직 시작하지 않은 정책이라 종료할 수 없어요 — 수정에서 기간을 바꿔주세요.'); return; }
  if (!confirm(`"${p.policyName}" 정책을 ${d}까지로 종료할까요? 정책은 지워지지 않고 기록으로 남아요.`)) return;
  const list = ppPolicies.map(x => (x.policyId === id ? { ...x, effectiveTo: d } : x));
  if (await savePolicyList(list, `"${p.policyName}" 정책을 ${d}까지로 종료했어요.`)) await renderPriorityPolicySettings();
}

// 정책이 바뀌면 설정 탭(정책 목록 + ①~⑫ 배지)을 바로 다시 그린다 — 보이는 중일 때만
onPriorityPolicyChange(() => {
  const view = document.getElementById('settings-view');
  if (!view || view.style.display === 'none') return;
  renderPriorityPolicySettings();
  if (typeof renderHDMapPriorityAreaSettings === 'function') renderHDMapPriorityAreaSettings();
});
