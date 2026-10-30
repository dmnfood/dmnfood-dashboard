function validDisplay(v) {
 const exact=(o,keys)=>o && typeof o==='object' && Object.keys(o).length===keys.length && keys.every(k=>Object.hasOwn(o,k));
 const iso=s=>typeof s==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString()===s && s<=v.asOf;
 const text=s=>typeof s==='string' && /^[\p{L}\p{N} ,·()_-]{1,80}$/u.test(s) && !/(?:https?|www|token|secret|password|bearer|ghp_|sk_|비밀번호|토큰|고객)/i.test(s) && !/\d{6}/.test(s);
 if(v.version!==3)return true;
 if(v.displayPolicy!=='approved-redacted-v1' || !Array.isArray(v.briefs)||v.briefs.length>100||!Array.isArray(v.services)||v.services.length>200)return false;
 const ids=new Set(v.items.map(i=>i.id)),seen=new Set();
 for(const b of v.briefs){const key=b.agentId+':'+b.stage;if(!exact(b,['agentId','stage','summary','observedAt'])||!ids.has(b.agentId)||!['doing','next','done'].includes(b.stage)||seen.has(key)||!text(b.summary)||!iso(b.observedAt))return false;seen.add(key);}
 seen.clear();
 for(const s of v.services){const key=s.agentId+':'+s.serviceId;if(!exact(s,['agentId','serviceId','connection','activity','observedAt'])||!ids.has(s.agentId)||!['paperclip','drive','github','n8n','chatgpt','dot'].includes(s.serviceId)||!['assigned','available','unknown'].includes(s.connection)||!['observed','unknown'].includes(s.activity)||(s.activity==='observed'&&s.connection!=='available')||!iso(s.observedAt)||seen.has(key))return false;seen.add(key);}
 return true;
}
export function validResponse(v) {
 const iso=s=>typeof s==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString()===s;
 const exact=(o,keys)=>o && Object.keys(o).length===keys.length && keys.every(k=>Object.hasOwn(o,k));
 if(!exact(v,v?.version===3?['version','state','asOf','items','displayPolicy','briefs','services']:['version','state','asOf','items']) || ![1,2,3].includes(v.version) || !['ready','empty'].includes(v.state) || !iso(v.asOf) || !Array.isArray(v.items) || v.items.length>100 || (v.state==='empty')!==(v.items.length===0)) return false;
 const ids=new Set();
 const valid=v.items.every(i=>{if(!exact(i,v.version>=2?['id','roleLabel','status','updatedAt','reportsTo','avatarKey']:['id','roleLabel','status','updatedAt']) || typeof i.id!=='string' || !/^office-[a-z0-9-]{1,40}$/.test(i.id) || ids.has(i.id) || typeof i.roleLabel!=='string' || !/^[\p{L}\p{N} ·_-]{1,60}$/u.test(i.roleLabel) || !['idle','working','blocked','unknown'].includes(i.status) || !iso(i.updatedAt))return false;ids.add(i.id);return true;});
 if(!valid)return false;
 if(!validDisplay(v) || new TextEncoder().encode(JSON.stringify(v)).length>32768)return false;
 if(!valid || v.version===1)return valid;
 const byId=new Map(v.items.map(i=>[i.id,i]));
 if(v.items.length && v.items.filter(i=>i.reportsTo===null).length!==1)return false;
 for(const item of v.items){
  if(item.avatarKey!==null && (typeof item.avatarKey!=='string'||!/^character-(0[1-9]|1[0-4])$/.test(item.avatarKey)))return false;
  const seen=new Set();let n=item;while(n){if(seen.has(n.id))return false;seen.add(n.id);if(n.reportsTo!==null&&!byId.has(n.reportsTo))return false;n=byId.get(n.reportsTo);}
 }return true;
}
export function createOfficeClient({currentUser,sessionValid,request=fetch,render,clear,status=()=>{},timeoutMs=5000}) {
 let generation=0,controller;
 function reset(){generation++;controller?.abort();clear();}
 async function refresh(){
  generation++;controller?.abort(); const epoch=generation,user=currentUser();if(!user || !sessionValid(user)){clear();return;}
  clear({preserveEntry:true});status('loading');
  controller=new AbortController();const signal=controller.signal;
  const timer=setTimeout(()=>{if(epoch===generation){generation++;controller?.abort();if(currentUser()===user && sessionValid(user)){clear({preserveEntry:true});status('unavailable');}else clear();}},timeoutMs);
  const live=()=>epoch===generation && !signal.aborted && currentUser()===user && sessionValid(user);
  try {
   const token=await user.getIdToken();if(!live())return;
   const response=await request('/api/office/read',{headers:{Authorization:`Bearer ${token}`},credentials:'same-origin',cache:'no-store',redirect:'error',signal});
   if(!live())return;
   if(response.status!==200){status(response.status===401?'unauthorized':response.status===403?'forbidden':'unavailable');return;}
   if(!(response.headers.get('content-type')||'').startsWith('application/json')){status('unavailable');return;}
   // Bound the response while streaming, before parsing or rendering.
   const reader=response.body.getReader();let size=0;const chunks=[];
   try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768 || !live())throw Error('limit');chunks.push(value);}} finally {await reader.cancel();}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   if(live()){if(validResponse(value))render(value);else status('unavailable');}
  }catch{if(live())status('unavailable');}finally{clearTimeout(timer);}
 }
 return {refresh,reset};
}
