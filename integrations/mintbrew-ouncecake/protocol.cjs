const MAGIC=0x31435a4f;
const MAX_GAMES=1000;
const HEADER_BYTES=4096;
const TILE_WIDTH=768;
const TILE_HEIGHT=32;
const TILE_BYTES=TILE_WIDTH*TILE_HEIGHT/2;
const STORAGE_BYTES=16*1024*1024;
const STATES=Object.freeze({reading:0,catalog:1,preparing:2,running:3,error:4,closing:5});

function header(state,count=0,message=''){
 if(!Object.values(STATES).includes(state)||!Number.isInteger(count)||count<0||count>MAX_GAMES)
  throw Error('Invalid OunceCake display state');
 const ascii=Buffer.from(String(message).replace(/[^\x20-\x7e]/g,'?').slice(0,76),'ascii');
 const data=Buffer.alloc(HEADER_BYTES);
 data.writeUInt32LE(MAGIC,0);data.writeUInt32LE(state,4);data.writeUInt32LE(count,8);
 data.writeUInt32LE(ascii.length,16);ascii.copy(data,128);
 return data;
}
module.exports={MAGIC,MAX_GAMES,HEADER_BYTES,TILE_WIDTH,TILE_HEIGHT,TILE_BYTES,STORAGE_BYTES,STATES,header};
