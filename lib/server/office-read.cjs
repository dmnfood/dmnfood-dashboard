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
const authorize = require('./firebase-authorize.cjs');
const MAX_BYTES = 32768;
function sanitize(value) {
 if (!value || ![1,2,3].includes(value.version) || !['ready','empty'].includes(value.state) || !Array.isArray(value.items) || value.items.length > 100 || !iso(value.asOf)) throw Error('schema');
 if ((value.state === 'empty') !== (value.items.length === 0)) throw Error('state');
 if(!validDisplay(value))throw Error('display');
 const ids = new Set();
 const items = value.items.map(item => {
  if (!item || typeof item.id !== 'string' || !/^office-[a-z0-9-]{1,40}$/.test(item.id) || ids.has(item.id) || typeof item.roleLabel !== 'string' || !/^[\p{L}\p{N} ·_-]{1,60}$/u.test(item.roleLabel) || !['idle','working','blocked','unknown'].includes(item.status) || !iso(item.updatedAt)) throw Error('item');
  ids.add(item.id);
  const result={id:item.id,roleLabel:item.roleLabel,status:item.status,updatedAt:item.updatedAt};
  if(value.version>=2){
   if(item.reportsTo!==null && (typeof item.reportsTo!=='string' || !/^office-[a-z0-9-]{1,40}$/.test(item.reportsTo)))throw Error('parent');
   if(item.avatarKey!==null && (typeof item.avatarKey!=='string'||!/^character-(0[1-9]|1[0-4])$/.test(item.avatarKey)))throw Error('avatar');
   Object.assign(result,{reportsTo:item.reportsTo,avatarKey:item.avatarKey});
  }return result;
 });
 const result = {version:value.version,state:value.state,asOf:value.asOf,items};
 if(value.version>=2){
  const roots=items.filter(i=>i.reportsTo===null),byId=new Map(items.map(i=>[i.id,i]));
  if(items.length && roots.length!==1)throw Error('root');
  for(const item of items){const seen=new Set();let n=item;while(n){if(seen.has(n.id))throw Error('cycle');seen.add(n.id);if(n.reportsTo!==null&&!byId.has(n.reportsTo))throw Error('parent');n=byId.get(n.reportsTo);}}
 }
 if(value.version===3)Object.assign(result,{displayPolicy:value.displayPolicy,briefs:value.briefs.map(b=>({...b})),services:value.services.map(s=>({...s}))});
 if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw Error('size');
 return result;
}
function iso(s) { return typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s; }
// No configured upstream or Office grant. Injection is for tests and a future approved adapter.
function createHandler({ authenticate = authorize, policy = () => false, reader = null, timeoutMs = 5000 } = {}) {
 return async (req,res) => {
  res.setHeader('Cache-Control','no-store, private'); res.setHeader('Vary','Authorization');
  res.setHeader('Content-Type','application/json');
  const reply = (status, body={version:1,state:'unavailable',items:[]}) => res.status(status).json(body);
  if (req.method !== 'GET') { res.setHeader('Allow','GET'); return reply(405); }
  // Fixed public origin; never trust forwarded host headers to authorize an Origin.
  if (req.headers?.origin && req.headers.origin !== 'https://dashboard.dmnfood.co.kr') return reply(403);
  if ((req.url || '').includes('?') || Object.keys(req.query || {}).length) return reply(400);
  let timer; const controller = new AbortController();
  try {
   const work = async () => {
    const user = await authenticate(req,{requireExplicitApproval:true});
    if (!user || !['manager','admin'].includes(user.role) || await policy(user) !== true) throw Object.assign(Error('denied'),{status:403});
    if (controller.signal.aborted || !reader) throw Error('unavailable');
    const result = await reader({signal:controller.signal,limit:100,maxBytes:MAX_BYTES});
    if (controller.signal.aborted) throw Error('timeout');
    return sanitize(result);
   };
   const result = await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('timeout'));},timeoutMs);})]);
   return reply(200,result);
  } catch (error) { return reply([401,403].includes(error?.status)?error.status:503); }
  finally {clearTimeout(timer); controller.abort();}
 };
}
module.exports={createHandler,sanitize};
