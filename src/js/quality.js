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

function analyzeDayQuality(sortedPoints){
  const gaps=[], teleports=[];
  for(let i=1;i<sortedPoints.length;i++){
    const prev=sortedPoints[i-1], cur=sortedPoints[i];
    const t1=timeToSec(prev.time), t2=timeToSec(cur.time);
    let dtSec=null;
    if(t1!=null&&t2!=null){
      dtSec=t2-t1;
      if(dtSec<0) dtSec+=86400; // 자정을 넘어간 경우 보정
    }
    if(dtSec!=null&&dtSec>GAP_THRESHOLD_SEC){
      gaps.push({i,fromTime:prev.time,toTime:cur.time,gapSec:dtSec});
    }
    const distM=haversine(prev.lat,prev.lng,cur.lat,cur.lng);
    if(dtSec!=null&&dtSec>0){
      const speedKmh=(distM/dtSec)*3.6;
      if(speedKmh>TELEPORT_SPEED_KMH){
        teleports.push({i,time:cur.time,speedKmh,distM});
      }
    }else if(dtSec===0&&distM>200){
      // 같은 시각에 200m 넘게 떨어진 좌표 → 명백한 GPS 오류
      teleports.push({i,time:cur.time,speedKmh:Infinity,distM});
    }
  }
  const suspectIdx=new Set();
  gaps.forEach(g=>{ suspectIdx.add(g.i-1); suspectIdx.add(g.i); });
  teleports.forEach(t=>{ suspectIdx.add(t.i-1); suspectIdx.add(t.i); });
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
