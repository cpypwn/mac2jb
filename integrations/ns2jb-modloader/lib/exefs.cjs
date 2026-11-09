'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,align,sha}=require('./common.cjs');
const {validateProgramId}=require('./codefs-identity.cjs');
function lz4(data,size){
 const out=Buffer.alloc(size);let i=0,p=0;
 function length(n){if(n===15){let v;do{check(i<data.length,'Truncated LZ4 length');v=data[i++];n+=v;}while(v===255);}return n;}
 while(i<data.length){const token=data[i++],literal=length(token>>>4);check(i+literal<=data.length&&p+literal<=size,'Invalid LZ4 literal');data.copy(out,p,i,i+literal);i+=literal;p+=literal;if(i===data.length)break;check(i+2<=data.length,'Truncated LZ4 match');const distance=data.readUInt16LE(i);i+=2;const n=length(token&15)+4;check(distance>0&&distance<=p&&p+n<=size,'Invalid LZ4 backreference');for(let k=0;k<n;k++)out[p+k]=out[p+k-distance];p+=n;}
 check(p===size,'LZ4 output size mismatch');return out;
}
function decodeNso(raw){
 check(raw.length>=256&&raw.toString('ascii',0,4)==='NSO0','Expected an NSO module');const flags=raw.readUInt32LE(12),segments=[];
 for(let i=0;i<3;i++){
  const at=16+i*16,offset=raw.readUInt32LE(at),address=raw.readUInt32LE(at+4),size=raw.readUInt32LE(at+8),packed=(flags&(1<<i))?raw.readUInt32LE(0x60+4*i):size;
  check(size<=512*1024*1024&&offset+packed<=raw.length&&(!size||offset>=256),'NSO segment extent exceeds module');
  const data=(flags&(1<<i))?((flags&0x80)?require('./zbic.cjs').decodeZbic(raw.subarray(offset,offset+packed),size):lz4(raw.subarray(offset,offset+packed),size)):Buffer.from(raw.subarray(offset,offset+size));
  if(flags&(1<<(i+3)))check(sha(data)===raw.subarray(0xa0+i*32,0xc0+i*32).toString('hex'),'NSO segment hash differs');
  segments.push({address,size,data});
 }
 for(let i=1;i<3;i++)check(segments[i-1].address+segments[i-1].size<=segments[i].address,'NSO memory segments overlap');
 return{header:Buffer.from(raw.subarray(0,256)),segments,buildId:raw.subarray(0x40,0x60).toString('hex'),original:raw};
}
function encodeNso(nso){
 const header=Buffer.from(nso.header),parts=[];let offset=256;
 header.writeUInt32LE((header.readUInt32LE(12)&~0x87)|0x38,12);
 for(let i=0;i<3;i++){const s=nso.segments[i],start=align(offset);parts.push(Buffer.alloc(start-offset),s.data);header.writeUInt32LE(start,16+i*16);header.writeUInt32LE(s.address,20+i*16);header.writeUInt32LE(s.data.length,24+i*16);header.writeUInt32LE(s.data.length,0x60+i*4);Buffer.from(sha(s.data),'hex').copy(header,0xa0+i*32);offset=start+s.data.length;}
 const nameAt=nso.header.readUInt32LE(0x1c),nameSize=nso.header.readUInt32LE(0x2c);
 check(!nameSize||nameAt>=256&&nameAt+nameSize<=nso.original.length,'NSO module name exceeds source');
 header.writeUInt32LE(nameSize?offset:0,0x1c);if(nameSize)parts.push(nso.original.subarray(nameAt,nameAt+nameSize));
 const raw=Buffer.concat([header,...parts]);decodeNso(raw);return raw;
}
function parseIps(bytes){
 const magic=bytes.toString('ascii',0,5),wide=magic==='IPS32';check(wide||magic==='PATCH','Expected PATCH or IPS32 header');
 const width=wide?4:3,tail=wide?'EEOF':'EOF',rows=[];let at=5;
 while(true){check(at+width<=bytes.length,'Truncated IPS record');if(bytes.toString('ascii',at,at+width)===tail){at+=width;break;}
  const offset=bytes.readUIntBE(at,width);at+=width;check(at+2<=bytes.length,'Truncated IPS size');const length=bytes.readUInt16BE(at);at+=2;let data;
  if(length){check(at+length<=bytes.length,'Truncated IPS data');data=bytes.subarray(at,at+length);at+=length;}
  else{check(at+3<=bytes.length,'Truncated IPS RLE');const count=bytes.readUInt16BE(at);check(count>0,'Empty IPS RLE');data=Buffer.alloc(count,bytes[at+2]);at+=3;}
  rows.push({offset,data});
 }
 // The optional file-truncation field does not apply to mapped NSO memory.
 // Like Atmosphere, stop at EOF rather than truncating a module segment.
 check(at===bytes.length||at+width===bytes.length,'Unexpected IPS trailing data');return rows;
}
function matchesPatch(patch,name,buildId){
 const key=path.posix.basename(patch.path).replace(/\.(ips|ips32)$/i,'');
 if(key===name)return true;
 return /^[0-9a-f]{2,64}$/i.test(key)&&key.length%2===0&&key.toLowerCase().padEnd(64,'0')===buildId;
}
function applyNsoPatches(raw,patches){
 const nso=decodeNso(raw),written=new Map();
 for(const patch of patches)for(const r of parseIps(fs.readFileSync(patch.file))){
  // Atmosphere patches an NSO's mapped image with the 0x100-byte file header
  // excluded/protected. Patch offsets are NOT compressed-file offsets.
  let lo=Math.max(256,r.offset),end=r.offset+r.data.length;
  while(lo<end){const address=lo-256,i=nso.segments.findIndex((s,i)=>s.address<=address&&address<(i<2?nso.segments[i+1].address:s.address+s.data.length+nso.header.readUInt32LE(0x3c)));check(i>=0,'IPS writes outside the mapped NSO at 0x'+lo.toString(16));const s=nso.segments[i],limit=i<2?nso.segments[i+1].address:s.address+s.data.length+nso.header.readUInt32LE(0x3c),n=Math.min(end-lo,limit-address),needed=address-s.address+n;
   if(needed>s.data.length){const growth=needed-s.data.length;check(needed<=512*1024*1024,'IPS segment growth exceeds the NSO limit');const data=Buffer.alloc(needed);s.data.copy(data);s.data=data;s.size=needed;if(i===2)nso.header.writeUInt32LE(nso.header.readUInt32LE(0x3c)-growth,0x3c);}
   for(let k=0;k<n;k++){const key=address+k,value=r.data[lo-r.offset+k],old=written.get(key);check(old===undefined||old===value,'Conflicting IPS writes at 0x'+(key+256).toString(16));written.set(key,value);s.data[address-s.address+k]=value;}lo+=n;
  }
 }
 return encodeNso(nso);
}
function moduleHeader(file){
 const fd=fs.openSync(file,'r'),header=Buffer.alloc(256);let length;
 try{length=fs.readSync(fd,header,0,256,0);}finally{fs.closeSync(fd);}
 return{header,buildId:length===256&&header.toString('ascii',0,4)==='NSO0'?header.subarray(0x40,0x60).toString('hex'):null};
}
async function buildExeFs(game,captured,out,pack,globalPatches=[]){
 check(captured.owner,'Missing title-qualified CodeFS identity');
 validateProgramId(game.titleId,captured.source,captured.owner.programId);
 const originals=new Map(captured.files.map(e=>[e.name,e])),names=new Map(captured.files.map(e=>[e.name.toLowerCase(),e.name]));
 const {extractExeFs}=require('./pfs.cjs');
 const base=game.exefsImage?extractExeFs(game.exefsImage,path.join(out,'exefs-image',game.titleId)):captured.files.map(e=>({name:e.name,size:e.size,file:path.join(out,e.localPath)}));
 const rows=new Map(base.map(e=>[e.name,{...e,modified:!!game.exefsImage}])),replacements=new Map(game.exefs.map(e=>[e.path.slice(1),e]));
 for(const [name,r] of replacements){
  check(!names.has(name.toLowerCase())||names.get(name.toLowerCase())===name,'ExeFS filename case differs from original: '+name);
  rows.set(name,{name,file:r.file,size:r.size,modified:true});
 }
 // Atmosphere precedence: a loose replacement wins over a .stub marker;
 // a .stub hides the original/PFS0 file when there is no loose replacement.
 for(const name of game.stubs||[])if(!replacements.has(name))rows.delete(name);
 check(rows.has('main')&&rows.has('main.npdm'),'The final CodeFS must contain main and main.npdm');
 const matched=new Set(),entries=[],patches=[...game.patches,...globalPatches];let changes=!!game.exefsImage||game.exefs.length>0||(game.stubs||[]).some(n=>originals.has(n)||base.some(e=>e.name===n));
 for(const row of rows.values()){
  Object.assign(row,moduleHeader(row.file));row.chosen=row.buildId?patches.filter(p=>matchesPatch(p,row.name,row.buildId)):[];
  if(row.chosen.length){changes=true;for(const p of row.chosen)matched.add(p.file);}
 }
 if(!changes)return{entries:[],group:null,matched:[]};
 for(const row of rows.values()){
  let file=row.file;
  if(row.chosen.length){
   const raw=applyNsoPatches(fs.readFileSync(file),row.chosen),target=path.join(out,'patched-exefs',game.titleId,row.name);
   fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.writeFileSync(target,raw,{mode:0o600});file=target;row.modified=true;
  }
  if(row.name==='main.npdm')check(row.size>=128&&row.header.toString('ascii',0,4)==='META','Invalid main.npdm replacement');
  const written=pack.append(file),original=originals.get(row.name)||null;
  if(!row.modified&&original)check(written.size===original.size&&written.sha256===original.sha256,'Captured CodeFS file changed: '+row.name);
  entries.push({titleId:game.titleId,name:row.name,source:captured.source,storage:captured.storage,selection:captured.selection,original,modified:row.modified,replacement:{size:written.size,sha256:written.sha256,sourceOffset:written.offset},patches:row.chosen.map(p=>p.path)});
 }
 const removed=[...originals.keys()].filter(n=>!rows.has(n));
 return{entries,group:{titleId:game.titleId,source:captured.source,selection:captured.selection,owner:captured.owner,removed},matched:[...matched]};
}

module.exports={decodeNso,encodeNso,parseIps,applyNsoPatches,matchesPatch,buildExeFs,lz4};
