// ══════════════════════════════════════════════════════════
//  importer — 파일 불러오기 (추가/병합)
//
//  ⚠ 여기가 이번 수정의 핵심이다.
//
//  예전 동작 (버그):
//      handleFiles() 첫 줄에서 entriesByDate = new Map() 으로
//      기존 데이터를 통째로 날려버렸다.
//      → 8/24 파일을 넣으면 8/23 기록이 사라졌다.
//
//  새 동작:
//      기존 저장 데이터 Load → 새 파일 파싱 → 기존 데이터와 Merge
//      → 중복 제거 → 시간순 정렬 → DB 저장 → 화면 갱신
//
//      파일을 불러오는 것은 "교체"가 아니라 "영구 DB에 추가"다.
//      기존 날짜 데이터는 사용자가 [데이터 관리]에서 직접 지우지 않는 한
//      절대 사라지지 않는다.
// ══════════════════════════════════════════════════════════

// ── 드래그앤드롭 / 파일 선택 (여러 개 동시 선택 지원) ──────
const dz=document.getElementById('dropzone');
const fileInput=document.getElementById('file-input');
['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag');}));
['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag');}));
dz.addEventListener('drop',e=>{
  const files=e.dataTransfer.files;
  if(files&&files.length) handleFiles(files);
});
fileInput.addEventListener('change',e=>{
  const files=e.target.files;
  if(files&&files.length) handleFiles(files);
  e.target.value=''; // 같은 파일을 연달아 다시 고를 수 있게
});

function showError(msg){
  const box=document.getElementById('error-box');
  box.textContent=msg; box.style.display='block';
}
function clearError(){ document.getElementById('error-box').style.display='none'; }

function readFileBuffer(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=e=>resolve(new Uint8Array(e.target.result));
    reader.onerror=()=>reject(new Error('파일을 읽지 못했어요.'));
    reader.readAsArrayBuffer(file);
  });
}

// 파일 자체의 지문 — "이 파일 통째로 전에 넣은 적 있나?" 안내용.
// 실제 중복 제거는 레코드 단위(date|time|vehicle|lat|lng)로 하므로,
// 이 값이 같아도 안 넣는 게 아니라 안내만 한다.
async function hashBuffer(bytes){
  try{
    const digest=await crypto.subtle.digest('SHA-1',bytes);
    return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }catch(_){ return ''; }
}

// ── 진행 표시 ─────────────────────────────────────────
function setImportBusy(on,message){
  const box=document.getElementById('import-progress');
  if(!box) return;
  box.style.display=on?'flex':'none';
  if(on) document.getElementById('import-progress-text').textContent=message||'불러오는 중…';
  dz.style.pointerEvents=on?'none':'';
  dz.style.opacity=on?'.5':'';
}

// ══════════════════════════════════════════════════════
//  handleFiles — 파일 여러 개를 순서대로 DB에 추가한다.
//  ★ 기존 데이터를 초기화하는 코드는 여기에 없다(있으면 안 된다).
// ══════════════════════════════════════════════════════
async function handleFiles(fileList){
  clearError();
  const files=Array.from(fileList);
  const results=[];
  const failed=[];

  setImportBusy(true,`파일 ${files.length}개 읽는 중…`);
  try{
    for(let i=0;i<files.length;i++){
      const file=files[i];
      setImportBusy(true,`(${i+1}/${files.length}) ${file.name} 처리 중…`);
      try{
        const bytes=await readFileBuffer(file);
        const records=RouteParser.parseBuffer(bytes);
        if(!records.length){
          failed.push({name:file.name,reason:'GPS 좌표를 찾지 못했어요'});
          continue;
        }
        const fileHash=await hashBuffer(bytes);
        const seenBefore=await RouteDB.findImportByFileHash(fileHash);

        // ★ 추가(merge)만 한다. 기존 날짜/기록은 그대로 둔다.
        const res=await RouteDB.importRecords(records,{filename:file.name,fileHash,importedBy:currentUserName()});
        results.push({...res,filename:file.name,seenBefore});
      }catch(err){
        console.warn('[경로뷰어] 파싱 실패:',file.name,err);
        failed.push({name:file.name,reason:err.message||'읽지 못했어요'});
      }
    }
  }finally{
    setImportBusy(false);
  }

  if(!results.length){
    showError(files.length>1
      ? '선택한 파일들에서 GPS 좌표를 찾지 못했어요. nav-app "오늘 기록 다운로드"로 받은 파일이 맞는지 확인해주세요.'
      : '파일에서 GPS 좌표를 찾지 못했어요. nav-app "오늘 기록 다운로드"로 받은 파일이 맞는지 확인해주세요.');
    return;
  }

  await refreshDateIndex();
  const stats=await RouteDB.stats();
  showImportReport(results,failed,stats);
  updateBackupStatus();
}

