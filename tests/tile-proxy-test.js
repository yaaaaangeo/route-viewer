// ══════════════════════════════════════════════════════════
//  tile-proxy-test — server.js 의 배경 지도 타일 프록시(/tiles/z/x/y.png) 검증.
//
//  진짜 OSM 대신 가짜 타일 서버를 띄워 ROUTE_VIEWER_TILE_UPSTREAM 으로 연결한다
//  (인터넷 불필요, OSM 에 부하 없음). 가짜 서버는 OSM 처럼 행동한다:
//    · 보통 타일: 200 image/png
//    · y=999: 200 image/png 인데 x-blocked 헤더 — OSM 차단 이미지와 같은 모양(상태 코드는 정상!)
//    · y=998: 403
//
//    · 앱 식별 User-Agent 로 요청하고, 서브도메인은 (x+y)%3 으로 고른다
//    · 처음엔 MISS(받아서 캐시), 다음엔 HIT(OSM 에 다시 안 감)
//    · 같은 타일 동시 요청 → OSM 에는 한 번만
//    · 차단/403 → 502, 캐시하지 않음, 서버 창에 거절 로그
//    · 차단됐어도 예전에 받아 둔(오래된) 타일이 있으면 STALE 로 준다
//    · 잘못된 좌표·경로 → 404, 기존 정적 파일 제공은 그대로
// ══════════════════════════════════════════════════════════
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 8098;
const UP_PORT = 8111;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 가짜 OSM ──
const upstreamHits = [];
const upstream = http.createServer((req, res) => {
  const m = /^\/([abc])\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(req.url);
  upstreamHits.push({ url: req.url, ua: req.headers['user-agent'] || '', sub: m && m[1] });
  if (!m) { res.writeHead(404); res.end(); return; }
  const [, , z, x, y] = m;
  setTimeout(() => { // 동시 요청이 겹치게 조금 늦게 응답
    if (y === '999') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'x-blocked': 'Access denied. See https://operations.osmfoundation.org/policies/tiles/' });
      res.end('BLOCKED-IMAGE');
    } else if (y === '998') {
      res.writeHead(403, { 'Content-Type': 'image/png' });
      res.end('FORBIDDEN');
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(`TILE ${z}/${x}/${y}`);
    }
  }, 80);
});

async function get(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('x-tile-cache'), body: Buffer.from(await res.arrayBuffer()).toString() };
}
const hitsFor = (z, x, y) => upstreamHits.filter(h => h.url.endsWith(`/${z}/${x}/${y}.png`)).length;

