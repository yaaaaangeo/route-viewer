// ══════════════════════════════════════════════════════════
//  settings — 차량 관리 · 지역 관리 · Coverage Depth 기준 (요구사항 13~16)
//
//  예전엔 VEHICLE_ORDER/VEHICLE_COLORS/ZONE_CENTERS/ZONE_COLORS/ZONE_POLYGONS 가
//  소스코드에 하드코딩돼 있었다. 이제 vehicles/zones 테이블(설정 데이터)에서
//  읽어오고, 여기서 추가/비활성화하면 코드 수정 없이 누적 지도·통계·Coverage·
//  파일 불러오기(필터 버튼)에 즉시 반영된다.
//
//  삭제가 아니라 "비활성화"만 제공한다 — 과거 기록은 zone/vehicle 이 자유
//  텍스트라 비활성화해도 절대 사라지지 않고, 필터 버튼에서만 빠진다.
// ══════════════════════════════════════════════════════════

async function renderSettingsView(){
  await Promise.all([refreshVehicleCache(),refreshZoneCache(),refreshSettingsCache()]);
  await renderVehicleSettingsList();
  await renderZoneSettingsList();
  renderDepthTierSettings();
  await renderClassificationSettings();
}

// ── 차량 관리 ─────────────────────────────────────────
async function renderVehicleSettingsList(){
  const el=document.getElementById('settings-vehicle-list');
  if(!el) return;
  let vehicles=[];
  try{ vehicles=await RouteDB.listVehicles(); }
  catch(err){ showError('차량 목록을 불러오지 못했어요. ('+err.message+')'); return; }
  el.innerHTML=vehicles.length ? vehicles.map(v=>`
    <div class="settings-row">
      <span class="settings-swatch" style="background:${escapeHtml(v.color||'#4fd8c7')}"></span>
      <span class="settings-row-name">${escapeHtml(v.displayName||v.name)}</span>
      <span class="settings-row-status ${v.active?'active':'inactive'}">${v.active?'활성':'비활성'}</span>
      <button type="button" class="btn ghost settings-row-btn" onclick="toggleVehicleActive('${escapeHtml(v.name)}', ${v.active?'false':'true'})">${v.active?'비활성화':'활성화'}</button>
    </div>`).join('') : '<div class="dm-empty">등록된 차량이 없어요.</div>';
}

async function toggleVehicleActive(name,active){
  try{
    await RouteDB.setVehicleActive(name,active);
    await refreshVehicleCache();
    await renderVehicleSettingsList();
    showToast(`${name} 차량을 ${active?'활성화':'비활성화'}했어요. 과거 기록은 그대로 있어요.`);
  }catch(err){ showError('차량 상태를 바꾸지 못했어요. ('+err.message+')'); }
}

function openAddVehicleModal(){
  openModal({
    title:'차량 추가',
    icon:'+',
    body:`
      <div class="settings-form-row">
        <label class="settings-form-label">차량 이름</label>
        <input type="text" id="new-vehicle-name" class="sync-input" placeholder="예: 토레스 5호" autocomplete="off" maxlength="30"/>
      </div>
      <div class="settings-form-row">
        <label class="settings-form-label">색상</label>
        <input type="color" id="new-vehicle-color" value="#4fd8c7"/>
      </div>
    `,
    buttons:[
      {label:'취소',onClick:closeModal},
      {label:'추가',primary:true,onClick:submitAddVehicle},
    ],
  });
  setTimeout(()=>{ const el=document.getElementById('new-vehicle-name'); if(el) el.focus(); },80);
}

async function submitAddVehicle(){
  const nameEl=document.getElementById('new-vehicle-name');
  const name=nameEl.value.trim();
  const color=document.getElementById('new-vehicle-color').value;
  if(!name){ showError('차량 이름을 입력해주세요.'); return; }
  try{
    await RouteDB.saveVehicle({name,color});
    closeModal();
    await refreshVehicleCache();
    await renderVehicleSettingsList();
    showToast(`${name}을(를) 추가했어요. 통계·필터·파일 불러오기에서 바로 쓸 수 있어요.`);
  }catch(err){ showError('차량을 추가하지 못했어요. ('+err.message+')'); }
}

