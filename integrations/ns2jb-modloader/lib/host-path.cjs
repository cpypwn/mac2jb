'use strict';
const path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {check}=require('./common.cjs');

// Host paths select files on the PC. Console paths are handled separately by
// the SD collector and must never pass through Windows/WSL translation.
function resolveRunDirectory(value){
 check(typeof value==='string'&&value.length&&!value.includes('\0'),'Invalid run directory');
 const windows=/^[a-z]:/i.test(value)||value.startsWith('\\\\');
 if(process.platform!=='win32'&&windows){
  const wsl=process.platform==='linux'&&(process.env.WSL_DISTRO_NAME||process.env.WSL_INTEROP||/microsoft/i.test(os.release()));
  check(wsl,'A Windows run directory was supplied to Linux Node. Use its Linux path, or run the loader in the environment that runs your ns2jb host.');
  check(!/^[a-z]:(?![\\/])/i.test(value),'Use an absolute Windows run directory, including the drive and slash.');
  let converted;
  try{converted=execFileSync('wslpath',['-u',value],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']}).replace(/\r?\n$/,'');}
  catch{throw Error('WSL could not translate the Windows run directory. Supply its Linux path with --run-dir, in the distribution running your ns2jb host.');}
  check(path.posix.isAbsolute(converted)&&!/[\r\n\0]/.test(converted),'WSL returned an invalid Linux run directory');
  return path.resolve(converted);
 }
 return path.resolve(value);
}
module.exports={resolveRunDirectory};
