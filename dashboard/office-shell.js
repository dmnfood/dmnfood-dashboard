// A desktop-only entry and truthful empty state; no organization or activity data.
export function mountOfficeShell({retry, document:doc=document}={}) {
 const main=doc.querySelector('#mainContent > .page-main');
 if(!main)throw Error('HOME unavailable');
 const previous={inert:main.inert,aria:main.getAttribute('aria-hidden')};
 const root=doc.createElement('section');root.id='office-unavailable';root.hidden=true;
 root.setAttribute('aria-label','오피스');
 const title=doc.createElement('h1');title.textContent='오피스';title.tabIndex=-1;
 const message=doc.createElement('p');message.setAttribute('role','status');
 const again=doc.createElement('button');again.type='button';again.textContent='다시 확인';again.addEventListener('click',()=>retry?.());
 root.append(title,message,again);doc.body.append(root);
 const button=doc.createElement('button');button.id='office-switch';button.type='button';button.textContent='오피스 →';button.setAttribute('aria-controls',root.id);button.setAttribute('aria-expanded','false');doc.body.append(button);
 let open=false,focus;
 const restore=()=>{main.inert=previous.inert;if(previous.aria===null)main.removeAttribute('aria-hidden');else main.setAttribute('aria-hidden',previous.aria);main.classList.remove('office-shell-away');};
 button.addEventListener('click',()=>{open=!open;root.hidden=!open;button.setAttribute('aria-expanded',String(open));button.textContent=open?'← 원래 홈':'오피스 →';if(open){focus=doc.activeElement;main.inert=true;main.setAttribute('aria-hidden','true');main.classList.add('office-shell-away');title.focus();}else{restore();button.focus();}});
 const labels={loading:'오피스 연결을 확인하고 있어요.',unavailable:'아직 업무 데이터가 연결되지 않았어요. 연결되면 기존 오피스 화면이 표시됩니다.',unauthorized:'로그인이 만료됐어요. 다시 로그인해 주세요.',forbidden:'오피스 정보를 볼 권한을 확인하지 못했어요.',empty:'아직 표시할 직원 정보가 없어요.'};
 return {get isOpen(){return open;},open(){if(!open)button.click();},setState(state){message.textContent=labels[state]||labels.unavailable;again.disabled=state==='loading';again.hidden=state==='unauthorized';},destroy(){const hadFocus=root.contains(doc.activeElement)||doc.activeElement===button;restore();root.remove();button.remove();if(hadFocus&&focus?.isConnected)focus.focus();}};
}
