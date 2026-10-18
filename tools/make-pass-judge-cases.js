// ══════════════════════════════════════════════════════════
//  통과 판정 공용 시험 파일 만들기 — tests/fixtures/pass_judge_cases.json
//
//  nav-app 과 Route Viewer 가 같은 궤적에 같은 판정을 내는지 확인하는 사례 모음.
//    · intent : 사람이 정한 뜻 (예: 역방향 주행은 정방향 통과 0회) — 두 저장소 시험이 모두 확인
//    · result : 이 규격(nav-app-pass-v1)으로 계산한 정확한 값 — 두 구현이 숫자까지 같아야 한다
//  합성 데이터다(직선 400m 도로 · 1초 측위 · 정해진 잡음). 실제 주행 기록이 아니다.
//
//  실행: node tools/make-pass-judge-cases.js   (규칙을 바꿨을 때만 — 만든 파일을 nav-app tests/fixtures 에도 복사)
// ══════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const CL = require('../src/js/collection-loop.js');

const LAT0 = 37.5000, LNG0 = 127.0300;
const kx = 111320 * Math.cos(LAT0 * Math.PI / 180), ky = 110540;
const toLL = (x, y) => [Math.round((LAT0 + y / ky) * 1e7) / 1e7, Math.round((LNG0 + x / kx) * 1e7) / 1e7];
// 대상 도로: 동쪽으로 400m (5점) · 반대 차도: 북쪽 12m 나란히 · 옆길: 남쪽 30m
const PATH = [0, 100, 200, 300, 400].map(x => toLL(x, 0));
const TWIN = [400, 300, 200, 100, 0].map(x => toLL(x, 12));
let seed = 42;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
/** x0→x1 을 speed m/s 로, 옆으로 y m, 잡음 ±noise m — t 는 t0 초부터 1초마다 */
function drive(x0, x1, y, o) {
  o = o || {};
  const speed = o.speed || 8, out = [];
  const dir = Math.sign(x1 - x0), n = Math.floor(Math.abs(x1 - x0) / speed);
  let t = o.t0 || 36000;
  for (let i = 0; i <= n; i++) {
    const x = x0 + dir * speed * i + (o.noise ? rnd() * 2 * o.noise : 0);
    const yy = y + (o.noise ? rnd() * 2 * o.noise : 0);
    const [lat, lng] = toLL(x, yy);
    out.push({ lat, lng, t });
    t += 1;
  }
  return out;
}
const shift = (track, sec) => track.map(p => ({ ...p, t: p.t + sec }));
const lastT = tr => tr[tr.length - 1].t;

const cases = [];
const add = (name, desc, track, options, intent) => cases.push({ name, desc, track, path: PATH, options: options || {}, intent });

add('two_way_forward', '정방향으로 끝까지 (잡음 ±3m)', drive(-30, 430, 0, { noise: 3 }), {}, { forwardPasses: 1, backwardPasses: 0 });
add('reverse', '역방향으로 끝까지 — 정방향 통과로 인정하지 않는다', drive(430, -30, 0, { noise: 3 }), {}, { forwardPasses: 0, backwardPasses: 1 });
add('twin_carriageway_with_neighbor', '북쪽 12m 반대 차도를 서쪽으로 — 옆 도로가 더 가까워 대상 도로 기록 아님', drive(430, -30, 12, { noise: 2 }),
  { neighbors: [TWIN] }, { forwardPasses: 0, backwardPasses: 0, onNeighborMin: 40 });
add('twin_carriageway_without_neighbor', '같은 궤적인데 옆 도로 정보가 없으면 대상 도로 역방향으로 보인다 (옆 도로 정보가 필요한 이유)', drive(430, -30, 12, { noise: 2 }),
  {}, { forwardPasses: 0, backwardPasses: 1 });
