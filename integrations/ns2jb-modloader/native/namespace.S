.text
.arch armv8.3-a
.global lfs_namespace_open_entry
.global lfs_namespace_directory_entry
.global lfs_namespace_type_entry
.global lfs_namespace_original_open
.global lfs_namespace_original_directory
.global lfs_namespace_original_type
lfs_namespace_open_entry:
 bti c
 ldr x4, context
 b lfs_namespace_open
lfs_namespace_directory_entry:
 bti c
 ldr x4, context
 b lfs_namespace_directory
lfs_namespace_type_entry:
 bti c
 ldr x3, context
 b lfs_namespace_type
lfs_namespace_original_open:
 bti c
 pacibsp
 sub sp, sp, #0x70
 stp x29, x30, [sp, #0x30]
 str x23, [sp, #0x40]
 b original_open_tail
lfs_namespace_original_directory:
 bti c
 pacibsp
 sub sp, sp, #0x70
 stp x29, x30, [sp, #0x30]
 str x23, [sp, #0x40]
 b original_directory_tail
lfs_namespace_original_type:
 bti c
 pacibsp
 sub sp, sp, #0x60
 stp x29, x30, [sp, #0x30]
 stp x22, x21, [sp, #0x40]
 b original_type_tail
.balign 8
context: .xword namespace_context
