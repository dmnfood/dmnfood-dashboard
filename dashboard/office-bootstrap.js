import { auth, hasValidLoginSession } from './js/firebase-client.js';
import { onIdTokenChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { createOfficeClient } from './office-client.js';
import { createOfficeView } from './office-view.js';
const desktop=()=>window.innerWidth>=1024;
const view=createOfficeView({desktop,retry:()=>client.refresh()});
const client=createOfficeClient({currentUser:()=>auth.currentUser,
 sessionValid:user=>desktop() && hasValidLoginSession(user),...view});
onIdTokenChanged(auth,()=>client.refresh());
window.addEventListener('pagehide',client.reset);
window.addEventListener('pageshow',()=>client.refresh());
document.addEventListener('visibilitychange',()=>document.hidden?client.reset():client.refresh());
window.addEventListener('storage',()=>client.refresh());
window.addEventListener('click',e=>{if(e.target.closest?.('.btn-logout'))client.reset();},true);
let wasDesktop=desktop();
window.addEventListener('resize',()=>{const now=desktop();if(now!==wasDesktop){wasDesktop=now;now?client.refresh():client.reset();}});
setInterval(()=>{if(!auth.currentUser || !hasValidLoginSession(auth.currentUser))client.reset();},1000);
