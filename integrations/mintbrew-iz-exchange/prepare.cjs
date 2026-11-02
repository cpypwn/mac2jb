const fs=require('node:fs'),path=require('node:path');
const check=(value,message)=>{if(!value)throw Error(message);};
const source=root=>path.join(root,'vendor/IZ2S-Platform/modules/iz-exchange/switch');
const destination=root=>path.join(root,'apps/iz-exchange');

function files(folder,prefix=''){
 const result=new Map();
 for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
  const name=prefix+entry.name,file=path.join(folder,entry.name);
  check(!entry.isSymbolicLink(),'File Exchange app contains a link: '+name);
  if(entry.isDirectory())for(const row of files(file,name+'/'))result.set(...row);
  else{check(entry.isFile(),'File Exchange app contains an unsupported item: '+name);result.set(name,fs.readFileSync(file));}
 }
 return result;
}

function verifySource(root){
 const folder=source(root),manifest=JSON.parse(fs.readFileSync(path.join(folder,'app.json')));
 check(manifest.format==='hblauncher.gpu-app'&&manifest.abi===1&&manifest.id==='iz-exchange'&&
  manifest.shaderEncoding==='deflate'&&manifest.hostRuntime==='module:iz-exchange/runtime',
  'Invalid File Exchange app manifest');
 const expected=files(folder);
 for(const name of ['app.json','app.vert.spv.deflate','app.frag.spv.deflate',
  'app.comp.spv.deflate','assets/state.bin','assets/data.bin','assets/icon.png'])
  check(expected.has(name),'Missing File Exchange app file: '+name);
 check(expected.get('assets/state.bin').length===1024,'Invalid File Exchange initial state');
 return expected;
}

function verifyMintBrew(root,mintBrewRoot){
 const expected=verifySource(root),actual=files(destination(mintBrewRoot));
 check(expected.size===actual.size,'File Exchange runtime file count changed');
 for(const [name,bytes]of expected)
  check(actual.get(name)?.equals(bytes),'Changed File Exchange runtime app file: '+name);
 return {files:actual.size};
}

function prepareMintBrew(root,mintBrewRoot){
 verifySource(root);
 const target=destination(mintBrewRoot);
 if(!fs.existsSync(target))fs.cpSync(source(root),target,{recursive:true,errorOnExist:true,force:false});
 return verifyMintBrew(root,mintBrewRoot);
}

module.exports={verifySource,verifyMintBrew,prepareMintBrew};
