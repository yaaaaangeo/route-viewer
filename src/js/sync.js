// ══════════════════════════════════════════════════════════
//  sync — 서버 동기화 (데스크톱 전용)
//
//  한 사람이 `node server.js` 로 서버를 하나 띄워두면, 그 주소를
//  아는 모든 데스크톱 앱이 "지금 동기화"를 눌러 서로의 기록을
//  합쳐서 볼 수 있다.
//
//    1) 서버에 있는 기록을 받아서 내 DB에 merge
//    2) 방금 병합된 내 DB 전체를 서버로 올림 — 서버도 merge 해서 저장
//
//  둘 다 "추가"만 하므로(교체 아님) 여러 명이 아무 때나 눌러도,
//  순서가 엇갈려도 기록이 지워지거나 두 배로 부풀지 않는다.
//
//  같은 주소는 앱 자동 업데이트 배포 주소로도 함께 쓰인다
//  (server.js가 release/ 폴더를 <주소>/updates 로 내려준다).
// ══════════════════════════════════════════════════════════

function isDesktop(){ return !!(window.routeAPI&&window.routeAPI.isDesktop); }

async function renderSyncPanel(){
  const el=document.getElementById('sync-panel');
  if(!el) return;
  if(!isDesktop()){
    // 브라우저 모드는 이미 server.js API로 직접 연결돼 있어서(공유 저장)
    // 이 패널은 데스크톱 앱에서만 보여준다.
    el.style.display='none';
    return;
  }
  el.style.display='flex';

  let cfg={};
  try{ cfg=await window.routeAPI.syncGetConfig()||{}; }catch(_){ cfg={}; }

  document.getElementById('sync-url-input').value=cfg.serverUrl||'';
  document.getElementById('sync-token-input').value=cfg.token||'';
  document.getElementById('sync-auto-checkbox').checked=!!cfg.autoSyncOnStart;
  updateSyncLastText(cfg.lastSyncAt);
}

function updateSyncLastText(iso){
  const el=document.getElementById('sync-last');
  if(!el) return;
  el.textContent=iso?`마지막 동기화: ${formatBackupTime(iso)}`:'아직 동기화한 적 없어요';
}

// 폼이 화면에 그려져 있을 때만 저장한다 — 자동(시작 시) 동기화처럼
// 패널을 아직 열지 않은 상태에서 불릴 수도 있어서, 그때는 DB에 저장된
// 이전 설정을 그대로 쓰고 건너뛴다.
async function saveSyncConfigFromForm(){
  const urlEl=document.getElementById('sync-url-input');
  if(!urlEl) return null;
  const serverUrl=urlEl.value.trim();
  const token=document.getElementById('sync-token-input').value.trim();
  const autoSyncOnStart=document.getElementById('sync-auto-checkbox').checked;
  try{
    const cfg=await window.routeAPI.syncSetConfig({serverUrl,token,autoSyncOnStart});
    updateSyncLastText(cfg.lastSyncAt);
    return cfg;
  }catch(err){
    showError('동기화 설정을 저장하지 못했어요. ('+err.message+')');
    return null;
  }
}

let syncRunning=false;

async function runServerSync(silent){
  if(!isDesktop()||syncRunning) return;
  syncRunning=true;
  const btn=document.getElementById('sync-run-btn');
  if(btn){ btn.disabled=true; btn.textContent='동기화 중…'; }
  try{
    await saveSyncConfigFromForm();
    const res=await window.routeAPI.syncRun();
    // 동기화는 RouteDB를 거치지 않고(메인 프로세스가 직접 병합) 기록·구역 경계·
    // 수동 셀까지 바꿀 수 있다 — 누적 지도 Coverage 캐시를 무효화하고 구역을 다시 읽는다.
    RouteDB.notifyChange('sync',[]);
    await loadZonePolygonsFromDb();
    await refreshZoneCache();
    await refreshDateIndex();
    updateSyncLastText(res.syncedAt);

    const pulledIn=res.pulled&&res.pulled.inserted||0;
    const pulledDup=res.pulled&&res.pulled.duplicates||0;
    const pushedIn=res.pushedInserted||0;
    const pushedDup=res.pushedDuplicates||0;

    if(!silent){
      openModal({
        title:'서버 동기화 완료',
        icon:'⇄',
        body:`
          <table class="ir-table">
            <tr><td class="ir-k">서버에서 받음</td><td class="ir-v mono">+${fmtNum(pulledIn)} <span style="color:var(--text-faint);">(중복 ${fmtNum(pulledDup)})</span></td></tr>
            <tr><td class="ir-k">서버로 올림</td><td class="ir-v mono">+${fmtNum(pushedIn)} <span style="color:var(--text-faint);">(중복 ${fmtNum(pushedDup)})</span></td></tr>
            <tr><td class="ir-k">전체 저장 날짜</td><td class="ir-v mono">${fmtNum(res.stats.days)}일</td></tr>
            <tr><td class="ir-k">전체 GPS 포인트</td><td class="ir-v mono">${fmtNum(res.stats.points)}</td></tr>
          </table>`,
        buttons:[{label:'확인',primary:true,onClick:closeModal}],
      });
    }else if(pulledIn>0){
      showToast(`서버와 동기화했어요 · 새 기록 ${fmtNum(pulledIn)}개 받음`);
    }

    // 동기화로 새 기록이 들어왔을 수 있으니 현재 보고 있는 화면을 다시 그린다
    const activeTab=document.querySelector('.mode-tab.active');
    if(activeTab&&activeTab.id==='tab-calendar') renderCalendarGrid();
    else if(activeTab&&activeTab.id==='tab-accum') renderAccumView();
    else if(activeTab&&activeTab.id==='tab-stats') renderStatsView();
    else if(activeTab&&activeTab.id==='tab-data') renderDataView();
  }catch(err){
    console.warn('[경로뷰어] 동기화 실패:',err);
    if(!silent) showError('동기화하지 못했어요. ('+err.message+')');
  }finally{
    syncRunning=false;
    if(btn){ btn.disabled=false; btn.textContent='지금 동기화'; }
  }
}

async function checkForAppUpdates(){
  if(!isDesktop()) return;
  await saveSyncConfigFromForm();
  try{
    await window.routeAPI.checkForUpdates();
  }catch(err){
    showError('업데이트를 확인하지 못했어요. ('+err.message+')');
  }
}

// 앱을 켤 때 자동 동기화가 켜져 있으면 조용히 한 번 실행
async function maybeAutoSyncOnStart(){
  if(!isDesktop()) return;
  try{
    const cfg=await window.routeAPI.syncGetConfig();
    if(cfg&&cfg.autoSyncOnStart&&cfg.serverUrl) runServerSync(true);
  }catch(_){ /* 설정을 못 읽으면 그냥 넘어간다 */ }
}
