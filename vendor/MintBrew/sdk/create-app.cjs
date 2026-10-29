const fs=require('node:fs/promises'),path=require('node:path');
async function create(id,name=id){
 if(!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)||typeof name!=='string'||!name.trim()||name.length>64)throw Error('Use a lowercase app-id and a display name of 1..64 characters');
 const root=path.resolve(__dirname,'../apps'),target=path.join(root,id),source=path.join(root,'hello-world');
 await fs.mkdir(target); // Refuse to overwrite an existing app, including symlinks.
 for(const item of ['assets','shaders','assets.py','build.cjs','app.json'])await fs.cp(path.join(source,item),path.join(target,item),{recursive:true,errorOnExist:true,force:false});
 const manifest=JSON.parse(await fs.readFile(path.join(target,'app.json')));manifest.id=id;manifest.name=name;manifest.description='Built with HB SDK';manifest.sdk={version:1,capabilities:[]};
 await fs.writeFile(path.join(target,'app.json'),JSON.stringify(manifest,null,2)+'\n');
 await fs.writeFile(path.join(target,'README.md'),`# ${name}\n\nBuild from the project root:\n\n\`\`\`sh\nnode apps/${id}/build.cjs\n\`\`\`\n\nEdit shaders/app.comp for logic, shaders/app.frag for rendering, and assets.py for text and icon artwork. See ../../sdk/README.md for the complete SDK guide.\n`);
 return target;
}
module.exports={create};if(require.main===module)create(process.argv[2],process.argv[3]).then(p=>console.log('Created '+p+'; run its build.cjs before refreshing the launcher.')).catch(e=>{console.error(e.message);process.exitCode=1;});
