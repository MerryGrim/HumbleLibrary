/* Read-only public release audit. Never reads/decrypts Data, Exports or account profiles.
 * node verification/test-release-privacy.cjs [--assets Releases/0.2.0 --version 0.2.0]
 * Only the generated verification report is written. No publishing/signing/installing.
 */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {execFileSync}=require('node:child_process');
const {projectRoot,outputRoot}=require('./test-env.cjs');
const argv=process.argv.slice(2),option=name=>{const index=argv.indexOf(name);return index<0?null:argv[index+1];};
const version=option('--version')||JSON.parse(fs.readFileSync(path.join(projectRoot,'source/package.json'),'utf8')).version;
const assets=option('--assets')?path.resolve(projectRoot,option('--assets')):null;
const report={version,readOnlyAudit:true,privateDataRead:false,accountDataDecrypted:false,checks:[],assets:[],installerReferences:[],findings:[],limits:'Path/entry allowlists, bounded credential-marker scans and public hashes/signatures. Does not establish live-account, installer runtime or physical-device behavior.'};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(name,action)=>{try{action();report.checks.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){report.checks.push({name,passed:false});report.findings.push({check:name,message:error.message});console.log(`FAIL ${name}: ${error.message}`);}};
const denyPath=/(?:^|\/)(?:Data|Exports|Account|Profile|Profiles|Interface|Sessions|Cookies|WebView2|\.release-secrets|node_modules|target|gen)(?:\/|$)|(?:^|\/)verification\/current(?:\/|$)|(?:^|\/)installer\/(?:work|output|build|bin|obj)(?:\/|$)|\.(?:dpapi|pdb|pfx|pem|key)$/i;
const forbiddenMarkers=[/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9]{36,}\b/,/\bgithub_pat_[A-Za-z0-9_]{60,}\b/];
function safeName(name){assert(name&&name.length<1024&&!name.includes('\\')&&!name.startsWith('/')&&!name.includes('\0'),'Invalid archive path');assert(name.split('/').every(part=>part&&part!=='.'&&part!=='..'),'Archive path traversal or directory entry');assert(!/^[A-Za-z]:/.test(name),'Absolute archive path');assert(!denyPath.test(name),`Private/generated archive path: ${name}`);}
function noLinks(target){let current=path.resolve(target);while(true){if(fs.existsSync(current))assert(!fs.lstatSync(current).isSymbolicLink(),'Audit refuses linked paths');const parent=path.dirname(current);if(parent===current)break;current=parent;}}
function readPublic(target,limit=160*1024*1024){noLinks(target);const stat=fs.lstatSync(target);assert(stat.isFile()&&stat.size>0&&stat.size<=limit,`Invalid public file: ${path.basename(target)}`);return fs.readFileSync(target);}
function scan(bytes,name){for(const text of [bytes.toString('utf8'),bytes.toString('utf16le')])for(const pattern of forbiddenMarkers)assert(!pattern.test(text),`Private credential marker found in public candidate: ${name}`);}
function zipEntries(bytes){let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}}assert(end>=0,'ZIP end record missing');assert.equal(bytes.readUInt16LE(end+4),0);assert.equal(bytes.readUInt16LE(end+6),0);const count=bytes.readUInt16LE(end+10);assert(count>0&&count<65535,'Unsupported empty/ZIP64 archive');assert.equal(bytes.readUInt16LE(end+8),count);let position=bytes.readUInt32LE(end+16);const entries=[],seen=new Set();for(let i=0;i<count;i++){assert(position+46<=bytes.length&&bytes.readUInt32LE(position)===0x02014b50,'Invalid ZIP central entry');const flags=bytes.readUInt16LE(position+8),method=bytes.readUInt16LE(position+10),compressed=bytes.readUInt32LE(position+20),size=bytes.readUInt32LE(position+24),nameLength=bytes.readUInt16LE(position+28),extra=bytes.readUInt16LE(position+30),comment=bytes.readUInt16LE(position+32),local=bytes.readUInt32LE(position+42);const name=bytes.subarray(position+46,position+46+nameLength).toString('utf8');safeName(name);assert(!seen.has(name),`Duplicate ZIP path: ${name}`);seen.add(name);assert(!(flags&1)&&[0,8].includes(method),'Encrypted/unsupported ZIP entry');assert(size<=128*1024*1024,'ZIP entry exceeds bounded audit size');assert(local+30<=bytes.length&&bytes.readUInt32LE(local)===0x04034b50,'Invalid ZIP local header');const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);assert(start+compressed<=bytes.length,'Truncated ZIP data');entries.push({name,size,read:()=>{const input=bytes.subarray(start,start+compressed);const value=method===0?input:zlib.inflateRawSync(input,{maxOutputLength:size+1});assert.equal(value.length,size,'ZIP inflated size mismatch');return value;}});position+=46+nameLength+extra+comment;}return entries;}

