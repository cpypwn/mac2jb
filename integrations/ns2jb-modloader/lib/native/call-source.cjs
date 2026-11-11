'use strict';
// Built into relocatable templates by tools/build.cjs, never assembled on use.
function callSource(count,publish=false,clearAllocation=false){
 if(!Number.isInteger(count)||count<0||count>6)throw Error('Invalid native argument count');
 if(clearAllocation&&(count!==1||publish))throw Error('Invalid native allocation template');
 return `.text
.arch armv8.3-a
.global _start
_start:
 ldr x9, owner
 cmp x0, x9
 b.ne passthrough
 pacibsp
 stp x29, x30, [sp, #-32]!
 stp x19, x20, [sp, #16]
 mov x19, x0
 ${Array.from({length:count},(_,i)=>'ldr x'+i+', arg'+i).join('\n ')}
 ${clearAllocation?'mov x20, x0':''}
 ${publish?`mov x8, x0
 add x9, x0, x1
1:
 dc cvau, x8
 add x8, x8, #64
 cmp x8, x9
 b.lo 1b
 dsb ish
 mov x8, x0
2:
 ic ivau, x8
 add x8, x8, #64
 cmp x8, x9
 b.lo 2b
 dsb ish
 isb
 mov x0, #0`:`ldr x16, operation
 blr x16`}
 ${clearAllocation?`cbz x0, allocation_done
 mov x9, x0
1:
 cmp x20, #8
 b.lo 2f
 str xzr, [x9], #8
 sub x20, x20, #8
 b 1b
2:
 cbz x20, allocation_done
 strb wzr, [x9], #1
 sub x20, x20, #1
 b 2b
allocation_done:`:''}
 ldr x9, result
 str x0, [x9]
 mov w0, #0x6dfe
 ldp x19, x20, [sp, #16]
 ldp x29, x30, [sp], #32
 retab
passthrough:
 pacibsp
 sub sp, sp, #32
 stp x29, x30, [sp, #16]
 add x29, sp, #16
 b original_tail
.balign 8
owner: .xword 0
operation: .xword 0
result: .xword 0
${Array.from({length:count},(_,i)=>'arg'+i+': .xword 0').join('\n')}
`;
}
module.exports={callSource};