// ── 지역 관리 ─────────────────────────────────────────
async function renderZoneSettingsList(){
  const el=document.getElementById('settings-zone-list');
  if(!el) return;
  let zones=[];
  try{ zones=await RouteDB.listZones(); }
  catch(err){ showError('지역 목록을 불러오지 못했어요. ('+err.message+')'); return; }
  el.innerHTML=zones.length ? zones.map(z=>{
    const hasPolygon=z.polygon&&z.polygon.length>=3;
    return `<div class="settings-row">
      <span class="settings-swatch" style="background:${escapeHtml(z.color||'#4fd8c7')}"></span>
      <span class="settings-row-name">${escapeHtml(z.name)}</span>
      <span class="settings-row-status ${z.active?'active':'inactive'}">${z.active?'활성':'비활성'}</span>
      <span class="settings-row-poly${hasPolygon?'':' muted'}">${hasPolygon?'경계 설정됨':'경계 미설정'}</span>
      <button type="button" class="btn ghost settings-row-btn" onclick="toggleZoneActive('${escapeHtml(z.name)}', ${z.active?'false':'true'})">${z.active?'비활성화':'활성화'}</button>
    </div>`;
  }).join('') : '<div class="dm-empty">등록된 지역이 없어요.</div>';
}

async function toggleZoneActive(name,active){
  try{
    await RouteDB.setZoneActive(name,active);
    await refreshZoneCache();
    await renderZoneSettingsList();
    showToast(`${name} 지역을 ${active?'활성화':'비활성화'}했어요. 과거 기록은 그대로 있어요.`);
  }catch(err){ showError('지역 상태를 바꾸지 못했어요. ('+err.message+')'); }
}

function openAddZoneModal(){
  openModal({
    title:'지역 추가',
    icon:'+',
    body:`
      <div class="settings-form-row">
        <label class="settings-form-label">지역 이름</label>
        <input type="text" id="new-zone-name" class="sync-input" placeholder="예: 성남" autocomplete="off" maxlength="30"/>
      </div>
      <div class="settings-form-row">
        <label class="settings-form-label">지도 중심 위도</label>
        <input type="text" id="new-zone-lat" class="sync-input mono" placeholder="37.4" autocomplete="off"/>
      </div>
      <div class="settings-form-row">
        <label class="settings-form-label">지도 중심 경도</label>
        <input type="text" id="new-zone-lng" class="sync-input mono" placeholder="127.1" autocomplete="off"/>
      </div>
      <div class="settings-form-row">
        <label class="settings-form-label">색상</label>
        <input type="color" id="new-zone-color" value="#4fd8c7"/>
      </div>
      <div class="ir-note">저장하면 누적 지도·통계·Coverage에 바로 나타나요. 경계는 저장 후 "누적 지도"에서 이 지역을 선택하고 지도를 클릭해서 직접 그리면 돼요.</div>
    `,
    wide:true,
    buttons:[
      {label:'취소',onClick:closeModal},
      {label:'저장',primary:true,onClick:submitAddZone},
    ],
  });
  setTimeout(()=>{ const el=document.getElementById('new-zone-name'); if(el) el.focus(); },80);
}

async function submitAddZone(){
  const name=document.getElementById('new-zone-name').value.trim();
  const latStr=document.getElementById('new-zone-lat').value.trim();
  const lngStr=document.getElementById('new-zone-lng').value.trim();
  const color=document.getElementById('new-zone-color').value;
  if(!name){ showError('지역 이름을 입력해주세요.'); return; }
  const centerLat=latStr?Number(latStr):null;
  const centerLng=lngStr?Number(lngStr):null;
  if((latStr&&isNaN(centerLat))||(lngStr&&isNaN(centerLng))){ showError('위도/경도는 숫자로 입력해주세요.'); return; }
  try{
    await RouteDB.saveZone({name,color,centerLat,centerLng});
    closeModal();
    await refreshZoneCache();
    await renderZoneSettingsList();
    showToast(`${name}을(를) 추가했어요. "누적 지도"에서 경계를 그려보세요.`);
  }catch(err){ showError('지역을 추가하지 못했어요. ('+err.message+')'); }
}

