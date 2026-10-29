const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const fs=require('node:fs/promises');
const layout=require('./layout.cjs'),{program,sprite,font}=require('./rom.cjs');

function reference(){
 const memory=new Uint8Array(4096),screen=new Uint8Array(64*32),v=new Uint8Array(16);
 font.forEach((value,index)=>memory[0x50+index]=value);
 program.forEach((word,index)=>{memory[0x200+index*2]=word>>>8;memory[0x201+index*2]=word&255;});
 sprite.forEach((value,index)=>memory[0x300+index]=value);
 let pc=0x200,i=0,delay=0;
 function instruction(keys){
  assert.ok(pc>=0x200&&pc<0x1000);
  const op=(memory[pc]<<8)|memory[pc+1];pc+=2;
  const family=op&0xf000,x=(op>>8)&15,y=(op>>4)&15;
  if(op===0x00e0)screen.fill(0);
  else if(family===0x1000)pc=op&0xfff;
  else if(family===0x3000){if(v[x]===(op&255))pc+=2;}
  else if(family===0x6000)v[x]=op&255;
  else if(family===0x7000)v[x]=(v[x]+(op&255))&255;
  else if(family===0xa000)i=op&0xfff;
  else if(family===0xd000){
   v[15]=0;
   for(let row=0;row<(op&15);row++)for(let bit=0;bit<8;bit++)if(memory[i+row]&(128>>bit)){
    const at=((v[y]+row)%32)*64+(v[x]+bit)%64;
    v[15]|=screen[at];screen[at]^=1;
   }
  }else if(family===0xe000&&(op&255)===0xa1){if((keys&(1<<v[x]))===0)pc+=2;}
  else if(family===0xf000&&(op&255)===0x07)v[x]=delay;
  else if(family===0xf000&&(op&255)===0x15)delay=v[x];
  else assert.fail('Unexpected test ROM instruction: '+op.toString(16));
 }
 return {frame(keys=0){if(delay)delay--;for(let n=0;n<32;n++)instruction(keys);},
  get x(){return v[0];},get y(){return v[1];},get lit(){return screen.reduce((sum,pixel)=>sum+pixel,0);}};
}

test('original ROM draws a sprite, moves on the mapped right key, and recenters with A',()=>{
 const chip=reference();
 for(let frame=0;frame<12;frame++){chip.frame();assert.ok(chip.lit>0);}
 assert.equal(chip.x,10);assert.equal(chip.y,10);assert.ok(chip.lit>0);
 for(let frame=0;frame<24;frame++){chip.frame(1<<6);assert.ok(chip.lit>0);}
 assert.ok(chip.x>10,'right key moves the emulated sprite');
 for(let frame=0;frame<24;frame++){chip.frame(1<<5);assert.ok(chip.lit>0);}
 assert.equal(chip.x,10);assert.equal(chip.y,10);assert.ok(chip.lit>0);
});

test('packaged CHIP-8 app has an owned CPU clock mailbox and bounded storage',async()=>{
 const app=await require('../../homebrew-launcher/app-catalog.cjs').readApp(__dirname);
 assert.equal(app.id,'chip8-test');
 assert.deepEqual(app.manifest.cpuBridge,{kind:'counter-v1',offset:0});
 assert.equal(app.files.memory.allocationBytes,layout.bytes);
 const bytes=await fs.readFile(path.join(__dirname,'assets/memory.bin'));
 assert.equal(bytes.length,layout.bytes);
 assert.equal(bytes.readUInt32LE(4*(layout.state+layout.pc)),0x200);
 assert.equal(bytes.readUInt32LE(4*(layout.memory+0x200)),0x60);
 assert.equal(bytes.readUInt32LE(4*(layout.memory+0x201)),0x0a);
});
