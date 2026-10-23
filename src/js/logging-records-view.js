// Desktop LOGGERD MVP. Mock observations are explicitly labelled and never real OCR results.
(function (global) {
  'use strict';
  let initialized = false, busy = false, editing = null, previewUrl = null, renderToken = 0;
  let assets = [], candidates = [], sessions = [], vehicles = [], jobs = [], includeMock = false;
  const esc = value => escapeHtml(String(value == null ? '' : value));
  const panel = () => document.getElementById('logging-records-panel');
  const actor = () => typeof currentUserName === 'function' ? currentUserName() : '';
  const message = text => { const el = document.getElementById('logging-message'); if (el) el.textContent = text; };
  function revoke() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; }
  function badge(isMock) { return isMock ? '<span class="logging-tag">MOCK · 테스트 기록</span>' : ''; }
  function input(name, label, value, options = {}) {
    return `<label>${esc(label)}<input name="${name}" value="${esc(value)}" ${options.required ? 'required' : ''}
      type="${options.type || 'text'}" ${options.readonly ? 'readonly' : ''} placeholder="${esc(options.placeholder || '알 수 없으면 비움')}" maxlength="300"/></label>`;
  }
  function table(rows, headers) {
    return `<div class="logging-scroll"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
  const fieldLabels = { folder: '세션 폴더명', loggingDate: '로깅 날짜', startedTime: '시작 시각', durationRaw: '녹화 시간',
    sizeRaw: '원본 용량 문자열', sizeValue: '전체 크기 숫자', sizeUnit: '전체 크기 단위', fileCount: '파일 개수',
    recordingCount: '녹화 횟수', completion: '완료 상태', loggerScope: 'LOGGERD 장비/설치', vehicleName: '차량', externalSessionId: '주행 세션' };
  function compareFields(before, after) {
    return table(Object.entries(fieldLabels).map(([key, label]) => `<tr><td>${label}</td><td>${esc(before[key] == null ? '미상' : before[key])}</td>
      <td>${esc(after[key] == null ? '미상' : after[key])}</td></tr>`), ['항목', '기존 값', '이번 값']);
  }
  function sourceFields(observation) {
    return table(LoggingRecords.FIELDS.map(key => `<tr><td>${fieldLabels[key]}</td><td>${esc(observation.fields[key] == null ? '미상' : observation.fields[key])}</td>
      <td>${esc(observation.evidence && observation.evidence[key] && observation.evidence[key].text)}</td></tr>`), ['항목', '원본 인식값', '인식 근거 텍스트'])
      + (observation.warnings || []).map(w => `<p class="logging-notice">${esc(w)}</p>`).join('');
  }
  function history(item) {
    if (item.observation) return sourceFields(item.observation);
    const actions = { confirm: '최초 확정', attach: '사진 근거 추가', replace: '충돌 검토 후 수정', edit: '기록 수정' };
    return item.evidence.map((e, i) => `<details><summary>근거 사진 ${i + 1} · 원본 인식값</summary>${sourceFields(e.observation)}</details>`).join('')
      + item.revisions.map(r => `<details><summary>${esc(actions[r.action] || r.action)} · ${esc(r.actor_name || '사용자 미상')} · ${esc(r.created_at)}</summary>
      <p>${esc(r.reason)}</p>${compareFields(JSON.parse(r.before_json) || {}, JSON.parse(r.after_json) || {})}</details>`).join('');
  }
  async function render() {
    const el = panel(); if (!el) return;
    const token = ++renderToken;
    const cap = await RouteDB.getLoggingCapabilities();
    if (!cap.supported) {
      el.innerHTML = '<h2>LOGGERD 로깅 기록</h2><p>사진 인식·기록 관리는 Electron 데스크톱 앱에서 지원합니다. 기존 GPS 기능은 계속 사용할 수 있습니다.</p>';
      return;
    }
    [assets, candidates, sessions, vehicles, jobs] = await Promise.all([
      RouteDB.listLoggingAssets(), RouteDB.listLoggingCandidates(), RouteDB.listLoggingSessions(), RouteDB.listVehicles(), RouteDB.listLoggingJobs(),
    ]);
    const totals = await RouteDB.getLoggingTotals({ includeMock });
    if (token !== renderToken) return;
    revoke(); editing = null;
    el.innerHTML = `<h2>LOGGERD 로깅 기록</h2>
      <p class="logging-notice">${cap.isMock ? '현재 Mock 인식기입니다. 사진 내용을 읽지 않고 테스트 후보 2개를 생성합니다. 모든 실제 값은 직접 확인·입력해야 합니다.' : '모든 인식 결과를 원본과 비교한 후 확정해주세요.'}
      원본 사진은 앱의 사용자 데이터 폴더에 보관됩니다.</p>
      <p>GB/TB 환산 기준 미확정: 아래 합계는 같은 원본 단위끼리만 더합니다. GPS 수집 시간에 합산하지 않습니다.
      기존 GPS JSON 백업·서버 동기화에는 로깅 사진과 기록이 포함되지 않습니다.</p>
      <div class="logging-actions"><button type="button" class="btn" data-logging-action="pick" ${busy ? 'disabled' : ''}>사진 여러 장 선택</button>
      <button type="button" class="btn ghost" data-logging-action="refresh">새로고침</button>
      <label><input type="checkbox" id="logging-include-mock" ${includeMock ? 'checked' : ''}/> 합계에 Mock 테스트 기록 포함</label></div>
      <div id="logging-message" role="status" aria-live="polite">${busy ? '사진 보관·처리 중…' : ''}</div>
      <h3>${includeMock ? 'Mock 포함 테스트 합계' : '확정 기록 합계'} · 세션 ${totals.sessions}개 / 완료 ${totals.completed}개</h3>
      ${table(totals.groups.map(g => `<tr><td>${g.dimension === 'date' ? '날짜' : '차량'}</td><td>${esc(g.key)}</td><td>${esc(g.total == null ? '미상' : g.total)} ${esc(g.unit || '')}</td><td>${g.knownSizes}/${g.sessions}</td></tr>`), ['구분', '날짜 / 차량', '표시값 합계 (환산 전)', '용량 확인 세션'])}
      <h3>검토 대기 · ${candidates.length}개</h3>
      ${table(candidates.map(c => `<tr><td>${badge(c.isMock)} ${esc(c.observation.fields.folder || '폴더명 미상')}</td><td>${esc(c.observation.fields.loggingDate || '날짜 미상')}</td>
        <td><button class="btn ghost" data-logging-action="review" data-id="${esc(c.id)}">검토</button></td></tr>`), ['세션 후보', '날짜', '작업'])}
      <div id="logging-editor"></div>
      <h3>확정 기록 · ${sessions.length}개</h3>
      ${table(sessions.map(s => `<tr><td>${badge(s.isMock)} ${esc(s.data.folder)}</td><td>${esc(s.data.loggingDate)}</td><td>${esc(s.data.vehicleName || '미연결')}</td>
        <td>${esc(s.data.sizeValue || '미상')} ${esc(s.data.sizeUnit || '')}</td><td>${esc(s.data.durationRaw || '미상')}</td>
        <td><button class="btn ghost" data-logging-action="edit" data-id="${esc(s.id)}">상세·수정</button></td></tr>`), ['폴더', '날짜', '차량', '전체 크기', '녹화 시간', '작업'])}
      <details><summary>보관 사진 ${assets.length}장 · 처리 이력</summary>
      ${table(assets.map(a => `<tr><td>${esc(a.original_name)}</td><td>${esc(a.sha256.slice(0, 12))}</td><td><button class="btn ghost" data-logging-action="photo" data-id="${esc(a.asset_id)}">원본 보기</button></td></tr>`), ['원본 파일', 'SHA-256', '작업'])}
      ${table(jobs.map(j => `<tr><td>${esc(j.recognizer)}</td><td>${esc(j.state)}</td><td>${esc(j.error && j.error.message)}</td><td>${j.state === 'failed' ? `<button class="btn ghost" data-logging-action="retry" data-id="${esc(j.id)}">재시도</button>` : ''}</td></tr>`), ['인식기', '상태', '안내', '작업'])}</details>
      <div id="logging-photo-only"></div>`;
  }
  async function preview(assetId, img) {
    const response = await RouteDB.readLoggingAsset(assetId);
    if (!img || !img.isConnected) return;
    revoke(); previewUrl = URL.createObjectURL(new Blob([response.bytes], { type: response.mimeType })); img.src = previewUrl;
  }
  async function openEditor(kind, id) {
    const item = kind === 'candidate' ? await RouteDB.getLoggingCandidate(id) : await RouteDB.getLoggingSession(id);
    if (kind === 'candidate' && item.state !== 'pending') { message('이미 처리된 후보입니다. 새로고침해주세요.'); return; }
    editing = { kind, id, item }; revoke();
    const d = kind === 'candidate' ? item.observation.fields : item.data;
    const el = document.getElementById('logging-editor');
    const options = ['unknown', 'completed', 'recording', 'incomplete', 'failed'];
    const labels = ['알 수 없음', '완료', '녹화 중', '미완료', '실패'];
    el.innerHTML = `<h3>${kind === 'candidate' ? '인식 결과 검토' : '확정 기록 상세·수정'} ${badge(item.isMock)}</h3>
      <div class="logging-review"><div class="logging-original"><img id="logging-preview" alt="LOGGERD 원본 사진"/>
      <p>각 세션의 ‘전체 크기’를 확인하세요. ‘디스크 여유’는 입력하지 마세요.</p>
      ${kind === 'session' ? item.evidence.map((e, i) => `<button type="button" class="btn ghost" data-logging-action="evidence-photo" data-id="${esc(e.assetId)}">근거 사진 ${i + 1}</button>`).join('') : ''}</div>
      <form id="logging-form"><div class="logging-fields">
      ${input('folder', '세션 폴더명', d.folder, { required: true })}
      ${input('loggerScope', 'LOGGERD 장비/설치 구분 (중복 폴더 구별)', d.loggerScope)}
      ${input('loggingDate', '로깅 날짜', d.loggingDate, { required: true, type: 'date' })}
      ${input('startedTime', '시작 시각 (HH:MM:SS)', d.startedTime)}
      ${input('durationRaw', '녹화 시간 (HH:MM:SS)', d.durationRaw)}
      ${input('sizeRaw', '선택한 원본 용량 문자열 (보존)', d.sizeRaw, { readonly: true })}
      ${input('sizeValue', '전체 크기 숫자', d.sizeValue)}
      <label>전체 크기 단위<select name="sizeUnit"><option value="">미상</option>${['GB', 'TB', 'GiB', 'TiB'].map(u => `<option ${d.sizeUnit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      ${input('fileCount', '파일 개수', d.fileCount)}${input('recordingCount', '녹화 횟수', d.recordingCount)}
      <label>LOGGERD 완료 상태<select name="completion">${options.map((v, i) => `<option value="${v}" ${(d.completion || 'unknown') === v ? 'selected' : ''}>${labels[i]}</option>`).join('')}</select></label>
      <label>차량<select name="vehicleName"><option value="">미연결</option>${vehicles.map(v => `<option value="${esc(v.name)}" ${d.vehicleName === v.name ? 'selected' : ''}>${esc(v.displayName || v.name)}</option>`).join('')}</select></label>
      ${input('externalSessionId', '기존 주행 세션 ID (선택)', d.externalSessionId)}
      </div>
      <label>변경·제외 사유<textarea name="reason" maxlength="500" placeholder="수정 또는 중복 처리 시 필요"></textarea></label>
      ${kind === 'candidate' && item.isMock ? '<label class="logging-notice"><input type="checkbox" name="mockAcknowledged" required/> 실제 사진 인식값이 아닌 Mock 후보임을 확인했습니다.</label>' : ''}
      <div id="logging-conflict"></div><p id="logging-form-message" role="alert"></p>
      <div class="logging-actions"><button type="submit" class="btn">${kind === 'candidate' ? '검토 후 확정' : '수정 저장'}</button>
      ${kind === 'candidate' ? '<button type="button" class="btn ghost" data-logging-action="reject">후보 제외</button>' : ''}
      <button type="button" class="btn ghost" data-logging-action="close">닫기</button></div></form></div>
      <details><summary>인식 원문·필드 근거 / 확정 수정 이력</summary>${history(item)}</details>`;
    const assetId = kind === 'candidate' ? item.assetId : item.evidence[0] && item.evidence[0].assetId;
    if (assetId) preview(assetId, document.getElementById('logging-preview')).catch(() => {
      const msg = document.getElementById('logging-form-message'); if (msg) msg.textContent = '원본 사진을 열지 못했어요. 저장된 파일을 확인해주세요.';
    });
    el.scrollIntoView({ block: 'nearest' });
  }
  function readForm(form) {
    const values = Object.fromEntries(new FormData(form));
    return { values, data: LoggingRecords.normalize(values) };
  }
  async function save(form) {
    if (!editing || busy) return;
    const msg = document.getElementById('logging-form-message');
    try {
      const { values, data } = readForm(form);
      if (editing.kind === 'candidate') {
        const duplicate = sessions.find(s => LoggingRecords.identity(s.data) === LoggingRecords.identity(data));
        if (duplicate && (!editing.duplicate || editing.duplicate.id !== duplicate.id)) {
          editing.duplicate = duplicate;
          document.getElementById('logging-conflict').innerHTML = `<h4>같은 세션 폴더가 있습니다</h4><p>기존 확정값과 이번 입력을 비교해 처리 방법을 선택하세요. 사유도 입력해주세요.</p>
            ${compareFields(duplicate.data, data)}
            <label>처리 방법<select name="resolution"><option value="">선택</option><option value="attach">동일한 값: 사진 근거만 추가</option><option value="replace">충돌 검토 완료: 이번 값으로 수정</option></select></label>`;
          msg.textContent = '기존 기록과 비교한 후 다시 확정해주세요.'; return;
        }
        busy = true;
        await RouteDB.confirmLoggingCandidate({ candidateId: editing.id, data, actor: actor(), mockAcknowledged: values.mockAcknowledged === 'on',
          existingId: duplicate && duplicate.id, expectedVersion: duplicate && duplicate.version, resolution: values.resolution, reason: values.reason });
      } else {
        busy = true;
        await RouteDB.updateLoggingSession({ id: editing.id, expectedVersion: editing.item.version, data, reason: values.reason, actor: actor() });
      }
      busy = false; await render(); message('검토한 기록을 저장했습니다.');
    } catch (e) { busy = false; if (msg) msg.textContent = e.message; }
  }
  async function click(event) {
    const target = event.target.closest('[data-logging-action]');
    if (!target || busy) return;
    const action = target.dataset.loggingAction, id = target.dataset.id;
    try {
      if (action === 'pick') {
        busy = true; target.disabled = true; message('원본 사진 보관·Mock 후보 생성 중…');
        const results = await RouteDB.pickLoggingPhotos(); busy = false;
        await render();
        message(`새 사진 ${results.filter(r => r.assetId && !r.duplicate).length}장 · 동일 사진 ${results.filter(r => r.duplicate).length}장 · 실패 ${results.filter(r => r.error).length}장`);
      } else if (action === 'refresh' || action === 'close') await render();
      else if (action === 'review') await openEditor('candidate', id);
      else if (action === 'edit') await openEditor('session', id);
      else if (action === 'evidence-photo') await preview(id, document.getElementById('logging-preview'));
      else if (action === 'photo') {
        const host = document.getElementById('logging-photo-only');
        host.innerHTML = '<img class="logging-photo" alt="보관한 원본 사진"/>';
        await preview(id, host.querySelector('img'));
      } else if (action === 'retry') {
        busy = true; await RouteDB.retryLoggingJob(id); busy = false; await render();
      } else if (action === 'reject' && editing) {
        const form = document.getElementById('logging-form');
        busy = true; await RouteDB.rejectLoggingCandidate({ candidateId: editing.id, reason: new FormData(form).get('reason'), actor: actor() });
        busy = false; await render();
      }
    } catch (e) { busy = false; target.disabled = false; const msg = document.getElementById('logging-form-message'); if (msg) msg.textContent = e.message; else message(e.message); }
  }
  function init() {
    if (initialized || !panel()) return; initialized = true;
    panel().addEventListener('click', click);
    panel().addEventListener('submit', e => { if (e.target.id === 'logging-form') { e.preventDefault(); save(e.target); } });
    panel().addEventListener('change', e => { if (e.target.id === 'logging-include-mock') { includeMock = e.target.checked; render().catch(() => message('목록을 불러오지 못했어요.')); } });
    if (global.routeAPI && typeof global.routeAPI.onLoggingChange === 'function') global.routeAPI.onLoggingChange(() => {
      RouteDB.notifyChange('logging:changed', []);
      if (!editing && !busy && typeof currentTab !== 'undefined' && currentTab === 'data') render().catch(() => {});
    });
    global.addEventListener('beforeunload', revoke);
  }
  global.initLoggingRecordsView = init;
  global.renderLoggingRecordsPanel = async () => { init(); if (editing || busy) return; try { await render(); } catch (_) { if (panel()) panel().textContent = 'LOGGERD 기록을 불러오지 못했어요. 앱을 다시 열어주세요.'; } };
}(window));
