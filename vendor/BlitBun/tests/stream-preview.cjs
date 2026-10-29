const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {thumbnail,WIDTH,HEIGHT}=require('../server/lib/stream-preview.cjs');
test('native thumbnail preserves source bytes and converts BGRA',()=>{
 const bytes=Buffer.alloc(1920*1080*4);for(let i=0;i<bytes.length;i+=4){bytes[i]=7;bytes[i+1]=19;bytes[i+2]=231;bytes[i+3]=255;}
 const before=Buffer.from(bytes),result=thumbnail({w:1920,h:1080,rgba:bytes,bgra:true});
 assert.equal(result.length,WIDTH*HEIGHT*4);assert.deepEqual([...result.subarray(0,4)],[231,19,7,255]);assert.deepEqual(bytes,before);
});
test('thumbnail letterboxes and rejects unavailable/detached frames',()=>{
 const result=thumbnail({w:4,h:4,rgba:Buffer.alloc(64,255)});assert.deepEqual([...result.subarray(0,4)],[0,0,0,255]);assert.equal(result[(90*320+160)*4],255);
 for(const frame of [null,{w:1920,h:1080,rgba:Buffer.alloc(0)},{w:0,h:1,rgba:Buffer.alloc(0)}])assert.equal(thumbnail(frame),null);
});
test('browser preview remains bounded and rate-limited without resizing capture',()=>{
 const html=fs.readFileSync(require.resolve('../server/lib/pc-screen.html'),'utf8');
 assert(!html.includes('id="launch"'));assert(!html.includes("launch:'doom'"));
 const body=html.slice(html.indexOf('const preview='),html.indexOf('async function captureFrame'));
 let now=0,hidden=false,draws=[];
 const display={width:320,height:180,getContext:()=>({fillRect(){},drawImage(...args){draws.push(args);}})};
 const env={$:()=>display,performance:{now:()=>now},document:{get hidden(){return hidden;}}};vm.createContext(env);vm.runInContext(body,env);
 const source={width:1920,height:1080};env.paintPreview(source);now=50;env.paintPreview(source);assert.equal(draws.length,1);now=200;env.paintPreview(source);assert.equal(draws.length,2);assert.deepEqual(draws[0].slice(1),[0,0,320,180]);
 hidden=true;now=400;env.paintPreview(source);assert.equal(draws.length,2);assert.deepEqual(source,{width:1920,height:1080});
 hidden=false;env.paintPreview({videoWidth:1920,videoHeight:1080},{x:0,y:0,w:1920,h:1080},1920,1080);assert.deepEqual(draws.at(-1).slice(1),[0,0,1920,1080,0,0,320,180]);
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
