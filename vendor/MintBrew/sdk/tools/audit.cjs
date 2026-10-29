// Read-only MOD0 inventory. No discovered function is invoked by this tool.
const fs=require('node:fs/promises'),path=require('node:path');
const {inspectModule}=require('../../homebrew-launcher/inspect.cjs');
function namespace(name){const m=name.match(/^_ZNK?2nn(\d+)/);if(!m)return name.startsWith('vk')?'Vulkan':'C / other';const start=m[0].length;return name.slice(start,start+Number(m[1]));}
function inventory(modules){
 const groups={};
 for(const [module,record]of Object.entries(modules))for(const symbol of record.symbols){
  if(symbol.type!==2)continue;const key=namespace(symbol.name);const row=groups[key]??={sdkDefinitions:0,mainImports:0,mainDefinitions:0};
  if(module==='sdk'&&symbol.section)row.sdkDefinitions++;else if(module==='main')row[symbol.section?'mainDefinitions':'mainImports']++;
 }
 return Object.fromEntries(Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)));
}
async function main(directory){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs'));
 if(!(await rpc.request({command:'status'})).ready)throw Error('Native bridge is not ready');
 const modules={};for(const name of ['main','sdk'])modules[name]=await inspectModule(rpc,rpc.a[name]);
 const report={session:rpc.a.session,created:new Date().toISOString(),groups:inventory(modules),modules};
 const file=path.join(directory,'sdk-audit.json');await fs.writeFile(file,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({file,groups:report.groups},null,2));return report;
}
module.exports={namespace,inventory,main};if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1;});
