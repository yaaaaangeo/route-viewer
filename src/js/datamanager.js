// ══════════════════════════════════════════════════════════
//  datamanager — 데이터 관리 (요구사항 11번)
//
//  데이터 삭제는 오직 이 화면에서만 가능하다.
//  파일을 불러오다가 데이터가 지워지는 일은 없다.
//
//    데이터 관리
//     ├─ 2026-08-23    삭제
//     ├─ 2026-08-24    삭제
//     ├─ 2026-08-25    삭제
//     └─ 전체 데이터 삭제   ← 확인창 필수
// ══════════════════════════════════════════════════════════

async function renderDataView(){
  const statusEl=document.getElementById('data-status');
  const summaryEl=document.getElementById('data-summary');
  const listEl=document.getElementById('data-date-list');
  const importsEl=document.getElementById('data-imports');
  const dangerEl=document.getElementById('data-danger');

  let stats,info=null;
  try{
    stats=await RouteDB.stats();
    if(window.routeAPI&&window.routeAPI.isDesktop) info=await window.routeAPI.info();
  }catch(err){
    showError('데이터 정보를 읽지 못했어요. ('+err.message+')');
    return;
  }

  const where=RouteDB.kind==='sqlite'
    ? `SQLite · ${escapeHtml(stats.dbPath||'')}`
    : `브라우저 IndexedDB · ${escapeHtml(stats.dbPath||'')}`;
  const sizeText=stats.dbBytes?`${(stats.dbBytes/1024/1024).toFixed(1)} MB`:'—';

  summaryEl.style.display='grid';
  summaryEl.innerHTML=`
    <div class="stat-cell"><div class="k">저장된 날짜</div><div class="v">${fmtNum(stats.days)}<small> 일</small></div></div>
    <div class="stat-cell"><div class="k">GPS 포인트</div><div class="v">${fmtNum(stats.points)}<small> 개</small></div></div>
    <div class="stat-cell"><div class="k">Import 이력</div><div class="v">${fmtNum(stats.imports)}<small> 건</small></div></div>
    <div class="stat-cell"><div class="k">저장 용량</div><div class="v">${sizeText}</div></div>
  `;

  statusEl.style.display='block';
  statusEl.innerHTML=`저장 위치 <code>${where}</code>`+
    (info?` <button class="btn ghost" type="button" style="margin-left:8px;padding:4px 10px;font-size:11px;" onclick="revealDatabaseFolder()">폴더 열기</button>`:'');

  await renderSyncPanel();

  const summaries=await refreshDateIndex();
  const dates=[...summaries.values()].sort((a,b)=>b.date.localeCompare(a.date));

  if(!dates.length){
    listEl.innerHTML='<div class="dm-empty">아직 저장된 주행 기록이 없어요.</div>';
    importsEl.innerHTML='';
    const adminEl=document.getElementById('data-issue-admin');
    if(adminEl) adminEl.innerHTML='';
    dangerEl.style.display='none';
    return;
  }

  listEl.innerHTML=dates.map(d=>{
    const zones=(d.zones||[]).map(([z])=>escapeHtml(z)).join(', ')||'—';
    const vehicles=(d.vehicles||[]).map(([v])=>escapeHtml(v)).join(', ')||'—';
    const warn=(d.quality&&d.quality.total)?`<span class="dm-warn" title="의심 항목 ${d.quality.total}건">⚠ ${d.quality.total}</span>`:'';
    const distText=(d.distanceKm!=null)?`${d.distanceKm.toFixed(1)}km`:'—';
    return `
      <div class="dm-row">
        <span class="dm-date mono">${escapeHtml(d.date)}</span>
        <span class="dm-meta">
          <span class="dm-count mono">${fmtNum(d.count)}개 지점</span>
          <span class="dm-dist mono">${distText}</span>
          <span class="dm-time mono">${escapeHtml(d.startTime||'—')} → ${escapeHtml(d.endTime||'—')}</span>
          <span class="dm-tags">${zones} · ${vehicles}</span>
          ${warn}
        </span>
        <span class="dm-actions">
          <button class="btn ghost dm-view" type="button" onclick="openDayDetail('${escapeHtml(d.date)}')">보기</button>
          <button class="btn ghost dm-del" type="button" onclick="deleteOneDate('${escapeHtml(d.date)}')">삭제</button>
        </span>
      </div>`;
  }).join('');

  dangerEl.style.display='flex';

  await renderIssueAdmin();

  // Import 이력 (요구사항 8) — 원본/추가/중복/충돌, 차량, Import한 사람까지 남긴다
  let imports=[];
  try{ imports=await RouteDB.listImports(15); }catch(_){ imports=[]; }
  importsEl.innerHTML=imports.length
    ? `<div class="stats-section-title">최근 불러오기 이력</div>
       <div class="dm-imports">${imports.map(im=>`
         <div class="dm-import">
           <div class="dm-import-row1">
             <span class="dm-import-file" title="${escapeHtml(im.filename)}">${escapeHtml(im.filename||'—')}</span>
             ${im.hasIssue?issueBadgeHtml(im.issueStatus):''}
             <span class="mono dm-import-nums">
               <span class="ir-add">+${fmtNum(im.inserted)}</span>
               ${im.duplicates?`<span class="ir-dup">중복 ${fmtNum(im.duplicates)}</span>`:''}
               ${im.conflicts?`<span class="ir-conflict">충돌 ${fmtNum(im.conflicts)}</span>`:''}
             </span>
           </div>
           ${im.hasIssue?`<div class="issue-note-text">${escapeHtml(im.issueNote||'')}</div>`:''}
           <div class="dm-import-row2 mono">
             <span>${escapeHtml(im.dates||'')}</span>
             ${im.vehicle?`<span>${escapeHtml(im.vehicle)}</span>`:''}
             ${im.distanceKm?`<span>${im.distanceKm.toFixed(1)}km</span>`:''}
             ${im.importedBy?`<span>Import 사용자 ${escapeHtml(im.importedBy)}</span>`:''}
             <span class="dm-import-at">${escapeHtml(formatBackupTime(im.importedAt))}</span>
             ${im.conflicts?`<button type="button" class="dm-import-detail" onclick="showImportHistoryDetail(${im.id})">상세</button>`:''}
           </div>
         </div>`).join('')}</div>`
    : '';
}

