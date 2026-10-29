const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

const root=path.resolve(__dirname,'..');
const prepare=path.join(__dirname,'prepare-mintbrew.cjs');

test('MintBrew restores ftpd-sb in its intended position without staging unreleased apps',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-mintbrew-ftpd-'));
 try{
  const vendor=path.join(directory,'vendor');
  fs.mkdirSync(vendor);
  fs.cpSync(path.join(root,'vendor/MintBrew'),path.join(vendor,'MintBrew'),{recursive:true});
  execFileSync(process.execPath,[prepare,'--prepare',directory],{stdio:'pipe'});
  execFileSync(process.execPath,[prepare,'--check-runtime',directory],{stdio:'pipe'});
  const apps=path.join(vendor,'MintBrew/apps');
  const names=fs.readdirSync(apps);
  assert.ok(names.includes('ftpd-sb'));
  assert.ok(!names.includes('mintnes')&&!names.includes('mintftp'));
  const ftp=JSON.parse(fs.readFileSync(path.join(apps,'ftpd-sb/app.json'),'utf8'));
  assert.equal(ftp.sdk?.ftpPort,5000);
  const catalog=await require('../vendor/MintBrew/homebrew-launcher/app-catalog.cjs').scan(apps);
  assert.deepEqual(catalog.rejected,[]);
  const order=catalog.apps.map(app=>app.id);
  assert.ok(order.indexOf('ouncecake')<order.indexOf('ftpd-sb'));
  assert.ok(order.indexOf('ftpd-sb')<order.indexOf('cpu-gpu-probe'));
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
