const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MANIFEST_SHA256='e640d308eff16f195d2cd72a18b914c481b6f28857f0f723d1970ecb3faa1281';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(value,message)=>{if(!value)throw Error(message);};

function files(folder,prefix=''){
  const result=[];
  for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
    const name=prefix+entry.name,target=path.join(folder,entry.name);
    check(!entry.isSymbolicLink(),'Precompiled shell contains a link: '+name);
    if(entry.isDirectory())result.push(...files(target,name+'/'));
    else{check(entry.isFile(),'Precompiled shell contains a special file: '+name);result.push(name);}
  }
  return result.sort();
}

function sourceFiles(root){
  const directory=path.join(root,'integrations/izlauncher-shell/prebuilt');
  const manifest=fs.readFileSync(path.join(root,'integrations/izlauncher-shell/prebuilt-SHA256SUMS'));
  check(sha(manifest)===MANIFEST_SHA256,'Changed precompiled shell inventory.');
  const inventory=new Map();
  for(const line of manifest.toString('utf8').trim().split('\n')){
    const row=/^([a-f0-9]{64})  (.+)$/.exec(line);
    check(row&&!path.isAbsolute(row[2])&&!/[\\\x00-\x1f]/.test(row[2])&&
      !row[2].split('/').some(part=>!part||part==='.'||part==='..')&&!inventory.has(row[2]),
      'Invalid precompiled shell inventory.');
    inventory.set(row[2],row[1]);
  }
  check(JSON.stringify(files(directory))===JSON.stringify([...inventory.keys()].sort()),
    'Unexpected or missing precompiled shell file.');
  const contents=new Map();
  for(const [name,digest] of inventory){
    const bytes=fs.readFileSync(path.join(directory,name));
    check(sha(bytes)===digest,'Changed precompiled shell: '+name);
    contents.set('shells/izlauncher/prebuilt/'+name,bytes);
  }
  const ids=new Set([...inventory.keys()].map(name=>name.split('/')[0]));
  check(ids.size>=1&&[...ids].every(id=>/^iz-shell-[a-f0-9]{16}$/.test(id)),
    'Invalid precompiled shell identity.');
  for(const id of ids){
    const ready=JSON.parse(contents.get('shells/izlauncher/prebuilt/'+id+'/ready.json'));
    check(ready.id===id,'Precompiled shell identity differs.');
  }
  return contents;
}

function prepare(root,runtime,write){
  const contents=sourceFiles(root);
  for(const [name,bytes] of contents)write(path.join(runtime,name),bytes);
  return [...new Set([...contents.keys()].map(name=>name.split('/')[3]))];
}

function verify(root,runtime){
  const contents=sourceFiles(root);
  for(const [name,bytes] of contents){
    const file=path.join(runtime,name),stat=fs.lstatSync(file);
    check(stat.isFile()&&!stat.isSymbolicLink()&&fs.readFileSync(file).equals(bytes),
      'Changed precompiled shell runtime file: '+name);
  }
  return {allowed:new Set(contents.keys()),ids:[...new Set([...contents.keys()].map(name=>name.split('/')[3]))]};
}

module.exports={MANIFEST_SHA256,sourceFiles,prepare,verify};