// Import History의 "[상세]" — 그 import에서 값이 갈렸던 레코드 목록(요구사항 7,8)
async function showImportHistoryDetail(importId){
  let conflicts=[];
  try{ conflicts=await RouteDB.getImportConflicts(importId); }
  catch(err){ showError('충돌 상세를 불러오지 못했어요. ('+err.message+')'); return; }

  const rows=conflicts.length
    ? conflicts.slice(0,100).map(c=>`
        <div class="conflict-item">
          <div class="conflict-head mono">
            <span>${escapeHtml(c.time||'—')}</span>
            <span>${escapeHtml(c.vehicle||'—')}</span>
            <span>${Number(c.lat).toFixed(5)}, ${Number(c.lng).toFixed(5)}</span>
          </div>
          <div class="conflict-diffs">
            ${(c.diffs||[]).map(d=>`<span class="conflict-diff"><b>${escapeHtml(d.field)}</b> ${escapeHtml(d.from)||'—'} ↔ ${escapeHtml(d.to)||'—'}</span>`).join('')}
          </div>
        </div>`).join('')
    : '<div class="dc-empty">값이 갈린 중복 기록은 없어요.</div>';

  openModal({
    title:'Import 충돌 상세',
    icon:'⚠',
    wide:true,
    body:`<div class="conflict-list">${rows}</div>`,
    buttons:[{label:'확인',primary:true,onClick:closeModal}],
  });
}

function revealDatabaseFolder(){
  if(window.routeAPI&&window.routeAPI.isDesktop) window.routeAPI.revealDatabase();
}

// ── 날짜 하나 삭제 ────────────────────────────────────
async function deleteOneDate(date){
  const sum=dateSummaryIndex.get(date);
  const ok=await confirmDialog({
    title:'날짜 삭제',
    message:`${date} 주행 기록을 삭제할까요?`,
    detail:sum?`GPS 포인트 ${sum.count.toLocaleString('ko-KR')}개가 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`
              :'이 작업은 되돌릴 수 없습니다.',
    confirmLabel:'삭제',
    danger:true,
  });
  if(!ok) return;

  try{
    const res=await RouteDB.deleteDate(date);
    await refreshDateIndex();
    await renderDataView();
    showToast(`${date} 기록 ${fmtNum(res.removed)}개를 삭제했어요.`);
  }catch(err){
    showError('삭제하지 못했어요. ('+err.message+')');
  }
}

// ── 전체 삭제 — 확인창 필수 ───────────────────────────
async function deleteAllData(){
  const stats=await RouteDB.stats();
  if(!stats.points){
    showToast('삭제할 데이터가 없어요.');
    return;
  }
  const ok=await confirmDialog({
    title:'전체 데이터 삭제',
    message:'모든 주행 기록을 삭제하시겠습니까?',
    detail:`${stats.days}일 · GPS 포인트 ${stats.points.toLocaleString('ko-KR')}개가 삭제됩니다.\n\n이 작업은 되돌릴 수 없습니다.`,
    confirmLabel:'전체 삭제',
    danger:true,
  });
  if(!ok) return;

  try{
    const res=await RouteDB.deleteAll();
    await refreshDateIndex();
    points=[];
    await renderDataView();
    showToast(`주행 기록 ${fmtNum(res.removed)}개를 모두 삭제했어요.`);
  }catch(err){
    showError('삭제하지 못했어요. ('+err.message+')');
  }
}