let candidates=[];const portableHashes=new Map();const installerRoot=path.join(projectRoot,'installer');
check('Repository ignores local exports, data, signing secrets and generated releases',()=>{
 const ignore=fs.readFileSync(path.join(projectRoot,'.gitignore'),'utf8').split(/\r?\n/).map(line=>line.trim());
 for(const rule of ['/Data/','/Exports/','/.release-secrets/','/Releases/','/verification/current/'])assert(ignore.includes(rule),`Missing privacy ignore rule: ${rule}`);
});
check('Source candidate inventory excludes private and generated trees',()=>{
 const roots=['source','verification','installer','docs','.github'].filter(name=>fs.existsSync(path.join(projectRoot,name)));
 const args=['--files','--hidden',...roots,'-g','!source/node_modules/**','-g','!source/src-tauri/target/**','-g','!source/src-tauri/gen/**','-g','!source/dist/**','-g','!verification/current/**','-g','!installer/bin/**','-g','!installer/obj/**','-g','!installer/output/**','-g','!installer/build/**','-g','!installer/work/**'];
 candidates=execFileSync('rg',args,{cwd:projectRoot,encoding:'utf8'}).split(/\r?\n/).filter(Boolean).map(name=>name.replaceAll('\\','/'));
 for(const name of candidates){safeName(name);const full=path.join(projectRoot,name);noLinks(full);assert(fs.lstatSync(full).isFile());}
 assert(candidates.length>40,'Source candidate inventory unexpectedly small');report.sourceCandidateCount=candidates.length;
});
check('Selected source candidates contain no private key or GitHub credential markers',()=>{for(const name of candidates){const full=path.join(projectRoot,name);if(fs.statSync(full).size<=2*1024*1024)scan(fs.readFileSync(full),name);}});
check('Installer bootstrap references remain reproducible and payload rules exclude profiles',()=>{
 const files=candidates.filter(name=>name.startsWith('installer/'));
 report.installerSourceCount=files.length;
 if(!files.length){assert(!assets,'Final release requires installer sources');return;}
 const scripts=files.filter(name=>/\.(?:iss|cpp)$/i.test(name));assert(scripts.some(name=>/\.iss$/i.test(name)),'Installer Inno source missing');
 for(const script of scripts){const text=fs.readFileSync(path.join(projectRoot,script),'utf8');
  for(const match of text.matchAll(/^\s*#include\s+"([^"{}]+)"/gm)){const reference=match[1];if(/^(?:compiler:|ISPPBuiltins\.iss$)/i.test(reference))continue;const full=path.resolve(path.dirname(path.join(projectRoot,script)),reference);assert(full.startsWith(projectRoot+path.sep),'Installer include escapes source project');assert(fs.existsSync(full),`Missing installer include: ${reference}`);report.installerReferences.push(path.relative(projectRoot,full).replaceAll('\\','/'));}
  for(const match of text.matchAll(/\bLicenseFile\s*:\s*"([^"{}]+)"|^SetupIconFile=([^\r\n{}]+)/gm)){const reference=match[1]||match[2];const full=path.resolve(path.dirname(path.join(projectRoot,script)),reference);assert(full.startsWith(projectRoot+path.sep),'Installer resource escapes project');assert(fs.existsSync(full),`Missing installer resource: ${reference}`);report.installerReferences.push(path.relative(projectRoot,full).replaceAll('\\','/'));}
  const filesSection=(/^\[Files\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/im.exec(text)||[])[1]||'';
  assert(!/Source:\s*"[^"\n]*(?:Data|Exports|Account|\.release-secrets)[\\/]/i.test(filesSection),'Installer payload copies a private tree');
 }
 const pack=fs.readFileSync(path.join(projectRoot,'verification/Package-Source.ps1'),'utf8');assert(/installer/i.test(pack),'Source packaging omits installer sources');
 for(const reference of ['installer/bootstrap.manifest','installer/InstallerLanguages.h','installer/languages.json','source/src-tauri/icons/icon.ico']){assert(fs.existsSync(path.join(projectRoot,reference)),`Bootstrap input missing: ${reference}`);report.installerReferences.push(reference);}
 report.installerReferences=[...new Set(report.installerReferences)].sort();
});
check('Installer PowerShell bootstrap/build scripts parse without executing them',()=>{
 if(!fs.existsSync(installerRoot)){assert(!assets,'Installer bootstrap missing');return;}
 const quoted=installerRoot.replaceAll("'","''");
 const code=`$ErrorActionPreference='Stop';$failures=@();Get-ChildItem -LiteralPath '${quoted}' -Recurse -File -Filter '*.ps1'|ForEach-Object{$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$errors);foreach($error in $errors){$failures+=@{file=$_.Name;line=$error.Extent.StartLineNumber;message=$error.Message}}};ConvertTo-Json -InputObject @($failures) -Compress`;
 const failures=JSON.parse(execFileSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8'}));
 assert.deepEqual(failures,[],'Installer bootstrap/build PowerShell parse errors');
});
check('Installer has all nine languages and byte-preserved MIT agreements',()=>{
 if(!fs.existsSync(installerRoot)){assert(!assets,'Installer language sources missing');return;}
 const languages=JSON.parse(readPublic(path.join(installerRoot,'languages.json'),1024*1024));
 const expected=['ru','en','de','it','es','fr','zh','ja','ko'];assert.deepEqual(languages.map(item=>item.code),expected);
 const license=readPublic(path.join(projectRoot,'LICENSE'),1024*1024);
 const manifest=JSON.parse(readPublic(path.join(installerRoot,'licenses/manifest.json'),65536));
 assert.equal(manifest.projectLicenseSha256,hash(license));assert.deepEqual(manifest.agreements.map(item=>item.language),expected);
 for(const item of manifest.agreements){const name='installer/licenses/'+item.file;safeName(name);const bytes=readPublic(path.join(projectRoot,name),1024*1024);assert.equal(item.bytes,bytes.length);assert.equal(item.sha256,hash(bytes));assert(bytes.subarray(bytes.length-license.length).equals(license),`MIT license modified in ${item.language}`);report.installerReferences.push(name);}
 execFileSync(process.execPath,[path.join(installerRoot,'generate-resources.cjs'),'--check'],{encoding:'utf8'});
 report.installerReferences=[...new Set([...report.installerReferences,'installer/licenses/manifest.json'])].sort();report.installerLanguages=expected;
});

if(assets){
const sourceName=`HumbleLibrary-${version}-Sources.zip`,portableName=`HumbleLibrary-${version}-Windows-x64-Portable.zip`,payloadName=`HumbleLibrary-${version}-Windows-x64.hlupdate`;
const names=fs.readdirSync(assets).filter(name=>fs.lstatSync(path.join(assets,name)).isFile());
const setup=names.filter(name=>new RegExp(`^HumbleLibrary-${version.replaceAll('.','\\.')}-(?:Windows-x64-Setup|Setup-Windows-x64|Setup)\\.exe$`,'i').test(name));
const allowed=[portableName,sourceName,payloadName,'update-manifest.json','update-manifest.sig','SHA256SUMS.txt',...setup];
check('Public asset allowlist contains setup, portable, source, signed payload and checksums',()=>{assert.equal(setup.length,1,'Expected one versioned setup EXE');for(const name of allowed)assert(names.includes(name),`Required public asset missing: ${name}`);report.publicUploadAllowlist=allowed;});
check('Public assets are bounded regular files and have recorded SHA-256 hashes',()=>{for(const name of allowed){const bytes=readPublic(path.join(assets,name),256*1024*1024);scan(bytes,name);report.assets.push({name,size:bytes.length,sha256:hash(bytes)});}});
check('Portable ZIP includes exactly the application, three documents and its portable marker',()=>{const entries=zipEntries(readPublic(path.join(assets,portableName)));assert.deepEqual(entries.map(entry=>entry.name).sort(),['HumbleLibrary.exe','README.md','LICENSE','THIRD_PARTY_NOTICES.md','portable.marker'].sort());for(const entry of entries){const bytes=entry.read();scan(bytes,entry.name);portableHashes.set(entry.name,hash(bytes));}});
check('Installer build receipt binds the same public app files and installed marker, excluding user profiles',()=>{
 assert.equal(setup.length,1);
 const base=setup[0].replace(/\.exe$/i,'');
 const receipt=JSON.parse(readPublic(path.join(assets,base+'.build.json'),2*1024*1024));
 assert.equal(receipt.version,version);assert.equal(receipt.qaFixture,false,'QA installer cannot be released');
 assert.equal(receipt.installerSha256,hash(readPublic(path.join(assets,setup[0]))));
 for(const field of ['perUser','inputStable'])assert.equal(receipt[field],true,`Installer receipt lacks ${field}`);
 for(const field of ['requiresAdministrator','startsApplication','networkDownloads','userDataIncluded','userDataDeletedOnUninstall'])assert.equal(receipt[field],false,`Unsafe installer receipt field: ${field}`);
 assert.deepEqual(receipt.languages,['ru','en','de','it','es','fr','zh','ja','ko']);
 assert.deepEqual(receipt.payload.map(item=>item.name).sort(),['HumbleLibrary.exe','README.md','LICENSE','THIRD_PARTY_NOTICES.md','installed.marker'].sort());
 for(const item of receipt.payload){const expected=item.name==='installed.marker'?hash(readPublic(path.join(installerRoot,'installed.marker'))):portableHashes.get(item.name);assert(expected,`Installer receipt has unknown payload: ${item.name}`);assert.equal(item.sha256.toLowerCase(),expected,`Installer payload differs from public files: ${item.name}`);}
 assert.equal(receipt.bootstrap.outerSha256.toLowerCase(),receipt.installerSha256.toLowerCase());
 for(const item of receipt.sources){safeName('installer/'+item.name);assert.equal(item.sha256.toLowerCase(),hash(readPublic(path.join(installerRoot,item.name))),`Installer source changed after build: ${item.name}`);}
 report.installerPayloadMatchesPublicApp=true;
 report.localBuildReceiptsExcludedFromPublicAllowlist=true;
});
check('Source ZIP excludes profiles/exports/secrets and includes installer sources with exact workspace bytes',()=>{const entries=zipEntries(readPublic(path.join(assets,sourceName)));assert(entries.some(entry=>/^installer\/.*\.iss$/i.test(entry.name)),'Installer source absent from source ZIP');for(const entry of entries){assert(!/\.(?:exe|dll|pdb|zip|hlupdate)$/i.test(entry.name),`Generated binary in source ZIP: ${entry.name}`);const data=entry.read();scan(data,entry.name);const full=path.resolve(projectRoot,entry.name);assert(full.startsWith(projectRoot+path.sep));assert(fs.existsSync(full),`Archived source not present in workspace: ${entry.name}`);assert.equal(hash(data),hash(readPublic(full)),`Stale archived source: ${entry.name}`);}for(const ref of report.installerReferences)assert(entries.some(entry=>entry.name===ref),`Installer dependency absent from source ZIP: ${ref}`);for(const candidate of candidates)assert(entries.some(entry=>entry.name===candidate),`Missing public source file in ZIP: ${candidate}`);report.sourceArchiveEntries=entries.length;});
check('Checksum file matches the exact public artifact bytes',()=>{const checksums=new Map();for(const line of readPublic(path.join(assets,'SHA256SUMS.txt'),65536).toString('utf8').split(/\r?\n/)){if(!line.trim())continue;const match=/^([a-fA-F0-9]{64})\s+\*?([^\\/]+)$/.exec(line);assert(match,'Malformed checksum line');assert(!checksums.has(match[2]),'Duplicate checksum path');checksums.set(match[2],match[1].toLowerCase());}for(const item of report.assets.filter(item=>item.name!=='SHA256SUMS.txt'))assert.equal(checksums.get(item.name),item.sha256,`Checksum mismatch/missing: ${item.name}`);});
check('Signed update manifest and payload match the pinned public application key',()=>{const raw=readPublic(path.join(assets,'update-manifest.json'),1024*1024),manifest=JSON.parse(raw),signature=Buffer.from(readPublic(path.join(assets,'update-manifest.sig'),1024).toString('ascii').trim(),'base64'),publicJson=JSON.parse(readPublic(path.join(projectRoot,'source/src-tauri/update-public-key.json'),16384));assert.equal(publicJson.algorithm,'ecdsa-p256-sha256-p1363');const blob=Buffer.from(publicJson.key,'base64');assert.equal(blob.length,72);const key=crypto.createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:blob.subarray(8,40).toString('base64url'),y:blob.subarray(40,72).toString('base64url')}});assert(crypto.verify('sha256',raw,{key,dsaEncoding:'ieee-p1363'},signature),'Manifest signature invalid');assert.equal(manifest.version,version);const payload=readPublic(path.join(assets,payloadName));assert.equal(manifest.portable.name,payloadName);assert.equal(manifest.portable.sha256,hash(payload));assert.equal(manifest.portable.size,payload.length);const decoded=JSON.parse(zlib.gunzipSync(payload,{maxOutputLength:160*1024*1024}));assert.deepEqual(decoded.files.map(file=>file.name).sort(),['HumbleLibrary.exe','README.md','LICENSE','THIRD_PARTY_NOTICES.md'].sort());for(const file of decoded.files){safeName(file.name);const bytes=Buffer.from(file.data,'base64');scan(bytes,file.name);if(file.name==='HumbleLibrary.exe')assert.equal(hash(bytes),manifest.appSha256);}});
}
fs.mkdirSync(outputRoot,{recursive:true});fs.writeFileSync(path.join(outputRoot,'release-privacy-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.checks.filter(item=>item.passed).length,failed:report.findings.length,publicAssetsAudited:report.assets.length,privateDataRead:false}));
if(report.findings.length)process.exitCode=1;
