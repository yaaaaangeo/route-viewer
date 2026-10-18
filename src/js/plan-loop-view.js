// ══════════════════════════════════════════════════════════
//  plan-loop-view — 추천 → nav-app 수집 계획 보내기 · 추천 계획 수행 결과 (nav-app 연계 화면)
//
//  계산은 전부 collection-loop.js(순수 함수)와 DB(evaluateDriveResult)가 한다. 여기서는 입력·표시만 한다.
//    · 오늘 추천 주행 Top 3 에서 고른 도로 구간 → CollectionPlan.json 파일 (서버 없음 — 파일로 nav-app 에 전달)
//    · nav-app 이 돌려준 DriveResult.json(자동 가져오기 폴더 또는 직접 불러오기) + GPS 원본 → 계획 대비 수행
//    · 새 기록으로 다시 돌린 추천과 계획 때 점수를 견준 전후 변화 → 저장
// ══════════════════════════════════════════════════════════
const PLAN_PICKS_LS_KEY='rv.navPlanUnchecked';
let navPlanUnchecked=(function(){ try{ return new Set(JSON.parse(localStorage.getItem(PLAN_PICKS_LS_KEY)||'[]')); }catch(_){ return new Set(); } })();
let planLoopBusy=false;
let planLoopState={ results:null, plans:null, statuses:null, loadedAt:0, error:null };

function planEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function isPlanPickChecked(id){ return !navPlanUnchecked.has(id); }

function togglePlanPick(id,on){
  if(on) navPlanUnchecked.delete(id); else navPlanUnchecked.add(id);
  try{ localStorage.setItem(PLAN_PICKS_LS_KEY,JSON.stringify([...navPlanUnchecked])); }catch(_){ /* 무시 */ }
  const btn=document.getElementById('rec-send-nav-btn');
  if(btn&&recTodayResult) btn.textContent=sendNavButtonLabel(recTodayResult);
}

function selectedPlanRecs(picks){
  return (picks&&picks.items||[]).filter(it=>it.source==='segment'&&isPlanPickChecked(it.id)).map(it=>findRecommendation(it.id)).filter(Boolean);
}

function sendNavButtonLabel(picks){
  return `🧭 네비게이션으로 보내기 (${selectedPlanRecs(picks).length}구간)`;
}

/** 오늘 추천 Top 3 아래에 붙이는 버튼 — 도로 구간 추천일 때만 (구역 추천에는 도로 형상이 없다) */
function renderSendNavButton(picks){
  if(!picks||picks.source!=='segment'||!picks.items.length) return '<span class="rec-muted">네비게이션으로 보내기는 도로 구간 자동 분석 추천이 있을 때 쓸 수 있어요.</span>';
  return `<button class="btn" type="button" id="rec-send-nav-btn" onclick="sendPicksToNavigation()">${planEsc(sendNavButtonLabel(picks))}</button>`;
}

/** 오늘 추천 항목 옆 체크 상자 */
function planPickCheckbox(it){
  if(it.source!=='segment') return '';
  return `<label class="rec-muted" style="display:inline-flex;gap:4px;align-items:center"><input type="checkbox" ${isPlanPickChecked(it.id)?'checked':''}
    onchange="togglePlanPick(${planEsc(JSON.stringify(it.id))},this.checked)"/>계획에 넣기</label>`;
}

/**
 * 고른 추천으로 하루 수집 계획을 만들어 파일로 내보낸다.
 * 점수·부족분은 추천 엔진 값 그대로 — 방문 순서는 권장 시간대 → (점수 − 이동 분) 순, 이동 거리는 HD Map 도로망(없으면 직선).
 * nav-app 이 이 파일을 받아 TMAP 으로 실제 차량 경로를 만들고 필수 구간 통과를 검증한 뒤 확정한다
 * (Route Viewer 의 도로망 최단 경로를 차량 경로로 쓰지 않는다).
 */
