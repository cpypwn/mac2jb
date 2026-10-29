import ftplib,io,secrets,argparse
parser=argparse.ArgumentParser(description="Test ftpd-sb using isolated files in save and tmp; deletes its own files afterward.")
parser.add_argument("host");parser.add_argument("--port",type=int,default=5000);parser.add_argument("--write",action="store_true",required=True,help="Allow isolated create/write/rename/delete checks")
args=parser.parse_args()
f=ftplib.FTP();f.connect(args.host,args.port,timeout=40);f.login();print('Connected to console FTP')
print('Root:',f.nlst())
for mount in ['save','tmp']:
 root='/'+mount+'/ftpd-sb-test-'+secrets.token_hex(5)
 f.mkd(root)
 try:
  payload=secrets.token_bytes(70001);name=root+'/upload.bin';f.storbinary('STOR '+name,io.BytesIO(payload));out=io.BytesIO();f.retrbinary('RETR '+name,out.write);assert out.getvalue()==payload
  f.rename(name,root+'/renamed.bin');entries=list(f.mlsd(root));assert any(n=='renamed.bin' and int(a['size'])==len(payload) for n,a in entries)
  tail=secrets.token_bytes(31);f.storbinary('APPE '+root+'/renamed.bin',io.BytesIO(tail));out=io.BytesIO();f.retrbinary('RETR '+root+'/renamed.bin',out.write,rest=32760);assert out.getvalue()==(payload+tail)[32760:]
  f.storbinary('STOR '+root+'/renamed.bin',io.BytesIO(b'replaced'));out=io.BytesIO();f.retrbinary('RETR '+root+'/renamed.bin',out.write);assert out.getvalue()==b'replaced'
  f.delete(root+'/renamed.bin');print(mount+': upload/download SHA-256, rename, MLSD, append, resume, overwrite, delete passed')
 finally:
  try:
   for n in f.nlst(root):
    try:f.delete(root+'/'+n.rsplit('/',1)[-1])
    except ftplib.error_perm:pass
   f.rmd(root)
  except Exception as e:print('Cleanup failed:',e)
try:
 f.mkd('/rom/ftpd-sb-denied');raise AssertionError('ROM write accepted')
except ftplib.error_perm as e:assert str(e).startswith('550')
f.cwd('/rom');print('ROM listing:',len(f.nlst()),'entries; write denied')
f.quit();print('LIVE FTP CHECK PASSED')
