const path=require('node:path');
const check=(value,message)=>{if(!value)throw Error(message);};

async function create({rpc,menu,directory,root,app,createRuntime}){
 check(app?.id==='iz-exchange'&&app.manifest?.hostRuntime==='module:iz-exchange/runtime',
  'Unsupported File Exchange runtime');
 const layout=require(path.join(root,'vendor/IZ2S-Platform/modules/iz-exchange/server/layout.cjs'));
 check(layout.OFFSET+layout.BYTES<=menu.controls.bytes,'File Exchange mailbox exceeds MintBrew storage');
 const factory=createRuntime||require(path.join(root,'vendor/IZ2S-Platform/modules/iz-exchange/server/runtime.cjs')).create;
 return factory({rpc,mapped:menu.controls.mapped,directory,app});
}

module.exports={create};
