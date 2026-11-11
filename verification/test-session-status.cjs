const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sourceRoot, outputRoot } = require('./test-env.cjs');
const source = fs.readFileSync(path.join(sourceRoot, 'src-tauri/src/humble_bridge.js'), 'utf8');
const route = '/api/auth/session-status';
const nonce = 'SYNTHETIC_SESSION_PROBE';
const checks = [];
const response = (value, extra = {}) => ({status:200,ok:true,redirected:false,url:`https://www.humblebundle.com${route}`,json:async()=>value,...extra});
function setup(fetcher, origin='https://www.humblebundle.com') {
  const calls=[], messages=[], logs=[];
  const window={fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);},__TAURI_INTERNALS__:{invoke:async(name,args)=>{assert.equal(name,'humble_bridge_result');messages.push(JSON.parse(JSON.stringify(args.payload)));}}};
  window.top=window;
  const document={}; Object.defineProperty(document,'cookie',{get(){throw Error('Cookie content must never be read');}});
  vm.runInNewContext(source,{window,location:{origin},document,URL,URLSearchParams,TextEncoder,AbortController,Map,Set,Date,
    DOMParser:class{constructor(){throw Error('New session proof must not parse the account page');}},
    console:Object.fromEntries(['log','warn','error','debug','info'].map(k=>[k,(...args)=>logs.push(args)])),setTimeout});
  return {calls,messages,logs,window,run:()=>window.__humbleLibraryRequest({nonce,operation:'auth'})};
}
function clean(env) {
  assert.deepEqual(env.logs,[]);
  for(const {options} of env.calls) {
    assert.equal(options.credentials,'same-origin'); assert.equal(options.cache,'no-store');
    assert.equal(options.body,undefined); assert(!options.method||options.method==='GET');
  }
  assert(!JSON.stringify(env.messages).includes('PRIVATE_CANARY'));
}
async function check(name, action){await action();checks.push({name,passed:true});console.log(`PASS ${name}`);}
(async()=>{
  await check('New authenticated status closes proof without fetching library or exposing account data',async()=>{
    for(const origin of ['https://www.humblebundle.com','https://humblebundle.com']){
      const env=setup(async url=>{assert.equal(url,route);return response({status:'authenticated',private:'PRIVATE_CANARY'},{url:origin+route});},origin);
      await env.run();assert.deepEqual(env.messages,[{kind:'result',ok:true,authenticated:true}]);assert.equal(env.calls.length,1);clean(env);
    }
  });
  await check('Anonymous status stays disconnected',async()=>{
    const env=setup(async()=>response({status:'anonymous'}));await env.run();
    assert.deepEqual(env.messages,[{kind:'result',ok:false,reason:'auth',httpStatus:200}]);clean(env);
  });
  await check('Unknown, malformed and cart-like success responses cannot authenticate',async()=>{
    for(const value of [{status:'unknown'},{status:'ok',totalMinor:0,currency:'USD'},{authenticated:true},{status:true},null,[],true]){
      const env=setup(async()=>response(value));await env.run();assert.equal(env.messages[0].reason,'protocol');assert.equal(env.calls.length,1);clean(env);
    }
  });
  await check('Only missing new route enables legacy compatibility',async()=>{
    const env=setup(async url=>url===route?response(null,{status:404,ok:false}):response(['SYNTHETIC_ORDER'],{url:'https://www.humblebundle.com/api/v1/user/order'}));
    await env.run();assert.deepEqual(env.calls.map(x=>x.url),[route,'/api/v1/user/order']);assert.deepEqual(env.messages,[{kind:'result',ok:true,authenticated:true}]);clean(env);
  });
  await check('Rejected, throttled and failed new session reads do not fall back to stale proof',async()=>{
    for(const [status,reason] of [[401,'auth'],[403,'auth'],[429,'rateLimited'],[500,'service']]){
      const env=setup(async()=>response(null,{status,ok:false}));await env.run();assert.equal(env.messages[0].reason,reason);assert.equal(env.calls.length,1);clean(env);
    }
  });
  await check('Session response is restricted to exact HTTPS storefront origins and path',async()=>{
    for(const url of ['https://auth.humblebundle.com/login','https://www.humblebundle.com/','http://www.humblebundle.com'+route,'https://www.humblebundle.com:444'+route,'https://www.humblebundle.com.evil.test'+route,'https://name:pass@www.humblebundle.com'+route]){
      const env=setup(async()=>response({status:'authenticated'},{url}));await env.run();assert.equal(env.messages[0].reason,'auth');assert.equal(env.calls.length,1);clean(env);
    }
  });
  await check('Network and JSON failures reveal only fixed errors',async()=>{
    for(const fetcher of [async()=>{throw Error('PRIVATE_CANARY');},async()=>response(null,{json:async()=>{throw Error('PRIVATE_CANARY');}})]){
      const env=setup(fetcher);await env.run();assert.equal(env.messages[0].ok,false);assert.equal(env.calls.length,1);clean(env);
    }
  });
  await check('Cancellation before session response cannot authenticate or start another read',async()=>{
    let finish;const env=setup(()=>new Promise(resolve=>finish=resolve));const pending=env.run();
    env.window.__humbleLibraryCancel(nonce);finish(response({status:'authenticated'}));await pending;
    assert.equal(env.messages[0].reason,'cancelled');assert.equal(env.calls.length,1);clean(env);
  });
  fs.mkdirSync(outputRoot,{recursive:true});fs.writeFileSync(path.join(outputRoot,'session-status-tests.json'),JSON.stringify({fixtureOnly:true,checks},null,2));
  console.log(`PASS ${checks.length} session-status scenarios`);
})().catch(error=>{console.error(error);process.exitCode=1;});
