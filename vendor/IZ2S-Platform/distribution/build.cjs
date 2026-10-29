#!/usr/bin/env node
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile),root=path.resolve(__dirname,'..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function build(){
  const status=await exec('git',['status','--porcelain','--untracked-files=normal'],{cwd:root});if(status.stdout.trim())throw Error('Commit or discard release changes before building.');
  const commit=(await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim(),version=require('../package.json').version;
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'iz2s-package-'));
  try{
    const source=path.join(temp,'source.tar');await exec('git',['archive','--format=tar','-o',source,commit],{cwd:root});
    const staged=path.join(temp,'iz2s-platform');await fs.mkdir(staged);await exec('tar',['-xf',source,'-C',staged]);
    // Developer executables stay in Git; user guides also ship in the runtime.
    await fs.rm(path.join(staged,'.dockerignore'),{force:true});
    await fs.rm(path.join(staged,'.vscode'),{recursive:true,force:true});
    await fs.rm(path.join(staged,'.release'),{recursive:true,force:true});await fs.rm(path.join(staged,'.github'),{recursive:true,force:true});
    await fs.rm(path.join(staged,'distribution/tests'),{recursive:true,force:true});
    for(const f of ['export.py','workflow.py','Containerfile','container-entry.cjs','container.sh','test-install.sh','verify.cjs','build.cjs','check-docs.py'])await fs.rm(path.join(staged,'distribution',f),{force:true});
    for(const id of require('./profile.json').optionalEngines){const folder=path.join(staged,'engines',id,'upstream');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'README.md'),'Download the original engine from the panel, or copy the complete repository here.\n');}
    const pkgFile=path.join(staged,'package.json'),pkg=JSON.parse(await fs.readFile(pkgFile));pkg.scripts={start:'node start.cjs',preview:'node distribution/preview.cjs',check:'node sdk/check.cjs'};await fs.writeFile(pkgFile,JSON.stringify(pkg,null,2)+'\n');
    await exec('python3',[path.join(__dirname,'check-docs.py'),staged]);
    const publication=await require('../sdk/publish-modules.cjs').publish(staged);if(publication.errors.length)throw Error(JSON.stringify(publication.errors));
    await require('../sdk/pack-agent.cjs').pack(staged);
    const report=await require('../sdk/check.cjs').check(staged);if(!report.valid)throw Error(JSON.stringify(report.errors));
    await fs.writeFile(path.join(staged,'release.json'),JSON.stringify({version,commit,profile:require('./profile.json'),created:new Date().toISOString()},null,2)+'\n');
    const lines=[];async function checks(dir){for(const e of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(dir,e.name);if(e.isDirectory())await checks(f);else lines.push(hash(await fs.readFile(f))+'  '+path.relative(staged,f));}}await checks(staged);await fs.writeFile(path.join(staged,'FILES.sha256'),lines.join('\n')+'\n');
    const output=path.join(root,'dist',`iz2s-platform-${version}-file-exchange.tar.gz`);await fs.mkdir(path.dirname(output),{recursive:true});await exec('tar',['-czf',output,'-C',temp,'iz2s-platform']);await fs.writeFile(output+'.sha256',hash(await fs.readFile(output))+'  '+path.basename(output)+'\n');
    console.log(output+'\n'+(await fs.stat(output)).size+' bytes; source '+commit.slice(0,12));return output;
  }finally{await fs.rm(temp,{recursive:true,force:true});}
}
if(require.main===module)build().catch(e=>{console.error(e.message);process.exitCode=1;});module.exports={build};
