// No bundled organization, task or activity snapshot. No data endpoint is configured.
// This function is a renderer, not an authorization boundary. A future caller must
// obtain a validated response from an approved server-side authorization path.
export function mountOffice(officeEvidence) {
 if (window.innerWidth<1024) return {status:'unavailable',destroy(){}};
 if (!officeEvidence) return {status:'unavailable', reason:'protected-data-path-unavailable'};
 if (!Array.isArray(officeEvidence.agents) || !officeEvidence.policy?.ceoId) throw new Error('Invalid Office data');
const cleanup=[];
const listen=(target,event,fn,options)=>{if(target){target.addEventListener(event,fn,options);cleanup.push(()=>target.removeEventListener(event,fn,options));}};
const assetURL = path => new URL(path, import.meta.url).href;
// Independently authored spatial scene. No external assets, credentials or requests.
const main=document.querySelector('#mainContent > .page-main');
const header=document.querySelector('.app-header');
if(!main)throw Error('HOME unavailable');
const previousHome={inert:main.inert,aria:main.getAttribute('aria-hidden')};
try {
const root=document.createElement('section');root.id='office-scene';root.inert=true;root.setAttribute('aria-label','오피스 — 배치 데모');root.setAttribute('aria-hidden','true');
// ID/reportsTo organization model used by this renderer.
const policy = Object.freeze({...officeEvidence.policy});
function organize(agents, p=policy) {
 const ids=new Set();
 for(const a of agents){if(!a.id||ids.has(a.id))throw Error('missing/duplicate ID');ids.add(a.id);}
 const live=agents.filter(a=>a.status!=='terminated');
 const byId=new Map(live.map(a=>[a.id,a]));
 if(!byId.has(p.ceoId)||byId.get(p.ceoId).reportsTo)throw Error('CEO root invalid');
 const groups=new Map([[p.ceoId,[]]]), unresolved=[];
 for(const a of live){
  let key=null,reason=null;
  if(a.id===p.ceoId)key=p.ceoId;
  else if(a.id===p.eaId && a.reportsTo===p.ceoId)key=p.ceoId;
  else {
   let n=a;const seen=new Set();
   while(n){
    if(seen.has(n.id)){reason='cycle';break;}seen.add(n.id);
    if(n.reportsTo===p.ceoId){key=n.id;break;}
    if(!n.reportsTo||!byId.has(n.reportsTo)){reason='missing/inactive parent';break;}
    n=byId.get(n.reportsTo);
   }
  }
  if(reason)unresolved.push({id:a.id,reason});
  else {if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);}
 }
 return {groups:[...groups].sort(([a],[b])=>a===p.ceoId?-1:b===p.ceoId?1:a.localeCompare(b)).map(([id,members])=>({id,members:members.sort((a,b)=>a.id===id?-1:b.id===id?1:a.id.localeCompare(b.id))})),unresolved,history:agents.filter(a=>a.status==='terminated')};
}

const esc=v=>String(v??'미확인').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const activeAgents=officeEvidence.agents.filter(a=>a.status!=='terminated');
const findAgent=id=>officeEvidence.agents.find(a=>a.id===id);
const org=organize(officeEvidence.agents);
const members=activeAgents.map(a=>[a.id,a.name,0,0,'#91aabc',a.title||a.name]);
const colors=['#aaa28b','#809b99','#8b99b1','#a18da5','#829ba6'];
const issues=officeEvidence.issues||[];
const taskURL=t=>officeEvidence.displayOnly?null:new URL('/CMP/issues/'+encodeURIComponent(t.identifier),officeEvidence.taskOrigin).href;
const latest=list=>[...list].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
const taskOf=id=>{const t=latest(issues.filter(t=>t.assigneeAgentId===id&&t.status==='in_progress'));return t?{text:t.title,issue:t.identifier,at:t.updatedAt,url:taskURL(t)}:null;};
const departmentTasks=g=>{const ids=new Set(g.members.map(a=>a.id)),list=issues.filter(t=>ids.has(t.assigneeAgentId));return [['Doing',['in_progress']],['Next',['todo','backlog','blocked','in_review']],['Done',['done']]].map(([label,states])=>({label,task:latest(list.filter(t=>states.includes(t.status)))}));};
// Editorial summaries bound to the observed task title and status; not live forecasts.
const taskSummaries=officeEvidence.taskSummaries||{};
const summarySources=new Map(officeEvidence.summarySources||[]);
const taskSummary=t=>{if(officeEvidence.displayOnly)return t.title;const entry=taskSummaries[t.identifier],source=summarySources.get(t.identifier);return entry&&entry[1]===t.status&&source?.title===t.title?entry[0]:({in_progress:'업무 진행 중',todo:'배정 업무 대기',backlog:'배정 업무 대기',blocked:'선행 조건 대기',in_review:'검토 대기',done:'업무 완료'}[t.status]||'상세 확인');};
function nameLines(name){
 const probe=document.createElement('span');probe.style.cssText='position:absolute;visibility:hidden;white-space:nowrap;font:14px "Noto Sans KR",sans-serif';document.body.append(probe);
 const width=text=>{probe.textContent=text;return probe.getBoundingClientRect().width||[...text].reduce((n,c)=>n+(/[\u3000-\uffff]/.test(c)?14:7),0);};
 const words=name.split(/\s+/),lines=[];let current='';
 for(const word of words){if(current&&width(current+' '+word)>106){lines.push(current);current='';}if(width(word)>106){for(const ch of [...word]){if(current&&width(current+ch)>106){lines.push(current);current='';}current+=ch;}}else current+=(current?' ':'')+word;}
 if(current)lines.push(current);probe.remove();return lines;
}
let ox=0,oy=0;const unit=.65;
const P=(x,y,z=0)=>[ox+(x-y)*.92*unit,oy+(x+y)*.40*unit-z*unit];
const pt=(x,y,z=0)=>P(x,y,z).map(n=>n.toFixed(2)).join(',');
const poly=(coords,fill,stroke='#ffffff22',cls='')=>`<polygon class="${cls}" points="${coords.map(v=>pt(...v)).join(' ')}" fill="${fill}" stroke="${stroke}"/>`;
const quad=(x,y,w,d,z,fill,stroke,cls)=>poly([[x,y,z],[x+w,y,z],[x+w,y+d,z],[x,y+d,z]],fill,stroke,cls);
const line=(a,b,color,width=2)=>`<line x1="${P(...a)[0]}" y1="${P(...a)[1]}" x2="${P(...b)[0]}" y2="${P(...b)[1]}" stroke="${color}" stroke-width="${width}"/>`;
const label=(x,y,z,text,size=13,color='#dce8f3')=>{const [sx,sy]=P(x,y,z);return `<text x="${sx}" y="${sy}" text-anchor="middle" fill="${color}" font-size="${size}" font-family="Noto Sans KR,sans-serif">${text}</text>`};
function desk(x,y,c,id){
 let s='';for(const [dx,dy]of [[0,0],[60,0],[0,34],[60,34]])s+=line([x+dx,y+dy,0],[x+dx,y+dy,30],'#697b91',3);
 s+=quad(x,y,60,34,30,'#314255','#8fa7bb');
 s+=quad(x+19,y+9,22,8,32,'#0e1727');
 s+=poly([[x+18,y+10,35],[x+48,y+10,35],[x+48,y+10,58],[x+18,y+10,58]],'#0d1727',c);
 s+=poly([[x+21,y+10,38],[x+45,y+10,38],[x+45,y+10,54],[x+21,y+10,54]],c);
 s+=quad(x+17,y+23,28,8,31,'#94a5b8');
 // Chair behind the desk; character feet on the same floor z=0.
 s+=quad(x+20,y+48,25,22,13,'#263649',c);
 const [cx,cy]=P(x+33,y+58,0);
 s+=`<ellipse cx="${cx}" cy="${cy+2}" rx="15" ry="5" fill="#0006"/>`;
 s+=line([x+28,y+55,1],[x+28,y+55,20],'#b8c5d8',5)+line([x+40,y+55,1],[x+40,y+55,20],'#b8c5d8',5);
 const agent=findAgent(id);
 s+=agent?.avatarFile ? `<image href="${assetURL(agent.avatarFile)}" x="${cx-23}" y="${cy-64}" width="46" height="64" aria-label="${agent.name} 원본 캐릭터"/>` : label(x+33,y+58,30,'캐릭터 미확인',9);

 return s;
}

function hull(points){const sorted=points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]),cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);const half=arr=>{const out=[];for(const p of arr){while(out.length>1&&cross(out.at(-2),out.at(-1),p)<=0)out.pop();out.push(p);}return out.slice(0,-1);};return [...half(sorted),...half([...sorted].reverse())];}
let scene='',labels='',wires='';const anchors=new Map(),employeeAnchors=new Map(),entranceEdges=new Map(),wireObstacles=[];
const side=org.groups.filter(g=>g.id!==policy.ceoId);
const rows=Math.max(2,Math.ceil(side.length/2));
const maxSide=Math.max(...org.groups.map(g=>Math.ceil(Math.sqrt(g.members.length))*130+32));
const cellWidth=Math.max(374,maxSide*2*.92*unit+32),rowPitch=Math.max(250,maxSide*2*.4*unit+98);
const sceneWidth=cellWidth*3,topFloor=Math.max(260,maxSide*.4*unit+154),sceneHeight=topFloor+(rows-1)*rowPitch+maxSide*.4*unit+40;
const people=org.groups.map((g,i)=>[g.id,findAgent(g.id).name,0,0,colors[i%colors.length],findAgent(g.id).title||'조직']);
for(const g of org.groups){
 const index=side.indexOf(g),center=g.id===policy.ceoId;
 ox=center?sceneWidth/2:(index%2===0?cellWidth/2:sceneWidth-cellWidth/2);oy=center?sceneHeight*.56:topFloor+Math.floor(index/2)*rowPitch;
 const color=people.find(p=>p[0]===g.id)[4],cols=Math.ceil(Math.sqrt(g.members.length)),rows=Math.ceil(g.members.length/cols);
 const w=cols*130+32,d=rows*130+32,x=-w/2,y=-d/2;
 const corners=[];for(let i=0;i<g.members.length;i++){const sx=x+(i%cols)*130,sy=y+Math.floor(i/cols)*130;corners.push([sx,sy],[sx+162,sy],[sx+162,sy+162],[sx,sy+162]);}
 const outline=hull(corners);
 scene+=poly(outline.map(([a,b])=>[a+8,b+8,-16]),'#0005','none','office-ground-shadow');
 for(let i=0;i<outline.length;i++){const a=outline[i],b=outline[(i+1)%outline.length];if(b[0]-a[0]-(b[1]-a[1])<0)scene+=poly([[...a,0],[...b,0],[...b,-16],[...a,-16]],'#293644','#465360','office-side');}
 scene+=poly(outline.map(a=>[...a,0]),color+'77','#617080','office-floor');
 const frontEdges=outline.map((a,i)=>[a,outline[(i+1)%outline.length]]).sort((a,b)=>(b[0][1]+b[1][1])-(a[0][1]+a[1][1]));
 const [ea,eb]=frontEdges[0],entrance=P((ea[0]+eb[0])/2,(ea[1]+eb[1])/2);anchors.set(g.id,entrance);entranceEdges.set(g.id,[P(...ea),P(...eb)]);
 const cardY=oy-(w+d)*.2*unit-106;wireObstacles.push({x:ox-160,y:cardY,w:320,h:95});
 const cardRows=departmentTasks(g),dept=officeEvidence.departmentFunctions?.[g.id]||'Team';
 labels+='<g class="office-department-label" data-person="'+g.id+'" tabindex="0" role="button" aria-label="'+esc(dept)+' 부서 업무 상세"><title>'+esc(dept+' · '+officeEvidence.at+' · '+cardRows.map(r=>r.label+': '+(r.task?r.task.identifier+' '+r.task.status+' '+r.task.title:'—')).join(' / '))+'</title><rect x="'+(ox-160)+'" y="'+cardY+'" width="320" height="95" rx="10" fill="#152130" stroke="#344658"/><text x="'+(ox-147)+'" y="'+(cardY+21)+'" font-size="17" fill="'+color+'">'+esc(dept)+'</text>'+cardRows.map((r,j)=>'<text x="'+(ox-147)+'" y="'+(cardY+43+j*21)+'" font-size="14" fill="#d2dbe6">'+r.label+' · '+esc(r.task?taskSummary(r.task):'—')+'</text>').join('')+'</g>';
 for(let i=0;i<g.members.length;i++){
  const a=g.members[i],frontClearance=(i%cols>0&&Math.floor(i/cols)>0)?40:0;
  const sx=x+22+(i%cols)*130+frontClearance,sy=y+18+Math.floor(i/cols)*130+frontClearance;
  const [nx,feetY]=P(sx+33,sy+58);const ny=feetY+16;employeeAnchors.set(a.id,[nx,feetY-30]);
  if(a.id===policy.ceoId){const [cx,cy]=P(sx+33,sy+58);scene+='<ellipse cx="'+cx+'" cy="'+cy+'" rx="27" ry="12" fill="none" stroke="#baa877" stroke-width="2"/>';}
  scene+='<g class="office-agent" tabindex="0" role="button" data-person="'+a.id+'" data-department="'+g.id+'" aria-label="'+esc(a.name)+' 상세">'+desk(sx,sy,color,a.id)+'</g>';
  // Name is below its own feet, with no opaque nameplate over neighbouring characters.
  const lines=nameLines(a.name);
  wireObstacles.push({x:nx-25,y:feetY-66,w:50,h:68});
  const nameWidth=Math.max(...lines.map(l=>[...l].length))*14;
  wireObstacles.push({x:nx-nameWidth/2-3,y:ny-14,w:nameWidth+6,h:lines.length*16+3});
  labels+='<text class="office-name" data-person="'+a.id+'" x="'+nx+'" y="'+ny+'" text-anchor="middle" font-size="14" fill="#d7e0eb">'+lines.map((part,j)=>'<tspan x="'+nx+'" dy="'+(j?16:0)+'">'+esc(part)+'</tspan>').join('')+'</text>';
 }
}
const origin=anchors.get(policy.ceoId);
for(const g of side){const dest=anchors.get(g.id),color=people.find(p=>p[0]===g.id)[4];wires+='<path class="office-wire" data-department="'+g.id+'" d="M '+origin.join(' ')+' C '+origin[0]+' '+(origin[1]+45)+', '+dest[0]+' '+(dest[1]+45)+', '+dest.join(' ')+'" style="stroke:'+color+'"><title>조직상 보고관계 · 현재 활동 미확인</title></path><circle cx="'+dest[0]+'" cy="'+dest[1]+'" r="3" fill="'+color+'"/>';}
const services=[['paperclip','Paperclip','연결 미확인'],['drive','네이버웍스','연결 미확인'],['github','GitHub','연결 미확인'],['n8n','n8n','연결 미확인'],['chatgpt','ChatGPT','직원별 연결 미확인'],['dot','ChatGPT dot','외부 도구; 직접 연결 미확인']];
if(officeEvidence.displayOnly)for(const service of services)service[2]='직원별 관측 상태 참조';
const dockScale=.65,dockPitch=100,dockWidth=6*dockPitch*dockScale,serviceLeft=(sceneWidth-dockWidth)/2,serviceX=i=>serviceLeft+(dockPitch/2+i*dockPitch)*dockScale,serviceBottom=4+56*dockScale;
const serviceColors={paperclip:'#aab8c7',drive:'#79aca1',github:'#b0a1c1',n8n:'#bd92a0'};
// Route independent relationships around character/name rectangles. Each
// entrance slot belongs to one relation; it does not merge evidence or activity.
function routeWire(a,b,pad){
 const boxes=wireObstacles.map(o=>({l:o.x-pad,r:o.x+o.w+pad,t:o.y-pad,b:o.y+o.h+pad}));
 const inside=(p,o)=>p[0]>o.l&&p[0]<o.r&&p[1]>o.t&&p[1]<o.b;
 const clear=(a,b)=>boxes.every(o=>{if(inside(a,o)||inside(b,o))return false;let lo=0,hi=1;for(const [v,d,min,max] of [[a[0],b[0]-a[0],o.l+.05,o.r-.05],[a[1],b[1]-a[1],o.t+.05,o.b-.05]]){if(Math.abs(d)<1e-8){if(v<min||v>max)return true;}else{let u=(min-v)/d,vv=(max-v)/d;if(u>vv)[u,vv]=[vv,u];lo=Math.max(lo,u);hi=Math.min(hi,vv);if(lo>hi)return true;}}return hi<0||lo>1;});
 const nodes=[a,b,...boxes.flatMap(o=>[[o.l,o.t],[o.r,o.t],[o.r,o.b],[o.l,o.b]]).filter(p=>!boxes.some(o=>inside(p,o)))];
 const ds=nodes.map(()=>Infinity),prev=[],seen=new Set();ds[0]=0;
 while(seen.size<nodes.length){let u=-1;for(let i=0;i<nodes.length;i++)if(!seen.has(i)&&(u<0||ds[i]<ds[u]))u=i;if(u<0||!isFinite(ds[u])||u===1)break;seen.add(u);for(let v=0;v<nodes.length;v++)if(!seen.has(v)&&clear(nodes[u],nodes[v])){const n=ds[u]+Math.hypot(nodes[u][0]-nodes[v][0],nodes[u][1]-nodes[v][1]);if(n<ds[v]){ds[v]=n;prev[v]=u;}}}
 if(!isFinite(ds[1]))return [a,b];const path=[];for(let u=1;u!==undefined;u=prev[u])path.unshift(nodes[u]);return path;
}
for(const r of officeEvidence.relations||[]){
 const base=employeeAnchors.get(r.agentId),i=services.findIndex(s=>s[0]===r.serviceId),group=org.groups.find(g=>g.members.some(a=>a.id===r.agentId));if(!base||i<0||!group)continue;
 const peers=officeEvidence.relations.filter(q=>group.members.some(a=>a.id===q.agentId)).sort((a,b)=>employeeAnchors.get(a.agentId)[0]-employeeAnchors.get(b.agentId)[0]||employeeAnchors.get(a.agentId)[1]-employeeAnchors.get(b.agentId)[1]||a.serviceId.localeCompare(b.serviceId)),slot=peers.indexOf(r),edge=entranceEdges.get(group.id),t=(slot+1)/(peers.length+1);
 const entry=[edge[0][0]+(edge[1][0]-edge[0][0])*t,edge[0][1]+(edge[1][1]-edge[0][1])*t+12];
 const dest=[base[0]+42+i*7,base[1]-20],x=serviceX(i),color=serviceColors[r.serviceId]||'#91aabc',rid=r.serviceId+':'+r.agentId;
 for(let step=0;step<30&&wireObstacles.some(o=>entry[0]>o.x-16&&entry[0]<o.x+o.w+16&&entry[1]>o.y-16&&entry[1]<o.y+o.h+16);step++)entry[1]+=3;
 const blockedPoint=p=>wireObstacles.some(o=>p[0]>o.x-5&&p[0]<o.x+o.w+5&&p[1]>o.y-5&&p[1]<o.y+o.h+5);
 const candidates=[];for(const dx of [33,-33,40,-40,48,-48,60,-60])for(const dy of [-20+i*7,-28+i*7,4+i*7,36+i*7]){const p=[base[0]+dx,base[1]+dy];if(!blockedPoint(p))candidates.push(p);}
 candidates.sort((a,b)=>Math.hypot(a[0]-base[0],a[1]-base[1])-Math.hypot(b[0]-base[0],b[1]-base[1]));if(candidates[0]){dest[0]=candidates[0][0];dest[1]=candidates[0][1];}
 const sideX=Math.min(...edge.map(p=>p[0]))-22-slot*5;
 const approach=[sideX,entry[1]-22];while(blockedPoint(approach))approach[0]-=3;
 const points=[...routeWire(approach,entry,2+i*.6),...routeWire(entry,dest,2+i*.6).slice(1)];
 let d='M '+x+' '+serviceBottom+' C '+x+' 100, '+sideX+' 100, '+approach.join(' ');
 for(let j=1;j<points.length;j++){const p=points[j];if(j===points.length-1){d+=' L '+p.join(' ');continue;}const a=points[j-1],b=points[j+1],la=Math.hypot(p[0]-a[0],p[1]-a[1]),lb=Math.hypot(b[0]-p[0],b[1]-p[1]),radius=Math.min(2,la/3,lb/3);const before=p.map((v,k)=>v+(a[k]-v)*radius/la),after=p.map((v,k)=>v+(b[k]-v)*radius/lb);d+=' L '+before.join(' ')+' Q '+p.join(' ')+', '+after.join(' ');}
 wires+='<g class="office-service-relation" data-relation-id="'+rid+'" data-service="'+r.serviceId+'" data-employee="'+r.agentId+'" data-department="'+group.id+'" style="--relation-color:'+color+'"><path class="office-wire office-service-wire" data-relation-id="'+rid+'" data-service="'+r.serviceId+'" data-employee="'+r.agentId+'" data-current-activity="'+(r.active?'confirmed':'unconfirmed')+'" d="'+d+'"><title>'+esc(services[i][1]+' → '+findAgent(r.agentId).name+' · '+r.kind+' · '+r.detail+' · '+r.observedAt)+'</title></path><circle class="office-relation-dot" data-endpoint="entrance" cx="'+entry[0]+'" cy="'+entry[1]+'" r="2.3"/><circle class="office-relation-dot" data-endpoint="employee" cx="'+dest[0]+'" cy="'+dest[1]+'" r="2.8"/></g>';
}
const serviceAssets={n8n:'office-assets/service-n8n.svg',paperclip:'office-assets/service-paperclip.svg',drive:'office-assets/service-drive.svg',github:'office-assets/github-mark.png'};
const serviceCard='<g class="office-services"><rect class="office-dock-border" x="'+serviceLeft+'" y="4" width="'+dockWidth+'" height="36.4" rx="7.8" fill="none" stroke="#617080"/>'+services.map(([id,name,state],i)=>'<g class="office-tool" tabindex="0" role="button" data-tool="'+id+'" aria-label="'+name+'; '+state+'; 상세"><title>'+name+' · '+state+' · '+officeEvidence.at+'</title><rect class="office-tool-hit" x="'+(serviceX(i)-30)+'" y="0" width="60" height="48" fill="transparent"/>'+(serviceAssets[id]?'<image href="'+assetURL(serviceAssets[id])+'" x="'+(serviceX(i)-11.05)+'" y="12.45" width="22.1" height="19.5"/>':'<text x="'+serviceX(i)+'" y="24.15" text-anchor="middle" font-size="9.1" fill="#d5deea">'+name+'</text>')+'</g>').join('')+'</g>';
root.innerHTML='<div class="office-heading"><h1 tabindex="-1" class="office-visually-hidden">오피스</h1></div><svg class="office-map" viewBox="0 0 '+sceneWidth+' '+sceneHeight+'" role="group" aria-label="직원 조직과 업무 · 조회 '+officeEvidence.at+'; 실시간 활동 아님"><g class="office-illustrations">'+scene+'</g><g class="office-tubes" pointer-events="none">'+wires+'</g><g class="office-label-layer">'+labels+serviceCard+'</g></svg><div class="office-legend"><button type="button" id="office-roster">직원·근거</button></div>';
const compact=document.createElement('div');compact.className='office-compact-list';compact.innerHTML='<p>이 창에서는 글자 크기를 유지하도록 조직 목록을 표시합니다.</p>'+org.groups.map(g=>'<section><h2>'+esc(findAgent(g.id).name)+' · '+g.members.length+'명</h2>'+g.members.map(a=>'<button type="button" class="office-compact-person" data-person="'+a.id+'">'+esc(a.name)+'</button>').join('')+'</section>').join('');root.insertBefore(compact,root.querySelector('.office-legend'));
document.body.append(root);
function fitScene(){
 const map=root.querySelector('.office-map'),top=Math.max(0,header?.getBoundingClientRect().bottom||0),panel=root.classList.contains('office-inspecting')?Math.min(352,window.innerWidth*.34)+24:0;
 const aw=Math.max(1,window.innerWidth-panel-32),ah=Math.max(1,window.innerHeight-top-80),scale=Math.min(aw/sceneWidth,ah/sceneHeight);
 map.style.width=sceneWidth+'px';map.style.height=sceneHeight+'px';map.style.transform='translate('+((aw-sceneWidth*scale)/2+16)+'px, 0px) scale('+scale+')';
 root.style.setProperty('--scene-height',sceneHeight*scale+'px');map.style.marginBottom=(sceneHeight*scale-sceneHeight)+'px';root.dataset.fitScale=scale;
 // Keep service interaction bounds at least 44 CSS px after scene fitting.
 root.querySelectorAll('.office-tool-hit').forEach(hit=>{
 const cx=Number(hit.getAttribute('x'))+Number(hit.getAttribute('width'))/2;
 const width=Math.max(60,44.1/scale),height=Math.max(48,44.1/scale);
 hit.setAttribute('x',cx-width/2);hit.setAttribute('width',width);
 hit.setAttribute('y',24-height/2);hit.setAttribute('height',height);
 });
 root.dataset.readability=scale*14<12?'limited':'normal';root.classList.toggle('office-compact',scale*14<12);root.querySelector('.office-compact-list').style.width=aw+'px';
}
const dialog=document.createElement('aside');dialog.id='office-detail';dialog.hidden=true;dialog.setAttribute('aria-labelledby','office-detail-title');document.body.append(dialog);
const statusText=s=>({idle:'대기',running:'실행 중으로 기록됨',working:'진행 중',blocked:'확인 필요',paused:'일시 정지',terminated:'종료 · 보존 이력 (현재 활동 아님)'}[s]||'미확인');
const roleSummaries=officeEvidence.roleSummaries||{};
function agentDetail(a){
 const parent=officeEvidence.agents.find(p=>p.id===a.reportsTo),children=activeAgents.filter(p=>p.reportsTo===a.id);
 return `<div class="office-identity">${a.avatarFile?`<img class="office-avatar" src="${esc(assetURL(a.avatarFile))}" alt="${esc(a.name)} 원본 캐릭터">`:'<p>캐릭터 출처 미확인</p>'}<h3>${esc(a.name)}</h3><p>${esc(a.title||a.name)} · ${statusText(a.status)} (조회 당시)</p></div>${org.groups.some(g=>g.id===a.id)?'<section class="office-info-card"><h4>부서에서 하는 일</h4>'+departmentTasks(org.groups.find(g=>g.id===a.id)).map(r=>'<p>'+({Doing:'진행 중',Next:'다음 일',Done:'마친 일'}[r.label]||r.label)+': '+(r.task?(officeEvidence.displayOnly?'<span>'+esc(taskSummary(r.task))+'</span> · ':'<a href="'+esc(taskURL(r.task))+'">'+esc(taskSummary(r.task))+'</a> · ')+esc({in_progress:'진행 중',backlog:'대기',done:'완료',todo:'예정',blocked:'막힘',in_review:'검토 중'}[r.task.status]||r.task.status)+' · 관측 '+esc(r.task.updatedAt):'—')+'</p>').join('')+'<p>전체 조회 '+esc(officeEvidence.at)+' · 상태별 최근 업무 한 건입니다.</p></section>':''}
 <section class="office-info-card"><h4>함께 쓰는 도구</h4><ul>${(officeEvidence.relations||[]).filter(r=>r.agentId===a.id).map(r=>'<li>'+esc(services.find(s=>s[0]===r.serviceId)?.[1]||r.serviceId)+' · '+esc(officeEvidence.displayOnly?r.detail:r.kind==='configured-indirect'?'드라이브 자료 전달에 사용 · 별도 사용 권한과 현재 실행은 미확인':'사용하도록 설정됨 · 현재 실행은 미확인')+' · '+esc(r.observedAt)+'</li>').join('')||'<li>직원별 관계 미확인</li>'}</ul><p>관계는 표시된 관측 시각 기준입니다. 선이 밝아지는 것은 선택 표시입니다.</p></section>
 <section class="office-info-card"><h4>최근 맡은 일</h4><p>${taskOf(a.id)?esc(taskOf(a.id).text)+' · 관측 '+esc(taskOf(a.id).at)+(officeEvidence.displayOnly?'':' · <a href="'+esc(taskOf(a.id).url)+'">배정 원문</a>'):'현재 작업 정보 없음'}</p></section>
 <section class="office-info-card"><h4>누구와 일하나요</h4><p>보고 대상: ${esc(parent?.name||'최상위')}<br>산하 직원: ${esc(children.map(p=>p.name).join(', ')||'없음')}<br>조직 관계는 실제 업무 지시·협업 증거와 다릅니다.</p></section>
 <section class="office-info-card"><h4>이번 일을 함께하는 사람</h4><p>지시받음: ${esc(a.assignmentSummary||'미확인')}<br>지시함: 미확인<br>실제 협업 수행: 미확인<br>관련 업무: ${esc(a.relatedWorkSummary||'미확인')}</p></section>
 <section class="office-info-card"><h4>확인한 때와 자료</h4><p>직원 상태·캐릭터: 보호된 응답의 허용 필드 · ${esc(a.statusUpdatedAt||officeEvidence.at)} · 검증된 응답 기준<br>최근 성공 실행을 현재 실행 상태로 환산하지 않습니다. 실시간 이벤트 미수집.<br>종료 직원은 현재 활동·산하 인원에서 제외합니다.</p></section>
 <section class="office-info-card"><h4>쓸 수 있도록 설정된 도구</h4><ul>${a.skills.map(s=>`<li>${esc(s.name)} · 설정 ${esc(s.state)}</li>`).join('')||'<li>목록 미확인</li>'}</ul><p>설정 기준 ${esc(a.skillsAt)} · 실제 로드·실행 여부와 별개입니다.</p></section>`;
}
let detailOpener=null;
let viewportBefore=null;
// The inspector is a body-level viewport overlay, outside the transformed scroll root.
function placeDetail(){
 const v=window.visualViewport;
 const top=Math.max(v?.offsetTop||0,header?.getBoundingClientRect().bottom||0)+12;
 const bottom=(v?.offsetTop||0)+(v?.height||window.innerHeight)-64;
 dialog.style.top=top+'px';
 dialog.style.height=Math.max(80,bottom-top)+'px';
}
function closeDetail(restore=true){
 if(dialog.hidden)return;
 dialog.hidden=true;highlight([]);
 const map=root.querySelector('.office-map'),previousTransition=map.style.transition;
 // Restore the unscaled coordinate system before measuring the return target.
 map.style.transition='none';root.classList.remove('office-inspecting');fitScene();
 if(detailOpener?.classList.contains('office-compact-person')&&!root.classList.contains('office-compact'))detailOpener=root.querySelector('.office-agent[data-person="'+detailOpener.dataset.person+'"]')||detailOpener;
 if(viewportBefore){root.scrollLeft=viewportBefore.x;root.scrollTop=viewportBefore.y;}
 viewportBefore=null;
 if(restore&&detailOpener?.isConnected){
  const r=detailOpener.getBoundingClientRect(),v=root.getBoundingClientRect();
  if(r.width&&r.height){
   const dx=r.left<v.left+12?r.left-v.left-12:r.right>v.right-12?r.right-v.right+12:0;
   const dy=r.top<v.top+12?r.top-v.top-12:r.bottom>v.bottom-64?r.bottom-v.bottom+64:0;
   root.scrollLeft+=dx;root.scrollTop+=dy;
  }
  detailOpener.focus({preventScroll:true});
 }
 // Flush restoration before returning to the normal opening transition.
 map.getBoundingClientRect();map.style.transition=previousTransition;
}
function openDetail(title,body){
 if(!officeAvailable()||!current)return;
 if(dialog.hidden)viewportBefore={x:root.scrollLeft,y:root.scrollTop};
 dialog.innerHTML=`<button type="button" class="office-close" aria-label="상세 닫기">닫기 ×</button><h2 id="office-detail-title" tabindex="-1">${esc(title)}</h2>${body}`;
 placeDetail();dialog.hidden=false;root.classList.add('office-inspecting');fitScene();
 dialog.querySelector('.office-close').onclick=()=>closeDetail();
 dialog.scrollTop=0;dialog.querySelector('h2').focus({preventScroll:true});
}
function escapeDetail(e){if(e.key==='Escape'&&!dialog.hidden){e.preventDefault();closeDetail();}}
root.addEventListener('keydown',escapeDetail);dialog.addEventListener('keydown',escapeDetail);
listen(window.visualViewport,'resize',placeDetail);
listen(window.visualViewport,'scroll',placeDetail);
function highlight(departments,employee=null,service=null){
 root.querySelectorAll('.office-wire:not(.office-service-wire)').forEach(w=>w.classList.toggle('office-highlight',departments.includes(w.dataset.department)));
 root.classList.toggle('office-relation-selection',!!(employee||service||departments.length));
 root.querySelectorAll('.office-service-relation').forEach(g=>{const selected=service?g.dataset.service===service:employee?g.dataset.employee===employee:departments.includes(g.dataset.department);g.classList.toggle('office-relation-selected',selected);g.querySelector('path').classList.toggle('office-highlight',selected);});
}
function select(id){const p=members.find(p=>p[0]===id),a=findAgent(id);const department=org.groups.find(g=>g.members.some(a=>a.id===id))?.id;highlight([department],detailOpener?.classList.contains('office-department-label')?null:id);
 const children=a?activeAgents.filter(b=>b.reportsTo===a.id):[];
 openDetail(`${p[1]}`,`<p>하는 일: ${esc(roleSummaries[a?.id]||p[5])}</p>${a?agentDetail(a):'<p>Dot은 중앙 CEO와 협업하는 외부 QA·접근 보조이며 Paperclip 직원 EA와 별개입니다. 회사 직원 설정·등록 스킬 목록 대상이 아닙니다. 외부 설정·실시간 사용은 미확인입니다.</p>'}${children.length?'<h3>함께 일하는 직원</h3>'+children.map(agentDetail).join(''):''}`);
}
function selectTool(key){const service=services.find(s=>s[0]===key),relations=(officeEvidence.relations||[]).filter(r=>r.serviceId===key);highlight([],null,key);openDetail(service[1]+' · 쓰임과 연결','<p>'+esc(service[2])+(key==='n8n'&&!officeEvidence.displayOnly?' — 연결 권한과 현재 실행은 미확인입니다.':'')+' · 전체 조회 '+esc(officeEvidence.at.slice(0,10))+'</p><ul>'+relations.map(r=>'<li>'+esc(findAgent(r.agentId).name)+' · '+esc(officeEvidence.displayOnly?r.detail:r.kind==='configured-indirect'?'드라이브 자료 전달에 사용 · 별도 사용 권한과 현재 실행은 미확인':'사용하도록 설정됨 · 현재 실행은 미확인')+' · '+esc(r.observedAt.slice(0,10))+'</li>').join('')+'</ul><p>배정·연결 가능·현재 활동은 별도 상태입니다.</p><p>'+esc(officeEvidence.serviceResearch.connectorAccess)+'</p><p>'+(relations.length?'':'누가 쓰는지는 아직 확인하지 못했습니다.')+'</p><p>'+esc(officeEvidence.serviceResearch.categories.join(' / '))+'</p>'+(key==='dot'?'<p>'+esc(officeEvidence.serviceResearch.dot)+'</p>':''));}
for(const [selector,callback]of [['.office-agent,.office-department-label,.office-compact-person',el=>select(el.dataset.person)],['.office-tool',el=>selectTool(el.dataset.tool)]])root.querySelectorAll(selector).forEach(el=>{el.addEventListener('click',()=>{detailOpener=el;callback(el)});el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();detailOpener=el;callback(el)}})});
root.querySelector('#office-roster').addEventListener('click',()=>{detailOpener=root.querySelector('#office-roster');highlight([]);openDetail('직원·등록 스킬 전체 목록',`<p>기준 ${esc(officeEvidence.at)}. 직원 ID와 reportsTo 기준으로 소속을 계산합니다. 분류 보류 ${org.unresolved.length}명. 활동 대상 ${activeAgents.length}명. 종료 이력은 아래 별도 보존하며 현재 활동이 아닙니다.</p>`+activeAgents.map(agentDetail).join('')+'<h3>종료된 직원 · 보존 이력</h3>'+officeEvidence.agents.filter(a=>a.status==='terminated').map(agentDetail).join(''));});

