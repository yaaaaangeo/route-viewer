// ══════════════════════════════════════════════════════════
//  osm-tile-ua — OSM 배경 타일 요청에 앱을 식별하는 User-Agent 를 붙인다.
//
//  왜 필요한가: tile.openstreetmap.org 는 자원봉사가 운영해서 타일 사용 정책
//  (operations.osmfoundation.org/policies/tiles)이 "앱을 식별할 수 있는 User-Agent"를
//  요구한다. Electron 기본 UA(…Electron/38.2.2 Safari/537.36)로 요청하면 타일 대신
//  "Access blocked" 403 이미지가 오고(응답에 `x-blocked: Access denied` 헤더), 지도가
//  노란 빗금으로 덮인다. 실제로 확인한 값: 차단 이미지 6,987바이트 / 정상 타일 43,121바이트.
//
//  브라우저 모드(server.js + 크롬)는 브라우저 자신의 UA 로 나가서 그대로 통과하므로
//  이 파일은 Electron(데스크톱 앱)에서만 쓴다.
// ══════════════════════════════════════════════════════════
'use strict';

// 타일 요청에만 건다 — Overpass API 등 다른 요청의 UA 는 그대로 둔다.
const OSM_TILE_URLS = ['https://*.tile.openstreetmap.org/*'];

// 정책이 요구하는 형식: 앱 이름 + 버전 + 연락처(문제 시 OSM 이 연락할 수 있어야 한다)
function osmTileUserAgent(version) {
  return `RouteViewer/${version || '0.0.0'} (+https://github.com/yaaaaangeo/route-viewer)`;
}

// session: Electron Session (보통 session.defaultSession)
// 반환: 실제로 건 UA 문자열 (걸지 못했으면 null)
function applyOsmTileUserAgent(session, version) {
  if (!session || !session.webRequest) return null;
  const ua = osmTileUserAgent(version);
  session.webRequest.onBeforeSendHeaders({ urls: OSM_TILE_URLS }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'User-Agent': ua } });
  });
  return ua;
}

module.exports = { OSM_TILE_URLS, osmTileUserAgent, applyOsmTileUserAgent };
