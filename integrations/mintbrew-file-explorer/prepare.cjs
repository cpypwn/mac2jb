const fs=require('node:fs'),path=require('node:path');

const FILES=['app.json','app.vert.spv','app.frag.spv','app.comp.spv',
 'assets/icon.png','assets/state.bin','assets/text.bin'];
const check=(value,message)=>{if(!value)throw Error(message);};

function sourceFiles(repository){
 const folder=path.join(repository,'integrations/mintbrew-file-explorer/app');
 const manifest=JSON.parse(fs.readFileSync(path.join(folder,'app.json')));
 check(manifest.format==='hblauncher.gpu-app'&&manifest.abi===1&&
  manifest.id==='mintftp'&&manifest.name==='MintFTP'&&manifest.sdk?.version===1&&
  JSON.stringify(manifest.sdk.services)==='["ftp"]'&&manifest.sdk.ftpPort===2121&&
  manifest.data==='assets/text.bin'&&manifest.initialState==='assets/state.bin'&&
  manifest.icon==='assets/icon.png',
  'Unexpected MintFTP app manifest');
 const files=new Map();
 for(const name of FILES){
  const file=path.join(folder,name),stat=fs.lstatSync(file);
  check(stat.isFile()&&!stat.isSymbolicLink(),'Invalid MintFTP source file: '+name);
  files.set(name,fs.readFileSync(file));
 }
 for(const stage of ['vertex','fragment','compute']){
  const name=manifest.shaders?.[stage],binary=files.get(name);
  check(binary&&binary.length>=20&&binary.length%4===0&&binary.readUInt32LE()===0x07230203,
   'Invalid MintFTP '+stage+' shader');
 }
 check(files.get(manifest.initialState).length===1024&&
  files.get(manifest.data).length===1024*2048,
  'Invalid MintFTP state or type atlas');
 return files;
}

function verifyMintBrew(repository,mintBrewRoot){
 const files=sourceFiles(repository),target=path.join(mintBrewRoot,'apps/mintftp'),seen=new Set();
 function visit(folder,relative=''){
  const stat=fs.lstatSync(folder);
  check(stat.isDirectory()&&!stat.isSymbolicLink(),'Invalid MintFTP folder: '+relative);
  for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
   const name=relative+entry.name,file=path.join(folder,entry.name);
   check(!entry.isSymbolicLink(),'MintFTP app forbids links: '+name);
   if(entry.isDirectory())visit(file,name+'/');
   else{check(entry.isFile()&&files.get(name)?.equals(fs.readFileSync(file)),
    'Changed MintFTP app file: '+name);seen.add(name);}
  }
 }
 visit(target);
 check(seen.size===files.size&&[...files.keys()].every(name=>seen.has(name)),
  'Missing MintFTP app file');
 return {files:files.size,version:'0.1.0'};
}

function prepareMintBrew(repository,mintBrewRoot){
 const target=path.join(mintBrewRoot,'apps/mintftp');
 if(fs.existsSync(target))return verifyMintBrew(repository,mintBrewRoot);
 const files=sourceFiles(repository);
 for(const [name,bytes] of files){
  const output=path.join(target,name);
  fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
  fs.writeFileSync(output,bytes,{flag:'wx',mode:0o600});
 }
 return verifyMintBrew(repository,mintBrewRoot);
}

module.exports={FILES,sourceFiles,prepareMintBrew,verifyMintBrew};
