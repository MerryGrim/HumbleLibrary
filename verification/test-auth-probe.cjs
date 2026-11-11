const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot } = require('./test-env.cjs');
const sourcePath = path.join(sourceRoot,'src-tauri/src/humble_bridge.js');
const source = fs.readFileSync(sourcePath,'utf8');
const nonce = '0123456789abcdef0123456789abcdef';
const canary = 'SYNTHETIC-PRIVATE-ORDER-CANARY';
const report = { fixtureOnly:true, sourcePath, sourceSha256:crypto.createHash('sha256').update(source).digest('hex'), checks:[] };
const response = (value,extra={})=>({status:200,ok:true,redirected:false,url:'https://www.humblebundle.com/api/v1/user/order',json:async()=>value,...extra});
function environment(fetcher,origin='https://www.humblebundle.com',topLevel=true) {
  const sent=[],requests=[],logs=[];
  const window={fetch:async(url,options)=>{requests.push({url,options});if(url==='/api/auth/session-status')return response(null,{status:404,ok:false,url:`${origin}/api/auth/session-status`});return fetcher(url,options);},__TAURI_INTERNALS__:{invoke:async(name,args)=>{assert.equal(name,'humble_bridge_result');assert.equal(args.nonce,nonce);sent.push(JSON.parse(JSON.stringify(args.payload)));}}};
  window.top=topLevel?window:{};
  const document={};Object.defineProperty(document,'cookie',{get(){throw Error('Auth probe must not read cookies or CSRF tokens');}});
  vm.runInNewContext(source,{window,location:{origin},document,URL,URLSearchParams,TextEncoder,AbortController,DOMParser:class{constructor(){throw Error('Auth probe must not read account DOM');}},console:Object.fromEntries(['log','info','warn','error','debug'].map(name=>[name,(...values)=>logs.push({name,values})])),setTimeout:action=>setTimeout(action,0),Map,Set,Date},{filename:sourcePath});
  return {window,sent,requests,logs,probe:()=>window.__humbleLibraryRequest({nonce,operation:'auth'})};
}
function readOnly(env,paths=['/api/v1/user/order']) {
  assert.deepEqual(env.requests.filter(request=>request.url!=='/api/auth/session-status').map(request=>request.url),paths,'Legacy fallback uses only the expected read-only paths');
  for(const request of env.requests) {
  assert(['GET',undefined].includes(request.options.method));
  assert.equal(request.options.body,undefined);
  assert.equal(request.options.credentials,'same-origin');
  assert.equal(request.options.cache,'no-store');
  assert.equal(request.options.headers.Accept,request.url==='/home/library'?'text/html':'application/json');
  }
  assert.deepEqual(env.logs,[],'No account data or errors may be logged');
  assert.equal(JSON.stringify(env.sent).includes(canary),false,'No raw order data or exception may reach IPC');
}
async function check(name,action){await action();report.checks.push({name,passed:true});console.log(`PASS ${name}`);}
(async()=>{
  await check('Auth adapter is restricted to exact storefront HTTPS origins and top-level frames',async()=>{
    for(const [origin,top] of [['http://www.humblebundle.com',true],['http://humblebundle.com',true],['https://www.humblebundle.com.evil.invalid',true],['https://humblebundle.com.evil.invalid',true],['https://www.humblebundle.com:444',true],['https://humblebundle.com:444',true],['https://auth.humblebundle.com',true],['https://www.humblebundle.com',false],['https://humblebundle.com',false]]) {
      const env=environment(async()=>{throw Error('Unexpected fixture request');},origin,top);
      assert.equal(env.window.__humbleLibraryRequest,undefined);assert.equal(env.window.__humbleLibraryBridgeState,undefined);assert.equal(env.requests.length,0);
    }
  });
  await check('Both canonical storefront origins can prove a session and accept only same-service redirects',async()=>{
    for(const origin of ['https://www.humblebundle.com','https://humblebundle.com']) {
      for(const redirected of [false,true]) {
        const alternate=origin==='https://www.humblebundle.com'?'https://humblebundle.com':'https://www.humblebundle.com';
        const env=environment(async()=>response([],{redirected,url:`${alternate}/api/v1/user/order`}),origin);
        await env.probe();assert.deepEqual(env.sent,[{kind:'result',ok:true,authenticated:true}]);readOnly(env);
      }
    }
    for(const url of ['https://auth.humblebundle.com/login','https://www.humblebundle.com.evil.invalid/api/v1/user/order','https://humblebundle.com:444/api/v1/user/order','http://humblebundle.com/api/v1/user/order','https://user:password@www.humblebundle.com/api/v1/user/order']) {
      const env=environment(async()=>response([],{redirected:true,url}));await env.probe();
      assert.deepEqual(env.sent,[{kind:'result',ok:false,reason:'auth',httpStatus:200}]);readOnly(env);
    }
  });
  await check('Only a valid order-list array proves login, including an empty account, without returning raw rows',async()=>{
    for(const list of [[],['SYNTHETIC_ORDER_1'],[{gamekey:'SYNTHETIC_ORDER_2',privateData:canary}],['SYNTHETIC_ORDER_1',{gamekey:'SYNTHETIC_ORDER_2'}]]) {
      const env=environment(async()=>response(list));await env.probe();
      assert.deepEqual(env.sent,[{kind:'result',ok:true,authenticated:true}]);readOnly(env);
    }
  });
  await check('HTTP401, HTTP403 and login/signin redirects never report successful authentication',async()=>{
    for(const extra of [{status:401,ok:false},{status:403,ok:false},{redirected:true,url:'https://www.humblebundle.com/login?next=purchases'},{redirected:true,url:'https://www.humblebundle.com/signin'}]) {
      const env=environment(async()=>response([canary],extra));await env.probe();
      assert.equal(env.sent.at(-1).ok,false);assert.equal(env.sent.at(-1).reason,'auth');
      assert.equal(env.sent.some(value=>value.authenticated===true),false);readOnly(env);
    }
  });
  await check('Invalid response JSON and every malformed list entry fail closed rather than accepting partial proof',async()=>{
    for(const value of [null,{},42,'[]',{orders:[]},[null],[''],['bad/id'],[{}],[{gamekey:42}],['VALID_ORDER',null],Array(10001).fill('VALID_ORDER')]) {
      const env=environment(async()=>response(value));await env.probe();
      assert.equal(env.sent.at(-1).ok,false);assert.equal(env.sent.at(-1).reason,'protocol');readOnly(env);
    }
    const env=environment(async()=>response(null,{json:async()=>{throw Error(canary);}}));await env.probe();
    assert.equal(env.sent.at(-1).reason,'protocol');readOnly(env);
  });
  await check('Transport failure exposes only a closed reason, never retries, mutates, reads secrets or sends a raw error',async()=>{
    const env=environment(async()=>{throw Error(canary);});await env.probe();
    assert.deepEqual(env.sent,[{kind:'result',ok:false,reason:'network'}]);readOnly(env);
  });
  await check('Failed auth reports only a bounded integer HTTP status and never raw response data',async()=>{
    for(const [status,reason] of [[401,'auth'],[403,'auth'],[404,'service'],[429,'rateLimited']]) {
      const env=environment(async()=>response(canary,{status,ok:false}));await env.probe();
      assert.deepEqual(env.sent,[{kind:'result',ok:false,reason,httpStatus:status}]);readOnly(env,status===404?['/api/v1/user/order','/home/library']:undefined);
    }
    const invalidJson=environment(async()=>response(null,{json:async()=>{throw Error(canary);}}));await invalidJson.probe();
    assert.deepEqual(invalidJson.sent,[{kind:'result',ok:false,reason:'protocol',httpStatus:200}]);readOnly(invalidJson);
    for(const status of [undefined,null,'401',0,99,600,200.5,NaN,Infinity]) {
      const env=environment(async()=>response(canary,{status,ok:false}));await env.probe();
      assert.deepEqual(env.sent,[{kind:'result',ok:false,reason:'service'}]);readOnly(env);
    }
    const syncFailure=environment(async()=>response(canary,{status:403,ok:false}));
    await syncFailure.window.__humbleLibraryRequest({nonce,operation:'sync'});
    assert.deepEqual(syncFailure.sent,[{kind:'result',ok:false,reason:'auth'}]);readOnly(syncFailure);
  });
  await check('Bridge readiness reports busy while a request is pending and returns to ready without exposing content',async()=>{
    let finish,markStarted;
    const started=new Promise(resolve=>{markStarted=resolve;});
    const env=environment(()=>new Promise(resolve=>{finish=resolve;markStarted();}));
    assert.equal(env.window.__humbleLibraryBridgeState(),'ready');
    const pending=env.probe();assert.equal(env.window.__humbleLibraryBridgeState(),'busy');
    await started;
    finish(response([]));await pending;
    assert.equal(env.window.__humbleLibraryBridgeState(),'ready');
    assert.deepEqual(env.sent,[{kind:'result',ok:true,authenticated:true}]);readOnly(env);
  });
  await check('Cancelling auth releases a stuck IPC reply without letting its late finally clear a newer probe',async()=>{
    const env=environment(async()=>response([]));
    const nextNonce='abcdef0123456789abcdef0123456789';
    let firstSent,secondSent,releaseFirst,releaseSecond;
    const firstStarted=new Promise(resolve=>{firstSent=resolve;});
    const secondStarted=new Promise(resolve=>{secondSent=resolve;});
    const bounded=promise=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Probe did not reach synthetic IPC')),2000);})]).finally(()=>clearTimeout(timer));};
    env.window.__TAURI_INTERNALS__.invoke=async(name,args)=>{
      assert.equal(name,'humble_bridge_result');
      assert.deepEqual(JSON.parse(JSON.stringify(args.payload)),{kind:'result',ok:true,authenticated:true});
      if(args.nonce===nonce){firstSent();await new Promise(resolve=>{releaseFirst=resolve;});}
      else{assert.equal(args.nonce,nextNonce);secondSent();await new Promise(resolve=>{releaseSecond=resolve;});}
    };
    const first=env.probe();await bounded(firstStarted);
    assert.equal(env.window.__humbleLibraryBridgeState(),'busy');
    env.window.__humbleLibraryCancel(nonce);
    assert.equal(env.window.__humbleLibraryBridgeState(),'ready');
    const second=env.window.__humbleLibraryRequest({nonce:nextNonce,operation:'auth'});await bounded(secondStarted);
    assert.equal(env.window.__humbleLibraryBridgeState(),'busy');
    releaseFirst();await first;
    assert.equal(env.window.__humbleLibraryBridgeState(),'busy','Old finally cannot release the new operation');
    env.window.__humbleLibraryCancel(nonce);
    assert.equal(env.window.__humbleLibraryBridgeState(),'busy','An old nonce cannot cancel the new operation');
    releaseSecond();await second;
    assert.equal(env.window.__humbleLibraryBridgeState(),'ready');
    assert.equal(env.requests.length,4);assert.deepEqual(env.logs,[]);
  });
  await check('Cancellation keeps sync and reveal serialized until their in-flight work finishes',async()=>{
    for(const kind of ['sync','reveal']) {
      let finish;
      const env=environment(()=>new Promise(resolve=>{finish=resolve;}));
      const pending=env.window.__humbleLibraryRequest({nonce,operation:kind,bundleId:'SYNTHETIC_ORDER',itemId:'synthetic:0:steam'});
      assert.equal(env.window.__humbleLibraryBridgeState(),'busy');
      env.window.__humbleLibraryCancel(nonce);
      assert.equal(env.window.__humbleLibraryBridgeState(),'busy');
      finish(response([]));await pending;
      assert.equal(env.window.__humbleLibraryBridgeState(),'ready');
      assert.deepEqual(env.sent,[{kind:'result',ok:false,reason:'cancelled'}]);
      assert(env.requests.every(request=>!request.options.method||request.options.method==='GET'));
    }
  });
  fs.mkdirSync(outputRoot,{recursive:true});fs.writeFileSync(path.join(outputRoot,'auth-probe-report.json'),JSON.stringify(report,null,2));
  console.log(`PASS ${report.checks.length} auth probe scenarios`);
})().catch(error=>{console.error(error);process.exitCode=1;});
