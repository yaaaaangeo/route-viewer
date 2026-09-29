// ══════════════════════════════════════════════════════════
//  quality — 데이터 품질 검사
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
//  데이터 품질 체크 — 30초 주기로 찍혀야 할 GPS 기록에서
//  1) 간격이 훨씬 벌어진 구간(기록 누락 의심)
//  2) 짧은 시간 안에 말도 안 되게 멀리 튄 좌표(GPS 오차/버그 의심)
//  을 자동으로 찾아낸다.
// ══════════════════════════════════════════════════════════
const GAP_THRESHOLD_SEC=90;    // 30초 주기의 3배 이상 벌어지면 누락 의심
const TELEPORT_SPEED_KMH=150;  // 도시 주행에서 나올 수 없는 속도면 좌표 점프 의심

function timeToSec(t){
  if(!t) return null;
  const parts=String(t).split(':').map(Number);
  if(parts.length<3||parts.some(isNaN)) return null;
  return parts[0]*3600+parts[1]*60+parts[2];
}

// 차량마다 따로 검사한다 — 섞인 채로 앞뒤를 비교하면 차량이 바뀌는 자리마다
// 가짜 '좌표 점프'가 잡힌다(core.js vehicleIndexPartitions 주석 참고).
// gaps/teleports 의 i 는 뒤쪽 점, prevI 는 같은 차량의 바로 앞 점 — 섞인 배열에서는
// prevI 가 i-1 이 아닐 수 있으니 쓰는 쪽도 prevI 를 봐야 한다.
function analyzeDayQuality(sortedPoints){
  const gaps=[], teleports=[];
  for(const part of vehicleIndexPartitions(sortedPoints)){
    for(let k=1;k<part.length;k++){
      const prevI=part[k-1], i=part[k];
      const prev=sortedPoints[prevI], cur=sortedPoints[i];
      const t1=timeToSec(prev.time), t2=timeToSec(cur.time);
      let dtSec=null;
      if(t1!=null&&t2!=null){
        dtSec=t2-t1;
        if(dtSec<0) dtSec+=86400; // 자정을 넘어간 경우 보정
      }
      if(dtSec!=null&&dtSec>GAP_THRESHOLD_SEC){
        gaps.push({i,prevI,fromTime:prev.time,toTime:cur.time,gapSec:dtSec});
      }
      const distM=haversine(prev.lat,prev.lng,cur.lat,cur.lng);
      if(dtSec!=null&&dtSec>0){
        const speedKmh=(distM/dtSec)*3.6;
        if(speedKmh>TELEPORT_SPEED_KMH){
          teleports.push({i,prevI,time:cur.time,speedKmh,distM});
        }
      }else if(dtSec===0&&distM>200){
        // 같은 시각에 200m 넘게 떨어진 좌표 → 명백한 GPS 오류
        teleports.push({i,prevI,time:cur.time,speedKmh:Infinity,distM});
      }
    }
  }
  // 차량별로 돌았으니 목록이 차량 순서로 묶여 있다 — 화면에는 시간순으로 보여준다
  gaps.sort((a,b)=>a.i-b.i);
  teleports.sort((a,b)=>a.i-b.i);
  const suspectIdx=new Set();
  gaps.forEach(g=>{ suspectIdx.add(g.prevI); suspectIdx.add(g.i); });
  teleports.forEach(t=>{ suspectIdx.add(t.prevI); suspectIdx.add(t.i); });
  return {gaps,teleports,suspectIdx,total:gaps.length+teleports.length};
}

function renderQualityPanel(quality){
  const el=document.getElementById('quality-panel');
  if(!quality||quality.total===0){
    el.className='quality-ok';
    el.innerHTML=`<span class="qp-badge ok">정상</span><span class="qp-note">시간 간격·좌표 점프 이상 없음</span>`;
    el.style.display='flex';
    return;
  }
  el.className='quality-warn';
  const items=[];
  quality.gaps.forEach(g=>items.push(`⏱ ${g.fromTime} → ${g.toTime} 사이 ${g.gapSec}초 공백 (기록 누락 의심)`));
  quality.teleports.forEach(t=>items.push(`📍 ${t.time} 지점 좌표 점프 (추정 ${isFinite(t.speedKmh)?Math.round(t.speedKmh)+'km/h':'순간이동'})`));
  el.innerHTML=`
    <div class="qp-header">
      <span class="qp-badge warn">⚠ 의심 ${quality.total}건</span>
      <span class="qp-note">지도 위에도 표시했어요 — 아래 목록으로 바로 확인 가능</span>
    </div>
    <div class="qp-list">${items.map(t=>`<div class="qp-item">${t}</div>`).join('')}</div>
  `;
  el.style.display='block';
}
