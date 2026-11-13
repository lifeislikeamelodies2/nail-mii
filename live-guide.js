/* Nail Mii — guided live camera measurement.
 * The user's alignment of a known-diameter coin sets pixel/mm scale.
 * Nails are detected by candidate bilateral color transitions, and a
 * stable result is proposed, never automatically committed.
 * Image frames are only processed locally inside the browser.
 */
(function(root){
'use strict';
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
function rgbAt(data,w,h,x,y){
  x=Math.round(x);y=Math.round(y);
  if(x<1||y<1||x>=w-1||y>=h-1)return null;
  const p=(y*w+x)*4;
  return [data[p],data[p+1],data[p+2]];
}
function delta(a,b){
  if(!a||!b)return 0;
  return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]) / Math.sqrt(3);
}
function med(a){const sorted=[...a].sort((x,y)=>x-y);return sorted[Math.floor(sorted.length/2)];}
function coinMatch(image,cx,cy,r){
  let tested=0,strong=0,contrast=0;
  for(let i=0;i<56;i++){
    const theta=2*Math.PI*i/56,u=Math.cos(theta),v=Math.sin(theta);
    const inside=rgbAt(image.data,image.width,image.height,cx+u*r*.88,cy+v*r*.88);
    const outside=rgbAt(image.data,image.width,image.height,cx+u*r*1.09,cy+v*r*1.09);
    if(!inside||!outside)continue;
    const d=delta(inside,outside);tested++;contrast+=d;if(d>21)strong++;
  }
  return {coverage:tested?strong/tested:0,contrast:tested?contrast/tested:0};
}
function findNail(image,centerX,centerY,guideDiameter,coinMm){
  const {width,height,data}=image;
  const guide=guideDiameter;
  const minHalf=Math.max(8,guide*.115),maxHalf=Math.min(guide*.39,width*.43);
  const edgeGap=clamp(guide*.023,2.5,7);
  const lineOffsets=[-guide*.017,0,guide*.017];
  let best=null;
  for(let shift=-guide*.08;shift<=guide*.08;shift+=2.5){
    for(let half=minHalf;half<=maxHalf;half+=2){
      const lx=centerX+shift-half,rx=centerX+shift+half;
      let left=0,right=0,valid=0;
      for(const dy of lineOffsets){
        const y=centerY+dy;
        const li=rgbAt(data,width,height,lx+edgeGap,y),lo=rgbAt(data,width,height,lx-edgeGap,y);
        const ri=rgbAt(data,width,height,rx-edgeGap,y),ro=rgbAt(data,width,height,rx+edgeGap,y);
        if(!li||!lo||!ri||!ro)continue;
        left+=delta(li,lo);right+=delta(ri,ro);valid++;
      }
      if(valid<3)continue;
      left/=valid;right/=valid;
      const smaller=Math.min(left,right),larger=Math.max(left,right);
      const balance=smaller/(larger+1e-6);
      // Texture, a single strong seam or one high-contrast edge is not a nail.
      if(smaller<10.5||balance<.44)continue;
      const mid=rgbAt(data,width,height,centerX+shift,centerY);
      const middleLeft=rgbAt(data,width,height,centerX+shift-half*.48,centerY);
      const middleRight=rgbAt(data,width,height,centerX+shift+half*.48,centerY);
      const uniformity=(delta(mid,middleLeft)+delta(mid,middleRight))/2;
      const veryWidePenalty=half>guide*.35?2.5:0;
      const score=smaller*(.6+.4*balance)-Math.max(0,uniformity-12)*.35-veryWidePenalty;
      if(!best||score>best.score)best={x1:lx,x2:rx,y:centerY,score,widthPx:2*half,uniformity};
    }
  }
  if(!best||best.score<11)return null;
  const mm=best.widthPx/guide*coinMm;
  if(mm<4.5||mm>23.5)return null;
  return {...best,mm};
}
class NailMiiLiveGuide {
  constructor({onSave,getCoin,getFinger,getHand}){
    this.onSave=onSave;this.getCoin=getCoin;this.getFinger=getFinger;this.getHand=getHand;
    this.video=$('liveVideo');this.canvas=$('liveOverlay');this.ctx=this.canvas.getContext('2d');
    this.stage='coin';this.running=false;this.stream=null;
    this.raf=0;this.lastFrame=0;this.samples=[];this.result=null;
    this.calibration=null;this.lastLabel='';
    this.offscreen=document.createElement('canvas');
    this.offscreenContext=this.offscreen.getContext('2d',{willReadFrequently:true});
    $('liveConfirmCoin').addEventListener('click',()=>this.acceptCoin());
    $('liveSaveNail').addEventListener('click',()=>this.save());
    $('liveRecalibrate').addEventListener('click',()=>this.resetCoin());
    $('liveClose').addEventListener('click',()=>this.stop(true));
  }
  label(text){
    if(this.lastLabel!==text){$('liveStatus').textContent=text;this.lastLabel=text;}
  }
  updateButtons(){
    const inCoin=this.stage==='coin';
    $('liveConfirmCoin').classList.toggle('hidden',!inCoin);
    $('liveSaveNail').classList.toggle('hidden',inCoin);
    $('liveRecalibrate').classList.toggle('hidden',inCoin);
    $('liveSaveNail').disabled=!this.result;
    $('liveStage').textContent=inCoin?'STEP 1 / 硬貨の基準合わせ':'STEP 2 / 爪の幅を測る';
    $('liveHint').textContent=inCoin
      ?'10円玉または100円玉の外周を円形ガイドにぴったり合わせてください。硬貨が円内に重なったら「この位置で基準を設定」を押します。'
      :'カメラと対象物の距離を変えず、爪のいちばん幅広い位置を中央の横線に合わせてください。緑のラインと数値が安定したら保存します。';
  }
  async start(){
    if(this.running)return;
    if(!navigator.mediaDevices?.getUserMedia)throw Error('このブラウザではカメラに対応していません。');
    this.stage='coin';this.calibration=null;this.samples=[];this.result=null;
    this.updateButtons();
    const stream=await navigator.mediaDevices.getUserMedia({
      audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:960}}
    });
    this.stream=stream;
    this.video.srcObject=stream;
    try{await this.video.play();}catch(err){stream.getTracks().forEach(t=>t.stop());this.stream=null;throw err;}
    this.running=true;this.lastFrame=0;
    this.label('円の中に硬貨を合わせてください。端末を真上から向け、距離を固定します。');
    this.raf=requestAnimationFrame(t=>this.frame(t));
  }
  stop(notify){
    cancelAnimationFrame(this.raf);
    this.running=false;this.samples=[];this.result=null;
    if(this.stream){this.stream.getTracks().forEach(t=>t.stop());this.stream=null;}
    this.video.pause();this.video.srcObject=null;
    if(notify)document.dispatchEvent(new CustomEvent('nailmii:close-guide'));
  }
  acceptCoin(){
    if(this.stage!=='coin'||!this.running)return;
    const score=this.lastCoinMatch;
    if(!score||score.coverage<.33){
      if(!confirm('硬貨の円周がガイドと一致していることを確認できませんでした。実際に硬貨の外周が円にぴったり重なっていますか？'))return;
    }
    this.calibration=this.guideSize();
    this.stage='nail';this.samples=[];this.result=null;
    this.label('基準を保存しました。スマホを同じ高さで固定し、今度は爪を中央に合わせてください。');
    this.updateButtons();
  }
  resetCoin(){
    this.stage='coin';this.calibration=null;this.samples=[];this.result=null;this.updateButtons();
    this.label('硬貨をもう一度円に合わせてください。');
  }
  guideSize(){
    const w=this.canvas.clientWidth||360,h=this.canvas.clientHeight||440;
    return Math.round(Math.min(w*.56,h*.45));
  }
  save(){
    if(!this.result||this.stage!=='nail')return;
    const {mm}=this.result;
    const finger=this.getFinger(),hand=this.getHand();
    if(mm<4||mm>30)return;
    if(this.onSave({mm,hand,finger})!==false){
      this.samples=[];this.result=null;
      this.updateButtons();
      this.label('保存しました。続けて次の爪を中央の横線に合わせてください。');
    }
  }
  getFrame(w,h){
    const v=this.video;
    if(!v.videoWidth||!v.videoHeight)return null;
    if(this.offscreen.width!==w||this.offscreen.height!==h){this.offscreen.width=w;this.offscreen.height=h;}
    const context=this.offscreenContext;
    const scale=Math.max(w/v.videoWidth,h/v.videoHeight),sw=w/scale,sh=h/scale;
    context.drawImage(v,(v.videoWidth-sw)/2,(v.videoHeight-sh)/2,sw,sh,0,0,w,h);
    const frame=context.getImageData(0,0,w,h);
    return {data:frame.data,width:w,height:h};
  }
  frame(t){
    if(!this.running)return;
    this.raf=requestAnimationFrame(now=>this.frame(now));
    if(t-this.lastFrame<110)return;this.lastFrame=t;
    const rect=this.canvas.getBoundingClientRect();
    if(rect.width<1||rect.height<1)return;
    const dpr=Math.min(2,window.devicePixelRatio||1),w=Math.round(rect.width),h=Math.round(rect.height);
    if(this.canvas.width!==Math.round(w*dpr)||this.canvas.height!==Math.round(h*dpr)){
      this.canvas.width=Math.round(w*dpr);this.canvas.height=Math.round(h*dpr);
    }
    const ctx=this.ctx;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const cx=w/2,cy=h*.49,d=this.guideSize(),r=d/2;
    let frame=null;
    try{frame=this.getFrame(w,h);}catch(e){console.warn('Live frame read failure',e);}
    ctx.save();ctx.lineWidth=4;ctx.strokeStyle='#fff';ctx.shadowColor='#0009';ctx.shadowBlur=5;
    if(this.stage==='coin'){
      const score=frame?coinMatch(frame,cx,cy,r):null;this.lastCoinMatch=score;
      const aligned=score&&score.coverage>=.57;
      ctx.strokeStyle=aligned?'#59e2a7':'#ffcc8c';
      ctx.setLineDash([12,7]);ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(cx-13,cy);ctx.lineTo(cx+13,cy);ctx.moveTo(cx,cy-13);ctx.lineTo(cx,cy+13);ctx.stroke();
      this.label(aligned?'円周の色が変わりました。硬貨の外周とガイドが一致しているか確認してください。':
        '硬貨の外周を黄色い円にぴったり合わせてください。');
      $('liveValue').textContent=this.getCoin()==='10'?'直径 23.5 mm':'直径 22.6 mm';
    }else{
      // One line becomes green only when bilateral edges appear consistent over time.
      const result=frame?findNail(frame,cx,cy,d,this.getCoin()==='10'?23.5:22.6):null;
      if(result){this.samples.push(result);if(this.samples.length>9)this.samples.shift();}
      else if(this.samples.length)this.samples.shift();
      const recent=this.samples.slice(-7).map(v=>v.mm);
      const spread=recent.length>=6?Math.max(...recent)-Math.min(...recent):Infinity;
      const stable=recent.length>=6&&spread<=.8;
      this.result=stable?{mm:med(recent),point:result}:null;
      this.updateButtons();
      const stroke=stable?'#59e2a7':'#ffcc8c';
      ctx.strokeStyle=stroke;ctx.lineWidth=3;ctx.setLineDash([7,7]);ctx.beginPath();
      ctx.moveTo(cx-r*.85,cy);ctx.lineTo(cx+r*.85,cy);ctx.stroke();ctx.setLineDash([]);
      ctx.strokeRect(cx-r*.72,cy-d*.27,r*1.44,d*.54);
      if(stable&&result){
        const width=this.result.mm/(this.getCoin()==='10'?23.5:22.6)*d;
        const center=(result.x1+result.x2)/2;
        ctx.strokeStyle='#59e2a7';ctx.lineWidth=5;ctx.beginPath();
        ctx.moveTo(center-width/2,cy);ctx.lineTo(center+width/2,cy);ctx.stroke();
        ctx.beginPath();ctx.arc(center-width/2,cy,7,0,Math.PI*2);ctx.arc(center+width/2,cy,7,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
      }
      $('liveValue').textContent=stable?this.result.mm.toFixed(1)+' mm（参考値）':'爪の境界を解析中…';
      this.label(stable?'緑色の線が爪の両端に一致しているか確認し、正しければ保存してください。':
       '爪の幅が最も広い位置を横線に合わせてください。判別できない場合は写真計測を使ってください。');
    }
    ctx.restore();
  }
}
root.NailMiiLiveGuide=NailMiiLiveGuide;
})(window);
