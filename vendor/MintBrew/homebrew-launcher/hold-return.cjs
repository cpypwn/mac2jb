const B=1<<1,MINUS=1<<11,HOLD_MS=900;

function buttons(state,extension){
 let held=state.readUInt32LE(32)&1?state.readUInt32LE(8):0;
 if(extension.length<960||extension.readUInt32LE(0)!==0x48425344||extension.readUInt32LE(4)!==1||!(extension.readUInt32LE(12)&64))return held;
 for(let i=0;i<5;i++){
  const offset=640+i*64;
  if(extension.readUInt32LE(offset+32)&1)held|=extension.readUInt32LE(offset+8);
 }
 return held;
}

function create(thresholdMs=HOLD_MS){
 let bSince=null,minusSince=null;
 return {
  update(held,now){
   bSince=held&B?(bSince??now):null;
   minusSince=held&MINUS?(minusSince??now):null;
   return bSince!==null&&now-bSince>=thresholdMs||minusSince!==null&&now-minusSince>=thresholdMs;
  },
  reset(){bSince=minusSince=null;}
 };
}

module.exports={buttons,create,B,MINUS,HOLD_MS};
