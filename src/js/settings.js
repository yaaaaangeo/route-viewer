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
