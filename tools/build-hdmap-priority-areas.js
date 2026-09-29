// ══════════════════════════════════════════════════════════
//  build-hdmap-priority-areas.js
//
//  src/data/hdmap-priority-areas.json(사람이 고치는 원본 GeoJSON)을
//  src/data/hdmap-priority-areas.js(브라우저용 window 전역)로 복사한다.
//
//  왜 두 벌인가 — hdmap_gangnam_roads.js/.json 과 같은 이유다.
//  src/index.html 을 file:// 로 그냥 열었을 때 fetch()로 로컬 JSON 을 읽는 건
//  브라우저 CORS 정책에 막히지만(Failed to fetch), <script src="..."> 태그는 막히지 않는다.
//  Node(Electron main · 테스트)는 .json 을 require 한다.
//
//  ①~⑫ 경계를 .json 에 채운 뒤 이걸 한 번 실행하면 화면에도 반영된다.
//
//  실행: node tools/build-hdmap-priority-areas.js
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'src', 'data');
const SRC = path.join(DATA_DIR, 'hdmap-priority-areas.json');
const OUT = path.join(DATA_DIR, 'hdmap-priority-areas.js');
const GLOBAL_VAR = 'HDMAP_PRIORITY_AREAS';

const raw = fs.readFileSync(SRC, 'utf8');
const data = JSON.parse(raw);   // 형식이 깨졌으면 여기서 멈춘다

const features = data.features || [];
const filled = features.filter(f => f && f.geometry);
console.log(`구역 ${features.length}개 · 경계 있음 ${filled.length}개 · 경계 미설정 ${features.length - filled.length}개`);
if (filled.length !== features.length) {
  const missing = features.filter(f => !f || !f.geometry).map(f => (f && f.properties && f.properties.areaNo) || '?');
  console.log(`  경계 미설정: ${missing.join(', ')} — 통계 화면에서는 '경계 미설정'으로만 표시되고 집계에서 빠집니다.`);
}

const js = `// 자동 생성 파일 — tools/build-hdmap-priority-areas.js 로 다시 만든다. 직접 고치지 말 것.\n`
  + `// 원본: src/data/hdmap-priority-areas.json\n`
  + `window.${GLOBAL_VAR} = ${JSON.stringify(data)};\n`;
fs.writeFileSync(OUT, js, 'utf8');
console.log(`완료: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
