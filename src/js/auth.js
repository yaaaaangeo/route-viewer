// ══════════════════════════════════════════════════════════
//  auth — 로그인(이름 확인용)
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
//  로그인 — 이름 확인용. 서버 인증이 아니라 "지금 이 세션은 누가
//  보고 있는지" 표시하기 위한 용도. sessionStorage에만 저장되며
//  탭을 닫으면 사라진다 (nav-app 로그인과 동일한 성격/저장 방식).
// ══════════════════════════════════════════════════════════
const LOGIN_KEY='route_viewer_user';

// ⚠️ 이 명단에 있는 이름만 경로 뷰어를 볼 수 있어요.
// 명단은 [설정 › 접근 권한]에서 추가·해제하고 DB 설정(allowedUsers)에 저장된다 — 백업·서버 동기화에도 같이 실린다.
// 비밀번호가 아니라 이름 확인용 가벼운 출입 명단이라 완전한 보안은 아니다(개발자도구로 우회 가능).
// 명단을 한 번도 저장한 적 없으면 아래 기본 명단을 쓴다.
const DEFAULT_ALLOWED_USERS=['양은규'];
const USER_NAME_MAX=30;
let allowedUsers=DEFAULT_ALLOWED_USERS.slice();
let resolveAllowedUsersReady;
const allowedUsersReady=new Promise(r=>{ resolveAllowedUsersReady=r; });

function normalizeUserName(n){ return String(n==null?'':n).replace(/\s+/g,' ').trim(); }
function userNameKey(n){ return normalizeUserName(n).toLowerCase(); }

// 공백 정리 · 빈 이름/너무 긴 이름 제외 · 대소문자 무시 중복 제거(먼저 나온 표기 유지)
function sanitizeAllowedUsers(list){
  const seen=new Set(), out=[];
  (Array.isArray(list)?list:[]).forEach(n=>{
    const name=normalizeUserName(n);
    if(!name||name.length>USER_NAME_MAX||seen.has(userNameKey(name))) return;
    seen.add(userNameKey(name)); out.push(name);
  });
  return out;
}

function isAllowedUser(name){
  const key=userNameKey(name);
  return !!key&&allowedUsers.some(u=>userNameKey(u)===key);
}

// 저장된 명단을 읽고 나서야 로그인 여부를 판단한다(startRouteViewer 가 저장소 연결 직후 부른다).
// 저장소를 못 열었으면 기본 명단으로 판단한다.
async function loadAllowedUsers(){
  try{
    const s=await RouteDB.getSettings();
    const list=sanitizeAllowedUsers(s&&s.allowedUsers);
    allowedUsers=list.length?list:DEFAULT_ALLOWED_USERS.slice();
  }catch(err){
    console.warn('[경로뷰어] 접근 권한 명단을 읽지 못했어요 — 기본 명단을 씁니다:',err);
    allowedUsers=DEFAULT_ALLOWED_USERS.slice();
  }
  resolveAllowedUsersReady();
  initLogin();
  return allowedUsers;
}

function getAllowedUsers(){ return allowedUsers.slice(); }

// 명단 저장 — 빈 명단은 저장하지 않는다(아무도 못 들어오게 되므로)
async function saveAllowedUsers(list){
  const clean=sanitizeAllowedUsers(list);
  if(!clean.length) throw new Error('최소 한 명은 남아 있어야 해요.');
  const saved=await RouteDB.setSettings({allowedUsers:clean});
  const stored=sanitizeAllowedUsers(saved&&saved.allowedUsers);
  allowedUsers=stored.length?stored:clean;
  // 지금 들어와 있는 사람이 명단에서 빠졌으면 바로 로그인 화면으로
  const cur=currentUserName();
  if(cur&&!isAllowedUser(cur)) logoutUser('접근 권한이 해제된 이름이에요.');
  return allowedUsers.slice();
}

function logoutUser(message){
  try{ sessionStorage.removeItem(LOGIN_KEY); }catch(_){}
  applyLoggedInUser('—');
  showLoginScreen();
  if(message) showLoginError(message);
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

async function submitLogin(){
  await allowedUsersReady;   // 저장된 명단을 읽기 전에는 판단하지 않는다
  let name=normalizeUserName(document.getElementById('login-name-input').value);
  if(!name) return;
  if(!isAllowedUser(name)){
    showLoginError('등록되지 않은 이름이에요. 접근 권한이 있는 이름인지 확인해주세요.');
    return;
  }
  hideLoginError();
  // 명단에 적힌 표기 그대로 남긴다(Import 이력의 "누가 넣었는지"가 같은 사람이면 같은 이름이 되도록)
  name=allowedUsers.find(u=>userNameKey(u)===userNameKey(name))||name;
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
// initLogin() 은 저장된 명단을 읽은 뒤 loadAllowedUsers() 가 부른다(그 전까지 로그인 화면이 떠 있다)
