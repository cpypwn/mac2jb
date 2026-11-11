'use strict';
const {check}=require('./common.cjs');
// IPSwitch data is compiled during setup; the game only consumes binary IPS32.
// No fixed line length or patch count: limits follow IPS record/address widths.
function decodeText(bytes,label){
 if(typeof bytes==='string')return bytes.replace(/^\uFEFF/,'');
 check(Buffer.isBuffer(bytes),'Expected patch text bytes');
 let encoding='utf-8',input=bytes;
 if(bytes[0]===0xff&&bytes[1]===0xfe){encoding='utf-16le';input=bytes.subarray(2);}
 else if(bytes[0]===0xfe&&bytes[1]===0xff){encoding='utf-16be';input=bytes.subarray(2);}
 try{return new TextDecoder(encoding,{fatal:true}).decode(input).replace(/^\uFEFF/,'');}
 catch{throw Error(label+': invalid '+encoding+' patch text');}
}
function compilePchtxt(bytes,label='patch.pchtxt'){
 const text=decodeText(bytes,label),records=[];let buildId,enabled=false,shift=0n,lineNumber=0;
 const fail=message=>{throw Error(label+':'+lineNumber+': '+message);};
 function strip(line){
  let quote='';for(let i=0;i<line.length;i++){
   const c=line[i];if(quote){if(c==='\\')i++;else if(c===quote)quote='';}
   else if(c==='"'||c==="'")quote=c;else if(c==='/'||c==='#')return line.slice(0,i).trim();
  }return line.trim();
 }
 function stringBytes(value){
  const quote=value[0],out=[];let closed=false;
  const escapes={a:7,b:8,e:27,f:12,n:10,r:13,t:9,v:11,'?':63,'\\':92,'"':34,"'":39};
  for(let i=1;i<value.length;i++){
   const c=value[i];if(c===quote){if(value.slice(i+1).trim())fail('Unexpected text after the closing quote');closed=true;break;}
   if(c!=='\\'){const code=value.codePointAt(i),char=String.fromCodePoint(code);out.push(Buffer.from(char));i+=char.length-1;continue;}
   if(++i>=value.length)fail('Incomplete string escape');
   const e=value[i];if(e==='x'){
    const digits=/^[0-9a-f]{1,2}/i.exec(value.slice(i+1))?.[0];if(!digits)fail('Expected hex digits after \\x');out.push(Buffer.from([parseInt(digits,16)]));i+=digits.length;
   }else if(/[0-7]/.test(e)){
    const digits=/^[0-7]{1,3}/.exec(value.slice(i))?.[0],n=parseInt(digits,8);if(n>255)fail('Octal string escape exceeds one byte');out.push(Buffer.from([n]));i+=digits.length-1;
   }else if(Object.hasOwn(escapes,e))out.push(Buffer.from([escapes[e]]));else fail('Unknown string escape \\'+e);
  }
  if(!closed)fail('Unterminated string');
  // IPSwitch strings include the terminating NUL.
  return Buffer.concat([...out,Buffer.from([0])]);
 }
 for(const raw of text.split(/\r\n|\n|\r/)){
  lineNumber++;const line=strip(raw);if(!line)continue;
  if(/^@stop\s*$/i.test(line))break;
  const id=/^@nsobid-((?:[0-9a-f]{2}){1,32})\s*$/i.exec(line);
  if(id){const next=id[1].toLowerCase().padEnd(64,'0');if(buildId&&buildId!==next)fail('Multiple different NSO Build IDs in one patch text');buildId=next;continue;}
  if(/^@enabled\s*$/i.test(line)){enabled=true;continue;}
  if(/^@disabled\s*$/i.test(line)){enabled=false;continue;}
  const flag=/^@flag\s+(\w+)(?:\s+(.+))?$/i.exec(line);
  if(flag){
   if(flag[1].toLowerCase()==='print_values'&&!flag[2])continue;
   if(flag[1].toLowerCase()==='offset_shift'&&/^[+-]?(?:0x[0-9a-f]+|\d+)$/i.test(flag[2]||'')){
    let s=flag[2],sign=1n;if(s[0]==='-'||s[0]==='+'){if(s[0]==='-')sign=-1n;s=s.slice(1);}shift=sign*BigInt(s);continue;
   }
   fail('Unsupported or invalid IPSwitch flag: '+line);
  }
  // Old IPSwitch endian directives are retained for byte-stream compatibility.
  if(/^@(little|big)(?:[ _-]?endian)?\s*$/i.test(line))continue;
  if(line[0]==='@')fail('Unknown IPSwitch directive: '+line);
  if(!enabled)continue;
  const row=/^([0-9a-f]{1,8})\s+(.+)$/i.exec(line);if(!row)fail('Expected a hexadecimal offset and byte data or a quoted string');
  const offset=BigInt('0x'+row[1])+shift;if(offset<0n||offset>0xffffffffn)fail('Shifted patch offset is outside the IPS32 address range');
  let data;
  if(row[2][0]==='"'||row[2][0]==="'")data=stringBytes(row[2]);
  else{const hex=row[2].replace(/\s/g,'');if(!/^(?:[0-9a-f]{2})+$/i.test(hex))fail('Patch data must contain complete hexadecimal bytes');data=Buffer.from(hex,'hex');}
  if(offset+BigInt(data.length)>0x100000000n)fail('Patch data exceeds the IPS32 address range');
  records.push({offset:Number(offset),data});
 }
 if(!buildId)fail('Missing @nsobid-<NSO_BUILD_ID>; ELF-to-NSO patch texts need to be exported as an NSO first');
 const chunks=[Buffer.from('IPS32')];let emitted=0;
 for(const record of records)for(let at=0;at<record.data.length;){
  let n=Math.min(0xffff,record.data.length-at),offset=record.offset+at;
  // A record at EEOF is indistinguishable from the IPS32 terminator. Extend
  // the previous record across that address when splitting a long value.
  if(offset===0x45454f46)fail('IPS32 cannot encode a record starting at its EEOF marker');
  if(at+n<record.data.length&&offset+n===0x45454f46)n--;
  const header=Buffer.alloc(6);header.writeUInt32BE(offset);header.writeUInt16BE(n,4);chunks.push(header,record.data.subarray(at,at+n));at+=n;emitted++;
 }
 chunks.push(Buffer.from('EEOF'));const buffer=Buffer.concat(chunks);
 return{buildId,buffer,records:emitted,patchedBytes:records.reduce((n,r)=>n+r.data.length,0)};
}
module.exports={compilePchtxt,decodeText};
