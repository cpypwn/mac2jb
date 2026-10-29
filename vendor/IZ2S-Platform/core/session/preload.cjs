const path=require('node:path');
const cacheRoot=root=>path.join(root,'data/state/module-cache');
async function resolve(root,ids,options={}){
 if(!Array.isArray(ids)||ids.length>15||ids.some(id=>typeof id!=='string'))throw Error('Choose up to 15 available modules');
 if(!ids.length)return [];
 const repo=await require('../packages/repository.cjs').create(root,options),list=await repo.list();
 const selected=[...new Set(ids)].map(id=>{const pkg=list.packages.find(p=>p.id===id||p.file===id);if(!pkg)throw Error('Selected module is no longer available: '+id);if(pkg.supported===false)throw Error('Module incompatible with this host or shell: '+id);return pkg.id;});
 await require('../modules.cjs').verify(root,selected);return selected;
}
async function prepare(root,ids,destination,options={}){
 if(!ids.length)return;
 const repo=await require('../packages/repository.cjs').create(root,options),list=await repo.list();
 for(const id of ids){const pkg=list.packages.find(p=>p.id===id);if(!pkg)throw Error('Selected module is no longer available: '+id);await repo.install(pkg.file,destination);}
 const catalog=await require('../services/app-catalog.cjs').scan(destination);if(catalog.rejected.length)throw Error(catalog.rejected.map(a=>a.error).join('; '));
 await require('../packages/shell-builder.cjs').build(catalog.apps,cacheRoot(root));
}
module.exports={resolve,prepare,cacheRoot};
