const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {sourceRoot,outputRoot,loadPlaywright,browserLaunchOptions}=require('./test-env.cjs');
const esbuild=require(require.resolve('esbuild',{paths:[sourceRoot]}));
const imageUrl='https://hb.imgix.net/bf24c85350f7504c0eb3877685eae0fb262afa93.png?auto=compress,format&s=2c938928e244482aa2b5e441f7740f6f';
const fixtureUrl='https://hl-public-cover-fixture.invalid/';
const report={fixtureOnly:true,cachedImageMetadata:imageUrl,accountAccess:false,checks:[],responses:[],errors:[],blockedRequests:[]};
const fixtureApi=`const noop=async()=>()=>{};export const api={preview:false,status:async()=>({connected:false,bundles:[{id:'synthetic-public-cover',title:'Sci-Fi Game Dev Assets (Synty)',imageUrl:${JSON.stringify(imageUrl)},purchasedAt:'2026-10-25',items:[]}]}),sync:async()=>{throw Error('Unexpected sync in public image fixture');},onSyncActivity:async()=>()=>{},onProgress:noop,onWarning:noop,onUpdateProgress:noop,onLoginCompleted:noop,onLoginCancelled:noop,onSessionStatus:noop,setNativeLanguage:async()=>{},updateReady:async()=>{},updateStatus:async()=>({enabled:false,repository:'',configured:false,currentVersion:'0.1.2',supported:true}),copy:async()=>{},login:async()=>{throw Error('Authentication forbidden in public image fixture');},openExternal:async()=>{throw Error('External navigation forbidden in public image fixture');}};`;
(async()=>{
const bundle=await esbuild.build({stdin:{contents:`import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import App from'./src/App';createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);`,resolveDir:sourceRoot,loader:'tsx'},bundle:true,write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'},plugins:[{name:'public-cover-fixture',setup(build){build.onResolve({filter:/^\.\/api$/},()=>({path:'api',namespace:'public-cover-fixture'}));build.onResolve({filter:/^@tauri-apps\/api\/window$/},()=>({path:'window',namespace:'public-cover-fixture'}));build.onLoad({filter:/.*/,namespace:'public-cover-fixture'},args=>({contents:args.path==='api'?fixtureApi:'export const getCurrentWindow=()=>({});',loader:'js'}));}}]});
fs.mkdirSync(outputRoot,{recursive:true});
const browser=await loadPlaywright().chromium.launch(browserLaunchOptions);
try{
 const css=['styles.css','Notification.css','BundleSort.css'].map(file=>fs.readFileSync(path.join(sourceRoot,'src',file),'utf8')).join('\n');
 for(const theme of ['dark','light']){
  const context=await browser.newContext({viewport:{width:1280,height:800},locale:'ru-RU',reducedMotion:'reduce'});
  await context.route('**/*',route=>{
   const url=route.request().url();
   if(url===fixtureUrl)return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="root"></div></body></html>'});
   report.blockedRequests.push(url);return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  page.on('response',response=>{if(response.url()===imageUrl)report.responses.push({theme,status:response.status(),contentType:response.headers()['content-type']||''});});
  await page.goto(fixtureUrl);await page.evaluate(theme=>{localStorage.setItem('humble-library-language','ru');localStorage.setItem('humble-library-theme',theme);},theme);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.getByRole('button',{name:'Открыть бандл Sci-Fi Game Dev Assets (Synty)',exact:true}).waitFor();
  await page.locator('.bundle-tile .cover-fallback').waitFor();
  assert.equal(await page.locator('.bundle-tile img').count(),0,'Cached cover must not be requested while banners are paused');
  const dimensions=await page.locator('.bundle-tile .cover-fallback').evaluate(element=>({width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height}));
  const tile=await page.locator('.bundle-tile').boundingBox(),cover=await page.locator('.bundle-cover').boundingBox();
  assert(tile&&cover&&tile.width>=218&&tile.width<=300,'Existing tile grid geometry is retained');
  assert(Math.abs(cover.width/cover.height-1.82)<0.02,'Existing 1.82 cover box aspect ratio is retained');
  assert.equal(await page.locator('.key-value').count(),0);assert.equal(await page.locator('.cover-fallback').count(),1);
  assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
  const screenshot=`placeholder-cover-1280x800-${theme}.png`;await page.screenshot({path:path.join(outputRoot,screenshot)});
  report.checks.push({theme,passed:true,dimensions,tile,cover,screenshot});
  console.log(`PASS ${theme}: placeholder rendered without a CDN request, existing tile geometry`);
  await context.close();
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.blockedRequests,[]);
}finally{await browser.close();fs.writeFileSync(path.join(outputRoot,'cover-visual-report.json'),JSON.stringify(report,null,2));}
console.log(`PASS ${report.checks.length} placeholder visual scenarios; no image or Humble account/page accessed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
