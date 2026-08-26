// ══════════════════════════════════════════════════════════
//  parser — nav-app "오늘 기록 다운로드" 파일(.xlsx/.xls/.csv) 역파싱
//
//  브라우저(전역 XLSX)와 Node(require('xlsx')) 양쪽에서 같은 코드를 쓴다.
//  테스트가 화면과 정확히 같은 파싱 결과를 검증할 수 있도록 하기 위함.
//
//  실제 파일 헤더 예:
//    A1  차량 | 토레스 3호차 | 이름 | 최수헌 | 입장시각 | 09:01:55
//    A3  번호 | 날짜 | 시각 | GPS위치 | 도로종류 | 날씨 | 시간대 | 장소 | 교통밀도 | 차량속도(km/h)
//  → 데이터 행에는 '차량'/'구역' 열이 없다.
//    · 차량 = 1행의 정보값을 그날 전체 차량으로 사용
//    · 구역 = '장소' 텍스트에서 강남/판교/시흥을 찾아 추론
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('xlsx'));
  } else {
    root.RouteParser = factory(root.XLSX);
  }
}(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';

  const ZONE_NAMES = ['강남', '판교', '시흥'];

  function parseRouteWorkbook(wb) {
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows.length) return [];

    // 파일 맨 위 로그인 정보 행("차량", "토레스 1호차", "이름", ...) — 데이터 행에
    // '차량' 열이 따로 없을 때 이 값을 그날 전체의 차량으로 대신 쓴다.
    let infoRowVehicle = '';
    if (rows[0] && String(rows[0][0] || '').trim() === '차량') {
      infoRowVehicle = String(rows[0][1] || '').trim();
    }

    let headerIdx = -1;
    let colGps = -1, colTime = -1, colDate = -1, colPlace = -1, colSpeed = -1,
      colRoad = -1, colZone = -1, colVehicle = -1, colWeather = -1,
      colTimeOfDay = -1, colTraffic = -1;

    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const idx = rows[i].findIndex(c => String(c).trim() === 'GPS위치');
      if (idx >= 0) {
        headerIdx = i; colGps = idx;
        const find = name => rows[i].findIndex(c => String(c).trim() === name);
        colTime = find('시각');
        colDate = find('날짜');
        colPlace = find('장소');
        colRoad = find('도로종류');
        colSpeed = rows[i].findIndex(c => String(c).trim().startsWith('차량속도'));
        colZone = find('구역');
        colVehicle = find('차량');
        colWeather = find('날씨');
        colTimeOfDay = find('시간대');
        colTraffic = rows[i].findIndex(c => {
          const t = String(c).trim();
          return t === '교통밀도' || t === '교통량';
        });
        break;
      }
    }
    if (headerIdx < 0) return [];

    const out = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.length) continue;
      const raw = String(r[colGps] || '').trim();
      const m = raw.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
      if (!m) continue;
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (!isFinite(lat) || !isFinite(lng)) continue;

      const placeVal = colPlace >= 0 ? String(r[colPlace] || '').trim() : '';
      let zoneVal = colZone >= 0 ? String(r[colZone] || '').trim() : '';
      if ((!zoneVal || zoneVal === '—') && placeVal) {
        // '구역' 열이 없는 파일 대비: '장소' 텍스트에 강남/판교/시흥이 들어있으면 그걸로 판단
        const found = ZONE_NAMES.find(z => placeVal.includes(z));
        if (found) zoneVal = found;
      }
      let vehicleVal = colVehicle >= 0 ? String(r[colVehicle] || '').trim() : '';
      if ((!vehicleVal || vehicleVal === '—') && infoRowVehicle) vehicleVal = infoRowVehicle;

      const clean = v => (v && v !== '—' ? v : '');
      const weatherVal = colWeather >= 0 ? String(r[colWeather] || '').trim() : '';
      const timeOfDayVal = colTimeOfDay >= 0 ? String(r[colTimeOfDay] || '').trim() : '';
      const trafficVal = colTraffic >= 0 ? String(r[colTraffic] || '').trim() : '';

      out.push({
        lat, lng,
        date: colDate >= 0 ? normalizeDate(r[colDate]) : '',
        time: colTime >= 0 ? normalizeTime(r[colTime]) : '',
        place: placeVal,
        road: colRoad >= 0 ? String(r[colRoad] || '').trim() : '',
        speed: colSpeed >= 0 ? String(r[colSpeed] || '').trim() : '',
        zone: clean(zoneVal),
        vehicle: clean(vehicleVal),
        weather: clean(weatherVal),
        timeOfDay: clean(timeOfDayVal),
        traffic: clean(trafficVal),
      });
    }
    return out;
  }

  // 엑셀이 날짜를 Date 객체나 시리얼 숫자로 넘겨줄 때가 있어 YYYY-MM-DD 로 통일한다.
  // (중복 판정 키에 들어가는 값이라 표기가 흔들리면 안 된다)
  function normalizeDate(v) {
    if (v instanceof Date && !isNaN(v.getTime())) {
      const p = n => String(n).padStart(2, '0');
      return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    const s = String(v == null ? '' : v).trim();
    const m = s.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (m) {
      const p = n => String(n).padStart(2, '0');
      return `${m[1]}-${p(m[2])}-${p(m[3])}`;
    }
    return s;
  }

  // 시각도 마찬가지로 HH:MM:SS 로 통일
  function normalizeTime(v) {
    if (v instanceof Date && !isNaN(v.getTime())) {
      const p = n => String(n).padStart(2, '0');
      return `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
    }
    const s = String(v == null ? '' : v).trim();
    const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const p = n => String(n).padStart(2, '0');
      return `${p(m[1])}:${m[2]}:${m[3] || '00'}`;
    }
    return s;
  }

  function parseBuffer(buffer) {
    const wb = XLSX.read(buffer, { type: buffer instanceof Uint8Array ? 'array' : 'buffer' });
    return parseRouteWorkbook(wb);
  }

  return { parseRouteWorkbook, parseBuffer, normalizeDate, normalizeTime, ZONE_NAMES };
}));
