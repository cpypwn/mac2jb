const fs=require('node:fs/promises'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const layout=require('./layout.cjs'),{program,sprite,font}=require('./rom.cjs');

async function main(){
 const root=__dirname,assets=path.join(root,'assets'),shaders=path.join(root,'shaders');
 await fs.mkdir(assets,{recursive:true});
 const memory=Buffer.alloc(layout.bytes),put=(address,value)=>{
  if(!Number.isInteger(address)||address<0||address>=4096||value<0||value>255)throw Error('Invalid CHIP-8 memory byte');
  memory.writeUInt32LE(value,4*(layout.memory+address));
 };
 font.forEach((value,index)=>put(0x50+index,value));
 program.forEach((word,index)=>{put(0x200+index*2,word>>>8);put(0x201+index*2,word&255);});
 sprite.forEach((value,index)=>put(0x300+index,value));
 memory.writeUInt32LE(0x200,4*(layout.state+layout.pc));
 memory.writeUInt32LE(0x9e3779b9,4*(layout.state+layout.random));
 const defines=[
  ['C8_MEMORY',layout.memory],['C8_REGISTERS',layout.registers],
  ['C8_STATE',layout.state],['C8_STACK',layout.stack],['C8_DISPLAY',layout.display],
  ['C8_PC',layout.pc],['C8_I',layout.i],['C8_SP',layout.sp],
  ['C8_DELAY',layout.delay],['C8_SOUND',layout.sound],['C8_RANDOM',layout.random],
  ['C8_HALTED',layout.halted],['C8_LAST_CLOCK',layout.lastClock],
  ['C8_CLOCK_PHASE',layout.clockPhase],['C8_CLOCK_READY',layout.clockReady],
  ['C8_FRAME',layout.frame],['C8_INSTRUCTIONS',layout.instructions]
 ];
 await fs.writeFile(path.join(shaders,'layout.glsl'),defines.map(([name,value])=>'const uint '+name+'='+value+'u;').join('\n')+'\n');
 await fs.writeFile(path.join(assets,'memory.bin'),memory);
 await fs.writeFile(path.join(assets,'state.bin'),Buffer.alloc(1024));
 execFileSync('python3',[path.join(root,'assets.py')],{stdio:'inherit'});
 await require('../../sdk/build.cjs').buildApp(root);
}

if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
