export const AUDIT = () => {
  const px = c => { const m = String(c).match(/[\d.]+/g) || []; return [+m[0]||0,+m[1]||0,+m[2]||0, m[3]===undefined?1:+m[3]]; };
  const lum = ([r,g,b]) => { const f=v=>{v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4);}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const over = (fg,bg) => { const a=fg[3]; return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a)); };
  const effBg = el => { let n=el, acc=null; while(n && n!==document.documentElement){ const c=px(getComputedStyle(n).backgroundColor); if(c[3]>0){ if(!acc) acc=c; else acc=[...over(acc,c),1]; if(acc[3]>=0.99||c[3]>=0.99) return acc.slice(0,3);} n=n.parentElement;} return acc?acc.slice(0,3):[11,18,32]; };
  const contrast=(a,b)=>{const l1=lum(a),l2=lum(b);return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);};
  const sel=el=>{let s=el.tagName.toLowerCase(); const c=String(el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className||'').trim().split(/\s+/).filter(Boolean).slice(0,3); if(c.length)s+='.'+c.join('.'); return s;};
  // 조상이 overflow를 자르면 요소는 그 교집합만큼만 실제로 보인다.
  // 이걸 모르면 클립되어 안 보이는 요소가 겹침으로 잡힌다(티커 퇴장 애니메이션 등).
  const clipRect = el => {
    let r = el.getBoundingClientRect();
    let t = r.top, l = r.left, b = r.bottom, rt = r.right;
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const pr = n.getBoundingClientRect();
      t = Math.max(t, pr.top); l = Math.max(l, pr.left);
      b = Math.min(b, pr.bottom); rt = Math.min(rt, pr.right);
    }
    return { top: t, left: l, bottom: b, right: rt, width: Math.max(0, rt - l), height: Math.max(0, b - t) };
  };
  const vw=innerWidth, vh=innerHeight;
  const lowContrast=[],hOverflow=[],hidScroll=[],tinyTap=[],clippedLH=[];
  document.querySelectorAll('body *').forEach(el=>{
    const cs=getComputedStyle(el);
    if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0')return;
    const r=el.getBoundingClientRect(); if(r.width===0||r.height===0)return;
    if(r.right>vw+2||r.left<-2) hOverflow.push({sel:sel(el),left:Math.round(r.left),right:Math.round(r.right),txt:(el.textContent||'').trim().slice(0,24)});
    // scroll container with hidden content and no visible affordance
    if(el.scrollHeight>el.clientHeight+8 && ['auto','scroll'].includes(cs.overflowY) && el.clientHeight>40)
      hidScroll.push({sel:sel(el),shown:el.clientHeight,total:el.scrollHeight,hiddenPct:Math.round((1-el.clientHeight/el.scrollHeight)*100)});
    if(el.scrollHeight>el.clientHeight+8 && ['hidden','clip'].includes(cs.overflowY) && el.clientHeight>20)
      hidScroll.push({sel:sel(el),shown:el.clientHeight,total:el.scrollHeight,hiddenPct:Math.round((1-el.clientHeight/el.scrollHeight)*100),HARDCLIP:true});
    const own=[...el.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()).map(n=>n.textContent.trim()).join(' ');
    if(own){
      const fg=px(cs.color), bg=effBg(el);
      const fgc=fg[3]<1?over(fg,bg):fg.slice(0,3);
      const ratio=contrast(fgc,bg), fs=parseFloat(cs.fontSize), fw=+cs.fontWeight||400;
      const need=(fs>=24||(fs>=18.66&&fw>=700))?3:4.5;
      if(ratio<need&&!/^[\p{Extended_Pictographic}\s]+$/u.test(own)) lowContrast.push({sel:sel(el),text:own.slice(0,28),color:cs.color,fs,fw,ratio:+ratio.toFixed(2)});
      const lh=cs.lineHeight==='normal'?fs*1.2:parseFloat(cs.lineHeight);
      if(lh<fs*1.1&&/[가-힣]/.test(own)) clippedLH.push({sel:sel(el),text:own.slice(0,20),fs,lh:+lh.toFixed(1)});
    }
    if((el.tagName==='BUTTON'||el.tagName==='A'||el.getAttribute('role')==='button')&&(r.height<32||r.width<32)) tinyTap.push({sel:sel(el),text:(el.textContent||'').trim().slice(0,16),w:Math.round(r.width),h:Math.round(r.height)});
  });
  const boxes=[...document.querySelectorAll('body *')].filter(el=>{const cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0')return false; const r=el.getBoundingClientRect(); if(r.width<8||r.height<8||r.bottom<0||r.top>innerHeight)return false; return [...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());}).map(el=>({el,r:clipRect(el)})).filter(o=>o.r.width>4&&o.r.height>4);
  const overlaps=[];
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
    const a=boxes[i],b=boxes[j];
    if(a.el.contains(b.el)||b.el.contains(a.el))continue;
    const x=Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left);
    const y=Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top);
    if(x>4&&y>4){const area=x*y,minA=Math.min(a.r.width*a.r.height,b.r.width*b.r.height); if(area/minA>0.2)overlaps.push({a:sel(a.el),at:(a.el.textContent||'').trim().slice(0,16),b:sel(b.el),bt:(b.el.textContent||'').trim().slice(0,16),ov:Math.round(area/minA*100)+'%'});}
  }
  const de=document.documentElement;
  const dedupe = arr => { const s=new Set(); return arr.filter(o=>{const k=JSON.stringify(o); if(s.has(k))return false; s.add(k); return true;}); };
  return {vw,vh,overflowX:de.scrollWidth-de.clientWidth,docH:de.scrollHeight,
    lowContrast:dedupe(lowContrast).sort((a,b)=>a.ratio-b.ratio).slice(0,15),
    hOverflow:dedupe(hOverflow).slice(0,8), hidScroll:dedupe(hidScroll).slice(0,8),
    clippedLH:dedupe(clippedLH).slice(0,8), tinyTap:dedupe(tinyTap).slice(0,10), overlaps:dedupe(overlaps).slice(0,12)};
};
