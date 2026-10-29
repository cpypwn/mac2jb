function moduleCompatibility(
  descriptor,
  {
    shell = process.env.IZ2S_SHELL || process.env.IZ15_SHELL || 'izlauncher',
    shellDescriptor,
    platform = process.platform + '-' + process.arch,
    consoleAbi = 1,
  } = {},
) {
  const reasons = [];
  const moduleShells=new Set([shell]);
  if(shellDescriptor?.id===shell&&shellDescriptor.consoleAbi===consoleAbi)
    for(const id of shellDescriptor.moduleShells||[])moduleShells.add(id);
  if (!descriptor.platforms.includes(platform)) reasons.push('Unsupported host: ' + platform);
  if (
    descriptor.switch &&
    descriptor.requires?.shell &&
    !(
      Array.isArray(descriptor.requires.shell)
        ? descriptor.requires.shell
        : [descriptor.requires.shell]
    ).some(id=>moduleShells.has(id))
  )
    reasons.push('Requires shell: ' + [].concat(descriptor.requires.shell).join(', '));
  if (
    descriptor.switch &&
    (descriptor.switch.abi !== consoleAbi ||
      (descriptor.requires?.consoleAbi && descriptor.requires.consoleAbi !== consoleAbi))
  )
    reasons.push('Console ABI mismatch');
  if (descriptor.requires?.platformApi !== 1) reasons.push('Platform API mismatch');
  return { supported: !reasons.length, reasons };
}
function minimumVersion(actual,requirement){
 if(!requirement)return true;
 const parse=value=>{const m=/^(?:>=)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value||'');if(!m)throw Error('Unsupported module version requirement: '+value);return {numbers:m.slice(1,4).map(Number),pre:m[4]?.split('.')};};
 const a=parse(actual),b=parse(requirement);for(let i=0;i<3;i++){if(a.numbers[i]!==b.numbers[i])return a.numbers[i]>b.numbers[i];}
 if(!a.pre||!b.pre)return !a.pre||!!b.pre;
 for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){
  if(a.pre[i]===b.pre[i])continue;if(a.pre[i]===undefined)return false;if(b.pre[i]===undefined)return true;
  const an=/^\d+$/.test(a.pre[i]),bn=/^\d+$/.test(b.pre[i]);if(an&&bn)return Number(a.pre[i])>Number(b.pre[i]);if(an!==bn)return !an;return a.pre[i]>b.pre[i];
 }
 return true;
}
function dependencyReason(dependency,installed){
 if(!installed)return 'Required module: '+dependency.id;
 return minimumVersion(installed.descriptor.version,dependency.version)?null:'Required module: '+dependency.id+' >= '+dependency.version.replace(/^>=/,'')+' (installed '+installed.descriptor.version+')';
}
module.exports = { moduleCompatibility, minimumVersion, dependencyReason };
