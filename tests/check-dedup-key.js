// 중복 판정 키(date|time|vehicle|lat|lng)로 합쳐지는 행들이
// 정말 "완전히 같은 행"인지, 아니면 다른 정보를 가진 행을 잃는지 확인한다.
'use strict';
const fs = require('fs');
const path = require('path');
const RouteParser = require('../src/js/parser.js');

const XLSX_DIR = path.join(__dirname, '..', '주행기록');
let totalRows = 0, totalKeys = 0, lossy = 0;
const lossySamples = [];

for (const f of fs.readdirSync(XLSX_DIR).filter(x => /\.xlsx?$/i.test(x)).sort()) {
  const recs = RouteParser.parseBuffer(fs.readFileSync(path.join(XLSX_DIR, f)));
  const groups = new Map();
  for (const r of recs) {
    const key = [r.date, r.time, r.vehicle, r.lat.toFixed(6), r.lng.toFixed(6)].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let fileLossy = 0;
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const rest = r => JSON.stringify([r.place, r.road, r.speed, r.zone, r.weather, r.timeOfDay, r.traffic]);
    const first = rest(rows[0]);
    if (rows.some(r => rest(r) !== first)) {
      fileLossy++;
      if (lossySamples.length < 5) lossySamples.push({ file: f, key, rows: rows.map(rest) });
    }
  }
  totalRows += recs.length;
  totalKeys += groups.size;
  lossy += fileLossy;
  console.log(`${f}\n   원본 ${recs.length}행 → 고유키 ${groups.size}개 (합쳐짐 ${recs.length - groups.size}행) · 값이 다른데 합쳐짐: ${fileLossy}건`);
}

console.log(`\n합계: 원본 ${totalRows}행 → 고유키 ${totalKeys}개`);
console.log(`값이 서로 다른데 같은 키로 합쳐진 그룹: ${lossy}건`);
if (lossySamples.length) {
  console.log('\n예시:');
  lossySamples.forEach(s => console.log(' ', s.file, s.key, JSON.stringify(s.rows)));
}