async function sendPicksToNavigation(){
  if(planLoopBusy) return;
  const picks=recTodayResult;
  const recs=selectedPlanRecs(picks);
  if(!recs.length){ alert('계획에 넣을 도로 구간을 하나 이상 골라주세요.'); return; }
  const regions=[...new Set(recs.map(r=>r.parentZone))];
  if(regions.length>1){ alert(`한 계획에는 한 지역만 담아요 — 지금 고른 구간: ${regions.join(', ')}`); return; }
  planLoopBusy=true;
  try{
    const pol=(typeof autoRecResult!=='undefined'&&autoRecResult)?autoRecResult.policy:null;
    // 옆 도로(통과 판정)·방향 기록·nav-app 방향 피드백 — 자동 분석이 그 지역 것일 때만 쓴다
    const an=(typeof autoAnalysis!=='undefined'&&autoAnalysis&&autoAnalysis.parentZone===regions[0])?autoAnalysis:null;
    let feedback=[];
    try{ feedback=typeof RouteDB.listDirectionFeedback==='function'?await RouteDB.listDirectionFeedback():[]; }catch(_){ feedback=[]; }
    const allRecs=(typeof autoRecResult!=='undefined'&&autoRecResult)?(autoRecResult.allRecommendations||autoRecResult.recommendations||[]):[];
    const speed=autoRecResult&&autoRecResult.settings&&autoRecResult.settings.collectionSpeedKmh;
    const build=list=>CollectionLoop.buildCollectionPlan({
      recommendations:list, region:regions[0], planDate:picks.today,
      window:picks.window, vehicleCount:picks.vehicleCount,
      router:typeof planRouter==='function'?planRouter():null,
      roadSegments:an?an.segments:null, segmentStats:an?an.segmentStats:null, directionFeedback:feedback,
      candidates:allRecs, collectionSpeedKmh:speed||undefined,
      policy:pol?{policyId:pol.policyId,policyName:pol.policyName}:null,
      source:{appVersion:typeof APP_VERSION!=='undefined'?APP_VERSION:'', dataRevision:String(typeof recCache!=='undefined'&&recCache&&recCache.key||'')},
    });
    let plan=build(recs);
    // 목표 미달 예상 항목에 같은 조건의 대안이 있으면 바꿀지 묻는다 (대안 수집은 그 대안 구간의 목표로만 센다)
    const swaps=plan.items.filter(it=>it.feasibility.status==='shortfall'&&it.alternatives.some(a=>a.type==='longer'&&a.quantityStatus!=='shortfall'))
      .map(it=>({ from:it, to:it.alternatives.find(a=>a.type==='longer'&&a.quantityStatus!=='shortfall') }));
    if(swaps.length&&confirm(`목표 미달 예상 항목 ${swaps.length}개에 같은 조건(요일·시간대·조도)의 대안이 있어요:\n\n`+
        swaps.map(x=>`· ${x.from.title} (예상 ${x.from.estimate.expectedMinutes}분 / 부족 ${x.from.estimate.deficitMinutes}분)\n   → ${x.to.title} — ${x.to.why}`).join('\n')+
        '\n\n대안 구간으로 바꿔 계획을 만들까요? (취소하면 원래 구간 그대로)')){
      const byId=new Map(allRecs.map(r=>[r.id,r]));
      plan=build(recs.map(r=>{ const sw=swaps.find(x=>x.from.recommendationId===r.id); return sw&&byId.get(sw.to.recommendationId)||r; }));
    }
    // 저장 전에 보여 준다 — 예상은 달성이 아니다(달성은 주행 뒤 GPS 원본으로만)
    const sensText=it=>(it.estimate.speedSensitivity||[]).map(x=>`${x.speedKmh}km/h ${x.expectedMinutes}분`).join(' · ');
    const lines=plan.items.map(it=>`· [${it.feasibility.label}] ${it.title} — 방문 ${it.visits.length}회(${[...new Set(it.visits.map(v=>v.direction==='forward'?'형상 순서':'반대'))].join('·')} 방향)\n   ${it.estimate.note}\n   속도 가정별 예상: ${sensText(it)}`+
      (it.feasibility.reasons.length>1?`\n   ${it.feasibility.reasons.slice(1).join(' / ')}`:'')+
      (it.alternatives&&it.alternatives.length?`\n   대안: ${it.alternatives.map(a=>a.title+'('+(a.type==='chain'?'이어진 구간':a.lengthM+'m')+')').join(', ')}`:''));
    const ex=plan.excludedItems.map(e=>`· 제외: ${e.title} — ${e.reason}`);
    const warn=plan.feasibility.warnings.filter(w=>/시간대는/.test(w)).map(w=>'· '+w);
    const sm=plan.feasibility.summary;
    if(!confirm(`수집 계획 (${plan.items.length}구간 · 방문 ${plan.totals.passes}회) — 달성 가능 ${sm.achievable} · 조건부 ${sm.conditional} · 목표 미달 예상 ${sm.shortfall} · 방향 확인 필요 ${sm.direction_unknown}\n\n${lines.concat(ex,warn).join('\n')}\n\n`+
      `예상 수집 ${plan.totals.expectedMinutes}분 / 부족분 ${plan.totals.deficitMinutes}분 (남는 부족 ${plan.totals.shortfallMinutes}분 · 수집 속도 ${plan.feasibility.speedKmh}km/h 가정)\n`+
      `예상은 달성이 아니에요 — 주행 뒤 GPS 원본으로 판정합니다. 방향 가능 여부는 지도로 알 수 없어 nav-app 이 TMAP 으로 확인합니다${an?'':' · 옆 도로 정보 없음(자동 분석을 이 지역으로 먼저 돌리면 판정이 정확해져요)'}\n\n이 계획을 파일로 저장할까요?`)){ planLoopBusy=false; return; }
    const saved=await RouteDB.saveCollectionPlan(plan);
    const name=`collectionplan_${plan.planDate}_${plan.regionCode||'region'}_${plan.planId}.json`;
    const text=JSON.stringify(plan,null,1);
    let where='';
    if(window.routeAPI&&window.routeAPI.saveTextFile){
      const p=await window.routeAPI.saveTextFile(name,text,'json');
      if(!p){ planLoopBusy=false; renderPlanResults(true); return; }
      where=p;
      if(typeof RouteDB.markPlanExported==='function') await RouteDB.markPlanExported(plan.planId,plan.planVersion,p);
    }else{
      const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
      const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1500);
      where='다운로드 폴더';
      if(typeof RouteDB.markPlanExported==='function') await RouteDB.markPlanExported(plan.planId,plan.planVersion,name+' (브라우저 내려받기)');
    }
    alert(`수집 계획을 저장했어요 (검증 코드 ${saved.code})\n${where}\n\n`+
      `${plan.items.length}구간 · 방문 ${plan.totals.passes}회 · 예상 ${plan.totals.distanceKm}km (이동 ${plan.totals.travelKm}km)\n\n`+
      '이 파일을 카카오톡·Google Drive 등으로 nav-app 휴대폰에 보내고, nav-app 에서 파일을 열면\n'+
      '"추천 수집 주행"으로 TMAP 경로를 만들고 필수 구간 통과를 검증한 뒤 확정합니다.\n'+
      '(전달 여부는 기록이 남지 않아요 — nav-app 주행 결과가 들어오면 "전달 확인"으로 바뀝니다)');
    renderPlanResults(true);
  }catch(err){
    alert('수집 계획을 만들지 못했어요 — '+((err&&err.message)||err));
  }finally{ planLoopBusy=false; }
}

