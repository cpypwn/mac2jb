// Minimal non-domain CMIF for explicit research commands. Not exposed to GPU apps.
const {create}=require('./client.cjs');
const definitions=require('./ipc-functions.json'),services=require('./service-functions.json');
function encode(command,data=Buffer.alloc(0),{pid=false,handles=[]}={}){
 if(!Number.isInteger(command)||command<0||command>0xffffffff||!Buffer.isBuffer(data)||data.length>2048||handles.length>8||handles.some(h=>!Number.isInteger(h)||h<=0||h>0xffffffff))throw Error('Invalid IPC request');
 const bytes=Buffer.alloc(4096),special=pid||handles.length;bytes.writeUInt32LE(4,0);bytes.writeUInt32LE((Math.ceil((32+data.length)/4)|(special?0x80000000:0))>>>0,4);
 let at=8;if(special){bytes.writeUInt32LE((pid?1:0)|(handles.length<<1),at);at+=4;if(pid)at+=8;for(const h of handles){bytes.writeUInt32LE(h,at);at+=4;}}
 at=(at+15)&~15;bytes.writeUInt32LE(0x49434653,at);bytes.writeUInt32LE(command,at+8);data.copy(bytes,at+16);return bytes;
}
function decode(bytes){
 const h0=bytes.readUInt32LE(),h1=bytes.readUInt32LE(4);if((h0>>>16)!==0)throw Error('Unexpected IPC descriptors');let at=8,copy=[],move=[];
 if(h1>>>31){const special=bytes.readUInt32LE(at);at+=4;if(special&1)at+=8;for(let i=0;i<((special>>>1)&15);i++){copy.push(bytes.readUInt32LE(at));at+=4;}for(let i=0;i<((special>>>5)&15);i++){move.push(bytes.readUInt32LE(at));at+=4;}}
 const end=at+(h1&1023)*4;at=(at+15)&~15;if(end>bytes.length||at+16>end||bytes.readUInt32LE(at)!==0x4f434653)throw Error('Invalid CMIF response');
 return {result:bytes.readUInt32LE(at+8),data:Buffer.from(bytes.subarray(at+16,end)),copy,move};
}
async function open(rpc,name){
 if(!/^[a-z0-9:-]{1,8}$/.test(name))throw Error('Invalid service name');
 const api=await create(rpc,{...definitions,service:services.service,close:services.closeHandle});await api.write(0x2000,Buffer.from(name+'\0'));
 const result=await api.result('service',[api.base+0x2100,api.base+0x2000,name.length]);if(result)throw Error('Open '+name+' result '+result);const handle=(await api.read(0x2100,4)).readUInt32LE();let closed=false,busy=false;
 return {api,handle,aruid:()=>api.call('aruid'),async request(command,data,options){if(closed||busy)throw Error('IPC channel closed or busy');busy=true;try{await api.write(0,encode(command,data,options));const transport=await api.result('send',[handle,api.base,4096]);if(transport)return {transport,result:null};return {transport,...decode(await api.read(0,4096))};}finally{busy=false;}},async close(){if(!closed){closed=true;return api.result('close',[handle]);}}};
}
module.exports={encode,decode,open};
