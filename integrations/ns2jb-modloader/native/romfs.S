.text
.arch armv8.3-a
.global _start
.global lfs_size
.global original_size
/* Context owns all data and native server references. No process-local state
 * from SmileBASIC. x18 and used callee-saved registers are preserved. */
_start:
 pacibsp
 stp x29, x30, [sp, #-288]!
 stp x19, x20, [sp, #16]
 stp x21, x22, [sp, #32]
 stp x23, x24, [sp, #48]
 stp x25, x26, [sp, #64]
 stp x27, x28, [sp, #80]
 mov x29, sp
 mov x19, x0
 mov x20, x1
 mov x21, x2
 mov x22, x3
 ldr x24, resident_context
 mov x8, #1
 add x9, x24, #96
 ldadd x8, xzr, [x9]
 add x9, x24, #16
 ldadd x8, xzr, [x9]
 ldr w8, [x24, #8]
 cbz w8, original_request
 cbz x22, original_request
 tbnz x20, #63, original_request
 adds x8, x20, x22
 b.cs original_request
 ldr x9, [x21, #8]
 cmp x22, x9
 b.hi original_request
 mov x0, x19
 add x1, sp, #96
 bl original_size
 cbnz w0, original_request
 ldr x26, [sp, #96]
 add x25, x24, #128
 ldr w28, [x24, #12]
 cbz w28, original_request
view_loop:
 ldr x8, [x25]
 cmp x8, x26
 b.ne next_view
 /* Verify the original header, file record and resource prefix. */
 add x8, sp, #128
 mov x9, #80
 stp x8, x9, [sp, #112]
 add x0, x19, #8
 mov x1, #0
 add x2, sp, #112
 mov x3, #80
 bl original_read
 cbnz w0, next_view
 add x8, sp, #128
 add x9, x25, #32
 mov x10, #80
 bl equal_bytes
 cbz w11, next_view
 add x8, sp, #128
 mov x9, #32
 stp x8, x9, [sp, #112]
 add x0, x19, #8
 ldr x1, [x25, #16]
 add x2, sp, #112
 mov x3, #32
 bl original_read
 cbnz w0, next_view
 add x8, sp, #128
 add x9, x25, #112
 mov x10, #32
 bl equal_bytes
 cbz w11, next_view
 add x8, sp, #128
 ldr w9, [x25, #276]
 stp x8, x9, [sp, #112]
 add x0, x19, #8
 ldr x1, [x25, #24]
 add x2, sp, #112
 ldr w3, [x25, #276]
 bl original_read
 cbnz w0, next_view
 add x8, sp, #128
 add x9, x25, #144
 ldr w10, [x25, #276]
 bl equal_bytes
 cbz w11, next_view
 add x8, x20, x22
 ldr x9, [x25, #8]
 cmp x8, x9
 b.hi original_request
 mov x8, #1
 add x9, x24, #24
 ldadd x8, xzr, [x9]
 ldr x23, [x21]
 /* Read the original portion, then clear only a possible virtual tail. */
 cmp x20, x26
 b.hs clear_all
 sub x27, x26, x20
 cmp x27, x22
 csel x27, x27, x22, lo
 add x0, x19, #8
 mov x1, x20
 mov x2, x21
 mov x3, x27
 bl original_read
 cbnz w0, read_error
 cmp x27, x22
 b.eq segments
 add x8, x23, x27
 sub x9, x22, x27
 b clear_loop
clear_all:
 mov x8, x23
 mov x9, x22
clear_loop:
 strb wzr, [x8], #1
 subs x9, x9, #1
 b.ne clear_loop
segments:
 ldr w28, [x25, #272]
 ldr x25, [x25, #280]
 cbz w28, success
segment_loop:
 ldp x8, x9, [x25]
 add x9, x8, x9
 add x10, x20, x22
 cmp x20, x8
 csel x26, x20, x8, hi
 cmp x10, x9
 csel x27, x10, x9, lo
 cmp x27, x26
 b.ls next_segment
 sub x27, x27, x26
 sub x10, x26, x20
 add x10, x23, x10
 stp x10, x27, [sp, #112]
 str xzr, [sp, #104]
 sub x2, x26, x8
 ldr x8, [x25, #16]
 add x2, x2, x8
 ldr x0, [x24, #32]
 add x1, sp, #104
 add x3, sp, #112
 mov x4, x27
 mov x5, #0
 bl source_read
 cbnz w0, read_error
 ldr x8, [sp, #104]
 cmp x8, x27
 b.ne short_read
 mov x8, #1
 add x9, x24, #80
 ldadd x8, xzr, [x9]
next_segment:
 add x25, x25, #32
 subs w28, w28, #1
 b.ne segment_loop
success:
 mov w0, #0
 b finish
next_view:
 add x25, x25, #288
 subs w28, w28, #1
 b.ne view_loop
original_request:
 add x0, x19, #8
 mov x1, x20
 mov x2, x21
 mov x3, x22
 bl original_read
 b finish
short_read:
 mov w0, #0xd401
read_error:
 mov x8, #1
 add x9, x24, #88
 ldadd x8, xzr, [x9]
finish:
 mov x8, #-1
 add x9, x24, #96
 ldadd x8, xzr, [x9]
 ldp x27, x28, [sp, #80]
 ldp x25, x26, [sp, #64]
 ldp x23, x24, [sp, #48]
 ldp x21, x22, [sp, #32]
 ldp x19, x20, [sp, #16]
 ldp x29, x30, [sp], #288
 retab
/* GetSize preserves the native error and only extends a verified RomFS view. */
lfs_size:
 pacibsp
 stp x29, x30, [sp, #-288]!
 stp x19, x20, [sp, #16]
 stp x21, x22, [sp, #32]
 stp x23, x24, [sp, #48]
 stp x25, x26, [sp, #64]
 mov x29, sp
 mov x19, x0
 mov x20, x1
 ldr x24, resident_context
 mov x8, #1
 add x9, x24, #96
 ldadd x8, xzr, [x9]
 bl original_size
 cbnz w0, size_finish
 ldr w8, [x24, #8]
 cbz w8, size_success
 ldr x21, [x20]
 add x25, x24, #128
 ldr w26, [x24, #12]
 cbz w26, size_success
size_loop:
 ldr x8, [x25]
 cmp x8, x21
 b.ne size_next
 add x8, sp, #112
 mov x9, #80
 stp x8, x9, [sp, #96]
 add x0, x19, #8
 mov x1, #0
 add x2, sp, #96
 mov x3, #80
 bl original_read
 cbnz w0, size_next
 add x8, sp, #112
 add x9, x25, #32
 mov x10, #80
 bl equal_bytes
 cbz w11, size_next
 add x8, sp, #112
 mov x9, #32
 stp x8, x9, [sp, #96]
 add x0, x19, #8
 ldr x1, [x25, #16]
 add x2, sp, #96
 mov x3, #32
 bl original_read
 cbnz w0, size_next
 add x8, sp, #112
 add x9, x25, #112
 mov x10, #32
 bl equal_bytes
 cbz w11, size_next
 add x8, sp, #112
 ldr w9, [x25, #276]
 stp x8, x9, [sp, #96]
 add x0, x19, #8
 ldr x1, [x25, #24]
 add x2, sp, #96
 ldr w3, [x25, #276]
 bl original_read
 cbnz w0, size_next
 add x8, sp, #112
 add x9, x25, #144
 ldr w10, [x25, #276]
 bl equal_bytes
 cbz w11, size_next
 ldr x8, [x25, #8]
 str x8, [x20]
 b size_success
size_next:
 add x25, x25, #288
 subs w26, w26, #1
 b.ne size_loop
size_success:
 mov w0, #0
size_finish:
 mov x8, #-1
 add x9, x24, #96
 ldadd x8, xzr, [x9]
 ldp x25, x26, [sp, #64]
 ldp x23, x24, [sp, #48]
 ldp x21, x22, [sp, #32]
 ldp x19, x20, [sp, #16]
 ldp x29, x30, [sp], #288
 retab
/* Replay the single original GetSize instruction before its unmodified body. */
original_size:
 pacibsp
 b original_size_tail
equal_bytes:
 mov w11, #1
compare_loop:
 ldrb w12, [x8], #1
 ldrb w13, [x9], #1
 cmp w12, w13
 b.ne different
 subs x10, x10, #1
 b.ne compare_loop
 ret
different:
 mov w11, #0
 ret
.balign 8
resident_context: .xword LFS_CONTEXT