(async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-tile-cache-'));
  await new Promise(r => upstream.listen(UP_PORT, '127.0.0.1', r));

  let serverLog = '';
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      ROUTE_VIEWER_TILE_UPSTREAM: `http://127.0.0.1:${UP_PORT}/{s}/{z}/{x}/{y}.png`,
      ROUTE_VIEWER_TILE_CACHE: cacheDir,
    },
  });
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { up = (await fetch(BASE + '/src/index.html')).ok; } catch (_) { await sleep(150); }
    }
    check('server.js 가 뜬다', up);

    console.log('\n[1] 처음 받는 타일');
    const a = await get('/tiles/14/13973/6348.png');
    check('200 image/png · MISS · 가짜 OSM 이 준 내용 그대로', a.status === 200 && a.type === 'image/png' && a.cache === 'MISS' && a.body === 'TILE 14/13973/6348',
      `${a.status} ${a.type} ${a.cache} "${a.body}"`);
    const first = upstreamHits.find(h => h.url.endsWith('/14/13973/6348.png'));
    check('OSM 에 앱 식별 User-Agent 로 요청한다(타일 정책)', !!first && /^RouteViewer\/\d+\.\d+\.\d+ \(\+https:\/\//.test(first.ua), first && first.ua);
    check('서브도메인은 (x+y)%3 으로 고른다', !!first && first.sub === 'abc'[(13973 + 6348) % 3], first && first.sub);
    check('디스크에 캐시된다', fs.existsSync(path.join(cacheDir, '14', '13973', '6348.png')));

    console.log('\n[2] 같은 타일 다시');
    const b = await get('/tiles/14/13973/6348.png');
    check('HIT · OSM 에 다시 요청하지 않는다', b.status === 200 && b.cache === 'HIT' && b.body === 'TILE 14/13973/6348' && hitsFor(14, 13973, 6348) === 1,
      `${b.cache} · OSM 요청 ${hitsFor(14, 13973, 6348)}번`);

    console.log('\n[3] 같은 새 타일 동시 5건');
    const many = await Promise.all(Array.from({ length: 5 }, () => get('/tiles/15/100/200.png')));
    check('5건 모두 200 · OSM 에는 한 번만', many.every(r => r.status === 200 && r.body === 'TILE 15/100/200') && hitsFor(15, 100, 200) === 1,
      `OSM 요청 ${hitsFor(15, 100, 200)}번`);

    console.log('\n[4] OSM 차단 이미지(HTTP 200 + x-blocked)');
    const blocked = await get('/tiles/10/5/999.png');
    check('502 로 거절한다(차단 이미지를 화면에 넘기지 않는다)', blocked.status === 502 && /x-blocked/.test(blocked.body), `${blocked.status} "${blocked.body.slice(0, 60)}"`);
    check('차단 이미지는 캐시하지 않는다', !fs.existsSync(path.join(cacheDir, '10', '5', '999.png')));
    await sleep(100);
    check('서버 창에 거절 로그가 남는다', /\[tiles\] OSM 이 타일 10\/5\/999 를 거절: HTTP 200 · x-blocked: Access denied/.test(serverLog),
      (serverLog.match(/\[tiles\][^\n]*/) || [''])[0]);
    const again = await get('/tiles/10/5/999.png');
    check('다음 요청도 다시 시도한다(거절이 캐시되지 않음)', again.status === 502 && hitsFor(10, 5, 999) === 2, `OSM 요청 ${hitsFor(10, 5, 999)}번`);

    console.log('\n[5] OSM 403');
    const forbidden = await get('/tiles/10/6/998.png');
    check('502 · 캐시하지 않음', forbidden.status === 502 && /HTTP 403/.test(forbidden.body) && !fs.existsSync(path.join(cacheDir, '10', '6', '998.png')),
      `${forbidden.status} "${forbidden.body}"`);

    console.log('\n[6] 차단됐지만 예전에 받아 둔 타일이 있을 때');
    const staleFile = path.join(cacheDir, '10', '7', '999.png');
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, 'OLD TILE');
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(staleFile, old, old);
    const stale = await get('/tiles/10/7/999.png');
    check('다시 받아 보고, 거절되면 STALE 로 예전 타일을 준다', stale.status === 200 && stale.cache === 'STALE' && stale.body === 'OLD TILE' && hitsFor(10, 7, 999) === 1,
      `${stale.status} ${stale.cache} "${stale.body}"`);

    console.log('\n[7] 잘못된 요청');
    const bad = {
      '줌 20(최대 19 초과)': await get('/tiles/20/0/0.png'),
      'x 범위 밖(z3 은 0~7)': await get('/tiles/3/8/0.png'),
      '확장자 다름': await get('/tiles/1/0/0.txt'),
      '경로 벗어나기': await get('/tiles/..%2F..%2Fserver.js'),
      '숫자 아님': await get('/tiles/a/b/c.png'),
    };
    const hitsBefore = upstreamHits.length;
    check('전부 404 · OSM 에 요청하지 않는다', Object.values(bad).every(r => r.status === 404) && upstreamHits.length === hitsBefore,
      Object.entries(bad).map(([k, r]) => `${k}:${r.status}`).join(' '));

    console.log('\n[8] 기존 기능');
    const page = await get('/src/index.html');
    check('정적 파일 제공은 그대로', page.status === 200 && /<title>/.test(page.body));
  } catch (err) {
    failed++; failures.push('예외: ' + err.message); console.error(err);
  } finally {
    server.kill();
    upstream.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failures.length) failures.forEach(f => console.log('   - ' + f));
  console.log('─'.repeat(60));
  process.exit(failed ? 1 : 0);
})();
