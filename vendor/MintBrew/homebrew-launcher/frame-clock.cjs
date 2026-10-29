const CLOCK_OFFSET=0x700d70;
const RESULTS_OFFSET=0x320000;
const COPY_OFFSET=0x586fb0;
const FREQUENCY=31250000;

function append(calls,{sdk,base,mapped,tickOffset}){
 if(!Array.isArray(calls)||![sdk,base,mapped,tickOffset].every(Number.isSafeInteger)||
    sdk<=0||base<=0||mapped<=0||tickOffset<0)throw Error('Invalid frame clock addresses');
 const result=base+RESULTS_OFFSET+calls.length*8;
 const mailbox=mapped+CLOCK_OFFSET;
 if(!Number.isSafeInteger(result)||!Number.isSafeInteger(mailbox))throw Error('Frame clock address exceeds safe range');
 calls.push({function:sdk+tickOffset,args:[0,0,0,0]});
 calls.push({function:sdk+COPY_OFFSET,args:[mailbox,result,8,0]});
 return {result,mailbox};
}

async function initializeMailbox(rpc,mailbox,frequency){
 if(frequency!==FREQUENCY)throw Error('Unsupported frame clock frequency');
 if(!Number.isSafeInteger(mailbox)||mailbox<=0)throw Error('Invalid frame clock mailbox');
 const bytes=Buffer.alloc(4);bytes.writeUInt32LE(frequency);
 await rpc.write(mailbox+8,bytes);
}

const initialize=(rpc,mapped,frequency)=>initializeMailbox(rpc,mapped+CLOCK_OFFSET,frequency);

module.exports={CLOCK_OFFSET,RESULTS_OFFSET,COPY_OFFSET,FREQUENCY,append,initialize,initializeMailbox};
