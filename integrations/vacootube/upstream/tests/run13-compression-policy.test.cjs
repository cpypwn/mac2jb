const {test}=require('node:test'),assert=require('node:assert/strict'),{compressionLevelFor}=require('../server/streaming/lib/pc-stream-delta.cjs');
test('Stored-block automatic mode requires fresh, connected SDK Ethernet; dock or address alone is insufficient',()=>{
 const now=Date.now(),state={at:new Date(now).toISOString(),stale:false,mode:'docked',network:{connected:true,type:'ethernet',ip:'10.42.0.20'}};
 assert.equal(compressionLevelFor({state,now}),0);
 for(const altered of [{...state,stale:true},{...state,at:new Date(now-7000).toISOString()},{...state,at:undefined},{...state,network:{...state.network,connected:false}},{...state,network:{...state.network,type:'wifi'}},{...state,network:{...state.network,type:'unknown'}},null])assert.equal(compressionLevelFor({state:altered,now}),1);
 for(const level of [0,1,3,6])assert.equal(compressionLevelFor({state,now,level,explicit:true}),level);
 assert.equal(compressionLevelFor({state,now,level:3}),3);assert.throws(()=>compressionLevelFor({level:2}),/Invalid compression level/);
});
