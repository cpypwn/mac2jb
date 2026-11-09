#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/server';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {pathToFileURL} from 'node:url';
import {createKit} from './kit.mjs';
export function createServer(kit) {
  const server=new McpServer({name:'mac2jb-local',version:'0.1.0'});
  const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  const register=(name,description,inputSchema,action)=>server.registerTool(name,{description,inputSchema,annotations},async args=>{
    try {const result=await action(args);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
    catch(error) {return {isError:true,content:[{type:'text',text:String(error.message).slice(0,2048)}]};}
  });
  register('mac2jb_list_sessions','List bounded local session metadata. Does not establish connection health.',
    z.object({offset:z.number().int().min(0).max(4096).default(0),limit:z.number().int().min(1).max(50).default(20)}),args=>kit.sessions(args));
  register('mac2jb_preflight','Verify configured runtime profile, pinned bootstrap SHA256 and START argument count before transfer.',z.object({}),()=>kit.preflight());
  register('mac2jb_bootstrap_checksum','Generate a read-only SmileBASIC Direct-mode checksum command for slot 0, with expected source length and checksum. Does not send keys.',z.object({}),()=>kit.checksum());
  register('mac2jb_discover_held_sessions','Find verified held RPC sessions using existing bounded loopback probes. Never creates or takes over a session.',z.object({}),()=>kit.discover());
  register('mac2jb_held_status','Verify an exact held RPC run using existing proof, source and live endpoint checks. Run is relative to the configured Sessions root.',
    z.object({run:z.string().min(1).max(1024)}),args=>kit.status(args));
  return server;
}
async function main() {
  const args=process.argv.slice(2);
  if(args.length!==4 || args[0]!=='--runtime-root' || args[2]!=='--sessions-root')
    throw Error('Usage: node server.mjs --runtime-root /canonical/extracted/session --sessions-root /canonical/Sessions');
  const kit=await createKit({runtimeRoot:args[1],sessionsRoot:args[3]});
  await createServer(kit).connect(new StdioServerTransport());
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
