const fs=require('node:fs/promises'),path=require('node:path'),{deflateSync}=require('node:zlib');
async function build(directory=path.join(__dirname,'../app')){
 directory=path.resolve(directory);await require('../../../sdk/build.cjs').buildApp(directory);const manifest=JSON.parse(await fs.readFile(path.join(directory,'app.json')));manifest.shaderEncoding='deflate';
 for(const [name,stage]of [['vertex','vert'],['fragment','frag'],['compute','comp']]){const file='app.'+stage+'.spv';await fs.writeFile(path.join(directory,file+'.deflate'),deflateSync(await fs.readFile(path.join(directory,file)),{level:9}));manifest.shaders[name]=file+'.deflate';}
 await fs.writeFile(path.join(directory,'app.json'),JSON.stringify(manifest));
}
module.exports={build};if(require.main===module)build(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1;});
