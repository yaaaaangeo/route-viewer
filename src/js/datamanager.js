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

  // Import 이력 (요구사항 8) — 원본/추가/중복/충돌, 차량, Import한 사람까지 남긴다
  let imports=[];
  try{ imports=await RouteDB.listImports(15); }catch(_){ imports=[]; }
  importsEl.innerHTML=imports.length
    ? `<div class="stats-section-title">최근 불러오기 이력</div>
       <div class="dm-imports">${imports.map(im=>`
         <div class="dm-import">
           <div class="dm-import-row1">
             <span class="dm-import-file" title="${escapeHtml(im.filename)}">${escapeHtml(im.filename||'—')}</span>
             <span class="mono dm-import-nums">
               <span class="ir-add">+${fmtNum(im.inserted)}</span>
               ${im.duplicates?`<span class="ir-dup">중복 ${fmtNum(im.duplicates)}</span>`:''}
               ${im.conflicts?`<span class="ir-conflict">충돌 ${fmtNum(im.conflicts)}</span>`:''}
             </span>
           </div>
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
