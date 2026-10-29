'use strict';
const {execFileSync}=require('node:child_process');
const fallbackControllers=Object.freeze(['usb-drd0','usb-drd1','usb-drd3']);
function parseGadgetControllers(text) {
  const found=new Set();let current;
  for(const line of String(text).split('\n')) {
    const node=/^([ |]*)\+-o (\S+)/.exec(line);
    if(!node)continue;
    if(!node[1]) {
      const controller=/^(usb-drd(?:[0-9]|1[0-5]))@/.exec(node[2]);
      current=controller?.[1];
    } else if(current&&node[2]==='gay_bowser_usbgadget') found.add(current);
  }
  return [...found].sort((a,b)=>Number(a.slice(7))-Number(b.slice(7)));
}
function readRegistry() {
  return execFileSync('/usr/sbin/ioreg',['-w0','-p','IOService','-c','AppleARMIODevice','-r','-d','3'],
    {encoding:'utf8',timeout:5000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','ignore']});
}
function gadgetControllers(read=readRegistry) {
  try {
    const found=parseGadgetControllers(read());
    if(found.length)return found;
  } catch {}
  return [...fallbackControllers];
}
function autoControllers(preferred,discover=gadgetControllers) {
  return [...new Set([...(preferred?[preferred]:[]),...discover()])];
}
module.exports={fallbackControllers,parseGadgetControllers,gadgetControllers,autoControllers};
