// ══════════════════════════════════════════════════════════
//  ui — 공용 모달 (import 결과 · 삭제 확인 · 백업 복구 방식 선택)
//
//  기존 화면 톤(어두운 패널 + 틸/앰버 포인트)을 그대로 따른다.
// ══════════════════════════════════════════════════════════
let modalOnEsc=null;

function openModal({title,icon,body,buttons,wide}){
  const back=document.getElementById('modal-backdrop');
  const box=document.getElementById('modal-box');
  box.classList.toggle('wide',!!wide);
  document.getElementById('modal-icon').textContent=icon||'';
  document.getElementById('modal-icon').style.display=icon?'flex':'none';
  document.getElementById('modal-title').textContent=title||'';
  document.getElementById('modal-body').innerHTML=body||'';

  const foot=document.getElementById('modal-foot');
  foot.innerHTML='';
  (buttons||[{label:'닫기',onClick:closeModal}]).forEach(b=>{
    const el=document.createElement('button');
    el.className='btn'+(b.primary?'':' ghost')+(b.danger?' danger':'');
    el.type='button';
    el.textContent=b.label;
    el.onclick=b.onClick;
    foot.appendChild(el);
  });

  back.classList.add('show');
  modalOnEsc=e=>{ if(e.key==='Escape') closeModal(); };
  document.addEventListener('keydown',modalOnEsc);
}

function closeModal(){
  document.getElementById('modal-backdrop').classList.remove('show');
  if(modalOnEsc){ document.removeEventListener('keydown',modalOnEsc); modalOnEsc=null; }
}

// 바깥쪽(어두운 영역)을 누르면 닫기 — 모달 안쪽 클릭은 무시
document.getElementById('modal-backdrop').addEventListener('mousedown',e=>{
  if(e.target.id==='modal-backdrop') closeModal();
});

// 예/아니오 확인창 (Promise). 데스크톱 앱에서는 OS 다이얼로그를 쓴다.
async function confirmDialog({title,message,detail,confirmLabel,danger}){
  if(window.routeAPI&&window.routeAPI.isDesktop){
    const idx=await window.routeAPI.confirm({
      type:danger?'warning':'question',
      title:title||'확인',
      message:message||'',
      detail:detail||'',
      buttons:['취소',confirmLabel||'확인'],
      defaultId:0,
      cancelId:0,
    });
    return idx===1;
  }
  return new Promise(resolve=>{
    openModal({
      title:title||'확인',
      icon:danger?'⚠':'?',
      body:`<div class="modal-msg">${escapeHtml(message||'')}</div>`+
           (detail?`<div class="modal-detail">${escapeHtml(detail).replace(/\n/g,'<br/>')}</div>`:''),
      buttons:[
        {label:'취소',onClick:()=>{closeModal();resolve(false);}},
        {label:confirmLabel||'확인',primary:!danger,danger:!!danger,onClick:()=>{closeModal();resolve(true);}},
      ],
    });
  });
}