// ── 잠깐 떴다 사라지는 알림 ───────────────────────────
let toastTimer=null;
function showToast(msg){
  const el=document.getElementById('toast');
  if(!el) return;
  el.textContent=msg;
  el.classList.add('show');
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),3200);
}

// ══════════════════════════════════════════════════════════
//  이슈 관리 (데이터 관리 탭)
//
//  Import 파일마다 이슈를 등록·수정하고, 확인 필요 ↔ 확인 완료를 바꾸고, 이슈 표시를
//  지울 수 있다. 파일명·메모로 찾을 수 있고, "이슈만 보기"로 좁힐 수 있다.
//  레코드 자체는 지우지 않는다 — 이슈는 어디까지나 그 데이터에 붙는 표시다.
// ══════════════════════════════════════════════════════════
let issueAdminOnlyIssues=false;
let issueAdminStatus='';      // '' | 'open' | 'resolved'
let issueAdminSearch='';
let issueAdminEditingId=null;
let issueAdminImports=[];
let issueAdminOverview=null;

async function renderIssueAdmin(){
  const el=document.getElementById('data-issue-admin');
  if(!el) return;
  try{
    issueAdminImports=await RouteDB.listImports(500,{
      issueOnly:issueAdminOnlyIssues,
      issueStatus:issueAdminStatus||undefined,
      search:issueAdminSearch||undefined,
      withRelatedRecords:true,   // 이 화면만 "그 파일에서 온 기록 수"를 보여준다
    });
    issueAdminOverview=await RouteDB.getIssueOverview({});
  }catch(err){
    console.warn('[경로뷰어] 이슈 관리 목록 조회 실패:',err);
    el.innerHTML='';
    return;
  }
  paintIssueAdmin();
}

function paintIssueAdmin(){
  const el=document.getElementById('data-issue-admin');
  if(!el) return;
  const ov=issueAdminOverview||{};
  const counts=ov.recordCounts||{};
  const rows=(issueAdminImports||[]).map(im=>issueAdminRowHTML(im)).join('')
    ||'<div class="dc-empty">조건에 맞는 Import 파일이 없어요.</div>';
  el.innerHTML=`
    <div class="stats-section-title">이슈 관리</div>
    <div class="dm-issue-summary mono">
      <span>이슈 파일 ${fmtNum(ov.issueImportCount||0)}개</span>
      <span class="issue-badge open">확인 필요 ${fmtNum(ov.openCount||0)}</span>
      <span class="issue-badge resolved">확인 완료 ${fmtNum(ov.resolvedCount||0)}</span>
      <span>이슈 데이터 ${fmtNum(counts.issue_all||0)}개 / 전체 ${fmtNum(counts.all||0)}개</span>
      ${ov.conflictCount?`<span class="rec-bad">동기화 충돌 정리 ${fmtNum(ov.conflictCount)}건</span>`:''}
    </div>
    <div class="dm-issue-controls">
      <label class="imp-check"><input type="checkbox" ${issueAdminOnlyIssues?'checked':''} onchange="setIssueAdminOnly(this.checked)"/><span>이슈만 보기</span></label>
      <select class="dm-issue-select" onchange="setIssueAdminStatus(this.value)">
        <option value=""${issueAdminStatus===''?' selected':''}>상태 전체</option>
        <option value="open"${issueAdminStatus==='open'?' selected':''}>확인 필요</option>
        <option value="resolved"${issueAdminStatus==='resolved'?' selected':''}>확인 완료</option>
      </select>
      <input type="text" class="dm-issue-search" id="issue-admin-search" value="${escapeHtml(issueAdminSearch)}"
             placeholder="파일명 · 이슈 메모 검색" oninput="setIssueAdminSearch(this.value)"/>
    </div>
    <div class="issue-list">${rows}</div>`;
}

