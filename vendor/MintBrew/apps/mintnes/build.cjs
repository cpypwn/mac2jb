const fs=require('node:fs/promises'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const layout=require('./layout.cjs');

async function main(){
 const root=__dirname,assets=path.join(root,'assets'),shaders=path.join(root,'shaders');
 await fs.mkdir(assets,{recursive:true});
 const rom=await fs.readFile(path.join(root,'rom','game.nes'));
 if(rom.length!==40976||rom.subarray(0,4).toString('hex')!=='4e45531a'||rom[4]!==2||rom[5]!==1||((rom[6]>>4)|(rom[7]&0xf0))!==0)throw Error('Expected a 32 KB PRG, 8 KB CHR mapper-0 iNES ROM');
 const memory=Buffer.alloc(layout.bytes);
 for(let i=0;i<32768;i++)memory.writeUInt32LE(rom[16+i],4*(layout.prg+i));
 for(let i=0;i<8192;i++)memory.writeUInt32LE(rom[16+32768+i],4*(layout.chr+i));
 memory.writeUInt32LE(0xfd,4*3);
 memory.writeUInt32LE(0x24,4*5);
 memory.writeUInt32LE(0x8000,4*4);
 memory.writeUInt32LE(1,4*19);
 memory.writeUInt32LE(1,4*21);
 Buffer.from('Diamond Chase (bundled)').forEach((byte,index)=>memory.writeUInt32LE(byte,4*(layout.menuText+index)));
 await fs.writeFile(path.join(assets,'memory.bin'),memory);
 const defs=Object.entries(layout).filter(([key])=>key!=='bytes').map(([key,value])=>`const uint NES_${key.replace(/[A-Z]/g,c=>'_'+c).toUpperCase()}=${value}u;`).join('\n');
 await fs.writeFile(path.join(shaders,'layout.glsl'),defs+'\n');
 await fs.writeFile(path.join(assets,'state.bin'),Buffer.alloc(1024));
 execFileSync('python3',[path.join(root,'assets.py')],{stdio:'inherit'});
 await require('../../sdk/build.cjs').buildApp(root);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
