#!/usr/bin/env python3
"""Task-owned observation and three fixed local connectivity responses; no forwarding."""
import argparse,datetime,html,importlib.util,json,os,struct,threading
from pathlib import Path
ROOT=Path(__file__).resolve().parent
SOURCE=ROOT / 'switch2-local-browser-entry.py'
spec=importlib.util.spec_from_file_location('original_local_entry',SOURCE)
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
base.HOSTS=base.HOSTS|{'ctest-ipv6.p01.ctest.srv.nintendo.net','api.p01.lp1.tabiji.srv.nintendo.net','topics.p01.lp1.bcat.srv.nintendo.net','dauth.p01.lp1.ndas.srv.nintendo.net'}
LOG_HOSTS=base.HOSTS|{'ctest-dl.p01.lp1.ctest.srv.nintendo.net','ctest-ul.p01.lp1.ctest.srv.nintendo.net','api.p01.lp1.ctest.srv.nintendo.net'}
lock=threading.Lock();context=threading.local()
def profile():
 try:
  p=ROOT/'profile.json'
  if p.stat().st_size>512:return 'redirect'
  m=json.loads(p.read_text()).get('profile')
  return m if m in ('redirect','inline','connectivity_ok','basic_auth') else 'redirect'
 except (OSError,ValueError):return 'redirect'
def event(kind,**fields):
 row={'at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':kind,**fields}
 try:
  with lock:
   p=ROOT/'traffic.jsonl'
   serialized=json.dumps(row)+'\n'
   if (p.stat().st_size if p.exists() else 0)+len(serialized.encode())>2097152:return
   fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
   with os.fdopen(fd,'a') as f:f.write(serialized)
 except OSError:pass
original_dns=base.dns_reply
def observed_dns(packet,address):
 answer=original_dns(packet,address)
 try:
  labels,end=base.read_name(packet,12);name=b'.'.join(labels).decode('ascii')[:253];kind=struct.unpack('!H',packet[end:end+2])[0]
  event('dns',peer=getattr(context,'peer','unknown'),transport=getattr(context,'transport','unknown'),host=name if name in LOG_HOSTS else 'other',qtype=kind,rcode=(struct.unpack('!H',answer[2:4])[0]&15) if answer else None)
 except (ValueError,UnicodeError,struct.error):event('dns_malformed')
 return answer
class UDP(base.UDPHandler):
 def handle(self):
  context.peer=self.client_address[0];context.transport='udp';return super().handle()
class TCP(base.TCPHandler):
 def handle(self):
  context.peer=self.client_address[0];context.transport='tcp';return super().handle()
class Entry(base.EntryHandler):
 def reply(self,status,body=b'',location=None,head=False):
  mode=profile();ua=self.headers.get('User-Agent','')[:256]
  category='nifm' if ('nnNifm' in ua or 'NX NIFM' in ua) else 'browser' if 'Mozilla' in ua else 'other'
  recognized=(status==302 and location==self.server.redirect_url)
  if recognized and mode=='basic_auth' and self.headers.get('Authorization','')!='Basic dGVzdDp0ZXN0':
   data=b'Local test only. Use test / test.\n';self.send_response(401)
   for k,v in [('WWW-Authenticate','Basic realm="Local portal test"'),('Content-Type','text/plain'),('Content-Length',str(len(data))),('Cache-Control','no-store'),('Connection','close')]:self.send_header(k,v)
   self.end_headers()
   if not head:self.wfile.write(data)
   status=401
  elif recognized and mode=='connectivity_ok':
   self.protocol_version='HTTP/1.1'
   if 'ctest' in self.headers.get('Host',''):
       self.send_response(200)
       for k,v in [('Content-Type','text/plain'),('Content-Length','2'),('Cache-Control','max-age=0, no-cache, no-store'),('Pragma','no-cache'),('X-Organization','Nintendo'),('Connection','keep-alive')]: self.send_header(k,v)
       self.end_headers()
       if not head: self.wfile.write(b'ok')
       return
   super().reply(status,body,location,head)
   return
  elif recognized and mode=='inline':
   data=('<!doctype html><meta charset="utf-8"><title>Local portal probe</title><h1>Local captive portal reached</h1><p>Trial: inline HTTP200.</p><a href="'+html.escape(self.server.redirect_url,quote=True)+'">Open prior browser tests</a>').encode()
   self.send_response(200)
   for k,v in [('Content-Type','text/html; charset=utf-8'),('Content-Length',str(len(data))),('Cache-Control','no-store'),('Connection','close'),('Content-Security-Policy',"default-src 'none'; base-uri 'none'")]:self.send_header(k,v)
   self.end_headers()
   if not head:self.wfile.write(data)
   status=200
  else:super().reply(status,body,location,head)
  try:
   parsed=base.urlsplit('http://'+self.headers.get('Host',''));safe_host=(parsed.hostname or '').lower().rstrip('.')
   if parsed.username or parsed.password or safe_host not in base.HOSTS|{self.server.bind_ip}:safe_host='other_or_invalid'
  except ValueError:safe_host='other_or_invalid'
  path_class='root' if self.path=='/' else 'health' if self.path=='/health' else 'other'
  event('http',peer=self.client_address[0],host=safe_host,path_class=path_class,method=self.command,ua_class=category,profile=mode,status=status,recognized_connection_root=recognized)
base.dns_reply=observed_dns;base.UDPHandler=UDP;base.TCPHandler=TCP;base.EntryHandler=Entry
def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--bind',type=base.local_ipv4,required=True)
 parser.add_argument('--dns-port',type=base.port,default=53)
 parser.add_argument('--http-port',type=base.port,default=80)
 parser.add_argument('--probe-port',type=base.port,default=8765)
 a=parser.parse_args()
 if not a.probe_port or a.probe_port==a.http_port:parser.error('Probe needs a separate nonzero port')
 services=[];threads=[]
 try:
  services=base.bind_services(a.bind,a.dns_port,a.http_port,a.probe_port)
  base.drop_sudo_privileges()
  for service in services:
   t=threading.Thread(target=service.serve_forever,kwargs={'poll_interval':.1});t.start();threads.append(t)
  print('Observed local helper ready; UID '+str(os.geteuid())+'; DNS/HTTP '+a.bind+'; profile '+profile(),flush=True)
  print('Bounded local traffic log: '+str(ROOT/'traffic.jsonl')+'; no forwarding or Authorization logging',flush=True)
  while all(t.is_alive() for t in threads):threads[0].join(.5)
 except KeyboardInterrupt:pass
 except (OSError,RuntimeError) as e:print('Could not start observed helper: '+str(e),flush=True);return 1
 finally:
  for service,t in zip(services,threads):
   if t.is_alive():service.shutdown()
  for service in reversed(services):service.server_close()
  for t in threads:t.join()
 return 0
if __name__=='__main__':raise SystemExit(main())
