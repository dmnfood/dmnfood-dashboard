'use strict';
const {createHandler}=require('./office-read.cjs');
// Composition boundary for an approved server-only adapter. No credentials, env
// reads, dynamic paths or request-selected configuration are accepted here.
function createProductionHandler({adapter=require("./office-settings.cjs").adapter,authenticate,timeoutMs=5000}={}) {
 const configured=adapter && typeof adapter.allowUser==='function' && typeof adapter.readOffice==='function';
 return createHandler({authenticate,timeoutMs,
  policy:user=>configured?adapter.allowUser(user):true,
  reader:configured?options=>adapter.readOffice(options):null});
}
module.exports={createProductionHandler};
