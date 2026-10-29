function make({scrollX=252,vertical=true}={}){
 const rom=Buffer.alloc(16+32768+8192);
 Buffer.from('4e45531a','hex').copy(rom);
 rom[4]=2;rom[5]=1;rom[6]=vertical?1:0;
 const code=[];
 const emit=(...bytes)=>code.push(...bytes);
 const lda=value=>emit(0xa9,value);
 const sta=address=>emit(0x8d,address&255,address>>8);
 const write=(address,value)=>{lda(address>>8);sta(0x2006);lda(address&255);sta(0x2006);lda(value);sta(0x2007);};
 emit(0x78);lda(0);sta(0x2000);sta(0x2001);emit(0xad,0x02,0x20);
 write(0x2000,1);write(0x201f,1);write(0x2400,2);
 write(0x3f00,0x0f);write(0x3f01,0x28);write(0x3f02,0x30);
 lda(0x0a);sta(0x2001);
 emit(0xad,0x02,0x20);lda(scrollX);sta(0x2005);lda(0);sta(0x2005);
 const loop=0x8000+code.length;emit(0x4c,loop&255,loop>>8);
 Buffer.from(code).copy(rom,16);
 rom.writeUInt16LE(0x8000,16+0x7ffa);
 rom.writeUInt16LE(0x8000,16+0x7ffc);
 rom.writeUInt16LE(0x8000,16+0x7ffe);
 for(let y=0;y<8;y++){
  rom[16+32768+16+y]=0xff;
  rom[16+32768+32+8+y]=0xff;
 }
 return rom;
}
function spriteZero(){
 const rom=Buffer.alloc(16+32768+8192);
 Buffer.from('4e45531a','hex').copy(rom);rom[4]=2;rom[5]=1;rom[6]=1;
 const code=[];
 const emit=(...bytes)=>code.push(...bytes);
 const lda=value=>emit(0xa9,value);
 const sta=address=>emit(0x8d,address&255,address>>8);
 const write=(address,value)=>{lda(address>>8);sta(0x2006);lda(address&255);sta(0x2006);lda(value);sta(0x2007);};
 emit(0x78);lda(0);sta(0x2000);sta(0x2001);emit(0xad,0x02,0x20);
 write(0x2000,1);write(0x20c0,1);write(0x2084,1);
 write(0x3f00,0x0f);write(0x3f01,0x28);write(0x3f11,0x30);
 lda(0);sta(0x2003);
 for(const byte of [31,1,0,32]){lda(byte);sta(0x2004);}
 lda(0x1e);sta(0x2001);
 emit(0xad,0x02,0x20);lda(0);sta(0x2005);sta(0x2005);
 emit(0x2c,0x02,0x20,0x50,0xfb);
 lda(8);sta(0x2005);lda(0);sta(0x2005);
 const loop=0x8000+code.length;emit(0x4c,loop&255,loop>>8);
 Buffer.from(code).copy(rom,16);
 for(const vector of [0x7ffa,0x7ffc,0x7ffe])rom.writeUInt16LE(0x8000,16+vector);
 for(let y=0;y<8;y++)rom[16+32768+16+y]=0xff;
 return rom;
}
function chrRam(){
 const rom=Buffer.alloc(16+32768);
 Buffer.from('4e45531a','hex').copy(rom);rom[4]=2;rom[5]=0;rom[6]=1;
 const code=[];
 const emit=(...bytes)=>code.push(...bytes);
 const lda=value=>emit(0xa9,value);
 const sta=address=>emit(0x8d,address&255,address>>8);
 const address=value=>{lda(value>>8);sta(0x2006);lda(value&255);sta(0x2006);};
 emit(0x78);lda(0);sta(0x2000);sta(0x2001);emit(0xad,0x02,0x20);
 address(0x0010);lda(0xff);for(let i=0;i<8;i++)sta(0x2007);
 address(0x2000);lda(1);sta(0x2007);
 address(0x3f00);lda(0x0f);sta(0x2007);lda(0x28);sta(0x2007);
 lda(0x0a);sta(0x2001);emit(0xad,0x02,0x20);lda(0);sta(0x2005);sta(0x2005);
 const loop=0x8000+code.length;emit(0x4c,loop&255,loop>>8);
 Buffer.from(code).copy(rom,16);
 for(const vector of [0x7ffa,0x7ffc,0x7ffe])rom.writeUInt16LE(0x8000,16+vector);
 return rom;
}
function sprite8x16(){
 const rom=Buffer.alloc(16+32768+8192);
 Buffer.from('4e45531a','hex').copy(rom);rom[4]=2;rom[5]=1;rom[6]=1;
 const code=[];
 const emit=(...bytes)=>code.push(...bytes);
 const lda=value=>emit(0xa9,value);
 const sta=address=>emit(0x8d,address&255,address>>8);
 const write=(address,value)=>{lda(address>>8);sta(0x2006);lda(address&255);sta(0x2006);lda(value);sta(0x2007);};
 emit(0x78);lda(0);sta(0x2000);sta(0x2001);emit(0xad,0x02,0x20);
 write(0x2062,1);
 write(0x3f00,0x0f);write(0x3f01,0x28);write(0x3f11,0x30);
 lda(0);sta(0x2003);
 for(const byte of [15,3,0,16,15,3,0x80,32]){lda(byte);sta(0x2004);}
 lda(0x20);sta(0x2000);lda(0x1e);sta(0x2001);
 emit(0xad,0x02,0x20);lda(0);sta(0x2005);sta(0x2005);
 emit(0x2c,0x02,0x20,0x50,0xfb);lda(0x55);sta(3);
 const loop=0x8000+code.length;emit(0x4c,loop&255,loop>>8);
 Buffer.from(code).copy(rom,16);
 for(const vector of [0x7ffa,0x7ffc,0x7ffe])rom.writeUInt16LE(0x8000,16+vector);
 for(let y=0;y<8;y++){
  rom[16+32768+16+y]=0xff;
  rom[16+32768+4096+3*16+y]=0xff;
 }
 return rom;
}
function apuStatus(){
 const rom=Buffer.alloc(16+32768+8192);
 Buffer.from('4e45531a','hex').copy(rom);rom[4]=2;rom[5]=1;
 const code=[];
 const emit=(...bytes)=>code.push(...bytes);
 const lda=value=>emit(0xa9,value);
 const sta=address=>emit(0x8d,address&255,address>>8);
 lda(15);sta(0x4015);
 for(const address of [0x4003,0x4007,0x400b,0x400f]){lda(8);sta(address);}
 emit(0xad,0x15,0x40);sta(0);lda(6);sta(0x4015);emit(0xad,0x15,0x40);sta(1);
 lda(0);sta(0x4015);emit(0xad,0x15,0x40);sta(2);
 const loop=0x8000+code.length;emit(0x4c,loop&255,loop>>8);
 Buffer.from(code).copy(rom,16);
 for(const vector of [0x7ffa,0x7ffc,0x7ffe])rom.writeUInt16LE(0x8000,16+vector);
 return rom;
}
module.exports={make,spriteZero,chrRam,sprite8x16,apuStatus};
