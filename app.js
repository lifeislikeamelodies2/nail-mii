'use strict';
/* Nail Mii: client-side photographic measurement with optional automatic edge proposals. */
const COIN_MM = Object.freeze({ '10': 23.5, '100': 22.6 });
const FINGERS = Object.freeze(['親指','人差し指','中指','薬指','小指']);
const DEFAULT_SIZES = Object.freeze([18,17,16,15,14,13,12,11,10,9]);
const STORAGE_KEY = 'nail-mii-widths-v1';
const CHART_KEY = 'nail-mii-chart-v1';
const $ = (id) => document.getElementById(id);
const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const clonePoints = (points) => points ? points.map((p)=>({x:p.x,y:p.y})) : [];
function readStorage(key, fallback){ try { const v=JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
function readWidths(){
  const saved=readStorage(STORAGE_KEY,{});
  return Object.fromEntries(['left','right'].map(hand=>[hand,Array.from({length:5},(_,i)=>{
    const n=Number(saved?.[hand]?.[i]); return Number.isFinite(n)&&n>=4&&n<=35 ? Math.round(n*10)/10 : null;
  })]));
}
function readChart(){
  const c=readStorage(CHART_KEY,null);
  if(c && typeof c.name==='string' && Array.isArray(c.sizes) && c.sizes.length===10 && c.sizes.every(x=>Number.isFinite(x)&&x>0&&x<40)) return c;
  return {name:'サンプルサイズ表',sizes:[...DEFAULT_SIZES],isExample:true};
}
const state={
  hand:'left',finger:0,mode:'coin',widths:readWidths(),chart:readChart(),
  hands:{left:{photo:null,coin:'10',calibration:null,points:Array(5).fill(null)},right:{photo:null,coin:'10',calibration:null,points:Array(5).fill(null)}},
  draft:[],zoom:1,panX:0,panY:0,gesture:null,
  stream:null,facing:'environment',cameraOpen:false
};
const current=()=>state.hands[state.hand];
let autoScanSerial=0;
const suggestion=(h,i)=>{const p=h.autoNails?.[i]?.points; if(!p||p.length!==2)return null; const c=h.calibration; if(c){const d=dist(...c),mm=dist(...p)/d*COIN_MM[h.coin];if(!Number.isFinite(mm)||mm<4||mm>30)return null;}return p;};
function pointsForFinger(h,i){return clonePoints(h.points[i]||suggestion(h,i));}
let toastTimer;
function toast(message){const el=$('toast');el.textContent=message;el.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.add('hidden'),3400);}
function status(message){const el=$('statusMessage'); if(!message){el.classList.add('hidden');return;}el.textContent=message;el.classList.remove('hidden');}
function storeWidths(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state.widths));}catch{toast('保存できませんでした。ブラウザの保存設定をご確認ください。');}}
function coinSize(){return COIN_MM[current().coin];}
function mmFromPoints(points){const c=current().calibration;if(!c||c.length!==2||points.length!==2)return null;const d=dist(c[0],c[1]);if(d<=0)return null;return dist(points[0],points[1])/d*coinSize();}
function sizeFor(mm){
  if(mm===null)return null;
  const entries=state.chart.sizes.map((width,i)=>({width,i})).filter(x=>x.width + .000001 >= mm).sort((a,b)=>a.width-b.width);
  return entries.length?entries[0].i:null;
}
function displaySize(mm){if(mm===null)return '—';const s=sizeFor(mm);return s===null?'範囲外':`${s}号${state.chart.isExample?'（仮）':''}`;}
function updateStage(){
  const photo=current().photo,cal=current().calibration;
  const stage=!photo?0:!cal?1:state.mode==='coin'?1:state.widths[state.hand].every(x=>x!==null)?3:2;
  document.querySelectorAll('.step').forEach((el,i)=>{el.classList.toggle('active',i===stage);el.classList.toggle('done',i<stage);});
  $('photoEmpty').classList.toggle('hidden',!!photo||state.cameraOpen);
  $('photoEditor').classList.toggle('hidden',!photo||state.cameraOpen);
  $('cameraView').classList.toggle('hidden',!state.cameraOpen);
  const doingCoin=state.mode==='coin';
  $('canvasMode').textContent=doingCoin?'硬貨の直径を測る':`${FINGERS[state.finger]}の幅を測る`;
  $('canvasInstructions').textContent=doingCoin?'自動推定された円の位置を確認。誤認識時は硬貨の直径になる2点をタップし、ドラッグで補正してください。':'自動推定された爪の左右端を確認。位置がずれているときはドラッグで調整し、検出できないときは2点を手動で指定してください。';
  $('sideTitle').textContent=doingCoin?'コインの外周を選ぼう':`${FINGERS[state.finger]}の幅を測ろう`;
  $('sideDescription').textContent=doingCoin?'硬貨の中心を通る直径を測るため、外周の両端を指定してください。':'拡大して爪の左右端を正確にタップ。丸い計測点は指でドラッグして位置を調整できます。';
  $('sideHint').textContent=doingCoin?'10円玉は23.5mm、100円玉は22.6mm。実寸を使って爪の幅に換算します。':'測る幅は爪を真上から見た直線幅です。カーブに沿った幅とは異なります。';
  $('coinReference').textContent=`${coinSize().toFixed(1)} mm`;
  $('confirmPointsBtn').disabled=state.draft.length!==2;
  $('confirmPointsBtn').innerHTML=doingCoin?'硬貨の直径を確定 <span>→</span>':'この指の幅を保存 <span>→</span>';
  updateCanvasMetric();
}
function updateCanvasMetric(){
  const el=$('canvasMetric');
  if(state.draft.length!==2){el.textContent=`${state.draft.length} / 2点`;return;}
  if(state.mode==='coin'){el.textContent=`直径 ${dist(state.draft[0],state.draft[1]).toFixed(0)} px`;}
  else{const mm=mmFromPoints(state.draft);el.textContent=mm===null?'硬貨を先に計測':`${mm.toFixed(1)} mm`;}
}
function renderFingers(){
  const container=$('fingerSelector');container.innerHTML='';
  FINGERS.forEach((finger,i)=>{const btn=document.createElement('button');btn.type='button';btn.className=`finger-button${state.finger===i?' selected':''}${state.widths[state.hand][i]!==null?' done':''}`;btn.innerHTML=`<span class="finger-mark"></span><span>${i===1?'人差':i===2?'中':i===3?'薬':i===4?'小':'親'}指</span>`;
    btn.title=`${finger}を計測`;btn.setAttribute('aria-label',`${finger} ${state.widths[state.hand][i]??'未計測'}mm`);btn.addEventListener('click',()=>chooseFinger(i));container.append(btn);});
  const done=Object.values(state.widths).reduce((n,a)=>n+a.filter(x=>x!==null).length,0);
  $('progressCount').textContent=`${done} / 10 本`;
  $('progressBar').style.width=`${done*10}%`;
}
function renderResults(){
  for(const hand of ['left','right']){
    $(`${hand}Progress`).textContent=`${state.widths[hand].filter(x=>x!==null).length} / 5`;
    const list=$(`${hand}Rows`);list.innerHTML='';
    FINGERS.forEach((name,i)=>{
      const mm=state.widths[hand][i],row=document.createElement('div');row.className='result-row';
      const label=document.createElement('span');label.textContent=name;
      const width=document.createElement('span');width.className=`width${mm===null?' empty':''}`;width.textContent=mm===null?'未計測':`${mm.toFixed(1)} mm`;
      const cell=document.createElement('span');cell.className=`size${mm===null?' suggestion':''}`;cell.textContent=displaySize(mm);
      if(mm!==null){const b=document.createElement('button');b.type='button';b.textContent='修正';b.className='edit-link';b.addEventListener('click',()=>{selectHand(hand);chooseFinger(i);$('measure').scrollIntoView({behavior:'smooth'});if(!current().photo)toast('再計測には、同じ手の写真を撮影してください。');});cell.append(b);}
      row.append(label,width,cell);list.append(row);
    });
  }
}
function refresh(){
  document.querySelectorAll('[data-hand]').forEach(b=>{const selected=b.dataset.hand===state.hand;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));});
  $('coinType').value=current().coin;
  renderFingers();renderResults();updateStage();requestDraw();
}
function selectHand(hand){
  if(hand===state.hand)return;
  autoScanSerial++;
  stopCamera();state.hand=hand;state.mode=current().calibration?'nail':'coin';state.draft=state.mode==='coin'?clonePoints(current().calibration):pointsForFinger(current(),state.finger);resetView();status('');refresh();
}
function chooseFinger(i){
  state.finger=i;if(current().calibration)state.mode='nail';state.draft=state.mode==='coin'?clonePoints(current().calibration):pointsForFinger(current(),i);status('');refresh();
}
function resetView(){state.zoom=1;state.panX=0;state.panY=0;$('zoomLabel').textContent='100%';requestDraw();}
function handleCoinChange(value){
  const h=current();h.coin=value;
  if(h.calibration){h.points.forEach((p,i)=>{if(p&&p.length===2){state.widths[state.hand][i]=Math.round(mmFromPoints(p)*10)/10;}});storeWidths();}
  refresh();
}
async function normalizeFile(file){
  const url=URL.createObjectURL(file);
  try{const img=new Image();img.src=url;await img.decode();const max=2400,ratio=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*ratio));c.height=Math.max(1,Math.round(img.naturalHeight*ratio));c.getContext('2d').drawImage(img,0,0,c.width,c.height);return c;}
  finally{URL.revokeObjectURL(url);}
}
function usePhoto(canvas){
  stopCamera();autoScanSerial++;const h=current();h.photo=canvas;h.calibration=null;h.points=Array(5).fill(null);h.autoNails=Array(5).fill(null);state.mode='coin';state.draft=[];resetView();status('');refresh();toast('写真を読み込みました。自動認識を試します。');
  autoScanPhoto();
}
async function acceptFile(e){const file=e.target.files?.[0];e.target.value='';if(!file)return;if(!file.type.startsWith('image/')){toast('画像ファイルを選択してください');return;}try{usePhoto(await normalizeFile(file));}catch(err){console.error(err);status('画像を読み込めませんでした。別の写真をお試しください。');}}
async function stopCamera(){
  if(state.stream){state.stream.getTracks().forEach(t=>t.stop());state.stream=null;}
  $('cameraVideo').srcObject=null;state.cameraOpen=false;updateStage();
}
async function openCamera(){
  if(!navigator.mediaDevices?.getUserMedia){status('このブラウザではカメラを直接起動できません。下の「写真を選ぶ」からカメラ撮影または写真の選択をしてください。');$('photoInput').click();return;}
  try{
    await stopCamera();const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:state.facing},width:{ideal:1920},height:{ideal:1080}}});state.stream=stream;state.cameraOpen=true;
    const video=$('cameraVideo');video.srcObject=stream;await video.play();status('');updateStage();
  }catch(err){console.error(err);state.cameraOpen=false;status('カメラを起動できませんでした。ブラウザのカメラ許可を確認するか、「写真を選ぶ」から撮影してください。');updateStage();}
}
function capture(){
  const video=$('cameraVideo');if(!video.videoWidth){toast('カメラの準備ができていません');return;}
  const r=Math.min(1,2400/Math.max(video.videoWidth,video.videoHeight)),canvas=document.createElement('canvas');canvas.width=Math.round(video.videoWidth*r);canvas.height=Math.round(video.videoHeight*r);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);usePhoto(canvas);
}
function transform(){
  const canvas=$('editorCanvas'),h=current(),photo=h.photo,w=canvas.clientWidth||1,ht=canvas.clientHeight||1;
  if(!photo)return {x:0,y:0,s:1,w,ht};
  const fit=Math.min(w/photo.width,ht/photo.height),s=fit*state.zoom;
  return{x:(w-photo.width*s)/2+state.panX,y:(ht-photo.height*s)/2+state.panY,s,w,ht};
}
function fromCanvas(x,y){const t=transform(),p=current().photo;return{x:Math.max(0,Math.min(p.width,(x-t.x)/t.s)),y:Math.max(0,Math.min(p.height,(y-t.y)/t.s))};}
function toCanvas(p){const t=transform();return{x:t.x+p.x*t.s,y:t.y+p.y*t.s};}
let drawScheduled=false;
function requestDraw(){if(drawScheduled)return;drawScheduled=true;requestAnimationFrame(()=>{drawScheduled=false;draw();});}
function draw(){
  const c=$('editorCanvas'),rect=c.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
  const dpr=Math.min(window.devicePixelRatio||1,2);c.width=Math.round(rect.width*dpr);c.height=Math.round(rect.height*dpr);const ctx=c.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#2a2529';ctx.fillRect(0,0,rect.width,rect.height);
  const h=current(),p=h.photo;if(!p)return;const t=transform();ctx.drawImage(p,t.x,t.y,p.width*t.s,p.height*t.s);
  if(h.calibration && state.mode==='nail')drawPair(ctx,h.calibration,'#f6dfac',false);
  if(state.draft.length)drawPair(ctx,state.draft,'#ff88a8',true);
}
function drawPair(ctx,points,color,handles){
  if(points.length===2){const a=toCanvas(points[0]),b=toCanvas(points[1]);ctx.lineWidth=3;ctx.strokeStyle='rgba(0,0,0,.48)';ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(a.x+1,a.y+2);ctx.lineTo(b.x+1,b.y+2);ctx.stroke();ctx.lineWidth=2.5;ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    if(state.mode==='coin'&&handles){const r=dist(a,b)/2;ctx.setLineDash([7,6]);ctx.strokeStyle='#ffe6ba';ctx.lineWidth=2;ctx.beginPath();ctx.arc((a.x+b.x)/2,(a.y+b.y)/2,r,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);}
  }
  if(!handles)return;
  points.forEach((p,i)=>{const q=toCanvas(p);ctx.beginPath();ctx.fillStyle='#fff';ctx.arc(q.x,q.y,13,0,Math.PI*2);ctx.fill();ctx.lineWidth=3;ctx.strokeStyle=color;ctx.stroke();ctx.fillStyle='#6e3b4c';ctx.font='700 11px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(i===0?'A':'B',q.x,q.y);});
}
function eventPos(e){const r=$('editorCanvas').getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
function canvasPointerDown(e){
  if(!current().photo||e.button>0)return;
  e.preventDefault();const pos=eventPos(e);let marker=-1,nearest=Infinity;
  state.draft.forEach((p,i)=>{const q=toCanvas(p),d=dist(q,pos);if(d<nearest&&d<30){nearest=d;marker=i;}});
  if(marker>=0)state.gesture={type:'marker',index:marker};
  else if(state.draft.length<2){state.draft.push(fromCanvas(pos.x,pos.y));state.gesture={type:'marker',index:state.draft.length-1};}
  else state.gesture={type:'pan',prev:pos};
  try{e.currentTarget.setPointerCapture(e.pointerId);}catch{}
  updateStage();requestDraw();
}
function canvasPointerMove(e){
  if(!state.gesture||!current().photo)return;e.preventDefault();const pos=eventPos(e),g=state.gesture;
  if(g.type==='marker'){state.draft[g.index]=fromCanvas(pos.x,pos.y);}
  else if(g.type==='pan'){state.panX+=pos.x-g.prev.x;state.panY+=pos.y-g.prev.y;g.prev=pos;}
  updateCanvasMetric();requestDraw();
}
function canvasPointerUp(e){if(!state.gesture)return;state.gesture=null;try{e.currentTarget.releasePointerCapture(e.pointerId);}catch{}updateStage();}
function zoom(multiplier){
  const old=state.zoom,next=Math.max(1,Math.min(7,old*multiplier));if(old===next)return;
  const p=current().photo;if(p){const r=$('editorCanvas').getBoundingClientRect(),w=r.width,ht=r.height,fit=Math.min(w/p.width,ht/p.height);
    // Zoom about the visual center, preserving the point under it.
    const centerImgX=(w/2-(w-p.width*fit*old)/2-state.panX)/(fit*old);
    const centerImgY=(ht/2-(ht-p.height*fit*old)/2-state.panY)/(fit*old);
    state.panX=w/2-(w-p.width*fit*next)/2-centerImgX*fit*next;
    state.panY=ht/2-(ht-p.height*fit*next)/2-centerImgY*fit*next;
  }
  state.zoom=next;$('zoomLabel').textContent=`${Math.round(next*100)}%`;requestDraw();
}
async function autoScanPhoto(){
  const vision=window.NailMiiVision,h=current(),photo=h.photo,hand=state.hand,ticket=++autoScanSerial;
  if(!photo||!vision){status('自動認識機能を読み込めませんでした。手動で2点を指定してください。');return;}
  const stillCurrent=()=>ticket===autoScanSerial && current()===h && h.photo===photo && state.hand===hand;
  const button=$('autoDetectBtn');button.disabled=true;button.textContent='認識しています…';status('写真を解析しています。指先の認識モデルは初回のみ読み込みに時間がかかります。');
  try{
    await new Promise(resolve=>setTimeout(resolve,50));
    const proposal=!h.calibration ? vision.detectCoin(photo):null;
    if(!stillCurrent())return;
    if(proposal && !h.calibration && state.mode==='coin' && state.draft.length===0){
      state.draft=clonePoints(proposal.points);updateStage();requestDraw();
      status('硬貨の輪郭を自動推定しました。円が外周と一致するか確認して「硬貨の直径を確定」を押してください。');
    } else if(!h.calibration && state.mode==='coin' && state.draft.length===0){
      status('硬貨の輪郭を確実に検出できませんでした。写真上の硬貨の両端を手動で選択してください。');
    }
    try{
      const calibrated=h.calibration||proposal?.points||null;
      const result=await vision.detectNails(photo,calibrated,COIN_MM[h.coin]);
      if(!stillCurrent())return;
      h.autoNails=result.nails||Array(5).fill(null);
      const count=h.autoNails.filter(Boolean).length;
      if(state.mode==='nail' && !h.points[state.finger] && state.draft.length===0){state.draft=pointsForFinger(h,state.finger);refresh();}
      if(state.mode==='coin' && state.draft.length===2){status('硬貨の円と外周を確認して確定してください。爪の候補は'+count+'本見つかりました（読み取り結果は要確認）。');}
      else if(state.mode==='nail' && count){status(count+'本の爪の左右端を推定しました。選んだ指の計測点を確認し、必要ならドラッグで補正してください。');}
      else if(!result.foundHand){status('手全体を認識できませんでした。硬貨を確認後、指の爪の左右端を手動で指定してください。');}
      else if(!count){status('爪の境界が不明瞭でした。爪の両端は手動で指定してください。');}
    }catch(error){console.warn('Hand model unavailable',error);if(stillCurrent()){status('指先の自動認識が利用できません。硬貨の確認後、爪の両端を手動で指定してください。');}}
  }catch(error){console.warn('Automatic image measurement failed',error);if(stillCurrent())status('自動認識に失敗しました。写真を確認して、2点を手動で指定してください。');}
  finally{if(stillCurrent()){button.disabled=false;button.textContent='自動認識をやり直す';refresh();}}
}
function confirmPoints(){
  if(state.draft.length!==2)return;
  const len=dist(...state.draft);if(len<3){toast('2点が近すぎます。もう少し離して指定してください。');return;}
  const h=current();
  if(state.mode==='coin'){
    if(len<14){toast('硬貨が小さく写っています。拡大できる写真を使うことをおすすめします。');}
    h.calibration=clonePoints(state.draft);state.mode='nail';state.draft=pointsForFinger(h,state.finger);toast(state.draft.length===2?'硬貨の基準を設定しました。爪の自動候補を確認してください。':'硬貨の基準を設定しました。次は爪の左右端を指定してください。');
  }else{
    const mm=mmFromPoints(state.draft);if(mm===null){toast('先に硬貨の直径を指定してください');return;}
    if(mm<4||mm>35){toast(`計測値は${mm.toFixed(1)}mmです。爪の横幅をもう一度確認してください。`);return;}
    h.points[state.finger]=clonePoints(state.draft);state.widths[state.hand][state.finger]=Math.round(mm*10)/10;storeWidths();
    const next=state.widths[state.hand].findIndex(x=>x===null);
    if(next>=0){state.finger=next;state.draft=pointsForFinger(h,next);toast(`${FINGERS.find((_,i)=>i===state.finger)??'次の指'}を続けて計測できます。`);}
    else{state.draft=[];toast('この手の5本を計測しました。反対の手も測れます。');}
  }
  refresh();
}
function resetPoints(){state.draft=[];updateStage();requestDraw();}
function editChartRows(){
  const root=$('chartRows');root.innerHTML='';state.chart.sizes.forEach((n,i)=>{
    const div=document.createElement('label');div.className='chart-entry';div.innerHTML=`<span>${i}号</span><input type="number" inputmode="decimal" aria-label="${i}号の幅" min="1" max="39.9" step="0.1" value="${n}"><small>mm</small>`;root.append(div);
  });$('chartName').value=state.chart.name;
}
function saveChart(){
  const fields=[...document.querySelectorAll('#chartRows input')],sizes=fields.map(i=>Number(i.value));
  if(sizes.some((n,i)=>!fields[i].value||!Number.isFinite(n)||n<=0||n>39.9)){toast('0.1〜39.9mmの範囲で、10個すべて入力してください。');return;}
  const name=$('chartName').value.trim()||'カスタムサイズ表';state.chart={name,sizes,isExample:sizes.every((n,i)=>Math.abs(n-DEFAULT_SIZES[i])<0.001)};try{localStorage.setItem(CHART_KEY,JSON.stringify(state.chart));}catch{toast('サイズ表を保存できませんでした');return;}renderResults();toast('サイズ表を保存しました。候補号数を更新しました。');
}
function resetChart(){state.chart={name:'サンプルサイズ表',sizes:[...DEFAULT_SIZES],isExample:true};try{localStorage.removeItem(CHART_KEY);}catch{}editChartRows();renderResults();toast('説明用の初期値に戻しました。');}
function formatResults(){
  const lines=[`Nail Mii — ネイルサイズ計測`,`サイズ表：${state.chart.name}${state.chart.isExample?'（仮）':''}`, '※すべて上から見た直線幅の参考値'];
  for(const hand of ['left','right']){lines.push(`\n${hand==='left'?'左手':'右手'}`);FINGERS.forEach((f,i)=>{const v=state.widths[hand][i];lines.push(`${f}：${v===null?'未計測':`${v.toFixed(1)}mm / ${displaySize(v)}`}`);});}
  lines.push('\nチップ購入時はメーカーのサイズ表とカーブ幅をご確認ください。');return lines.join('\n');
}
async function copyResults(){const value=formatResults();try{await navigator.clipboard.writeText(value);toast('計測結果をコピーしました');}catch{const el=document.createElement('textarea');el.value=value;el.style.position='fixed';el.style.opacity='0';document.body.append(el);el.select();const ok=document.execCommand('copy');el.remove();toast(ok?'計測結果をコピーしました':'コピーできませんでした');}}
function downloadResultsImage(){
  const canvas=document.createElement('canvas');canvas.width=1120;canvas.height=1090;const ctx=canvas.getContext('2d');
  const rr=(x,y,w,h,r,fill)=>{ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill();};
  ctx.fillStyle='#fff8f5';ctx.fillRect(0,0,1120,1090);rr(55,52,1010,985,26,'#ffffff');
  ctx.fillStyle='#b95776';ctx.font='700 23px sans-serif';ctx.fillText('✳  Nail Mii',93,114);
  ctx.fillStyle='#473940';ctx.font='bold 43px "Noto Sans JP",sans-serif';ctx.fillText('わたしのネイルサイズ',93,188);
  ctx.fillStyle='#927983';ctx.font='22px "Noto Sans JP",sans-serif';ctx.fillText(`サイズ表：${state.chart.name}${state.chart.isExample?'（サンプル）':''}`.slice(0,48),93,233);
  for(let hi=0;hi<2;hi++){
    const hand=hi===0?'left':'right',start=285+hi*340;rr(90,start,940,310,17,'#fff9fa');ctx.fillStyle='#b95776';ctx.font='700 22px sans-serif';ctx.fillText(hand==='left'?'LEFT HAND  /  左手':'RIGHT HAND  /  右手',113,start+37);
    ctx.font='20px "Noto Sans JP",sans-serif';FINGERS.forEach((name,i)=>{const mm=state.widths[hand][i],col=i<3?0:1,row=i<3?i:i-3;const x=120+col*475,y=start+91+row*66;
      ctx.fillStyle='#5d5055';ctx.fillText(name,x,y);ctx.fillStyle='#ac6880';ctx.fillText(mm===null?'—':`${mm.toFixed(1)}mm`,x+145,y);ctx.fillStyle='#987d85';ctx.fillText(displaySize(mm),x+270,y);
    });
  }
  ctx.fillStyle='#927983';ctx.font='18px "Noto Sans JP",sans-serif';ctx.fillText('※ 写真で測る直線幅です。チップのカーブ幅と実寸をご確認ください。',93,1005);
  const a=document.createElement('a');a.download=`nail-mii-sizes-${new Date().toISOString().slice(0,10)}.png`;a.href=canvas.toDataURL('image/png');document.body.append(a);a.click();a.remove();toast('計測結果の画像を保存しました');
}
async function shareApp(){
  const data={title:'Nail Mii | ネイルサイズ計測',text:'10円玉・100円玉で爪の幅を測れる無料アプリ',url:location.href.split('#')[0]};
  if(navigator.share){try{await navigator.share(data);return;}catch(err){if(err.name==='AbortError')return;}}
  try{await navigator.clipboard.writeText(data.url);toast('アプリのURLをコピーしました');}catch{toast('アプリのURLをブラウザからコピーしてください');}
}
function clearResults(){if(!confirm('左右10本の計測データを削除しますか？ サイズ表の設定は残ります。'))return;
  state.widths={left:Array(5).fill(null),right:Array(5).fill(null)};state.draft=[];for(const h of ['left','right'])state.hands[h].points=Array(5).fill(null);storeWidths();refresh();toast('計測データを削除しました');
}
function init(){
  document.querySelectorAll('[data-hand]').forEach(b=>b.addEventListener('click',()=>selectHand(b.dataset.hand)));
  $('coinType').addEventListener('change',e=>handleCoinChange(e.target.value));
  $('startCameraBtn').addEventListener('click',openCamera);$('cameraStopBtn').addEventListener('click',stopCamera);$('switchCameraBtn').addEventListener('click',()=>{state.facing=state.facing==='environment'?'user':'environment';openCamera();});$('captureBtn').addEventListener('click',capture);
  for(const id of ['photoInput','photoReplaceInput'])$(id).addEventListener('change',acceptFile);
  $('retakeBtn').addEventListener('click',openCamera);
  $('zoomOutBtn').addEventListener('click',()=>zoom(1/1.45));$('zoomInBtn').addEventListener('click',()=>zoom(1.45));$('zoomResetBtn').addEventListener('click',resetView);
  const canvas=$('editorCanvas');canvas.addEventListener('pointerdown',canvasPointerDown);canvas.addEventListener('pointermove',canvasPointerMove);canvas.addEventListener('pointerup',canvasPointerUp);canvas.addEventListener('pointercancel',canvasPointerUp);window.addEventListener('resize',requestDraw);
  $('resetPointsBtn').addEventListener('click',resetPoints);$('confirmPointsBtn').addEventListener('click',confirmPoints);$('autoDetectBtn').addEventListener('click',autoScanPhoto);
  $('shareBtn').addEventListener('click',shareApp);$('exportImageBtn').addEventListener('click',downloadResultsImage);$('copyResultsBtn').addEventListener('click',copyResults);$('clearResultsBtn').addEventListener('click',clearResults);
  $('saveChartBtn').addEventListener('click',saveChart);$('resetChartBtn').addEventListener('click',resetChart);
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.stream)stopCamera();});
  editChartRows();refresh();
  if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
init();
