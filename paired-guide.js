/* Nail Mii — simultaneous two-zone guided camera.
   Camera pixels are processed on-device and never uploaded.
   Image recognition proposes candidates; users verify both before saving. */
(function (root) {
  'use strict';
  const $=id=>document.getElementById(id);
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
  const diff=(a,b)=>!a||!b?0:Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])/Math.sqrt(3);
  const lum=c=>c?.[0]*.299+c?.[1]*.587+c?.[2]*.114;
  function color(image,x,y){
    const ix=Math.round(x),iy=Math.round(y);
    if(ix<1||iy<1||ix>=image.width-1||iy>=image.height-1)return null;
    const p=(iy*image.width+ix)*4,d=image.data;
    return[d[p],d[p+1],d[p+2]];
  }
  function layout(w,h){
    // Left nail box, right coin ring; all coords are CSS pixel coordinates.
    const margin=Math.max(10,w*.035);
    const gap=Math.max(10,w*.035);
    const col=(w-margin*2-gap)/2;
    const nailX=margin,nailY=h*.26,nailW=col,nailH=Math.min(h*.52,col*2.15);
    const coinX=w-margin-col,coinR=Math.min(col*.39,h*.16);
    const coinCX=coinX+col/2,coinCY=h*.51;
    const nailCX=nailX+col/2,nailCY=nailY+nailH*.5;
    return{nail:{x:nailX,y:nailY,w:nailW,h:nailH,cx:nailCX,cy:nailCY},
      coin:{cx:coinCX,cy:coinCY,r:coinR},w,h};
  }
  function ringStats(image,cx,cy,r){
    const count=72;
    let valid=0,pos=0,neg=0,contrast=0,diffs=[];
    for(let i=0;i<count;i++){
      const angle=i*Math.PI*2/count,ux=Math.cos(angle),uy=Math.sin(angle);
      const a=color(image,cx+ux*r*.90,cy+uy*r*.90);
      const b=color(image,cx+ux*r*1.10,cy+uy*r*1.10);
      if(!a||!b)continue;
      const signed=lum(b)-lum(a),strength=diff(a,b);
      diffs.push(strength);valid++;contrast+=strength;
      if(signed>10&&strength>16)pos++;
      else if(signed< -10&&strength>16)neg++;
    }
    if(valid<56)return null;
    const coherent=Math.max(pos,neg)/valid;
    const median=diffs.sort((a,b)=>a-b)[Math.floor(diffs.length/2)];
    return{coherent,median,average:contrast/valid,valid,
      score:coherent*.72+Math.min(median/70,1)*.28};
  }
  function detectCoin(image,guide){
    const {cx,cy,r}=guide;
    let best=null;
    // Search only in the right-hand coin guide: textiles and fingernails elsewhere
    // cannot be mistaken for a coin.
    const offset=r*.20;
    for(let dx=-offset;dx<=offset;dx+=Math.max(3,r*.07)){
      for(let dy=-offset;dy<=offset;dy+=Math.max(3,r*.07)){
        for(let radius=r*.78;radius<=r*1.23;radius+=Math.max(2,r*.04)){
          const xx=cx+dx,yy=cy+dy,stats=ringStats(image,xx,yy,radius);
          if(!stats||stats.coherent<.66||stats.median<13)continue;
          const penalty=.09*Math.hypot(dx,dy)/r+.08*Math.abs(radius-r)/r;
          const rank=stats.score-penalty;
          if(!best||rank>best.rank)best={x:xx,y:yy,r:radius,rank,stats};
        }
      }
    }
    if(!best||best.rank<.63)return null;
    return{center:{x:best.x,y:best.y},radius:best.r,
      points:[{x:best.x-best.r,y:best.y},{x:best.x+best.r,y:best.y}],
      confidence:best.rank};
  }
  function fingerEdges(image,cx,cy,coinPixels,coinMm,guide){
    // Bilateral nail edges must also have outer fingertip edges beyond them.
    // This prevents returning the full finger width.
    const mmPerPx=coinMm/coinPixels;
    const minHalf=4.4/mmPerPx/2,maxHalf=23.2/mmPerPx/2;
    const maxSearch=Math.min(maxHalf,guide.w*.44);
    if(minHalf>=maxSearch)return null;
    const gap=clamp(coinPixels*.022,2,6);
    const offsets=[-2,0,2];
    const borderX=guide.x+5,borderMax=guide.x+guide.w-5;
    function outsideEdge(x,direction){
      let best=0;
      for(let v=Math.max(6,coinPixels*.05);v<=Math.min(coinPixels*.25,guide.w*.28);v+=2){
        const at=x+direction*v;
        if(at<borderX||at>borderMax)break;
        const a=color(image,at-3,cy),b=color(image,at+3,cy);
        best=Math.max(best,diff(a,b));
      }
      return best;
    }
    let best=null;
    for(let shift=-guide.w*.115;shift<=guide.w*.115;shift+=2){
      const midX=cx+shift;
      for(let half=minHalf;half<=maxSearch;half+=1.8){
        const l=midX-half,r=midX+half;
        if(l-gap<borderX||r+gap>borderMax)continue;
        let vl=0,vr=0;
        for(const oy of offsets){
          vl+=diff(color(image,l+gap,cy+oy),color(image,l-gap,cy+oy));
          vr+=diff(color(image,r-gap,cy+oy),color(image,r+gap,cy+oy));
        }
        vl/=3;vr/=3;
        const lower=Math.min(vl,vr),higher=Math.max(vl,vr);
        if(lower<10.5||lower/(higher+.01)<.44)continue;
        if(Math.min(outsideEdge(l,-1),outsideEdge(r,1))<15.5)continue;
        const c=color(image,midX,cy);
        const inner=(diff(c,color(image,midX-half*.78,cy))+diff(c,color(image,midX+half*.78,cy)))/2;
        if(inner>15&&inner>lower*.3)continue;
        const score=lower*(.6+.4*lower/(higher+.01))-Math.max(0,inner-7)*1.25;
        if(!best||score>best.score)best={left:l,right:r,y:cy,score,widthPx:2*half,mm:2*half*mmPerPx};
      }
    }
    return best&&best.score>=11?best:null;
  }
  function analyze(image,guide,coinMm){
    const coin=detectCoin(image,guide.coin);
    const nail=coin?fingerEdges(image,guide.nail.cx,guide.nail.cy,2*coin.radius,coinMm,guide.nail):null;
    return{coin,nail};
  }
  class PairedGuide {
    constructor({onCapture,getCoin}){
      this.getCoin=getCoin;this.onCapture=onCapture;
      this.video=$('liveVideo');
      this.overlay=$('liveOverlay');
      this.ctx=this.overlay.getContext('2d');
      this.stream=null;this.running=false;this.ticket=0;this.raf=0;
      this.buffer=document.createElement('canvas');
      this.lastStatus='';
      $('liveCaptureBtn').addEventListener('click',()=>this.capture());
      $('liveClose').addEventListener('click',()=>this.stop(true));
    }
    resetCoin(){this.lastStatus='';}
    status(text){
      if(text!==this.lastStatus){$('liveStatus').textContent=text;this.lastStatus=text;}
    }
    async start(){
      if(this.running)return;
      const ticket=++this.ticket;
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera API not supported');
      const stream=await navigator.mediaDevices.getUserMedia({
        video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false
      });
      if(this.ticket!==ticket){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;this.video.srcObject=stream;
      try{await this.video.play();}
      catch(e){stream.getTracks().forEach(t=>t.stop());this.stream=null;throw e;}
      if(this.ticket!==ticket){stream.getTracks().forEach(t=>t.stop());return;}
      this.running=true;
      this.status('爪は左の枠、硬貨は右の円へ。両方を入れて1回撮影してください。');
      this.raf=requestAnimationFrame(()=>this.draw());
    }
    stop(notify){
      this.ticket++;
      this.running=false;
      cancelAnimationFrame(this.raf);
      this.video.pause();
      this.video.srcObject=null;
      if(this.stream){this.stream.getTracks().forEach(t=>t.stop());this.stream=null;}
      if(notify)document.dispatchEvent(new CustomEvent('nailmii:close-guide'));
    }
    dims(){
      const b=this.overlay.getBoundingClientRect();
      return{w:Math.round(b.width),h:Math.round(b.height)};
    }
    photo(w,h,scale){
      const v=this.video,out=document.createElement('canvas');
      out.width=Math.round(w*scale);out.height=Math.round(h*scale);
      const ctx=out.getContext('2d',{willReadFrequently:true});
      const destW=out.width,destH=out.height;
      const factor=Math.max(destW/v.videoWidth,destH/v.videoHeight);
      const sw=destW/factor,sh=destH/factor;
      ctx.drawImage(v,(v.videoWidth-sw)/2,(v.videoHeight-sh)/2,sw,sh,0,0,destW,destH);
      return out;
    }
    capture(){
      if(!this.running||!this.video.videoWidth)return;
      const {w,h}=this.dims();
      if(w<100||h<120)return;
      // Capture once; analyze a downscaled copy from the *same frozen frame*.
      const factor=Math.min(2,Math.max(1,1400/Math.max(w,h)));
      const still=this.photo(w,h,factor);
      const imageContext=this.buffer.getContext('2d',{willReadFrequently:true});
      this.buffer.width=w;this.buffer.height=h;
      imageContext.drawImage(still,0,0,w,h);
      const bytes=imageContext.getImageData(0,0,w,h);
      const guide=layout(w,h);
      const coinMm=this.getCoin()==='10'?23.5:22.6;
      const found=analyze({data:bytes.data,width:w,height:h},guide,coinMm);
      const scale=still.width/w;
      const points=arr=>arr?.map(p=>({x:p.x*scale,y:p.y*scale}))||null;
      const data={
        coinPoints:points(found.coin?.points),
        nailPoints:found.nail?points([{x:found.nail.left,y:found.nail.y},{x:found.nail.right,y:found.nail.y}]):null,
        coinConfidence:found.coin?.confidence??null
      };
      this.stop(false);
      this.onCapture(still,data);
    }
    draw(){
      if(!this.running)return;
      this.raf=requestAnimationFrame(()=>this.draw());
      const {w,h}=this.dims();if(w<2||h<2)return;
      const dpr=Math.min(window.devicePixelRatio||1,2);
      if(this.overlay.width!==Math.round(w*dpr)||this.overlay.height!==Math.round(h*dpr)){
        this.overlay.width=Math.round(w*dpr);this.overlay.height=Math.round(h*dpr);
      }
      const ctx=this.ctx,geo=layout(w,h),n=geo.nail,c=geo.coin;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      ctx.shadowBlur=6;ctx.shadowColor='#101016aa';ctx.lineWidth=3.5;
      ctx.strokeStyle='#8defd7';ctx.setLineDash([12,6]);
      const rr=Math.min(n.w*.19,26);
      ctx.beginPath();ctx.roundRect(n.x,n.y,n.w,n.h,rr);ctx.stroke();
      ctx.strokeStyle='#ffe4ab';ctx.beginPath();ctx.arc(c.cx,c.cy,c.r,0,Math.PI*2);ctx.stroke();
      ctx.setLineDash([]);ctx.lineWidth=2;ctx.strokeStyle='#8defd7';
      ctx.beginPath();ctx.moveTo(n.x+n.w*.2,n.cy);ctx.lineTo(n.x+n.w*.8,n.cy);ctx.stroke();
      ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='700 13px system-ui,sans-serif';
      ctx.fillStyle='#fff';ctx.shadowBlur=5;
      ctx.fillText('爪',n.cx,n.y-16);ctx.fillText(this.getCoin()+'円玉',c.cx,c.cy+c.r+19);
    }
  }
  root.NailMiiPairedGuide=PairedGuide;
  root.NailMiiPairedAnalyzer=Object.freeze({analyze,layout,detectCoin,fingerEdges});
})(window);