add('side_road_30m', '남쪽 30m 나란한 길 — 허용 25m 밖', drive(-30, 430, -30, { noise: 2 }), {}, { forwardPasses: 0, backwardPasses: 0 });
add('offset_24m', '24m 옆(허용 25m 안)', drive(-30, 430, -24), {}, { forwardPasses: 1 });
add('offset_26m', '26m 옆(허용 25m 밖)', drive(-30, 430, -26), {}, { forwardPasses: 0 });
add('coverage_75', '구간의 75%만 — 통과 아님 (기준 80%)', drive(-30, 300, 0), {}, { forwardPasses: 0, forwardPartials: 1 });
add('coverage_82', '구간의 82% — 통과', drive(-30, 328, 0), {}, { forwardPasses: 1 });
(() => {
  const a = drive(-30, 200, 0), b = shift(drive(200, 430, 0), lastT(drive(-30, 200, 0)) - 36000 + 90);
  add('gap_90s_split', '절반 → 90초 측위 끊김 → 나머지 절반 — 다른 주행 구간이라 한 통과로 잇지 않는다', a.concat(b), {}, { forwardPasses: 0, forwardPartials: 2, runs: 2 });
  const c = shift(drive(200, 430, 0), lastT(drive(-30, 200, 0)) - 36000 + 30);
  add('gap_30s_tunnel', '절반 → 30초 끊김(터널 등) → 나머지 — 같은 통과, 끊긴 시간은 5초만 수집으로', a.concat(c), {}, { forwardPasses: 1, forwardSecondsMax: 65 });
})();
(() => {
  const tr = drive(-30, 430, 0);
  const withJumps = [];
  tr.forEach((p, i) => { withJumps.push(p); if (i % 10 === 5) withJumps.push({ lat: p.lat + 0.009, lng: p.lng, t: p.t + 0.5 }); });
  add('jumps', '측위 튐(1km) 6번 — 버리고 통과·시간을 부풀리지 않는다', withJumps, {}, { forwardPasses: 1, jumpsMin: 5 });
})();
add('slow_noisy', '3m/s 저속 · 잡음 ±3m — 방향이 흔들려도 통과는 1회', drive(-30, 430, 0, { speed: 3, noise: 3 }), {}, { forwardPasses: 1, backwardPasses: 0 });
(() => {
  const a = drive(-30, 200, 0), t1 = lastT(a);
  const stop = []; for (let k = 1; k <= 90; k++) stop.push({ ...a[a.length - 1], lat: a[a.length - 1].lat + (k % 2) * 0.000005, t: t1 + k });
  const b = shift(drive(200, 430, 0), t1 + 91 - 36000);
  add('stop_90s_on_segment', '구간 중간 신호 대기 90초(측위는 계속) — 한 통과', a.concat(stop, b), {}, { forwardPasses: 1 });
})();
add('crossing', '수직으로 가로지름(교차로) — 대상 도로 기록 아님', (() => {
  const out = []; let t = 36000;
  for (let y = -60; y <= 60; y += 8) { const [lat, lng] = toLL(200, y); out.push({ lat, lng, t }); t += 1; }
  return out;
})(), {}, { forwardPasses: 0, backwardPasses: 0 });
(() => {
  const a = drive(-30, 430, 0), b = shift(drive(-30, 430, 0), 7200);
  add('window', '시간대 안 1회 + 2시간 뒤 시간대 밖 1회', a.concat(b), { window: { fromSec: 35900, toSec: 37000 } }, { forwardPasses: 2, forwardWindowPasses: 1 });
})();
add('connector_clip', '연결 경로가 구간 앞 30%만 스침 — 통과 아님', drive(-30, 120, 0), {}, { forwardPasses: 0, forwardPartials: 1 });

const out = {
  format: 'nav-app-pass-judge-cases', judge: CL.PASS_JUDGE_VERSION, defaults: CL.PASS_JUDGE_DEFAULTS,
  note: '합성 궤적(실제 주행 아님). intent 는 사람이 정한 뜻, result 는 이 규격의 정확한 값 — nav-app 과 Route Viewer 가 모두 같아야 한다.',
  cases: cases.map(c => {
    const j = CL.passJudge(c.track, c.path, c.options);
    const pick = r => ({ coverage: r.coverage, cells: r.cells, seconds: r.seconds, windowSeconds: r.windowSeconds, passes: r.passes, windowPasses: r.windowPasses, partials: r.partials });
    return { ...c, result: { totalCells: j.totalCells, points: j.points, used: j.used, jumps: j.jumps, gaps: j.gaps, runs: j.runs, onTarget: j.onTarget, onNeighbor: j.onNeighbor,
      unknownHeading: j.unknownHeading, forward: pick(j.forward), backward: pick(j.backward) } };
  }),
};
const file = path.join(__dirname, '..', 'tests', 'fixtures', 'pass_judge_cases.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(file, out.cases.length + '개');
out.cases.forEach(c => console.log(c.name.padEnd(32), `F ${c.result.forward.passes}회 ${c.result.forward.coverage} ${c.result.forward.seconds}s 부분${c.result.forward.partials}`,
  `| B ${c.result.backward.passes}회 ${c.result.backward.coverage}`, `| 옆${c.result.onNeighbor} 튐${c.result.jumps} 구간${c.result.runs}`, '| 의도', JSON.stringify(c.intent)));
