// ══════════════════════════════════════════════════════════
//  backup — 백업 저장 / 백업 복구
//
//  백업에 들어가는 것 (요구사항 12번):
//    · 주행 기록   data{날짜:[포인트…]}
//    · 구역 경계   zonePolygons
//    · 차량 정보   각 포인트의 vehicle 필드
//    · Import 정보 imports[]
//
//  복구는 두 가지 중에서 사용자가 고른다:
//    · 병합 복구      기존 데이터에 백업 내용을 "추가"한다 (중복은 자동 제외)
//    · 전체 교체 복구  기존 데이터를 지우고 백업 내용으로 갈아끼운다
//
//  기본값은 병합이다. 실수로 데이터를 잃는 쪽이 기본이 되면 안 된다.
// ══════════════════════════════════════════════════════════

function formatBackupTime(iso){
  if(!iso) return '알 수 없음';
  const d=new Date(iso);
  if(isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('ko-KR',{
    year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',
    hour12:false,
  });
}

async function recordBackupHistory(kind,iso,detail){
  const entry={kind,at:iso||new Date().toISOString(),detail:detail||''};
  const current=await RouteDB.getBackupHistory();
  await RouteDB.setBackupHistory(dedupeBackupHistory([entry,...current]));
  await updateBackupStatus();
}

async function updateBackupStatus(){
  const el=document.getElementById('backup-status');
  if(!el) return;
  let history=[];
  try{ history=await RouteDB.getBackupHistory()||[]; }catch(_){ history=[]; }
  if(!history.length){
    el.textContent='백업 기록: 없음';
    el.title='아직 백업 저장/복구 기록이 없어요';
    return;
  }
  const latest=history[0];
  el.textContent=`백업 기록: ${formatBackupTime(latest.at)}`;
  el.title=history.map(h=>`${formatBackupTime(h.at)} · ${h.kind}${h.detail?' · '+h.detail:''}`).join('\n');
}

// ── 백업 저장 ─────────────────────────────────────────
async function exportBackup(){
  const stats=await RouteDB.stats();
  if(!stats.points){
    openModal({
      title:'백업할 데이터가 없어요',
      icon:'!',
      body:'<div class="modal-msg">먼저 "파일 불러오기"에서 주행 기록을 불러와주세요.</div>',
      buttons:[{label:'확인',primary:true,onClick:closeModal}],
    });
    return;
  }

  let backup;
  try{
    backup=await RouteDB.buildBackupPayload();
  }catch(err){
    showError('백업을 만들지 못했어요. ('+err.message+')');
    return;
  }

  await recordBackupHistory('백업 저장',backup.exportedAt,`${backup.dateCount}일 기록`);
  backup.backupHistory=await RouteDB.getBackupHistory();

  const json=JSON.stringify(backup);
  const filename=`route-viewer-backup_${dstr(new Date())}.json`;

  if(window.routeAPI&&window.routeAPI.isDesktop){
    try{
      const saved=await window.routeAPI.saveBackupFile(filename,json);
      if(saved){
        openModal({
          title:'백업 저장 완료',
          icon:'✓',
          body:`<table class="ir-table">
              <tr><td class="ir-k">날짜</td><td class="ir-v mono">${fmtNum(backup.dateCount)}일</td></tr>
              <tr><td class="ir-k">GPS 포인트</td><td class="ir-v mono">${fmtNum(stats.points)}</td></tr>
              <tr><td class="ir-k">구역 경계</td><td class="ir-v mono">${Object.keys(backup.zonePolygons||{}).length}개</td></tr>
              <tr><td class="ir-k">Import 이력</td><td class="ir-v mono">${fmtNum((backup.imports||[]).length)}건</td></tr>
            </table>
            <div class="ir-note">${escapeHtml(saved)}</div>`,
          buttons:[{label:'확인',primary:true,onClick:closeModal}],
        });
      }
    }catch(err){
      showError('백업 파일을 저장하지 못했어요. ('+err.message+')');
    }
    return;
  }

  // 브라우저: 다운로드로 저장
  const blob=new Blob([json],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// ── 백업 복구 ─────────────────────────────────────────
async function startBackupRestore(){
  clearError();
  if(window.routeAPI&&window.routeAPI.isDesktop){
    let picked=null;
    try{ picked=await window.routeAPI.pickBackupFile(); }
    catch(err){ showError('백업 파일을 열지 못했어요. ('+err.message+')'); return; }
    if(!picked) return;
    handleBackupText(picked.text,picked.name);
    return;
  }
  document.getElementById('backup-input').click();
}

function handleBackupImport(evt){
  const file=evt.target.files&&evt.target.files[0];
  if(!file) return;
  clearError();
  const reader=new FileReader();
  reader.onload=e=>handleBackupText(e.target.result,file.name);
  reader.onerror=()=>showError('백업 파일을 읽지 못했어요.');
  reader.readAsText(file);
  evt.target.value='';
}

// 파일을 읽었으면 복구 방식을 먼저 물어본다 — 말없이 덮어쓰지 않는다
async function handleBackupText(text,filename){
  let parsed;
  try{
    parsed=JSON.parse(text);
    if(!parsed||parsed.type!=='route-viewer-backup'||!parsed.data||typeof parsed.data!=='object'){
      throw new Error('route-viewer 백업 형식이 아니에요');
    }
  }catch(err){
    console.warn('[경로뷰어] 백업 복구 실패:',err);
    showError('백업 파일을 읽지 못했어요. "백업 저장"으로 받은 .json 파일인지, 파일이 손상되지 않았는지 확인해주세요.');
    return;
  }

  const dates=Object.keys(parsed.data).sort();
  const pointCount=Object.values(parsed.data).reduce((a,v)=>a+(Array.isArray(v)?v.length:0),0);
  const current=await RouteDB.stats();

  openModal({
    title:'백업 복구 방식 선택',
    icon:'⟲',
    body:`
      <table class="ir-table">
        <tr><td class="ir-k">백업 파일</td><td class="ir-v mono">${escapeHtml(filename||'')}</td></tr>
        <tr><td class="ir-k">만든 시각</td><td class="ir-v mono">${escapeHtml(formatBackupTime(parsed.exportedAt))}</td></tr>
        <tr><td class="ir-k">백업 안의 날짜</td><td class="ir-v mono">${fmtNum(dates.length)}일</td></tr>
        <tr><td class="ir-k">백업 안의 포인트</td><td class="ir-v mono">${fmtNum(pointCount)}</td></tr>
        <tr><td class="ir-k">지금 저장된 데이터</td><td class="ir-v mono">${fmtNum(current.days)}일 · ${fmtNum(current.points)} 포인트</td></tr>
      </table>
      <div class="restore-modes">
        <label class="restore-mode">
          <input type="radio" name="restore-mode" value="merge" checked/>
          <div>
            <div class="rm-title">병합 복구 <span class="rm-tag">권장</span></div>
            <div class="rm-desc">지금 저장된 기록은 그대로 두고 백업 내용을 <b>추가</b>합니다. 겹치는 기록은 자동으로 걸러집니다.</div>
          </div>
        </label>
        <label class="restore-mode danger">
          <input type="radio" name="restore-mode" value="replace"/>
          <div>
            <div class="rm-title">전체 교체 복구</div>
            <div class="rm-desc">지금 저장된 주행 기록을 <b>모두 지우고</b> 백업 내용으로 바꿉니다. 되돌릴 수 없습니다.</div>
          </div>
        </label>
      </div>`,
    wide:true,
    buttons:[
      {label:'취소',onClick:closeModal},
      {label:'복구 시작',primary:true,onClick:()=>{
        const sel=document.querySelector('input[name="restore-mode"]:checked');
        const mode=sel?sel.value:'merge';
        closeModal();
        runBackupRestore(parsed,mode,filename);
      }},
    ],
  });
}

async function runBackupRestore(parsed,mode,filename){
  if(mode==='replace'){
    const ok=await confirmDialog({
      title:'전체 교체 복구',
      message:'지금 저장된 모든 주행 기록을 지우고 백업 내용으로 바꿀까요?',
      detail:'이 작업은 되돌릴 수 없습니다.',
      confirmLabel:'전체 교체',
      danger:true,
    });
    if(!ok) return;
  }

  setImportBusy(true,'백업 복구 중…');
  let result;
  try{
    result=await RouteDB.restoreBackupPayload(parsed,mode);
  }catch(err){
    setImportBusy(false);
    console.warn('[경로뷰어] 백업 복구 실패:',err);
    showError('백업을 복구하지 못했어요. ('+err.message+')');
    return;
  }finally{
    setImportBusy(false);
  }

  await recordBackupHistory(
    mode==='replace'?'백업 복구(전체 교체)':'백업 복구(병합)',
    new Date().toISOString(),
    `${result.inserted}건 추가`
  );

  await loadZonePolygonsFromDb();
  await refreshZoneCache(); // 백업에 들어있던 지역 설정(색·활성 여부)도 화면에 반영
  await refreshDateIndex();
  const stats=await RouteDB.stats();

  openModal({
    title:'백업 복구 완료',
    icon:'✓',
    body:`
      <table class="ir-table">
        <tr><td class="ir-k">파일</td><td class="ir-v mono">${escapeHtml(filename||'')}</td></tr>
        <tr><td class="ir-k">복구 방식</td><td class="ir-v mono">${mode==='replace'?'전체 교체':'병합'}</td></tr>
        <tr><td class="ir-k">읽은 기록</td><td class="ir-v mono">${fmtNum(result.total)}</td></tr>
        <tr><td class="ir-k">새로 추가</td><td class="ir-v mono"><b style="color:var(--green)">${fmtNum(result.inserted)}</b></td></tr>
        <tr><td class="ir-k">중복 제외</td><td class="ir-v mono">${fmtNum(result.duplicates)}</td></tr>
        <tr><td class="ir-k">전체 저장 날짜</td><td class="ir-v mono">${fmtNum(stats.days)}일</td></tr>
        <tr><td class="ir-k">전체 GPS 포인트</td><td class="ir-v mono">${fmtNum(stats.points)}</td></tr>
      </table>`,
    buttons:[{label:'달력에서 보기',primary:true,onClick:()=>{closeModal();showCalendar();}}],
  });
}
