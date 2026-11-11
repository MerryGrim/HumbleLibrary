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
  const window={fetch:async(url,options)=>{requests.push({url,options});return fetcher(url,options);},__TAURI_INTERNALS__:{invoke:async(name,args)=>{assert.equal(name,'humble_bridge_result');assert.equal(args.nonce,nonce);sent.push(JSON.parse(JSON.stringify(args.payload)));}}};
  window.top=topLevel?window:{};
  const document={};Object.defineProperty(document,'cookie',{get(){throw Error('Auth probe must not read cookies or CSRF tokens');}});
  vm.runInNewContext(source,{window,location:{origin},document,URL,URLSearchParams,TextEncoder,AbortController,DOMParser:class{constructor(){throw Error('Auth probe must not read account DOM');}},console:Object.fromEntries(['log','info','warn','error','debug'].map(name=>[name,(...values)=>logs.push({name,values})])),setTimeout:action=>setTimeout(action,0),Map,Set,Date},{filename:sourcePath});
  return {window,sent,requests,logs,probe:()=>window.__humbleLibraryRequest({nonce,operation:'auth'})};
}
function readOnly(env) {
  assert.equal(env.requests.length,1,'Auth proof makes one request only');
  const request=env.requests[0];
  assert.equal(request.url,'/api/v1/user/order');
  assert(['GET',undefined].includes(request.options.method));
  assert.equal(request.options.body,undefined);
  assert.equal(request.options.credentials,'same-origin');
  assert.equal(request.options.cache,'no-store');
  assert.deepEqual(env.logs,[],'No account data or errors may be logged');
  assert.equal(JSON.stringify(env.sent).includes(canary),false,'No raw order data or exception may reach IPC');
}
async function check(name,action){await action();report.checks.push({name,passed:true});console.log(`PASS ${name}`);}
(async()=>{
  await check('Auth adapter is restricted to the exact official HTTPS origin and top-level frame',async()=>{
    for(const [origin,top] of [['http://www.humblebundle.com',true],['https://www.humblebundle.com.evil.invalid',true],['https://humblebundle.com',true],['https://auth.humblebundle.com',true],['https://www.humblebundle.com',false]]) {
      const env=environment(async()=>{throw Error('Unexpected fixture request');},origin,top);
      assert.equal(env.window.__humbleLibraryRequest,undefined);assert.equal(env.requests.length,0);
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
  fs.mkdirSync(outputRoot,{recursive:true});fs.writeFileSync(path.join(outputRoot,'auth-probe-report.json'),JSON.stringify(report,null,2));
  console.log(`PASS ${report.checks.length} auth probe scenarios`);
})().catch(error=>{console.error(error);process.exitCode=1;});
