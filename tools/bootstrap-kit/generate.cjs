#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {profileById} = require('../../scripts/host-profiles.cjs');
const VERSION = 1;
const BASE_SHA256 = 'dca34ac7977cfd3f7cb657a79da925450472b6527ea83d022a9aa25510b168d5';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function ipv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) ||
      value.split('.').some(x => Number(x)>255)) throw Error('Preset must be a dotted-decimal IPv4 address with octets 0..255.');
  return value.split('.').map(Number);
}
function checksum(bytes) {
  const text=bytes.toString('ascii');
  if (!text.endsWith('\n') || bytes.some(b=>b>126 || b<32 && b!==10)) throw Error('Expected ASCII source with LF line endings.');
  const lines=text.slice(0,-1).split('\n'); let h=0,n=0;
  for(const line of lines){for(const c of line+'\n'){h=(h*257+c.charCodeAt(0))%1000003;n++;}h=(h*257+10)%1000003;}
  return {lines:lines.length,characters:n,checksum:h,
    command:`H=0:N=0:PRGEDIT 0:FOR I=1 TO ${lines.length}:S$=PRGGET$():FOR J=0 TO LEN(S$)-1:H=(H*257+ASC(MID$(S$,J,1))) MOD 1000003:N=N+1:NEXT:H=(H*257+10) MOD 1000003:NEXT:PRINT N,H`};
}
function helpers(address) {
  const octets=address===undefined?null:ipv4(address);
  return `' NS2DK V1: OPTIONAL KURUMUZ HELPERS\n`+
`COMMON DEF DKINFO
 PRINT "NS2DK V1 KURUMUZ / SAVE NS2DK"
 PRINT "START: 5 ARGUMENTS / PORT 39380"
 PRINT "ORIGINAL NS2 MUST REMAIN SAVED"
END
COMMON DEF DKHELP
 PRINT "FAVORITE RUNS INITIALIZATION ONLY"
 PRINT "THEN DIRECT: REMOVE ONCE"
 PRINT "THEN V=DKCONNECT() OR DKSTART(...)"
 PRINT "AFTER FAILURE: RESTART, DO NOT RETRY"
END
COMMON DEF DKSTATUS
 PRINT "PHASE",PHASE,"FD",FD
 PRINT "PHASE 0 DOES NOT PROVE REMOVE RAN"
 PRINT "NO AUTOMATIC RETRY OR RECONNECT"
END
COMMON DEF DKCHECK(P#,A#,B#,C#,D#)
 IF P#<1024 OR P#>65535 OR P#!=FLOOR(P#) THEN RETURN 0
 IF MIN(A#,B#,C#,D#)<0 OR MAX(A#,B#,C#,D#)>255 THEN RETURN 0
 IF A#!=FLOOR(A#) OR B#!=FLOOR(B#) THEN RETURN 0
 IF C#!=FLOOR(C#) OR D#!=FLOOR(D#) THEN RETURN 0
 RETURN 1
END
COMMON DEF DKSTART(P#,A#,B#,C#,D#)
 IF !DKCHECK(P#,A#,B#,C#,D#) THEN
  PRINT "INVALID PORT OR IP":RETURN 0
 ENDIF
 IF PHASE!=0 THEN
  PRINT "ALREADY ATTEMPTED / START DECLINED":RETURN 0
 ENDIF
 RETURN START(P#,A#,B#,C#,D#)
END
`+(octets?`COMMON DEF DKCONNECT()
 RETURN DKSTART(39380,${octets.join(',')})
END
`:'');
}
function scratch(extension) {
  return `VAR PHASE=0,FD=-1,CALLS=0,V,ERRORS=0
V=DKSTART(1023,192,168,50,1):IF V!=0 THEN INC ERRORS
V=DKSTART(65536,192,168,50,1):IF V!=0 THEN INC ERRORS
V=DKSTART(39380.5,192,168,50,1):IF V!=0 THEN INC ERRORS
V=DKSTART(39380,-1,168,50,1):IF V!=0 THEN INC ERRORS
V=DKSTART(39380,192,256,50,1):IF V!=0 THEN INC ERRORS
V=DKSTART(39380,192,168,50.5,1):IF V!=0 THEN INC ERRORS
V=DKSTART(39380,192,168,50,1.5):IF V!=0 THEN INC ERRORS
IF CALLS!=0 OR PHASE!=0 THEN INC ERRORS
PHASE=6:V=DKSTART(39380,192,168,50,1)
IF V!=0 OR CALLS!=0 OR PHASE!=6 THEN INC ERRORS
PHASE=0:V=DKSTART(39380,192,168,50,1)
IF V!=1 OR CALLS!=1 OR PHASE!=0 THEN INC ERRORS
PRINT "DK TEST ERRORS",ERRORS,"CALLS",CALLS
END
COMMON DEF START(P,A,B,C,D)
 CALLS=CALLS+1:RETURN 1
END
`+extension;
}
function generate({profileId='kurumuz',source,address}={}) {
  if(profileId!=='kurumuz') throw Error('Only the pinned kurumuz five-argument bootstrap is supported.');
  const profile=profileById(profileId);
  if(profile.startArgumentCount!==5 || profile.startPort!==39380 || profile.bootstrapSha256!==BASE_SHA256)
    throw Error('Pinned kurumuz profile changed; review the extension before updating it.');
  const bytes=source===undefined?fs.readFileSync(path.resolve(__dirname,'../..',profile.bootstrap)):Buffer.from(source);
  if(sha256(bytes)!==BASE_SHA256) throw Error('Original bootstrap SHA256 mismatch; refusing to extend it.');
  const extension=helpers(address), output=Buffer.concat([bytes,Buffer.from(extension)]);
  const names=[...output.toString().matchAll(/^COMMON DEF ([A-Z0-9_$#]+)[ (\n]/gm)].map(m=>m[1]);
  if(new Set(names).size!==names.length) throw Error('Duplicate COMMON DEF declaration.');
  if(extension.split('\n').some(line=>line.length>96)) throw Error('Extension line exceeds the tested 96-character width.');
  const receipt={format:'mac2jb-bootstrap-kit-v1',version:VERSION,profileId,saveName:'NS2DK',
    baseSha256:sha256(bytes),baseBytes:bytes.length,extensionSha256:sha256(extension),
    outputSha256:sha256(output),startArgumentCount:5,preset:address??null,
    sourceCheck:checksum(output),hardwareValidated:false,
    limitations:['PHASE 0 does not establish whether REMOVE ran.','Appended definitions may affect allocation; hardware validation is required.','No retry, reconnect, persistence or extra privileges.']};
  return {output,extension,receipt,scratch:Buffer.from(scratch(extension))};
}
function main(args) {
  if(args.length!==1 && args.length!==3 || args.length===3 && args[1]!=='--address')
    throw Error('Usage: node tools/bootstrap-kit/generate.cjs OUTPUT_DIRECTORY [--address IPv4]');
  const result=generate({address:args[2]}),directory=path.resolve(args[0]);
  fs.mkdirSync(directory,{recursive:true});
  for(const [name,value] of [['NS2DK.bas',result.output],['NS2DK-manifest.json',JSON.stringify(result.receipt,null,2)+'\n'],['NS2DK-scratch-test.bas',result.scratch]])
    fs.writeFileSync(path.join(directory,name),value,{flag:'wx'});
  console.log(JSON.stringify({directory,...result.receipt},null,2));
}
module.exports={generate,helpers,checksum,ipv4};
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
