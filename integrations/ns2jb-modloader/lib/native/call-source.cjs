'use strict';
// Built into relocatable templates by tools/build.cjs, never assembled on use.
function callSource(count){
 if(!Number.isInteger(count)||count<0||count>6)throw Error('Invalid native argument count');
 return `.text
.arch armv8.3-a
.global _start
_start:
 ldr x9, owner
 cmp x0, x9
 b.ne passthrough
 pacibsp
 stp x29, x30, [sp, #-32]!
 str x19, [sp, #16]
 mov x19, x0
 ${Array.from({length:count},(_,i)=>'ldr x'+i+', arg'+i).join('\n ')}
 bl operation
 str x0, [x19, #8]
 mov w0, #0x6dfe
 ldr x19, [sp, #16]
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
${Array.from({length:count},(_,i)=>'arg'+i+': .xword 0').join('\n')}
`;
}
module.exports={callSource};
