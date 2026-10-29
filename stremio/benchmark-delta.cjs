#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const zlib=require('node:zlib');
const bc1=require('./bc1.cjs');
const delta=require('../vendor/BlitBun/server/lib/block-delta.cjs');

const frames=12,width=1280,height=720,base=0x20000000;
const round=value=>Number(value.toFixed(2));

function image(index,kind){
  const bytes=Buffer.alloc(width*height*4);
  const left=index*17%width,top=index*5%height;
  let random=(index+1)*0x9e3779b9;
  const next=()=>{random^=random<<13;random^=random>>>17;random^=random<<5;return random&255;};
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const offset=(y*width+x)*4;
    let value=((x*3+y*2)>>3)&255;
    if(kind==='motion'&&x>=left&&x<left+180&&y>=top&&y<top+120)value=230;
    bytes[offset]=kind==='noise'?next():value;
    bytes[offset+1]=kind==='noise'?next():(value+x)&255;
    bytes[offset+2]=kind==='noise'?next():(value+y)&255;
    bytes[offset+3]=255;
  }
  return bytes;
}

function measure(kind){
  let before=Buffer.alloc(width*height/2);
  const result={kind,frames,rawBytes:0,deflateBytes:0,deltaBytes:0,deflateEncodeMs:0,deltaEncodeMs:0};
  for(let index=0;index<frames;index++){
    const current=bc1.encode(image(index,kind),width,height);
    const deflateStart=performance.now();
    const packed=zlib.deflateRawSync(current,{level:1});
    result.deflateEncodeMs+=performance.now()-deflateStart;
    assert.ok(zlib.inflateRawSync(packed).equals(current));
    const deltaStart=performance.now();
    const encoded=delta.encode(current,before,{base,sequence:index+1,keyframe:index===0,level:1,budgetMs:8});
    result.deltaEncodeMs+=performance.now()-deltaStart;
    assert.ok(delta.decode(encoded.packet,before,{base}).equals(current));
    result.rawBytes+=current.length;result.deflateBytes+=packed.length;result.deltaBytes+=encoded.packet.length;
    before=current;
  }
  result.deflateReductionPercent=round(100*(1-result.deflateBytes/result.rawBytes));
  result.deltaReductionPercent=round(100*(1-result.deltaBytes/result.rawBytes));
  result.deflateEncodeMsPerFrame=round(result.deflateEncodeMs/frames);
  result.deltaEncodeMsPerFrame=round(result.deltaEncodeMs/frames);
  delete result.deflateEncodeMs;delete result.deltaEncodeMs;
  return result;
}

console.log(JSON.stringify({scope:'synthetic Mac-side BC1 frames; excludes console inflate, network and GPU presentation',
  results:['motion','noise'].map(measure)},null,2));
