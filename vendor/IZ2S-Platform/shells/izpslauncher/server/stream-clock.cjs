// Stream controls share a shell-owned mailbox. Publish the qualified hardware
// counter before each render, without host polling or an additional thread.
const OFFSET=0x700c80+240,FREQUENCY_OFFSET=OFFSET+8;
function append(calls,{sdk,base,mapped,tick}){
 const index=calls.length;
 calls.push({function:tick,args:[0,0,0,0]});
 calls.push({function:sdk+0x586fb0,args:[mapped+OFFSET,base+0x320000+index*8,8,0]});
 return index;
}
function frequencyWord(frequency){
 if(frequency!==31250000)throw Error('Unqualified stream clock frequency');
 const word=Buffer.alloc(4);word.writeUInt32LE(frequency);return word;
}
module.exports={OFFSET,FREQUENCY_OFFSET,append,frequencyWord};