// ── Coverage Depth 기준 (요구사항 11) ─────────────────
function renderDepthTierSettings(){
  const el=document.getElementById('settings-depth-tiers');
  if(!el) return;
  const tiers=[...depthTiers].sort((a,b)=>a.threshold-b.threshold);
  el.innerHTML=tiers.map((t,i)=>{
    const rangeText=i===tiers.length-1 ? `${t.threshold}회 이상`
      : (t.threshold===tiers[i+1].threshold-1 ? `${t.threshold}회` : `${t.threshold}~${tiers[i+1].threshold-1}회`);
    return `
      <div class="settings-row depth-tier-row">
        <span class="depth-swatch" style="background:${t.color}"></span>
        <span class="settings-row-name">${escapeHtml(t.label)}</span>
        <span class="mono depth-tier-range">${rangeText}</span>
        <span class="depth-tier-input-wrap">
          <span class="mono" style="color:var(--text-faint);font-size:10.5px;">기준</span>
          <input type="number" min="0" class="depth-threshold-input mono" value="${t.threshold}"
                 ${i===0?'disabled title="첫 등급은 0회 고정이에요"':''}
                 onchange="updateDepthTierThreshold(${i},this.value)"/>
          <span class="mono" style="color:var(--text-faint);font-size:10.5px;">회 이상</span>
        </span>
      </div>`;
  }).join('');
}

async function updateDepthTierThreshold(index,value){
  const n=parseInt(value,10);
  if(isNaN(n)||n<0){ renderDepthTierSettings(); return; }
  const tiers=[...depthTiers].sort((a,b)=>a.threshold-b.threshold);
  tiers[index]={...tiers[index],threshold:n};
  try{
    await RouteDB.setSettings({coverageDepthTiers:tiers});
    await refreshSettingsCache();
    renderDepthTierSettings();
    showToast('Coverage Depth 기준을 저장했어요.');
  }catch(err){
    showError('설정을 저장하지 못했어요. ('+err.message+')');
    renderDepthTierSettings();
  }
}

// ══════════════════════════════════════════════════════════
//  교통 시간대 · 조도 조건(일출·일몰 전후 범위)
//
//  검증 규칙은 time-conditions.js validateTrafficPeriods 하나 — 화면은 입력 중에 미리 보여주기만 하고,
//  저장할 때 저장소(SQLite/IndexedDB)가 같은 함수로 다시 검증해서 잘못된 설정은 저장하지 않는다.
//  저장이 끝나면 날짜 요약을 새 기준으로 재분류한다(원본 기록은 바뀌지 않는다).
// ══════════════════════════════════════════════════════════
let trafficPeriodFormValues=null; // 아직 저장하지 않은 입력값 [{id,start,end}]
let reclassifyUiRunning=false;

async function renderClassificationSettings(){
  const cfg=currentClassificationConfig();
  if(!trafficPeriodFormValues) trafficPeriodFormValues=cfg.trafficPeriods.map(p=>({id:p.id,start:p.start,end:p.end}));
  renderTrafficPeriodRows();
  renderLightWindowInputs(cfg);
  validateTrafficPeriodForm();
  await renderClassificationStatus();
}

function renderTrafficPeriodRows(){
  const el=document.getElementById('settings-traffic-periods');
  if(!el) return;
  // 시작 시각 순으로 보여줄 뿐, 판정은 순서가 아니라 시작·종료 시각으로 한다
  const rows=[...trafficPeriodFormValues].sort((a,b)=>{
    const sa=TimeConditions.parseClock(a.start,false), sb=TimeConditions.parseClock(b.start,false);
    return (sa==null?9999:sa)-(sb==null?9999:sb);
  });
  el.innerHTML=rows.map(p=>{
    const id=escapeHtml(p.id);
    const label=escapeHtml(TimeConditions.TRAFFIC_PERIOD_LABELS[p.id]||p.id);
    return `
    <div class="settings-row traffic-period-row" data-period="${id}">
      <span class="settings-row-name">${label}</span>
      <span class="mono traffic-period-id">${id}</span>
      <span class="traffic-period-inputs">
        <input type="text" class="sync-input mono tp-input" id="tp-start-${id}" value="${escapeHtml(p.start)}" maxlength="5" placeholder="HH:mm" aria-label="${label} 시작" oninput="onTrafficPeriodInput('${id}','start',this.value)"/>
        <span class="mono" style="color:var(--text-faint);">~</span>
        <input type="text" class="sync-input mono tp-input" id="tp-end-${id}" value="${escapeHtml(p.end)}" maxlength="5" placeholder="HH:mm" aria-label="${label} 종료" oninput="onTrafficPeriodInput('${id}','end',this.value)"/>
      </span>
    </div>`;
  }).join('');
}

