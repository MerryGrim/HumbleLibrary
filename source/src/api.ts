import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import type {Bundle, KeyItem} from './types';
import metadata from '../package.json';

export type AuthState = 'unknown' | 'authenticated' | 'unauthenticated';
export type SessionStatus = {connected:boolean;authState:AuthState};
export type LibraryStatus = SessionStatus & {lastSync?:string|null; bundles:Bundle[];warning?:string|null;enumerationComplete?:boolean};
export type LoginAttempt = {attemptId:string};
export type UpdateSettings={enabled:boolean;repository:string;configured:boolean;currentVersion:string;lastCheck?:number;mode?:string;supported?:boolean;lastApplyError?:string|null};
export type UpdateRelease={version:string;notes:string;url:string;size:number;staged:boolean};
export type UpdateCheck={status:'available'|'current'|'notConfigured'|'disabled'|'throttled';release:UpdateRelease|null;checkedAt:number;cached?:boolean};
export type UpdateProgress={phase:string;received:number;total:number;percent:number};
export type LibraryProgress={completed:number;total:number;stage?:'purchases'|'keys'};
export type SyncActivity={phase:string;state:'reading'|'waiting';attempt:number;delayMs:number;reason?:'network'|'rateLimited'|'service'};
const preview = !isTauri() && new URLSearchParams(location.search).get('preview') === '1';
const cover = (name:string, color:string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${color}"/><path d="M400 0L640 200V360H280Z" fill="#ffffff" opacity=".06"/><text x="40" y="205" fill="#fff" font-family="Segoe UI,Arial" font-size="34" font-weight="600">${name}</text><text x="42" y="250" fill="#fff" opacity=".6" font-family="Segoe UI,Arial" font-size="17">PREVIEW BUNDLE</text></svg>`)}`;
const fixtures:Bundle[] = [
  {id:'preview-tools',title:'Game Development Collection',imageUrl:cover('GAME DEVELOPMENT','#243d5d'),purchasedAt:'2026-10-20',items:[
    {id:'fab',title:'Fantasy Environment',platform:'Epic / Fab',key:'PREVIEW-FAB-ONLY-0001',status:'revealed',instructions:'Демонстрационная запись, не настоящий ключ.'},
    {id:'steam',title:'Adventure Toolkit',platform:'Steam',key:null,status:'hidden'},
    {id:'gog',title:'Pixel Adventure',platform:'GOG',key:'PREVIEW-GOG-ONLY-0003',status:'revealed'},
    {id:'software',title:'Art Studio',platform:'Other',key:'preview_art:license/123',status:'revealed'},
    {id:'unavailable',title:'Audio Collection',platform:'Other',key:null,status:'unavailable',instructions:'Ключ временно недоступен.'},
    {id:'external',title:'Publisher Collection',platform:'Publisher',key:null,status:'external',redeemUrl:'https://www.humblebundle.com',instructions:'Получение на сайте издателя.'}
  ]},
  {id:'preview-games',title:'Indie Adventure Bundle',imageUrl:cover('INDIE ADVENTURES','#5a3447'),purchasedAt:'2026-10-12',items:[
    {id:'indie-1',title:'Northern Lights',platform:'Steam',key:null,status:'hidden'},
    {id:'indie-2',title:'Faraway Islands',platform:'Steam',key:null,status:'hidden'},
    {id:'indie-3',title:'The Long Journey',platform:'GOG',key:null,status:'hidden'}
  ]},
  {id:'preview-art',title:'Digital Art Essentials',imageUrl:cover('DIGITAL ART','#37524b'),purchasedAt:'2026-09-30',items:[
    {id:'art-1',title:'Illustration Workshop',platform:'Other',key:'PREVIEW-ART-ONLY-0001',status:'revealed'}
  ]}
];
const previewResetKey = 'humble-library-preview-reset';
let previewReset = false;
try { previewReset = preview && localStorage.getItem(previewResetKey) === '1'; } catch { /* Demo persistence is optional. */ }
let previewConnected = !previewReset;
let previewLibraryRetained = !previewReset;
let previewUpdates:UpdateSettings={enabled:false,repository:'',configured:false,currentVersion:metadata.version,mode:'portable',supported:true};
const delay = (ms:number) => new Promise(resolve => setTimeout(resolve,ms));
export const api = {
  preview,
  async setNativeLanguage(language:string):Promise<void>{ if(isTauri()) await invoke('set_ui_language',{language}); },
  async updateReady():Promise<void>{ if(isTauri()) await invoke('updates_ready'); },
  async updateStatus():Promise<UpdateSettings>{ if(!isTauri())return structuredClone(previewUpdates);return invoke('updates_get'); },
  async saveUpdateSettings(enabled:boolean,repository:string):Promise<UpdateSettings>{
    if(!isTauri()){previewUpdates={...previewUpdates,enabled,repository,configured:!!repository};return structuredClone(previewUpdates);}
    return invoke('updates_set',{enabled,repository});
  },
  async checkUpdates(manual=true):Promise<UpdateCheck>{
    if(!isTauri())return {status:previewUpdates.configured?'current':'notConfigured',release:null,checkedAt:Math.floor(Date.now()/1000)};
    return invoke('updates_check',{manual});
  },
  async downloadUpdate(version:string):Promise<UpdateCheck>{return invoke('updates_download',{version});},
  async applyUpdate(version:string):Promise<void>{return invoke('updates_apply',{version});},
  async onUpdateProgress(callback:(value:UpdateProgress)=>void):Promise<()=>void>{if(!isTauri())return ()=>{};return listen<UpdateProgress>('update-progress',event=>callback(event.payload));},
  async status():Promise<LibraryStatus> {
    if(preview) return {connected:previewConnected,authState:previewConnected?'authenticated':'unauthenticated',lastSync:previewConnected || previewLibraryRetained ? '2026-10-25T12:00:00Z' : null,bundles:structuredClone(previewConnected || previewLibraryRetained ? fixtures : [])};
    if(!isTauri()) return {connected:false,authState:'unknown',bundles:[]};
    return invoke('humble_status');
  },
  async login():Promise<LoginAttempt> {
    if(preview){ previewConnected=true; previewLibraryRetained=true; previewReset=false; try { localStorage.removeItem(previewResetKey); } catch { /* Demo persistence is optional. */ } return {attemptId:crypto.randomUUID()}; }
    return invoke('humble_login');
  },
  async sync():Promise<LibraryStatus> {
    if(preview){ if(previewReset) throw new Error('Войдите в Humble Bundle в отдельном окне, затем обновите библиотеку.'); await delay(350); return {connected:previewConnected,authState:previewConnected?'authenticated':'unauthenticated',lastSync:new Date().toISOString(),bundles:structuredClone(fixtures),enumerationComplete:true}; }
    return invoke('humble_sync');
  },
  async reveal(bundleId:string,itemId:string):Promise<KeyItem> {
    if(preview){
      await delay(900);
      const item = fixtures.find(b=>b.id===bundleId)?.items.find(i=>i.id===itemId);
      if(!item || item.status!=='hidden') throw new Error('Ключ недоступен для раскрытия');
      item.key=`PREVIEW-${itemId.toUpperCase()}-ONLY-0002`; item.status='revealed';
      return structuredClone(item);
    }
    return invoke('humble_reveal',{bundleId,itemId});
  },
  async cancel():Promise<void> { if(!preview) await invoke('humble_cancel'); },
  async logout():Promise<void> { if(preview){ previewConnected=false; previewLibraryRetained=false; return; } return invoke('humble_logout'); },
  async clearCache():Promise<void> { if(preview) return; return invoke('humble_clear_cache'); },
  async importLegacy():Promise<LibraryStatus|null> {
    if(!isTauri()) return null;
    return invoke('humble_import_legacy',{allowUnbound:true});
  },
  async resetLogin():Promise<void> { if(preview){ previewConnected=false; return; } return invoke('humble_reset_login'); },
  async resetAll():Promise<LibraryStatus> {
    if(preview){ previewConnected=false; previewLibraryRetained=false; previewReset=true; try { localStorage.setItem(previewResetKey,'1'); } catch { /* Demo persistence is optional. */ } return {connected:false,authState:'unauthenticated',lastSync:null,bundles:[]}; }
    return invoke('humble_reset_all');
  },
  async copy(text:string):Promise<void> {
    if(isTauri()) return invoke('copy_text',{text});
    await navigator.clipboard.writeText(text);
  },
  async exportKeys(contents:string,defaultName:string):Promise<string|null> {
    if(isTauri()) return invoke('export_keys',{contents,defaultName});
    if(!preview) throw new Error('Экспорт доступен в приложении');
    const url=URL.createObjectURL(new Blob([contents],{type:defaultName.endsWith('.csv')?'text/csv;charset=utf-8':'text/plain;charset=utf-8'}));
    const anchor=document.createElement('a'); anchor.href=url; anchor.download=defaultName; anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    return defaultName;
  },
  async openExternal(url:string):Promise<void> {
    if(isTauri()) return invoke('open_external',{url});
    window.open(url,'_blank','noopener,noreferrer');
  },
  async onLoginCompleted(callback:(attempt:LoginAttempt)=>void):Promise<()=>void> {
    if(!isTauri()) return ()=>{};
    return listen<LoginAttempt>('humble-login-completed',event=>callback(event.payload));
  },
  async onLoginCancelled(callback:(attempt:LoginAttempt)=>void):Promise<()=>void> {
    if(!isTauri()) return ()=>{};
    return listen<LoginAttempt>('humble-login-cancelled',event=>callback(event.payload));
  },
  async onProgress(callback:(value:LibraryProgress)=>void):Promise<()=>void> {
    if(!isTauri()) return ()=>{};
    return listen<LibraryProgress>('humble-progress',event=>callback(event.payload));
  },
  async onSyncActivity(callback:(value:SyncActivity)=>void):Promise<()=>void> {
    if(!isTauri()) return ()=>{};
    return listen<SyncActivity>('humble-sync-activity',event=>callback(event.payload));
  },
  async onSessionStatus(callback:(value:SessionStatus)=>void):Promise<()=>void> {
    if(!isTauri()) return ()=>{};
    return listen<SessionStatus>('humble-session-status',event=>callback(event.payload));
  },
  async onWarning(callback:(message:string)=>void):Promise<()=>void> {
    if(!isTauri()) return ()=>{};
    return listen<string>('humble-warning',event=>callback(event.payload));
  }
};
