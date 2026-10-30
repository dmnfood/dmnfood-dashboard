import { validResponse } from './office-client.js';
import { mountOffice } from './office-slide.js';
import { mountOfficeShell } from './office-shell.js';
// v1 has no organization edges: never invent a root or reporting relationship.
export function toRendererDTO(value) {
 if(!validResponse(value) || ![2,3].includes(value.version) || !value.items.length)return null;
 return {at:value.asOf,policy:{ceoId:value.items.find(i=>i.reportsTo===null).id},
  displayOnly:value.version===3,
  agents:value.items.map(i=>({id:i.id,name:i.roleLabel,title:i.roleLabel,status:i.status,
   reportsTo:i.reportsTo,statusUpdatedAt:i.updatedAt,avatarFile:i.avatarKey?`office-assets/${i.avatarKey}.png`:null,
   skills:[],skillsAt:'미확인'})),issues:(value.briefs||[]).map((b,n)=>({identifier:'brief-'+n,assigneeAgentId:b.agentId,status:{doing:'in_progress',next:'todo',done:'done'}[b.stage],title:b.summary,updatedAt:b.observedAt})),relations:(value.services||[]).map(s=>({agentId:s.agentId,serviceId:s.serviceId,kind:s.connection,active:s.activity==='observed',observedAt:s.observedAt,detail:({assigned:'배정됨 · 연결 미확인',available:'연결 가능 확인',unknown:'연결 미확인'}[s.connection])+' · '+(s.activity==='observed'?'현재 활동 관측':'현재 활동 미확인')})),
  departmentFunctions:Object.fromEntries(value.items.map(i=>[i.id,i.roleLabel])),
  serviceResearch:{connectorAccess:'연결 설정 미확인',categories:[],dot:'외부 도구 상태 미확인'}};
}
export function createOfficeView({mount=mountOffice,shell=mountOfficeShell,desktop=()=>window.innerWidth>=1024,retry}={}) {
 let instance,entry,pendingOpen=false;
 const clear=({preserveEntry=false}={})=>{
  pendingOpen=preserveEntry && !!(pendingOpen||instance?.isOpen||entry?.isOpen);
  instance?.destroy();instance=null;if(!preserveEntry){entry?.destroy();entry=null;}
 };
 const status=state=>{if(!desktop()){clear();return;}clear({preserveEntry:true});
  if(!entry)entry=shell({retry});entry.setState(state);if(pendingOpen)entry.open?.();pendingOpen=false;
 };
 const render=value=>{if(!desktop()){clear();return;}const dto=toRendererDTO(value);if(!dto){status('empty');return;}
  const reopen=!!(pendingOpen||entry?.isOpen||instance?.isOpen);
  clear();try{instance=mount(dto);if(reopen)instance.open?.();}catch(error){pendingOpen=reopen;status('unavailable');throw error;}
 };
 return {render,clear,status};
}
