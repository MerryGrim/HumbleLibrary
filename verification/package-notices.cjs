const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),source=path.join(root,'source');
const metadata=JSON.parse(fs.readFileSync(path.join(__dirname,'current/cargo-metadata.json'),'utf8').replace(/^\ufeff/,''));
const resolved=new Set(metadata.resolve.nodes.map(node=>node.id));
let output='# Third-party notices\n\nHumble Library is an independent client and is not affiliated with Humble Bundle.\n\n';
output+='The interface follows Unreal Manager, Copyright (c) 2026 Nyanma (MerryGrim) and Unreal Manager contributors, MIT License.\n\n';
output+='Protocol references (no account data included):\n- https://github.com/MrMarble/hb-key-exporter\n- https://github.com/gfargo/humble-bundle-keys\n\n';
function append(name,version,license,folder,repository){
  output+=`## ${name} ${version}\n\nLicense: ${license||'See upstream license'}\n${repository?`Source: ${repository}\n`:''}\n`;
  for(const filename of fs.readdirSync(folder).filter(file=>/^(?:licen[cs]e(?:[-_.].*)?|copying(?:[-_.].*)?|notice(?:[-_.].*)?)$/i.test(file)).sort()){
    const file=path.join(folder,filename),stat=fs.statSync(file);
    if(!stat.isFile()||stat.size>512*1024)continue;
    output+=`### ${filename}\n\n${fs.readFileSync(file,'utf8')}\n\n`;
  }
}
for(const pkg of metadata.packages.filter(pkg=>resolved.has(pkg.id)&&pkg.name!=='humble-library').sort((a,b)=>a.name.localeCompare(b.name)))
  append(pkg.name,pkg.version,pkg.license,path.dirname(pkg.manifest_path),pkg.repository);
const lock=JSON.parse(fs.readFileSync(path.join(source,'package-lock.json'),'utf8'));
for(const [relative,entry] of Object.entries(lock.packages).filter(([relative,pkg])=>relative&&!pkg.dev).sort()){
  const folder=path.join(source,relative);if(!fs.existsSync(folder))continue;
  const pkg=JSON.parse(fs.readFileSync(path.join(folder,'package.json'),'utf8'));
  append(pkg.name,pkg.version,pkg.license,folder,typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url);
}
output+='## Unreal Manager MIT notice\n\n'+fs.readFileSync(path.join(root,'LICENSE'),'utf8');
fs.writeFileSync(path.join(root,'THIRD_PARTY_NOTICES.md'),output);
console.log('Third-party notices generated for resolved Windows crates and frontend runtime packages.');
