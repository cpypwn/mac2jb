const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const layout=require('../../vendor/MintBrew/apps/mintnes/layout.cjs');

function romDirectory(){return path.join(os.homedir(),'Library','Application Support','mac2jb','MintNES','roms');}
function validRom(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<16||!bytes.subarray(0,4).equals(Buffer.from('4e45531a','hex')))throw Error('Invalid iNES header');
 const prgBanks=bytes[4],chrBanks=bytes[5],flags=bytes[6],mapper=(flags>>4)|(bytes[7]&0xf0);
 if((prgBanks!==1&&prgBanks!==2)||(chrBanks!==0&&chrBanks!==1)||mapper!==0||(flags&0x0c)!==0||(bytes[7]&0x0c)===0x08)throw Error('MintNES supports mapper 0 ROMs with 16/32 KB PRG and CHR ROM or RAM');
 const size=16+prgBanks*16384+chrBanks*8192;
 if(bytes.length<size)throw Error('Truncated iNES ROM');
 return {prgBanks,mirroring:flags&1,chrRam:chrBanks===0,prg:bytes.subarray(16,16+prgBanks*16384),chr:bytes.subarray(16+prgBanks*16384,size)};
}
async function readRom(file){
 const size=(await fs.stat(file)).size;
 if(size<16||size>65536)throw Error('NES ROM file size is outside the supported range');
 const bytes=await fs.readFile(file);validRom(bytes);return bytes;
}
function title(filename){
 return filename.replace(/\.nes$/i,'').normalize('NFKD').replace(/[^\x20-\x7e]/g,'_').slice(0,40)||'Unnamed ROM';
}
function menuNames(roms){
 const output=Buffer.alloc(layout.nameWords*layout.maxRoms*4);
 roms.slice(0,layout.maxRoms).forEach((rom,index)=>{
  Buffer.from(rom.title,'ascii').forEach((byte,i)=>output.writeUInt32LE(byte,(index*layout.nameWords+i)*4));
 });
 return output;
}
function imageFor(app,bytes,roms,selected){
 const rom=validRom(bytes),image=Buffer.from(app.files.memory.bytes);
 if(image.length!==layout.bytes)throw Error('MintNES memory image has changed size');
 const prg=rom.prgBanks===1?Buffer.concat([rom.prg,rom.prg]):rom.prg;
 for(let i=0;i<32768;i++)image.writeUInt32LE(prg[i],(layout.prg+i)*4);
 for(let i=0;i<8192;i++)image.writeUInt32LE(rom.chrRam?0:rom.chr[i],(layout.chr+i)*4);
 image.writeUInt32LE(0,layout.menuMode*4);
 image.writeUInt32LE(selected,layout.selected*4);
 image.writeUInt32LE(roms.length,layout.count*4);
 image.writeUInt32LE(rom.mirroring,layout.mirroring*4);
 image.writeUInt32LE(rom.chrRam?1:0,layout.chrRam*4);
 const reset=prg[0x7ffc]|(prg[0x7ffd]<<8);
 if(reset<0x8000)throw Error('NES reset vector is outside PRG ROM');
 image.writeUInt32LE(reset,4*4);
 menuNames(roms).copy(image,layout.menuText*4);
 return image;
}
async function create({rpc,gpu,app,directory=romDirectory(),onProgress=()=>{}}){
 if(!gpu.privateStorage?.mapped||gpu.privateStorage.bytes!==layout.bytes)throw Error('MintNES private memory is unavailable');
 const folder=directory,marker=path.join(folder,'.initialized'),bundled=path.join(app.root,'rom','game.nes');
 await fs.mkdir(folder,{recursive:true});
 try{await fs.access(marker);}catch(error){
  if(error.code!=='ENOENT')throw error;
  await fs.copyFile(bundled,path.join(folder,'Diamond Chase.nes'),fs.constants.COPYFILE_EXCL).catch(copyError=>{if(copyError.code!=='EEXIST')throw copyError;});
  await fs.writeFile(marker,'1\n');
 }
 let roms=[],lastRefresh=0,wasMenu=true;
 const mapped=gpu.privateStorage.mapped;
 async function scan(){
  const entries=await fs.readdir(folder,{withFileTypes:true}),next=[];
  for(const entry of entries){
   if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.nes'))continue;
   const file=path.join(folder,entry.name);
   try{await readRom(file);next.push({file,title:title(entry.name)});}
   catch(error){onProgress('Skipped '+entry.name+': '+error.message);}
  }
  next.sort((a,b)=>a.title.localeCompare(b.title));roms=next.slice(0,layout.maxRoms);
  await rpc.write(mapped+layout.menuText*4,menuNames(roms));
  const state=await rpc.read(mapped,(layout.count+1)*4);
  const selected=Math.min(state.readUInt32LE(layout.selected*4),Math.max(0,roms.length-1));
  const update=Buffer.alloc(12);update.writeUInt32LE(selected,0);update.writeUInt32LE(roms.length,4);update.writeUInt32LE(0,8);
  await rpc.write(mapped+layout.selected*4,update);
  return roms;
 }
 await scan();
 return {folder,async start(){},async pending(){
  const state=await rpc.read(mapped,(layout.refreshRequest+1)*4);
  return state.readUInt32LE(layout.loadRequest*4)!==0||
   state.readUInt32LE(layout.refreshRequest*4)!==lastRefresh||
   (state.readUInt32LE(layout.menuMode*4)!==0&&!wasMenu);
 },async afterBatch(){
  const state=await rpc.read(mapped,(layout.minusHeld+1)*4);
  const menu=state.readUInt32LE(layout.menuMode*4)!==0;
  const refresh=state.readUInt32LE(layout.refreshRequest*4);
  if((menu&&!wasMenu)||refresh!==lastRefresh){lastRefresh=refresh;await scan();}
  wasMenu=menu;
  const request=state.readUInt32LE(layout.loadRequest*4);
  if(request===0)return;
  const selected=request-1;
  if(selected>=roms.length){await rpc.write(mapped+layout.loadRequest*4,Buffer.alloc(4));return;}
  try{
   const bytes=await readRom(roms[selected].file);
   const image=imageFor(app,bytes,roms,selected);
   await rpc.write(mapped,image);
   wasMenu=false;
   onProgress('Loaded '+roms[selected].title+' in MintNES');
  }catch(error){
   await rpc.write(mapped+layout.loadRequest*4,Buffer.alloc(4));
   onProgress('MintNES could not load '+roms[selected].title+': '+error.message);
  }
 },async close(){},scan};
}

module.exports={create,romDirectory,validRom,readRom,title,menuNames,imageFor};