// 데스크톱 앱: 메뉴/버튼에서 "파일 선택" 다이얼로그로 불러오기
async function openRouteFileDialog(){
  if(!(window.routeAPI&&window.routeAPI.isDesktop)){
    document.getElementById('file-input').click();
    return;
  }
  clearError();
  let picked=[];
  try{ picked=await window.routeAPI.pickRouteFiles(); }
  catch(err){ showError('파일을 열지 못했어요. ('+err.message+')'); return; }
  if(!picked.length) return;

  const results=[], failed=[];
  setImportBusy(true,`파일 ${picked.length}개 읽는 중…`);
  try{
    for(let i=0;i<picked.length;i++){
      const f=picked[i];
      setImportBusy(true,`(${i+1}/${picked.length}) ${f.name} 처리 중…`);
      try{
        const bytes=new Uint8Array(f.buffer);
        const records=RouteParser.parseBuffer(bytes);
        if(!records.length){ failed.push({name:f.name,reason:'GPS 좌표를 찾지 못했어요'}); continue; }
        const fileHash=await hashBuffer(bytes);
        const seenBefore=await RouteDB.findImportByFileHash(fileHash);
        const res=await RouteDB.importRecords(records,{filename:f.name,fileHash,importedBy:currentUserName()});
        results.push({...res,filename:f.name,seenBefore});
      }catch(err){
        console.warn('[경로뷰어] 파싱 실패:',f.name,err);
        failed.push({name:f.name,reason:err.message||'읽지 못했어요'});
      }
    }
  }finally{
    setImportBusy(false);
  }

  if(!results.length){
    showError('선택한 파일에서 GPS 좌표를 찾지 못했어요.');
    return;
  }
  await refreshDateIndex();
  const stats=await RouteDB.stats();
  showImportReport(results,failed,stats);
  updateBackupStatus();
}

