'use strict';
const {check,sha}=require('../common.cjs');
const profile=require('./fs-abi.json');
const logging=new Set([0x1050a0,0x1053d0,0x105410]);
// These are actual hook/call targets, rather than every page between them.
const executable=[0x4b8c0,0x694c0,0x69580,0xedb60,0xedbe0,0xedc60,0xefa00,
 0x103390,0x1036f0,0x1042e0,0x1045b0,0x1048c0,0x104e10,0x104ef0,
 0x1050a0,0x1053d0,0x105410,0x105480,0x105720,0x105800,0x1058f0,0x107490,0x107570,0x107600,
 0x107650,0x1077b0,0x107bc0,0x107cd0,0x11fed0,0x1201b0,0x121400,
 0x215620,0x215800,0x2187d0,0x218870,0x24a7a0,0x24d100,0x24d800];
function validateFsMappings(mappings){
 const unavailable=executable.filter(offset=>!mappings.some(map=>map.offset<=offset&&map.end>=offset+16&&[4,5].includes(map.permissions))),unsupported=unavailable.filter(offset=>!logging.has(offset));
 if(unsupported.length){const error=Error('Required native FS code is not executable: '+unsupported.map(offset=>'FS+0x'+offset.toString(16)).join(', '));error.fsCompatibility={stage:'native-code-mappings',unsupported,mappings};throw error;}
 return{loggingExecutable:!unavailable.length,unavailableLogging:unavailable};
}
function validateFsAbi(bytes){
 check(Buffer.isBuffer(bytes)&&bytes.length>=profile.captureSize,'FS capture is incomplete');
 const changed=profile.ranges.map(range=>({...range,actual:sha(bytes.subarray(range.offset,range.offset+range.size))})).filter(range=>range.actual!==range.sha256),mismatches=changed.filter(range=>!logging.has(range.offset));
 if(mismatches.length){const error=Error('Unsupported FS function layout: '+mismatches.map(range=>range.purpose+' at FS+0x'+range.offset.toString(16)).join(', '));error.fsCompatibility={stage:'native-functions',mismatches};throw error;}
 const padding=profile.padding;
 // Only the gateway and temporary control blocks are written. Unused bytes
 // later in this page may legitimately contain read-only data.
 for(const region of padding.used)check(bytes.subarray(region.offset,region.offset+region.size).every(byte=>byte===0),'FS gateway space is already occupied at FS+0x'+region.offset.toString(16));
 return{profile:2,sha256:sha(bytes),validatedRanges:profile.ranges.length-changed.length,runtimeLoggingCompatible:!changed.length,loggingMismatches:changed};
}
module.exports={validateFsAbi,validateFsMappings,profile};
