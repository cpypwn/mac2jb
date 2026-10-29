// The launcher is the SDK integration fixture. No diagnostics menu or separate app.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const L=require('../host/layout.cjs');
async function main(){
 const root=path.resolve(__dirname,'../..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'hb-sdk-launcher-'));
 async function step(state,buttons,axes={}){const input=Buffer.alloc(64);input.writeUInt32LE(buttons,8);input.writeUInt32LE(1,32);input.writeInt32LE(axes.leftY||0,20);input.writeInt32LE(axes.rightX||0,24);input.writeInt32LE(axes.rightY||0,28);await fs.writeFile(path.join(dir,'state'),state);await fs.writeFile(path.join(dir,'input'),input);execFileSync(path.join(root,'homebrew-launcher/game-compute-check'),[path.join(dir,'state'),path.join(dir,'out'),path.join(root,'homebrew-launcher/shaders/launcher.comp.spv'),path.join(dir,'input'),'1'],{env:{...process.env,HB_FULL_OUTPUT:'1'},stdio:'pipe'});return fs.readFile(path.join(dir,'out'));}
 let state=Buffer.alloc(8*1024*1024);state.writeUInt32LE(L.MAGIC,L.OFFSET);state.writeUInt32LE(L.VERSION,L.OFFSET+4);state.writeUInt32LE(32,L.OFFSET+12);state.writeUInt32LE(1,112);state.writeUInt32LE(1,1020);
 // Startup qualification remains black; continuous frames reveal the menu once.
 let startup=Buffer.from(state);startup.writeFloatLE(1+1/15,960);
 startup=await step(startup,0);assert.ok(Math.abs(startup.readFloatLE(960)-1)<1e-6,'qualification frame stays black');
 startup.writeFloatLE(1,960);
 for(let frame=0;frame<15;frame++){
  const before=startup.readFloatLE(960);startup=await step(startup,0);
  assert.ok(startup.readFloatLE(960)<before,'startup fade advances every frame');
 }
 assert.ok(startup.readFloatLE(960)<1e-6,'menu fully visible after 15 frames');
 // The right stick is a pointer alternative when the Joy-Con is attached.
 let stick=Buffer.from(startup);
 stick=await step(stick,0,{rightX:32767});
 assert.equal(stick.readFloatLE(816),978,'right stick moves pointer right');
 assert.equal(stick.readFloatLE(820),540,'right stick keeps pointer Y');
 assert.equal(stick.readUInt32LE(788),1,'right stick activates pointer mode');
 assert.equal(stick.readUInt32LE(1004),1,'right stick shows cursor without optical tracking');
 stick=await step(stick,0);
 assert.equal(stick.readFloatLE(816),978,'pointer stays after right stick release');
 assert.equal(stick.readUInt32LE(1004),1,'stick cursor stays visible after release');
 stick=await step(stick,0,{rightY:32767});
 assert.equal(stick.readFloatLE(820),522,'right stick up moves pointer up');
 assert.equal(stick.readFloatLE(816),978,'right stick up keeps pointer X');
 const stickClick=Buffer.from(startup);stickClick.writeFloatLE(960,816);stickClick.writeFloatLE(551,820);stickClick.writeUInt32LE(1,788);
 const clicked=await step(stickClick,512);
 assert.equal(clicked.readFloatLE(964),1,'ZR launches through the stick pointer');
 const ring=L.OFFSET+0x4000+712,record=ring+32+40;state.writeUInt32LE(1,ring+16);state.writeUInt32LE(1,ring+24);state.writeBigUInt64LE(2n,record);state.writeBigUInt64LE(1n,record+16);state.writeInt32LE(20,record+24);state.writeInt32LE(-10,record+28);state.writeUInt32LE(3,record+32);
 state=await step(state,0);assert.equal(state.readFloatLE(816),990,'optical X delta');assert.equal(state.readFloatLE(820),525,'optical Y delta');
 state=await step(state,0);assert.equal(state.readFloatLE(816),990,'sample applied once');
 state.writeBigUInt64LE(3n,record);state.writeBigUInt64LE(2n,record+16);state=await step(state,0);assert.equal(state.readFloatLE(816),990,'inconsistent entry rejected');
 state=await step(state,8);assert.equal(state.readUInt32LE(92),0,'Y does not open a system menu');assert.equal(state.readUInt32LE(L.OFFSET+2048),0,'launcher has no diagnostic requests');
 // Restore a stable optical sample and verify mode-specific shoulder clicks.
 state.writeBigUInt64LE(4n,record);state.writeBigUInt64LE(2n,record+16);state.writeInt32LE(0,record+24);state.writeInt32LE(0,record+28);
 const shoulder=Buffer.from(state);shoulder.writeFloatLE(1660,816);shoulder.writeFloatLE(179,820);
 let click=await step(shoulder,64);assert.equal(click.readFloatLE(104),0,'L ignored when only right mouse tracks');
 click=await step(shoulder,128);assert.equal(click.readFloatLE(104),1,'R clicks the Refresh in right mouse mode');assert.equal(click.readUInt32LE(1004),1,'tracking shows cursor');
 shoulder.writeUInt32LE(1,record+32);click=await step(shoulder,128);assert.equal(click.readFloatLE(104),0,'R ignored outside optical tracking');assert.equal(click.readUInt32LE(1004),0,'cursor hides outside mouse mode');
 // One side can stay handheld while the detached side reports through player one.
 for(const [side,button,source] of [[0,64,2],[1,128,2],[0,64,3],[1,128,4]]){
  const mixed=Buffer.alloc(8*1024*1024);
  mixed.writeUInt32LE(L.MAGIC,L.OFFSET);mixed.writeUInt32LE(L.VERSION,L.OFFSET+4);
  mixed.writeUInt32LE(L.FLAGS.joyMouse|L.FLAGS.padSources,L.OFFSET+12);
  mixed.writeUInt32LE(1,784);mixed.writeFloatLE(1660,816);mixed.writeFloatLE(179,820);
  const base=L.OFFSET+0x4000+side*712,slot=base+32+40;
  mixed.writeUInt32LE(1,base+16);mixed.writeUInt32LE(1,base+24);
  mixed.writeBigUInt64LE(2n,slot);mixed.writeBigUInt64LE(1n,slot+16);mixed.writeUInt32LE(3,slot+32);
  const pad=L.OFFSET+L.FIELD.padSources+source*64;
  mixed.writeUInt32LE(button,pad+8);mixed.writeUInt32LE(1,pad+32);
  let result=await step(mixed,0);assert.equal(result.readFloatLE(104),1,'detached side clicks while primary handheld reports no button');
  result=await step(result,0);assert.equal(result.readFloatLE(104),1,'holding shoulder does not repeat click');
  mixed.writeUInt32LE(0,pad+32);result=await step(mixed,0);assert.equal(result.readFloatLE(104),0,'disconnected source cannot click');
 }
 state=await step(state,512);assert.equal(state.readFloatLE(964),1,'ZR on the hovered row launches selection');
 console.log('SDK launcher passed: black startup and 15-frame fade, right-stick pointer, optical movement, deduplication, torn-record rejection, no System menu, mode-specific shoulder clicks, cursor hiding, ZR launch.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
