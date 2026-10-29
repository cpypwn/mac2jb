// Inventory all readable executable mappings, including compatibility libraries.
const fs=require('node:fs/promises'),path=require('node:path');
const {inspectModule}=require('../../homebrew-launcher/inspect.cjs');
const {namespace}=require('./audit.cjs');
async function main(directory){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs'));
 const report={session:rpc.a.session,created:new Date().toISOString(),regions:[],modules:[]};
 for(let address=0;address<2**39;){
  if(report.regions.length>=4096)throw Error('Memory-map limit');const region=await rpc.query(address),next=region.address+region.size;
  if(!Number.isSafeInteger(next)||next<=address||region.address>address)throw Error('Invalid mapping');report.regions.push(region);address=next;
 }
 for(const region of report.regions.filter(r=>r.permissions===5&&!r.ipcReferences)){
  const item={base:region.address,bytes:region.size};report.modules.push(item);
  try{
   const module=await inspectModule(rpc,region.address,0x10000000);Object.assign(item,module);item.namespaces={};
   for(const symbol of module.symbols.filter(s=>s.section&&s.type===2)){const group=namespace(symbol.name);item.namespaces[group]=(item.namespaces[group]||0)+1;}
  }catch(error){item.error=error.message;}
 }
 await fs.writeFile(path.join(directory,'sdk-loaded-audit.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify(report.modules.map(({base,bytes,symbols,namespaces,error})=>({base,bytes,symbols:symbols?.length,namespaces,error})),null,2));return report;
}
module.exports={main};if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1;});
