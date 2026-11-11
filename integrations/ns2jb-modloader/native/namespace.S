.text
.arch armv8.3-a
.global lfs_context
.global lfs_lazy_config
.global lfs_read_entry
.global lfs_size_entry
.global lfs_namespace_open_entry
.global lfs_namespace_directory_entry
.global lfs_namespace_type_entry
.global lfs_namespace_mount_entry
.global lfs_codefs_original
lfs_context:
 bti c
 ldr x0, resident_context
 ret
lfs_lazy_config:
 bti c
 ldr x0, lazy_context
 ret
lfs_read_entry:
 bti c
 b lfs_read
lfs_size_entry:
 bti c
 b lfs_size
lfs_namespace_open_entry:
 bti c
 ldr x4, namespace_context
 b lfs_namespace_open
lfs_namespace_directory_entry:
 bti c
 ldr x4, namespace_context
 b lfs_namespace_directory
lfs_namespace_type_entry:
 bti c
 ldr x3, namespace_context
 b lfs_namespace_type
lfs_namespace_mount_entry:
 bti c
 b lfs_namespace_mount
lfs_codefs_original:
 bti c
 ldr x0, lfs_codefs_original_address
 ret
.balign 8
resident_context: .xword 0
namespace_context: .xword 0
lazy_context: .xword 0
lfs_codefs_original_address: .xword 0