// ══════════════════════════════════════════════════════
//  Import 결과 리포트
//
//    주행 기록 추가 완료
//    파일            2026-08-24_drive.xlsx
//    원본            5,349 records
//    새로 추가       3,643 records
//    중복 제외       1,706 records
//    중복률          31.9 %
//    충돌            1 record
//    전체 저장 날짜  17일
//    전체 GPS 포인트 21,438
//
//  여러 파일을 한 번에 넣었으면 파일별 결과 + 전체 합계를 함께 보여준다.
// ══════════════════════════════════════════════════════
function showImportReport(results,failed,stats){
  const many=results.length>1;
  const sum=results.reduce((a,r)=>({
    total:a.total+r.total,
    inserted:a.inserted+r.inserted,
    duplicates:a.duplicates+r.duplicates,
    conflicts:a.conflicts+(r.conflicts||0),
  }),{total:0,inserted:0,duplicates:0,conflicts:0});
  const dupRate=sum.total?Math.round(sum.duplicates/sum.total*1000)/10:0;
  const allDates=[...new Set(results.flatMap(r=>r.dates))].sort();

  const rows=[];
  if(many){
    rows.push(['파일',`${results.length}개`]);
  }else{
    rows.push(['파일',escapeHtml(results[0].filename)]);
  }
  rows.push(['날짜',allDates.length>4
    ? `${escapeHtml(allDates[0])} … ${escapeHtml(allDates[allDates.length-1])} (${allDates.length}일)`
    : allDates.map(escapeHtml).join(', ')]);
  rows.push(['원본',fmtNum(sum.total)]);
  rows.push(['새로 추가',`<b style="color:var(--green)">${fmtNum(sum.inserted)}</b>`]);
  rows.push(['중복 제외',sum.duplicates?`<b style="color:var(--amber)">${fmtNum(sum.duplicates)}</b>`:'0']);
  rows.push(['중복률',`${dupRate}%`]);
  if(sum.conflicts) rows.push(['충돌',`<b style="color:var(--red)">${fmtNum(sum.conflicts)}</b>`]);
  rows.push(['전체 저장 날짜',`${fmtNum(stats.days)}일`]);
  rows.push(['전체 GPS 포인트',fmtNum(stats.points)]);

  const perFile=many
    ? `<div class="ir-files">${results.map(r=>`
        <div class="ir-file">
          <span class="ir-file-name" title="${escapeHtml(r.filename)}">${escapeHtml(r.filename)}</span>
          <span class="ir-file-nums">
            <span class="ir-add">+${fmtNum(r.inserted)}</span>
            ${r.duplicates?`<span class="ir-dup">중복 ${fmtNum(r.duplicates)}</span>`:''}
            ${r.conflicts?`<span class="ir-conflict">충돌 ${fmtNum(r.conflicts)}</span>`:''}
            <span class="ir-date">${escapeHtml(r.dates.join(', '))}</span>
          </span>
        </div>`).join('')}</div>`
    : '';

  const repeated=results.filter(r=>r.seenBefore);
  const repeatNote=repeated.length
    ? `<div class="ir-note">이미 넣었던 파일이 ${repeated.length}개 포함돼 있어요. 같은 기록은 자동으로 걸러져서 포인트가 두 배가 되지 않아요.</div>`
    : '';

  const failNote=failed.length
    ? `<div class="ir-note warn">읽지 못한 파일 ${failed.length}개<br/>${
        failed.map(f=>`· ${escapeHtml(f.name)} — ${escapeHtml(f.reason)}`).join('<br/>')
      }</div>`
    : '';

  const zeroNote=(sum.inserted===0&&sum.duplicates>0)
    ? `<div class="ir-note">새로 추가된 기록은 없어요. 전부 이미 저장돼 있는 기록이에요. <b>기존 데이터는 그대로 있어요.</b></div>`
    : '';

  const hasDupInfo=sum.duplicates>0;

  openModal({
    title:'주행 기록 추가 완료',
    icon:'✓',
    body:`
      <table class="ir-table">
        ${rows.map(([k,v])=>`<tr><td class="ir-k">${k}</td><td class="ir-v mono">${v}</td></tr>`).join('')}
      </table>
      ${perFile}${zeroNote}${repeatNote}${failNote}
    `,
    buttons:[
      ...(hasDupInfo?[{label:'중복 상세',onClick:()=>showDuplicateDetail(results,sum)}]:[]),
      {label:'달력에서 보기',primary:true,onClick:()=>{closeModal();showCalendar();}},
      {label:'닫기',onClick:closeModal},
    ],
  });
}

// ══════════════════════════════════════════════════════
//  중복 상세 화면 (요구사항 7)
//
//    중복 분석
//    전체 원본   5,349
//    고유        3,643
//    중복        1,706
//    완전 동일   1,705
//    값 충돌         1
//
//    충돌 목록: 14:32:00 · 토레스 2호 · 37.12345, 127.12345
//              speed  0.0 ↔ 0.5
// ══════════════════════════════════════════════════════
function showDuplicateDetail(results,sum){
  const unique=sum.total-sum.duplicates;
  const exact=sum.duplicates-sum.conflicts;
  const allConflicts=results.flatMap(r=>r.conflictDetails||[]);

  const conflictRows=allConflicts.length
    ? allConflicts.slice(0,100).map(c=>`
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
    title:'중복 분석',
    icon:'⚠',
    wide:true,
    body:`
      <table class="ir-table">
        <tr><td class="ir-k">전체 원본</td><td class="ir-v mono">${fmtNum(sum.total)}</td></tr>
        <tr><td class="ir-k">고유</td><td class="ir-v mono">${fmtNum(unique)}</td></tr>
        <tr><td class="ir-k">중복</td><td class="ir-v mono">${fmtNum(sum.duplicates)}</td></tr>
        <tr><td class="ir-k">완전 동일</td><td class="ir-v mono">${fmtNum(exact)}</td></tr>
        <tr><td class="ir-k">값 충돌</td><td class="ir-v mono">${fmtNum(sum.conflicts)}</td></tr>
      </table>
      ${allConflicts.length?`<div class="stats-section-title" style="margin-top:14px;">충돌 목록${allConflicts.length>100?' (처음 100건)':''}</div>
      <div class="conflict-list">${conflictRows}</div>`:`<div class="ir-note" style="margin-top:12px;">${conflictRows}</div>`}
    `,
    buttons:[{label:'확인',primary:true,onClick:closeModal}],
  });
}