function onTrafficPeriodInput(id,field,value){
  const p=trafficPeriodFormValues.find(x=>x.id===id);
  if(p) p[field]=String(value||'').trim();
  validateTrafficPeriodForm();
}

function showSettingsErrors(elId,errors){
  const el=document.getElementById(elId);
  if(!el) return;
  if(errors&&errors.length){
    el.style.display='block';
    el.innerHTML='저장할 수 없어요:<ul class="settings-error-list">'+errors.map(e=>`<li>${escapeHtml(e)}</li>`).join('')+'</ul>';
  }else{
    el.style.display='none';
    el.innerHTML='';
  }
}

function validateTrafficPeriodForm(){
  const result=TimeConditions.validateTrafficPeriods(trafficPeriodFormValues||[]);
  showSettingsErrors('traffic-period-errors',result.errors);
  const btn=document.getElementById('traffic-period-save-btn');
  if(btn) btn.disabled=!result.ok||reclassifyUiRunning;
  return result;
}

async function saveTrafficPeriodSettings(){
  if(reclassifyUiRunning) return false;
  const result=validateTrafficPeriodForm();
  if(!result.ok) return false; // 잘못된 설정은 저장하지 않는다(이유는 위에 표시됨)
  return applyClassificationSettings({trafficPeriods:result.periods},'교통 시간대를 저장했어요.');
}

async function restoreDefaultTrafficPeriods(){
  if(reclassifyUiRunning) return false;
  trafficPeriodFormValues=TimeConditions.defaultTrafficPeriods().map(p=>({id:p.id,start:p.start,end:p.end}));
  renderTrafficPeriodRows();
  validateTrafficPeriodForm();
  return applyClassificationSettings({trafficPeriods:TimeConditions.defaultTrafficPeriods()},'교통 시간대를 기본값으로 되돌렸어요.');
}

function renderLightWindowInputs(cfg){
  const el=document.getElementById('settings-light-windows');
  if(!el) return;
  const row=(id,label,value)=>`
    <div class="settings-row depth-tier-row">
      <span class="settings-row-name">${label}</span>
      <span class="depth-tier-input-wrap">
        <span class="mono" style="color:var(--text-faint);font-size:10.5px;">±</span>
        <input type="number" min="0" max="${TimeConditions.MAX_WINDOW_MINUTES}" step="1" class="depth-threshold-input mono" id="${id}" value="${value}" oninput="validateLightWindowForm()"/>
        <span class="mono" style="color:var(--text-faint);font-size:10.5px;">분</span>
      </span>
    </div>`;
  el.innerHTML=row('light-sunrise-window','일출 전후',cfg.sunriseWindowMinutes)+row('light-sunset-window','일몰 전후',cfg.sunsetWindowMinutes);
}

function readLightWindowForm(){
  const v=id=>{ const el=document.getElementById(id); return el?String(el.value).trim():''; };
  const sr=TimeConditions.validateWindowMinutes(v('light-sunrise-window'),'일출 전후 범위');
  const ss=TimeConditions.validateWindowMinutes(v('light-sunset-window'),'일몰 전후 범위');
  return {ok:sr.ok&&ss.ok,errors:[sr.error,ss.error].filter(Boolean),sunriseWindowMinutes:sr.value,sunsetWindowMinutes:ss.value};
}

function validateLightWindowForm(){
  const r=readLightWindowForm();
  showSettingsErrors('light-window-errors',r.errors);
  const btn=document.getElementById('light-window-save-btn');
  if(btn) btn.disabled=!r.ok||reclassifyUiRunning;
  return r;
}

async function saveLightWindowSettings(){
  if(reclassifyUiRunning) return false;
  const r=validateLightWindowForm();
  if(!r.ok) return false;
  return applyClassificationSettings({sunriseWindowMinutes:r.sunriseWindowMinutes,sunsetWindowMinutes:r.sunsetWindowMinutes},'일출·일몰 전후 범위를 저장했어요.');
}

