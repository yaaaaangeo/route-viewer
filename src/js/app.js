// ══════════════════════════════════════════════════════════
//  app — 탭 전환 · 시작 절차
//
//  시작할 때 하는 일:
//    1) 저장소 연결 (데스크톱=SQLite / 브라우저=IndexedDB)
//    2) 예전 localStorage 데이터가 있으면 1회 이관
//    3) 구역 경계 · 백업 기록 · 날짜 요약 읽기
//    4) 기록이 있으면 달력, 없으면 파일 불러오기 화면
//
//  ★ 사용자가 예전 엑셀 파일을 매번 다시 넣을 필요가 없다.
//    앱을 껐다 켜도, PC를 재부팅해도 DB에 그대로 남아있다.
// ══════════════════════════════════════════════════════════

function setStorageBadge(text,title){
  const el=document.getElementById('storage-badge');
  if(!el) return;
  el.textContent=text;
  el.title=title||'현재 저장 위치';
  const strong=text.includes('SQLite');
  el.style.color=strong?'var(--teal)':'var(--amber)';
  el.style.borderColor=strong?'rgba(79,216,199,.45)':'rgba(245,166,35,.4)';
  el.style.background=strong?'rgba(79,216,199,.08)':'rgba(245,166,35,.08)';
}

// ══════════════════════════════════════════════════════════
//  모드 탭 — 화면만 바꿔주고, 데이터는 각 화면이 DB에서 읽는다.
// ══════════════════════════════════════════════════════════
function switchTab(tab){
  ['upload','calendar','accum','stats','data','settings'].forEach(t=>{
    const btn=document.getElementById('tab-'+t);
    if(btn) btn.classList.toggle('active',tab===t);
  });
  document.getElementById('console').style.display='none';
  document.getElementById('day-summary').style.display='none';
  document.getElementById('calendar-view').style.display='none';
  document.getElementById('accum-view').style.display='none';
  document.getElementById('stats-view').style.display='none';
  document.getElementById('data-view').style.display='none';
  document.getElementById('settings-view').style.display='none';
  document.getElementById('dropzone').style.display='none';
  clearError();
  if(tab==='calendar'){
    document.getElementById('calendar-view').style.display='flex';
    renderCalendarGrid();
    updateCalStatus();
  }else if(tab==='accum'){
    document.getElementById('accum-view').style.display='flex';
    // 탭을 왔다 갔다 한 것만으로는 Coverage를 다시 계산하지 않는다 —
    // 바뀐 게 없으면 기존 지도/Layer를 그대로 두고 크기만 다시 잰다(accum.js)
    enterAccumView();
  }else if(tab==='stats'){
    document.getElementById('stats-view').style.display='flex';
    renderStatsView();
  }else if(tab==='data'){
    document.getElementById('data-view').style.display='flex';
    renderDataView();
  }else if(tab==='settings'){
    document.getElementById('settings-view').style.display='flex';
    renderSettingsView();
  }else{
    document.getElementById('dropzone').style.display='block';
    updateDropzoneSummary();
  }
}

function updateCalStatus(){
  const el=document.getElementById('cal-status');
  if(!hasAnyData()){
    el.style.display='block';
    el.innerHTML='아직 불러온 기록이 없어요. <b>"파일 불러오기"</b> 탭에서 파일을 선택해주세요.';
  }else{
    el.style.display='none';
  }
}

// 파일 불러오기 화면 아래에 "지금 DB에 뭐가 들어있는지" 한 줄로 보여준다.
// 파일을 넣는 게 교체가 아니라 추가라는 걸 화면에서도 알 수 있게.
async function updateDropzoneSummary(){
  const el=document.getElementById('dz-summary');
  if(!el) return;
  let stats;
  try{ stats=await RouteDB.stats(); }catch(_){ return; }
  if(!stats.points){
    el.style.display='none';
    return;
  }
  const dates=sortedDataDates();
  const range=dates.length>1?`${dates[0]} ~ ${dates[dates.length-1]}`:(dates[0]||'');
  const unknown=dates.filter(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)).length;
  el.style.display='block';
  el.innerHTML=`현재 저장됨 · <b>${fmtNum(stats.days)}일</b> · <b>${fmtNum(stats.points)}</b> GPS 포인트 `+
    `<span class="dz-range mono">${escapeHtml(range)}</span><br/>`+
    `<span class="dz-note">새 파일을 넣으면 기존 기록에 <b>추가</b>됩니다. 지워지지 않아요.`+
    (unknown?` · 날짜를 못 읽은 묶음 ${unknown}건은 [데이터 관리]에서 확인할 수 있어요.`:'')+
    `</span>`;
}

// 파일을 새로 불러온 직후 — 가장 최근 기록이 있는 달로 이동시키고 달력 탭으로
function showCalendar(){
  // '날짜' 열이 없는 파일은 '날짜미상'으로 들어올 수 있어서, 실제 날짜만 골라 이동한다
  const dates=sortedDataDates().filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d));
  if(dates.length){
    const latest=new Date(dates[dates.length-1]+'T00:00:00');
    if(!isNaN(latest.getTime())) calMonth=latest;
  }
  switchTab('calendar');
}

// ══════════════════════════════════════════════════════════
//  시작
// ══════════════════════════════════════════════════════════
async function startRouteViewer(){
  try{
    const kind=await RouteDB.init();
    if(kind==='sqlite'){
      let info=null;
      try{ info=await window.routeAPI.info(); }catch(_){}
      setStorageBadge('SQLite',info?`영구 저장: ${info.dbPath}`:'로컬 SQLite 데이터베이스에 영구 저장');
    }else{
      setStorageBadge('브라우저 DB','이 브라우저의 IndexedDB에 저장 (데스크톱 앱으로 실행하면 SQLite에 저장돼요)');
    }
  }catch(err){
    console.error('[경로뷰어] 저장소 연결 실패:',err);
    setStorageBadge('저장 실패','저장소를 열지 못했어요');
    showError('저장소를 열지 못했어요. ('+err.message+')');
    switchTab('upload');
    return;
  }

  await loadZonePolygonsFromDb();
  await Promise.all([refreshZoneCache(),refreshVehicleCache(),refreshSettingsCache()]);
  await updateBackupStatus();
  await refreshDateIndex();
  updateBoundaryUI();

  if(hasAnyData()) showCalendar();
  else switchTab('upload');

  // 서버 동기화가 켜져 있으면 조용히 한 번 맞춰본다 (실패해도 알림 없음)
  maybeAutoSyncOnStart();
}

// ── 데스크톱 메뉴 연결 ────────────────────────────────
if(window.routeAPI&&window.routeAPI.isDesktop){
  window.routeAPI.onMenu('open-files',()=>{ switchTab('upload'); openRouteFileDialog(); });
  window.routeAPI.onMenu('export-backup',()=>exportBackup());
  window.routeAPI.onMenu('import-backup',()=>startBackupRestore());
  window.routeAPI.onMenu('open-data-manager',()=>switchTab('data'));
}

startRouteViewer();
