// ══════════════════════════════════════════════════════════
//  kpi-history — Career Log 의 "지금 상태 측정" · KPI Snapshot 저장 · 자동 기록
//
//  측정은 새로 집계하지 않고 이미 있는 계산을 부른다.
//    · 규모·조건별 수집량 : RouteDB.listDateSummaries() → CareerMetrics(ConditionStats·CollectionStats)
//    · ①~⑫ 구역 수집량   : RouteDB.getSubZoneStats() (HD Map 우선 수집 현황판과 같은 집계)
//    · Coverage Depth     : 누적 지도의 computeZoneCoverageCells() — 같은 도로 칸·수동 셀·방문 횟수
//    · 부족 조건          : Recommendation.buildRecommendations() (추천 탭과 같은 입력)
//
//  외부 요청을 하지 않는다. Coverage 는 이 PC 에 도로·건물 판정 데이터가 이미 있을 때만 계산한다
//  (없으면 "누적 지도에서 커버리지 갭을 한 번 열어 주세요"라고만 적는다 — 여기서 받아오지 않는다).
//
//  자동 기록은 이 PC 에서 Career Log 를 한 번이라도 연 경우에만 켜진다(localStorage 표시).
//  Career Log 를 모르는 팀원 PC 에서는 아무 계산도, 저장도 하지 않는다.
// ══════════════════════════════════════════════════════════
const KpiHistory=(function(){
  const AUTO_LS_KEY='rv.careerLog.autoSnapshot';
  const AUTO_DAILY_DELAY_MS=20000;          // 앱을 켠 직후 화면을 그리는 동안은 기다린다
  const AUTO_DAILY_INTERVAL_MS=60*60*1000;  // 앱을 켜둔 채 날짜가 바뀌어도 하루 한 번
  const AUTO_IMPORT_DEBOUNCE_MS=15000;      // 파일 여러 개를 연달아 넣으면 마지막 뒤 한 번만
  let inFlight=null;
  let importTimer=null;

  const CM=()=>window.CareerMetrics;
  const today=()=>Recommendation.kstDate();

  function autoEnabled(){
    try{ return localStorage.getItem(AUTO_LS_KEY)==='1'; }catch(_){ return false; }
  }
  function setAutoEnabled(on){
    try{ localStorage.setItem(AUTO_LS_KEY,on?'1':'0'); }catch(_){ /* 무시 */ }
  }
  // 처음 열 때만 켠다 — 사용자가 끈 뒤에는 다시 켜지 않는다
  function enableOnFirstUnlock(){
    try{ if(localStorage.getItem(AUTO_LS_KEY)==null) localStorage.setItem(AUTO_LS_KEY,'1'); }catch(_){ /* 무시 */ }
  }

  async function loadStore(){
    const [kpiSnapshots,collectionPlans,contributions,workTimes]=await Promise.all(
      CM().CAREER_KIND_IDS.map(kind=>RouteDB.listCareerItems(kind))
    );
    return {kpiSnapshots,collectionPlans,contributions,workTimes};
  }

  // ── Coverage Depth ────────────────────────────────────
  // 도로·건물 판정 데이터가 이 PC 에 이미 있는가(있으면 누적 지도 계산이 네트워크 없이 끝난다)
  function zoneMapDataLocal(zone){
    const poly=(typeof ZONE_POLYGONS!=='undefined')&&ZONE_POLYGONS[zone];
    if(!poly||poly.length<3) return {ok:false,reason:'운영 구역 경계가 없어 Coverage 를 계산할 수 없어요.'};
    const key=bboxKeyFor(poly);
    const roadsLocal=hdmapGlobalNamesFor(zone).length
      ? loadHdmapRoads(zone).length>0
      : ((loadZoneRoadsCache()[zone]||{}).bboxKey===key);
    const buildings=loadZoneBuildingsCache()[zone];
    if(roadsLocal&&buildings&&buildings.bboxKey===key) return {ok:true};
    return {ok:false,reason:'이 PC에 도로·건물 판정 데이터가 아직 없어요 — [누적 지도 → 커버리지 갭 보기]를 한 번 열면 받아 두고, 그다음부터 여기서도 계산돼요(Career Log 는 외부 요청을 하지 않아요).'};
  }

  async function measureCoverageDepth(areas){
    const byScope={}, notes={};
    if(typeof computeZoneCoverageCells!=='function'){
      notes['*']='누적 지도 모듈을 불러오지 못해 Coverage 를 계산하지 않았어요.';
      return {byScope,notes};
    }
    const zones=(typeof ACTIVE_ZONE_NAMES!=='undefined'?ACTIVE_ZONE_NAMES:[]).slice();
    for(const zone of zones){
      const local=zoneMapDataLocal(zone);
      if(!local.ok){ notes[zone]=local.reason; continue; }
      let res=null;
      try{
        res=await computeZoneCoverageCells(zone,{visitFilter:{issueFilter:CM().CAREER_ISSUE_FILTER}});
      }catch(err){
        notes[zone]='Coverage 계산 실패: '+((err&&err.message)||err);
        continue;
      }
      if(!res){ notes[zone]='운영 구역 경계가 없어 Coverage 를 계산할 수 없어요.'; continue; }
      const valid=res.cells.filter(c=>c.state==='valid');
      byScope[zone]={...CM().depthFromVisits(valid.map(c=>c.visits)),provisional:!res.cacheable};
      // ①~⑫ 는 상위 구역과 같은 칸·같은 방문 횟수를 구역 경계로 잘라서 센다(칸 중심이 경계 안이면 그 구역)
      const {latDeg,lngDeg}=res.grid;
      (areas||[]).filter(a=>a.hasPolygon&&a.parentZone===zone).forEach(a=>{
        const inside=valid.filter(c=>pointInPolygon((c.la+0.5)*latDeg,(c.lo+0.5)*lngDeg,a.polygon));
        byScope[String(a.areaNo)]={...CM().depthFromVisits(inside.map(c=>c.visits)),provisional:!res.cacheable};
      });
    }
    (areas||[]).forEach(a=>{
      const scope=String(a.areaNo);
      if(byScope[scope]) return;
      notes[scope]=!a.hasPolygon?'구역 경계(polygon)가 없어요.':(notes[a.parentZone]||`상위 구역(${a.parentZone})이 비활성이거나 경계가 없어요.`);
    });
    return {byScope,notes};
  }

  // ── 지금 상태 측정 ────────────────────────────────────
  async function measure(){
    const C=CM();
    const [summaries,stats,vehicles,zones,settings,coverageSnapshots,plans,savedPolygons]=await Promise.all([
      RouteDB.listDateSummaries(),RouteDB.stats(),RouteDB.listVehicles(),RouteDB.listZones(),RouteDB.getSettings(),
      RouteDB.listCoverageSnapshots(),RouteDB.listCareerItems('collectionPlans'),RouteDB.getHDMapPriorityPolygons(),
    ]);
    const date=today();
    const areas=HDMapPriority.listAreas(null,savedPolygons||{});
    const plan=C.activePlanFor(plans,date);
    const recSettings=Recommendation.effectiveRecommendationSettings((settings||{}).recommendationSettings);

    // 부족 조건 — 추천 탭과 같은 입력, 같은 데이터 기준
    const rec=Recommendation.buildRecommendations({
      summaries,zones,settings,coverageSnapshots,issueFilter:C.CAREER_ISSUE_FILTER,
    });
    const recDeficits=C.recommendationDeficitCounts(rec);

    // 구역별 측정값
    const measurements={};
    const activeZones=(zones||[]).filter(z=>z&&z.active!==false).map(z=>z.name);
    activeZones.forEach(z=>{ measurements[z]=C.measureZoneFromSummaries(summaries,z,C.CAREER_ISSUE_FILTER); });
    const inputs=HDMapPriority.toSubZoneInputs(areas);
    if(inputs.length){
      const areaStats=await RouteDB.getSubZoneStats(inputs,{filter:{issueFilter:C.CAREER_ISSUE_FILTER}});
      const byId=new Map((areaStats||[]).map(s=>[String(s.id),s]));
      areas.filter(a=>a.hasPolygon).forEach(a=>{
        measurements[String(a.areaNo)]=C.measureAreaFromSubZoneStat(a.areaNo,byId.get(String(a.id)));
      });
    }
    const depth=await measureCoverageDepth(areas);
    Object.keys(measurements).forEach(scope=>{
      const m=measurements[scope];
      if(depth.byScope[scope]) m.depth=depth.byScope[scope];
      else m.notes.depth=depth.notes[scope]||depth.notes['*']||'Coverage 가 계산되지 않았어요.';
    });

    const depthScopes=(plan&&plan.priorityZones&&plan.priorityZones.length)
      ? plan.priorityZones.map(String)
      : HDMapPriority.PRIORITY_AREA_NOS.map(String);
    const combined=C.combineDepth(depthScopes.map(s=>depth.byScope[s]));
    const scale=C.buildProjectScale({
      summaries,stats,vehicles,zones,areas,plan,
      targetCount:plan?C.expandPlanTargets(plan).length:undefined,
      analysisUnitCount:rec.analysisUnitCount,today:date,
    });
    const fulfillment=plan?C.evaluatePlan(plan,measurements):null;
    return {
      date,measuredAt:new Date().toISOString(),plan,plans,scale,monthScale:C.buildMonthScale(summaries,date),
      measurements,depth,depthScopes,combined,
      fulfillment,rec,recDeficits,recSettings,areas,zones,activeZones,
    };
  }

  // 오늘 날짜 Snapshot 을 새로 쓰거나(없으면) 최신 값으로 갱신한다
  async function recordSnapshot(source,measured){
    const m=measured||await measure();
    const existing=(await RouteDB.listCareerItems('kpiSnapshots')).find(s=>s.id===m.date)||null;
    const snap=CM().buildKpiSnapshot({
      date:m.date,plan:m.plan,scale:m.scale.raw,depth:m.combined,depthByScope:m.depth.byScope,depthScopes:m.depthScopes,
      fulfillment:m.fulfillment&&m.fulfillment.summary,recDeficits:m.recDeficits,source,previous:existing,
    });
    return RouteDB.saveCareerItem('kpiSnapshots',snap);
  }

  // 자동 기록 — 실패해도 사용자 화면에는 아무것도 띄우지 않는다(개인 기능이라 조용히)
  function runAuto(source){
    if(inFlight||!autoEnabled()||!RouteDB.backend) return inFlight;
    inFlight=(async()=>{
      try{
        const m=await measure();
        if(!m.scale.raw.recordCount) return null;   // 기록이 없으면 남길 것도 없다
        return await recordSnapshot(source,m);
      }catch(err){
        console.warn('[경로뷰어] Career Log 자동 기록 실패:',err);
        return null;
      }finally{ inFlight=null; }
    })();
    return inFlight;
  }

  async function checkDaily(){
    if(!autoEnabled()||!RouteDB.backend) return;
    try{
      const snaps=await RouteDB.listCareerItems('kpiSnapshots');
      if(snaps.some(s=>s.date===today())) return;
    }catch(_){ return; }
    runAuto('auto-daily');
  }

  function onRouteChange(evt){
    if(!evt||evt.method!=='importRecords'||!autoEnabled()) return;
    if(importTimer) clearTimeout(importTimer);
    importTimer=setTimeout(()=>{ importTimer=null; runAuto('auto-import'); },AUTO_IMPORT_DEBOUNCE_MS);
  }

  if(typeof RouteDB!=='undefined'&&RouteDB&&typeof RouteDB.onChange==='function') RouteDB.onChange(onRouteChange);
  setTimeout(checkDaily,AUTO_DAILY_DELAY_MS);
  setInterval(checkDaily,AUTO_DAILY_INTERVAL_MS);

  return {autoEnabled,setAutoEnabled,enableOnFirstUnlock,loadStore,measure,recordSnapshot,measureCoverageDepth,zoneMapDataLocal,today,
    get busy(){ return !!inFlight; }};
})();
