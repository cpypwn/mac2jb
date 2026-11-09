'use strict';
const {check,titleId}=require('./common.cjs');
const {programMatchesApplication}=require('./game-files/content.cjs');
function validateProgramId(applicationId,source,programId){
 const title=titleId(applicationId);
 check(typeof programId==='bigint'||typeof programId==='string'&&/^[0-9]+$/.test(programId),'Missing original NPDM Program ID');
 const id=BigInt(programId);check(id>=0n&&id<=0xffffffffffffffffn,'Invalid NPDM Program ID');
 const runtime=id.toString(16).padStart(16,'0');
 check(source&&typeof source.runtimeProgramId==='string','Missing selected NCA Program ID');
 check(runtime===titleId(source.runtimeProgramId),'Original NPDM Program ID does not match selected NCA Program ID');
 check(programMatchesApplication(title,source,runtime),'Selected CodeFS program does not belong to requested Title ID');
}
module.exports={validateProgramId};