/** nav-app 주행 결과 파일 직접 불러오기 (Drive 자동 가져오기를 안 쓸 때 · 브라우저 모드) */
async function importDriveResultFiles(input){
  const files=[...(input.files||[])];
  input.value='';
  let ok=0,dup=0; const bad=[];
  for(const f of files){
    try{
      const text=await f.text();
      const kind=CollectionLoop.detectDocument(text);
      if(kind==='plan'){ await RouteDB.saveCollectionPlan(JSON.parse(text)); ok++; continue; }
      if(kind==='routecheck'){ await RouteDB.saveRouteCheck(text); ok++; continue; }   // nav-app TMAP 탐색 결과 — 다음 계획의 방향 판단
      const r=await RouteDB.saveDriveResult(text,{source:'manual',fileName:f.name});
      if(r.status==='duplicate') dup++; else ok++;
    }catch(err){
      bad.push(`${f.name}: ${(err&&err.message)||err}`);
      let planId=''; try{ const d=JSON.parse(await f.text()); planId=d&&d.plan&&d.plan.planId?String(d.plan.planId):''; }catch(_){ /* 읽지 못함 */ }
      try{ if(typeof RouteDB.recordLinkImportFailure==='function') await RouteDB.recordLinkImportFailure({ fileName:f.name, planId, reason:String((err&&err.message)||err), kind:'manual' }); }catch(_){ /* 표시만 */ }
    }
  }
  alert(`주행 결과 ${ok}개 반영 · 이미 있음 ${dup}개${bad.length?`\n받지 않음:\n${bad.join('\n')}`:''}\n\n`+
    '수행 여부는 결과 파일이 아니라 주행기록 엑셀(GPS 원본)로 계산합니다 — 엑셀이 아직 없으면 "GPS 미검증"으로 보입니다.');
  renderPlanResults(true);
}

const STATUS_LABEL={ achieved:'목표 달성', passed:'지나감(목표 미달)', wrong_direction:'방향 반대', partial:'일부만', not_driven:'주행 안 함', unverified:'GPS 미검증' };
const STEP_ICON={ done:'✅', wait:'⏳', unknown:'❔', fail:'⚠️' };