// 저장 → 재분류. 저장소가 거절하면(검증 실패) 아무것도 바뀌지 않고 이유를 보여준다.
async function applyClassificationSettings(patch,savedMessage){
  try{
    await RouteDB.setSettings(patch);
  }catch(err){
    const errors=err&&err.errors?err.errors:String((err&&err.message)||err).split('\n');
    showSettingsErrors(patch.trafficPeriods?'traffic-period-errors':'light-window-errors',errors);
    showError('설정을 저장하지 못했어요. 기존 설정은 그대로예요.');
    return false;
  }
  await refreshSettingsCache();
  trafficPeriodFormValues=currentClassificationConfig().trafficPeriods.map(p=>({id:p.id,start:p.start,end:p.end}));
  renderTrafficPeriodRows();
  renderLightWindowInputs(currentClassificationConfig());
  validateTrafficPeriodForm();
  showToast(savedMessage+' 기존 기록을 새 기준으로 다시 분류할게요.');
  return runReclassification();
}

function setClassificationBusy(busy){
  ['traffic-period-save-btn','traffic-period-default-btn','light-window-save-btn','classification-reclassify-btn'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.disabled=busy;
  });
  document.querySelectorAll('.tp-input,#light-sunrise-window,#light-sunset-window').forEach(el=>{ el.disabled=busy; });
  if(!busy){ validateTrafficPeriodForm(); validateLightWindowForm(); }
}

// 날짜 요약 재분류 — 중복 실행 방지(화면 플래그 + 저장소도 같은 작업을 돌려줌), 진행률 표시,
// 실패해도 원본 기록은 그대로(남은 날짜는 다시 누르거나 다음 실행 때 이어서 처리됨).
// 끝나면 달력(날짜 요약 캐시)·통계가 새 기준을 쓰도록 다시 읽는다.
async function runReclassification(){
  if(reclassifyUiRunning) return false;
  reclassifyUiRunning=true;
  setClassificationBusy(true);
  const statusEl=document.getElementById('classification-status');
  if(statusEl) statusEl.textContent='재분류 중…';
  const timer=setInterval(async()=>{
    try{
      const st=await RouteDB.getClassificationStatus();
      if(statusEl&&st.running&&st.progress) statusEl.textContent=`재분류 중… ${fmtNum(st.progress.done)} / ${fmtNum(st.progress.total)}일`;
    }catch(_){ /* 진행률 조회 실패는 무시 — 작업 자체는 계속된다 */ }
  },300);
  let ok=false;
  try{
    const res=await RouteDB.reclassifySummaries();
    await refreshDateIndex();
    if(typeof renderCalendarGrid==='function') renderCalendarGrid();
    showToast(`날짜 ${fmtNum(res.rebuilt)}일을 새 기준으로 다시 분류했어요. 원본 기록은 그대로예요.`);
    ok=true;
  }catch(err){
    console.warn('[경로뷰어] 재분류 실패:',err);
    showError('재분류를 끝내지 못했어요. 원본 기록은 그대로이고, 아직 처리하지 못한 날짜는 "지금 재분류"를 누르면 이어서 처리돼요. ('+((err&&err.message)||err)+')');
  }finally{
    clearInterval(timer);
    reclassifyUiRunning=false;
    setClassificationBusy(false);
    await renderClassificationStatus();
  }
  return ok;
}

async function renderClassificationStatus(){
  const el=document.getElementById('classification-status');
  if(!el) return null;
  let st;
  try{ st=await RouteDB.getClassificationStatus(); }
  catch(err){ el.textContent='분류 상태를 확인하지 못했어요.'; return null; }
  if(st.running){
    el.textContent=st.progress?`재분류 중… ${fmtNum(st.progress.done)} / ${fmtNum(st.progress.total)}일`:'재분류 중…';
  }else if(st.staleDates>0){
    el.innerHTML=`새 기준으로 아직 분류하지 않은 날짜 ${fmtNum(st.staleDates)}일 / 전체 ${fmtNum(st.totalDates)}일 <button class="btn ghost settings-row-btn" type="button" id="classification-reclassify-btn" onclick="runReclassification()">지금 재분류</button>`;
  }else{
    el.textContent=`분류 기준 적용됨 · 날짜 ${fmtNum(st.totalDates)}일 모두 현재 기준`;
  }
  return st;
}
