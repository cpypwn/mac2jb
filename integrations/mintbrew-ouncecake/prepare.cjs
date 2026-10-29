const fs=require('node:fs');
const path=require('node:path');
const check=(value,message)=>{if(!value)throw Error(message);};
const source=root=>path.join(root,'integrations/mintbrew-ouncecake/app');

function walk(directory,prefix=''){
 const files=new Map();
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const relative=prefix+entry.name,target=path.join(directory,entry.name);
  check(!entry.isSymbolicLink(),'OunceCake app contains a link: '+relative);
  if(entry.isDirectory()){
   for(const [name,bytes] of walk(target,relative+'/'))files.set(name,bytes);
  }else{
   check(entry.isFile(),'OunceCake app contains an unsupported item: '+relative);
   files.set(relative,fs.readFileSync(target));
  }
 }
 return files;
}

function verifySource(root){
 const directory=source(root),manifest=JSON.parse(fs.readFileSync(path.join(directory,'app.json')));
 check(manifest.format==='hblauncher.gpu-app'&&manifest.abi===1&&manifest.id==='ouncecake'&&
  manifest.service==='ouncecake-v1'&&manifest.memory?.bytes===16*1024*1024,
  'Invalid bundled OunceCake app manifest');
 const files=walk(directory);
 for(const name of ['app.json','state.bin','data.bin','memory.bin','icon.png',
  'app.vert.spv','app.frag.spv','app.comp.spv'])check(files.has(name),'Missing OunceCake app file: '+name);
 check(files.get('state.bin').length===1024&&files.get('memory.bin').length===4096&&
  files.get('data.bin').length===1024*1024,
  'OunceCake app data geometry changed');
 for(const name of ['app.vert.spv','app.frag.spv','app.comp.spv'])
  check(files.get(name).readUInt32LE()===0x07230203,'Invalid OunceCake shader: '+name);
 return files;
}

function verifyMintBrew(root,mintBrewRoot){
 const expected=verifySource(root),folder=path.join(mintBrewRoot,'apps/ouncecake');
 const actual=walk(folder);
 check(actual.size===expected.size,'OunceCake runtime file count changed');
 for(const [name,bytes] of expected)
  check(actual.get(name)?.equals(bytes),'Changed OunceCake runtime app file: '+name);
 return {files:actual.size};
}

function prepareMintBrew(root,mintBrewRoot){
 verifySource(root);
 const folder=path.join(mintBrewRoot,'apps/ouncecake');
 if(!fs.existsSync(folder))fs.cpSync(source(root),folder,{recursive:true,errorOnExist:true,force:false});
 return verifyMintBrew(root,mintBrewRoot);
}

module.exports={verifySource,verifyMintBrew,prepareMintBrew};