/** 추천 계획 수행 결과 — 계획별 상태 · 결과 · 계획 대비 · 전후 변화 · 다음 주행 */
async function renderPlanResults(force){
  const el=document.getElementById('rec-plan-results');
  if(!el||typeof RouteDB==='undefined'||!RouteDB.backend||typeof RouteDB.listDriveResults!=='function') return;
  if(force||!planLoopState.results||Date.now()-planLoopState.loadedAt>15000){
    try{
      planLoopState.results=await RouteDB.listDriveResults({limit:20});
      planLoopState.plans=await RouteDB.listCollectionPlans(20);
      planLoopState.statuses=typeof RouteDB.listPlanStatuses==='function'?await RouteDB.listPlanStatuses(10):null;
      planLoopState.error=null;
    }catch(err){ planLoopState.error=String((err&&err.message)||err); planLoopState.results=[]; planLoopState.plans=[]; planLoopState.statuses=null; }
    planLoopState.loadedAt=Date.now();
  }
  const results=planLoopState.results||[], plans=planLoopState.plans||[], st=planLoopState.statuses;
  const currentRecs=(typeof autoRecResult!=='undefined'&&autoRecResult)?(autoRecResult.allRecommendations||autoRecResult.recommendations||[]):null;
  const browserMode=!(window.routeAPI&&window.routeAPI.saveTextFile);
  const statusHtml=st&&st.plans.length?`<details class="rec-llm" open><summary>계획별 상태</summary><table class="rec-table"><tr><th>계획</th><th>상태</th><th>단계</th></tr>
    ${st.plans.map(p=>`<tr><td class="mono">${planEsc(p.planId)} v${planEsc(p.planVersion)}</td><td><b>${planEsc(p.label)}</b></td>
      <td>${p.steps.map(s=>`<span title="${planEsc(s.detail)}">${STEP_ICON[s.state]||''} ${planEsc(s.label)}</span>`).join(' · ')}
      ${p.failures.length?`<div class="rec-muted">가져오기 실패: ${p.failures.map(f=>planEsc(f.fileName+' — '+f.reason)).join(' / ')}</div>`:''}</td></tr>`).join('')}</table>
    ${st.unlinkedFailures.length?`<div class="rec-muted">어느 계획 것인지 알 수 없는 실패 파일 ${st.unlinkedFailures.length}개: ${st.unlinkedFailures.slice(0,3).map(f=>planEsc(f.fileName+' — '+f.reason)).join(' / ')}</div>`:''}
    <div class="rec-muted">❔ 전달은 파일로만 오가 기록이 남지 않아요 — nav-app 주행 결과가 이 계획을 가리키면 ✅ 로 바뀝니다. 동기화(폴더 접근) 문제는 자동 가져오기 상태에, 파일 문제는 여기에 따로 보여요.</div></details>`:'';
  const blocks=[];
  for(const r of results.slice(0,5)){
    const ev=r.evaluation||{};
    const plan=r.planId?await RouteDB.getCollectionPlan(r.planId,r.planVersion||undefined):null;
    const rows=(ev.items||[]).map(it=>`<tr>
        <td>${planEsc(it.order)}</td><td>${planEsc(it.title)}</td><td><b>${planEsc(STATUS_LABEL[it.status]||it.status)}</b></td>
        <td class="mono">${it.routeFollowed?`${it.routeFollowed.completed}/${it.routeFollowed.visits}`:'—'}</td>
        <td class="mono">${it.coverageRight}%${it.directionOk===false?' (반대)':''}</td>
        <td class="mono">${it.passCount}/${it.plannedPasses}회${it.partialTraversals?` (일부 ${it.partialTraversals})`:''}</td>
        <td class="mono">${it.inWindowMinutes!=null?`시간대 ${it.inWindowMinutes}분`:`${it.collectedMinutes}분`} / 부족 ${it.needMinutes}분</td>
        <td>${planEsc((it.reasons||[]).join(' · '))}</td></tr>`).join('');
    let changeHtml='';
    if(plan&&currentRecs&&ev.gpsStatus==='verified'){
      const changes=CollectionLoop.compareRecommendations(plan,currentRecs,ev);
      try{ await RouteDB.saveRecommendationChanges(plan.planId,changes,[r.sessionId]); }catch(_){ /* 표시만 */ }
      changeHtml=`<details class="rec-llm"><summary>추천 전후 변화 (새 기록으로 다시 계산)</summary><table class="rec-table"><tr><th>구간</th><th>점수</th><th>부족분</th><th>변화</th></tr>
        ${changes.map(c=>`<tr><td>${planEsc(c.title)}</td><td class="mono">${c.beforeScore} → ${c.afterScore==null?'—':c.afterScore}</td>
          <td class="mono">${c.beforeNeedMinutes}분 → ${c.afterNeedMinutes==null?(c.status==='resolved'?'0분':'알 수 없음'):c.afterNeedMinutes+'분'}${c.needReducedMinutes?` (−${c.needReducedMinutes})`:''}</td><td>${planEsc(c.reason)}</td></tr>`).join('')}</table></details>`;
    }
    const remaining=(ev.items||[]).filter(it=>it.status!=='achieved');
    blocks.push(`<div class="rec-card">
      <div><b>${planEsc(r.driveDate)} · ${planEsc(r.vehicle)}</b> <span class="rec-muted">결과 ${planEsc(r.resultId)} · 세션 ${planEsc(r.sessionId)} · ${planEsc(r.endReason||'')}</span></div>
      <div>${planEsc(ev.gpsStatusLabel||'')}${ev.gps?` · GPS ${ev.gps.records||0}건(유효 ${ev.gps.usableRecords!=null?ev.gps.usableRecords:'-'}) · 공백 ${ev.gps.gaps||0} · 점프 ${ev.gps.jumps||0} · 수집 ${ev.gps.collectionMinutes!=null?ev.gps.collectionMinutes:'-'}분`:''}</div>
      ${ev.roadIndex&&ev.roadIndex!=='plan_neighbors'?`<div class="rec-muted">⚠️ ${planEsc(ev.roadIndexNote||'')}</div>`:''}
      ${ev.planMissing?'<div class="rec-muted">이 결과의 계획 파일이 Route Viewer 에 없어 계획 대비 비교를 못 해요(계획을 이 PC 에서 보냈는지 확인).</div>':''}
      ${ev.totals?`<div>계획 ${ev.totals.items}구간 · 목표 달성 ${ev.totals.achieved} · 지나감 ${ev.totals.passed} · 방향 반대 ${ev.totals.wrong_direction} · 일부 ${ev.totals.partial} · 안 함 ${ev.totals.not_driven} · 달성률 ${ev.totals.achieveRate}%</div>`:''}
      ${rows?`<table class="rec-table"><tr><th>#</th><th>구간</th><th>GPS 판정</th><th title="nav-app 보고 — 판정에 쓰지 않음">경로 따라감(보고)</th><th>권장 방향 Coverage</th><th>통과(한 번에 80%↑)</th><th>수집</th><th>이유</th></tr>${rows}</table>`:''}
      ${changeHtml}
      ${remaining.length&&ev.gpsStatus==='verified'?`<div class="rec-muted">다음 주행: 아직 부족한 ${remaining.length}구간은 위 오늘 추천에서 다시 계산된 순위로 나옵니다.</div>`:''}
    </div>`);
  }
  el.innerHTML=`<div class="rec-today-head"><div class="rec-today-title">추천 계획 수행 결과</div>
      <span class="rec-muted">보낸 계획 ${plans.length}개 · 받은 결과 ${results.length}개</span></div>
    ${planLoopState.error?`<div class="rec-muted">${planEsc(planLoopState.error)}</div>`:''}
    ${browserMode?'<div class="rec-muted">브라우저 모드: 옆 도로 정보가 없는 예전 계획은 계획 구간만으로 판정해 데스크톱(지역 도로망)과 다를 수 있어요 — 결과마다 판정 근거를 표시합니다.</div>':''}
    ${statusHtml}
    ${blocks.length?blocks.join(''):'<div class="rec-muted">아직 받은 주행 결과가 없어요. nav-app 이 주행을 마치면 결과 파일(driveresult_*.json)이 주행기록 엑셀과 함께 Google Drive 폴더에 올라오고, 자동 가져오기가 켜져 있으면 여기 나타납니다.</div>'}
    <div class="rec-today-actions">
      <label class="btn ghost" style="cursor:pointer">결과 파일 불러오기<input type="file" accept=".json,application/json" multiple style="display:none" onchange="importDriveResultFiles(this)"/></label>
      <button class="btn ghost" type="button" onclick="renderPlanResults(true)">새로고침</button>
      <span class="rec-muted">판정은 결과 파일의 보고값이 아니라 GPS 원본(주행기록)으로 다시 계산합니다 · "경로 따라감(보고)"과 "목표 달성"은 다릅니다</span>
    </div>`;
}
