const fs=require('node:fs'),path=require('node:path');
function tool(environment,name){
 const local=path.resolve(__dirname,'../tools',name);
 return process.env[environment]||(fs.existsSync(local)?local:name);
}
module.exports={tool};
