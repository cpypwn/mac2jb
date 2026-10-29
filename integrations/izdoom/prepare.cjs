const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const VERSION='0.17.1';
const RELEASE='https://github.com/byizmysh/IZDOOM/releases/tag/v0.17.1';
const SOURCE_SHA256='5540dcd22ec3b8dcd548027dcde6566b9dc8b1dce405ef496274655d4b138e78';
const MODULE_SHA256='d51e436be25227455ef9c8fc7dba62270c661412a5b4daeb618cd92bdcd2aa08';
const SUMS_SHA256='14dc9c21576710f43aff52aa89749b0be9c0b34db744c2e5dd52461959bddb18';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(value,message)=>{if(!value)throw Error(message);};

function source(root,archive){
  const folder=path.join(root,'vendor/IZDOOM');
  const sums=fs.readFileSync(path.join(folder,'SHA256SUMS'));
  check(sha(sums)===SUMS_SHA256,'Changed IZDOOM release checksums.');
  const rows=new Map(sums.toString('utf8').trim().split('\n').map(line=>{
    const match=/^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/.exec(line);
    check(match,'Invalid IZDOOM release checksums.');
    return [match[2],match[1]];
  }));
  const files=[['IZDOOM-v0.17.1-source.tar.gz',SOURCE_SHA256],
    ['IZDOOM-v0.17.1-IZ2S.izm',MODULE_SHA256]];
  for(const [name,digest] of files){
    const file=path.join(folder,name),stat=fs.lstatSync(file);
    check(stat.isFile()&&!stat.isSymbolicLink()&&sha(fs.readFileSync(file))===digest&&rows.get(name)===digest,
      'Changed IZDOOM release asset: '+name);
  }
  const pkg=archive.inspect(fs.readFileSync(path.join(folder,files[1][0])));
  const descriptor=pkg.descriptor;
  check(pkg.sha256===MODULE_SHA256&&descriptor.id==='izdoom'&&descriptor.version===VERSION&&
    JSON.stringify(descriptor.platforms)==='["linux-x64","linux-arm64"]'&&
    descriptor.requires?.platformApi===1&&descriptor.requires?.shell==='izlauncher'&&
    descriptor.requires?.consoleAbi===1&&descriptor.switch?.abi===1&&!descriptor.server&&
    descriptor.switch.files.includes('switch/memory.bin.deflate')&&
    pkg.files.some(file=>file.name==='game-data/DOOM1.WAD')&&
    pkg.files.some(file=>file.name==='LICENSES/DOOM1-SHAREWARE.txt'),
  'Unexpected IZDOOM release module.');
  return pkg;
}

const NOTICE_FILES=new Set(['COPYRIGHT','LICENSE','LICENSE-SCOPE.md','NOTICE.md','THIRD_PARTY.json']);

function mintBrewFiles(root,archive){
  const upstream=source(root,archive),files=new Map();
  for(const file of upstream.files){
    if(file.name.startsWith('switch/'))files.set(file.name.slice(7),file.bytes);
    else if(file.name.startsWith('LICENSES/')||file.name.startsWith('game-data/')||NOTICE_FILES.has(file.name))
      files.set(file.name,file.bytes);
  }
  const manifest=JSON.parse(files.get('app.json'));
  check(manifest.format==='hblauncher.gpu-app'&&manifest.abi===1&&manifest.id==='izdoom'&&
    manifest.version===VERSION&&manifest.service===undefined&&
    upstream.descriptor.switch.files.every(name=>files.has(name.slice(7)))&&
    files.has('game-data/DOOM1.WAD')&&files.has('LICENSES/DOOM1-SHAREWARE.txt'),
  'IZDOOM is not a standalone MintBrew GPU app.');
  manifest.name='DOOM';
  manifest.description='GPU POC based on PureDOOM, bundled with DOOM shareware v1.9 (Episode 1)';
  files.set('app.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
  files.set('icon.png',fs.readFileSync(path.join(root,'integrations/izdoom/branding/doom-icon.png')));
  return {files,sha256:upstream.sha256};
}

function prepareMintBrew(root,mintBrewRoot){
  const archive=require(path.join(root,'vendor/IZ2S-Platform/core/archive.cjs'));
  const info=mintBrewFiles(root,archive),directory=path.join(mintBrewRoot,'apps/izdoom');
  if(fs.existsSync(directory))return verifyMintBrew(root,mintBrewRoot);
  for(const [name,bytes] of info.files){
    const target=path.join(directory,name);
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  }
  return {sha256:info.sha256,files:info.files.size};
}

function verifyMintBrew(root,mintBrewRoot){
  const archive=require(path.join(root,'vendor/IZ2S-Platform/core/archive.cjs'));
  const info=mintBrewFiles(root,archive),directory=path.join(mintBrewRoot,'apps/izdoom');
  const seen=new Set();
  function verifyDirectory(folder,prefix=''){
    const stat=fs.lstatSync(folder);
    check(stat.isDirectory()&&!stat.isSymbolicLink(),'Invalid IZDOOM MintBrew folder: '+prefix);
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
      const name=prefix+entry.name,target=path.join(folder,entry.name);
      check(!entry.isSymbolicLink(),'IZDOOM MintBrew app forbids links: '+name);
      if(entry.isDirectory()){
        check([...info.files.keys()].some(file=>file.startsWith(name+'/')),
          'Unexpected IZDOOM MintBrew directory: '+name);
        verifyDirectory(target,name+'/');
      }
      else{
        check(entry.isFile()&&info.files.get(name)?.equals(fs.readFileSync(target)),
          'Changed IZDOOM MintBrew file: '+name);
        seen.add(name);
      }
    }
  }
  verifyDirectory(directory);
  check(seen.size===info.files.size&&[...info.files.keys()].every(name=>seen.has(name)),
    'Missing IZDOOM MintBrew app file.');
  return {sha256:info.sha256,files:info.files.size};
}

module.exports={VERSION,RELEASE,SOURCE_SHA256,MODULE_SHA256,SUMS_SHA256,source,mintBrewFiles,prepareMintBrew,verifyMintBrew};
