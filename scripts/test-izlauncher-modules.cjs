#!/usr/bin/env node
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validIds,catalog,validate,withDefaults,queue}=require('./izlauncher-modules.cjs');
const {moduleSelection}=require('./gui-izlauncher.cjs');

const packages=[
  {id:'iz-exchange',name:'File Exchange',version:'1.1.1',description:'Files',supported:true,file:'iz-exchange.izm'},
  {id:'blitbun',name:'BlitBun',version:'1.14.4',description:'Streaming',supported:true,file:'blitbun.izm'},
  {id:'vacootube',name:'VacooTube',version:'1.4.1',description:'Video',supported:false,file:'vacootube.izm'}
];
const options={verify:()=>({directory:'/private/izlauncher'}),repository:async()=>({list:async()=>({packages})})};

test('module selection is bounded and rejects duplicate or unsafe ids',()=>{
  assert.equal(validIds([]),true);
  assert.equal(validIds(['iz-exchange','blitbun']),true);
  for(const ids of [['blitbun','blitbun'],['../../other'],['VacooTube'],Array(16).fill('x'),null])
    assert.equal(validIds(ids),false);
  assert.equal(moduleSelection(['/run']),null);
  assert.deepEqual(moduleSelection(['/run','--modules','["blitbun"]']),['blitbun']);
  assert.throws(()=>moduleSelection(['/run','--modules','["blitbun","blitbun"]']),/distinct/);
});

test('explicit and custom modules add to the standard IZlauncher set',()=>{
  assert.deepEqual(withDefaults(['blitbun','custom']),
    ['iz-exchange','blitbun','vacootube','custom']);
  assert.throws(()=>withDefaults(Array.from({length:13},(_,i)=>'custom-'+i)),
    /no more than 15/);
  assert.deepEqual(withDefaults([]),['iz-exchange','blitbun','vacootube']);
});

test('catalog and queue use only compatible modules from the installed repository',async()=>{
  assert.deepEqual(await catalog('/root',options),packages.slice(0,2).map(({id,name,version,description})=>({id,name,version,description})));
  assert.deepEqual(await validate('/root',['blitbun'],options),['blitbun']);
  await assert.rejects(validate('/root',['vacootube'],options),/unavailable/);
  const calls=[];
  assert.deepEqual(await queue('/root','/session/state',['iz-exchange','blitbun'],{
    ...options,jobs:{create:async(...args)=>calls.push(args)}}),['iz-exchange','blitbun']);
  assert.deepEqual(calls.map(([state,pkg,source])=>[state,pkg.id,source]),[
    ['/session/state','iz-exchange','mac2jb'],['/session/state','blitbun','mac2jb']]);
  await assert.rejects(queue('/root','/session/state',['vacootube'],options),/unavailable/);
});