const toggle=document.createElement('button');toggle.id='office-switch';toggle.type='button';toggle.textContent='오피스 →';toggle.setAttribute('aria-controls','office-scene');toggle.setAttribute('aria-expanded','false');document.body.append(toggle);
const officeAvailable=()=>window.innerWidth>=1024;
let current=false,homeScroll=0,homeFocus=null,timer;const reduce=matchMedia('(prefers-reduced-motion: reduce)');
function show(office){
 office=office&&officeAvailable();
 if(current===office)return;clearTimeout(timer);
 if(office){homeScroll=window.scrollY;homeFocus=document.activeElement;}
 current=office;syncOfficeTop();
 root.classList.add('office-visible');root.classList.toggle('office-moving',!reduce.matches);main.classList.toggle('office-moving',!reduce.matches);
 root.classList.toggle('office-current',office);main.classList.toggle('office-away',office);
 root.inert=!office;main.inert=office;root.setAttribute('aria-hidden',String(!office));main.setAttribute('aria-hidden',String(office));
 toggle.setAttribute('aria-expanded',String(office));toggle.textContent=office?'← 원래 홈':'오피스 →';
 // Keep original body and main width/scroll geometry. No wrapper, scaling or iframe.
 if(!office){closeDetail(false);window.scrollTo({top:homeScroll,behavior:'instant'});if(officeAvailable())toggle.focus({preventScroll:true});else restoreHomeFocus();}
 else root.querySelector('h1').focus({preventScroll:true});
 const finish=()=>{main.classList.remove('office-moving');root.classList.remove('office-moving');if(!current)root.classList.remove('office-visible');};
 if(reduce.matches)finish();else timer=setTimeout(finish,460);
}
// Namespaced hash keeps every existing query parameter intact.
const isOffice=()=>location.hash==='#dmn-office';
toggle.addEventListener('click',()=>{if(!officeAvailable())return;const url=new URL(location.href);if(current)url.hash=history.state?.dmnOfficePreviousHash||'';else url.hash='dmn-office';history.pushState({...history.state,dmnOfficePreviousHash:current?history.state?.dmnOfficePreviousHash:location.hash},'',url);show(!current)});
function restoreHomeFocus(){
 const target=homeFocus?.isConnected&&homeFocus!==toggle&&!root.contains(homeFocus)&&!dialog.contains(homeFocus)?homeFocus:main;
 const old=target.getAttribute('tabindex');
 if(old===null)target.setAttribute('tabindex','-1');
 target.focus({preventScroll:true});
 if(old===null)target.removeAttribute('tabindex');
}
function syncAvailability(){
 const available=officeAvailable();
 const hadOfficeFocus=root.contains(document.activeElement)||dialog.contains(document.activeElement)||document.activeElement===toggle;
 toggle.hidden=!available;
 if(!available){
  // Only the module-owned hash is removed; queries and other hash routes survive.
  if(isOffice()){
   const url=new URL(location.href),previous=history.state?.dmnOfficePreviousHash;
   url.hash=typeof previous==='string'&&previous!=='#dmn-office'?previous:'';
   history.replaceState(history.state,'',url);
  }
  show(false);closeDetail(false);clearTimeout(timer);
  root.classList.remove('office-visible','office-current','office-moving','office-inspecting');
  main.classList.remove('office-away','office-moving');
  root.inert=true;root.setAttribute('aria-hidden','true');main.inert=false;main.setAttribute('aria-hidden','false');
  if(hadOfficeFocus)restoreHomeFocus();
 }else show(isOffice());
}
listen(window,'popstate',()=>{closeDetail(false);syncAvailability()});
listen(window,'hashchange',syncAvailability);
// Observe original Navbar without modifying it or home layout.
function syncOfficeTop(){root.style.top=Math.max(0,header?.getBoundingClientRect().bottom||0)+'px';placeDetail();fitScene();}
if(header){const observer=new ResizeObserver(syncOfficeTop);observer.observe(header);cleanup.push(()=>observer.disconnect());}
listen(window,'resize',()=>{syncAvailability();syncOfficeTop()},{passive:true});
listen(window,'scroll',syncOfficeTop,{passive:true});
syncOfficeTop();
syncAvailability();

 let destroyed=false;
 return {status:"mounted",destroy(){
  if(destroyed)return;destroyed=true;
  const hadFocus=root.contains(document.activeElement)||dialog.contains(document.activeElement)||document.activeElement===toggle;
  show(false);clearTimeout(timer);cleanup.forEach(fn=>fn());
  if(isOffice()){const url=new URL(location.href);url.hash=history.state?.dmnOfficePreviousHash||'';history.replaceState(history.state,'',url);}
  root.remove();dialog.remove();toggle.remove();main.classList.remove('office-away','office-moving');
  main.inert=previousHome.inert;if(previousHome.aria===null)main.removeAttribute('aria-hidden');else main.setAttribute('aria-hidden',previousHome.aria);
  if(hadFocus)restoreHomeFocus();
 }};
 }catch(error){cleanup.forEach(fn=>fn());for(const id of ['office-scene','office-detail','office-switch'])document.getElementById(id)?.remove();main.classList.remove('office-away','office-moving');main.inert=previousHome.inert;if(previousHome.aria===null)main.removeAttribute('aria-hidden');else main.setAttribute('aria-hidden',previousHome.aria);throw error;}
}
