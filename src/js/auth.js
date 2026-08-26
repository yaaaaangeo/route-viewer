// ══════════════════════════════════════════════════════════
//  auth — 로그인(이름 확인용)
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
//  로그인 — 이름 확인용. 서버 인증이 아니라 "지금 이 세션은 누가
//  보고 있는지" 표시하기 위한 용도. sessionStorage에만 저장되며
//  탭을 닫으면 사라진다 (nav-app 로그인과 동일한 성격/저장 방식).
// ══════════════════════════════════════════════════════════
const LOGIN_KEY='route_viewer_user';

// ⚠️ 이 목록에 있는 이름만 경로 뷰어를 볼 수 있어요.
// 파일 안의 값이라 완전한 보안은 아니고(개발자도구로 우회 가능), 팀 내부에서
// "아무나 못 열게" 하는 용도의 가벼운 출입 명단이에요. 필요하면 이 배열만 수정하면 됩니다.
const ALLOWED_USERS=['양은규','최수헌'];

function isAllowedUser(name){
  const norm=n=>n.trim().toLowerCase();
  return ALLOWED_USERS.some(u=>norm(u)===norm(name));
}

function initLogin(){
  let saved='';
  try{ saved=sessionStorage.getItem(LOGIN_KEY)||''; }catch(_){}
  if(saved&&isAllowedUser(saved)){
    applyLoggedInUser(saved);
    hideLoginScreen();
  }else{
    if(saved){ try{ sessionStorage.removeItem(LOGIN_KEY); }catch(_){} }
    showLoginScreen();
  }
}

function showLoginScreen(){
  const input=document.getElementById('login-name-input');
  let saved='';
  try{ saved=sessionStorage.getItem(LOGIN_KEY)||''; }catch(_){}
  input.value=saved;
  hideLoginError();
  updateLoginButton();
  document.getElementById('login-screen').classList.remove('hidden');
  setTimeout(()=>input.focus(),80);
}

function hideLoginScreen(){
  document.getElementById('login-screen').classList.add('hidden');
}

function showLoginError(msg){
  const el=document.getElementById('login-error');
  el.textContent=msg; el.style.display='block';
}
function hideLoginError(){
  document.getElementById('login-error').style.display='none';
}

function updateLoginButton(){
  const name=document.getElementById('login-name-input').value.trim();
  document.getElementById('login-submit').disabled=!name;
}

function submitLogin(){
  const name=document.getElementById('login-name-input').value.trim();
  if(!name) return;
  if(!isAllowedUser(name)){
    showLoginError('등록되지 않은 이름이에요. 접근 권한이 있는 이름인지 확인해주세요.');
    return;
  }
  hideLoginError();
  try{ sessionStorage.setItem(LOGIN_KEY,name); }catch(_){}
  applyLoggedInUser(name);
  hideLoginScreen();
}

function applyLoggedInUser(name){
  document.getElementById('user-badge-name').textContent=name;
}

// Import History에 "누가 넣었는지" 남기는 용도 (요구사항 8)
function currentUserName(){
  try{ return sessionStorage.getItem(LOGIN_KEY)||''; }catch(_){ return ''; }
}

document.getElementById('login-name-input').addEventListener('input',()=>{
  updateLoginButton();
  hideLoginError();
});
document.getElementById('login-name-input').addEventListener('keydown',e=>{
  if(e.key==='Enter') submitLogin();
});
initLogin();