function issueAdminRowHTML(im){
  const editing=issueAdminEditingId===im.id;
  const max=IssueFilter.ISSUE_NOTE_MAX;
  const cls=im.hasIssue?(im.issueStatus==='resolved'?'resolved':'open'):'';
  const conflict=im.issueConflict
    ? `<div class="ir-note warn">동기화 때 이슈가 겹쳐서 ${escapeHtml(im.issueConflict.keptFrom==='local'?'이 기기':'받아온 쪽')} 값을 남겼어요. 밀려난 메모: ${escapeHtml((im.issueConflict.replaced&&im.issueConflict.replaced.issueNote)||'(없음)')}</div>`
    : '';
  const body=editing
    ? `<div class="issue-edit-row">
         <input type="text" id="issue-admin-input-${im.id}" maxlength="${max}" value="${escapeHtml(im.issueNote||'')}" placeholder="이슈 내용을 한 줄로 적어주세요 (최대 ${max}자)"/>
         <button class="btn" type="button" onclick="saveIssueAdmin(${im.id})">저장</button>
         <button class="btn ghost" type="button" onclick="cancelIssueAdminEdit()">취소</button>
       </div>
       <div class="imp-err" id="issue-admin-err-${im.id}"></div>`
    : (im.hasIssue?`<div class="issue-note-text">${escapeHtml(im.issueNote||'')}</div>`:'');
  const actions=editing?'':`
    <div class="issue-item-actions">
      <button class="btn ghost" type="button" onclick="startIssueAdminEdit(${im.id})">${im.hasIssue?'메모 수정':'이슈 등록'}</button>
      ${im.hasIssue?`<button class="btn ghost" type="button" onclick="toggleIssueAdminStatus(${im.id})">${im.issueStatus==='resolved'?'확인 필요로 되돌리기':'확인 완료로 변경'}</button>`:''}
      ${im.hasIssue?`<button class="btn ghost" type="button" onclick="clearIssueAdmin(${im.id})" title="이슈 표시만 지워요. GPS 기록은 그대로 남아요">이슈 해제</button>`:''}
    </div>`;
  return `
    <div class="issue-item ${cls}">
      <div class="issue-item-head">
        <span class="imp-name" title="${escapeHtml(im.filename||'')}">${escapeHtml(im.filename||'(파일명 없음)')}</span>
        ${im.hasIssue?issueBadgeHtml(im.issueStatus):'<span class="issue-badge resolved">이슈 없음</span>'}
      </div>
      <div class="issue-item-meta mono">
        <span>${escapeHtml(im.dates||'')}</span>
        ${im.vehicle?`<span>${escapeHtml(im.vehicle)}</span>`:''}
        ${im.relatedRecords!=null?`<span>기록 ${fmtNum(im.relatedRecords)}개</span>`:''}
        <span>${escapeHtml(formatBackupTime(im.importedAt))}</span>
        ${im.issueUpdatedAt?`<span>이슈 수정 ${escapeHtml(formatBackupTime(im.issueUpdatedAt))}</span>`:''}
      </div>
      ${body}${conflict}${actions}
    </div>`;
}

function setIssueAdminOnly(on){ issueAdminOnlyIssues=!!on; issueAdminEditingId=null; renderIssueAdmin(); }
function setIssueAdminStatus(value){ issueAdminStatus=value||''; issueAdminEditingId=null; renderIssueAdmin(); }

let issueAdminSearchTimer=null;
function setIssueAdminSearch(value){
  issueAdminSearch=String(value||'');
  if(issueAdminSearchTimer) clearTimeout(issueAdminSearchTimer);
  // 글자를 칠 때마다 조회하면 목록이 깜빡인다 — 잠깐 멈출 때 한 번만 다시 읽는다
  issueAdminSearchTimer=setTimeout(async()=>{
    await renderIssueAdmin();
    const box=document.getElementById('issue-admin-search');
    if(box&&box.focus){ box.focus(); if(box.setSelectionRange) box.setSelectionRange(box.value.length,box.value.length); }
  },250);
}

function startIssueAdminEdit(importId){ issueAdminEditingId=importId; paintIssueAdmin(); }
function cancelIssueAdminEdit(){ issueAdminEditingId=null; paintIssueAdmin(); }

async function saveIssueAdmin(importId){
  const input=document.getElementById('issue-admin-input-'+importId);
  const check=IssueFilter.validateIssueInput({hasIssue:true,issueNote:input?input.value:''});
  if(!check.ok){
    const err=document.getElementById('issue-admin-err-'+importId);
    if(err){ err.textContent=check.errors[0]; err.style.display='block'; }
    return;
  }
  const current=(issueAdminImports||[]).find(im=>im.id===importId);
  await applyIssueAdminChange(importId,{
    hasIssue:true, issueNote:check.value.issueNote,
    issueStatus:(current&&current.hasIssue&&current.issueStatus)||'open',
  });
}

async function toggleIssueAdminStatus(importId){
  const im=(issueAdminImports||[]).find(x=>x.id===importId);
  if(!im) return;
  await applyIssueAdminChange(importId,{issueStatus:im.issueStatus==='resolved'?'open':'resolved'});
}

async function clearIssueAdmin(importId){
  await applyIssueAdminChange(importId,{hasIssue:false,issueNote:''});
}

async function applyIssueAdminChange(importId,patch){
  try{
    await RouteDB.updateImportIssue(importId,patch);
  }catch(err){
    showError(`이슈를 저장하지 못했어요. (${(err&&err.message)||err})`);
    return false;
  }
  issueAdminEditingId=null;
  await refreshDateIndex();   // 이슈 마스크가 바뀌어 날짜 요약도 다시 만들어졌다
  await renderIssueAdmin();
  return true;
}
