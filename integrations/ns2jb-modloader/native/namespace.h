#ifndef NS2_LFS_NAMESPACE_H
#define NS2_LFS_NAMESPACE_H
#include <stdint.h>
#include <stddef.h>
struct ns_out {void **value;};
struct ns_buffer {void *data;uint64_t capacity;};
typedef uint32_t (*ns_open_fn)(void *,struct ns_out *,const char *,uint32_t);
typedef uint32_t (*ns_type_fn)(void *,uint32_t *,const char *);
typedef uint32_t (*ns_read_fn)(void *,uint64_t *,int64_t,const struct ns_buffer *,int64_t,uint32_t);
typedef uint32_t (*ns_size_fn)(void *,uint64_t *);
typedef void (*ns_release_fn)(void *);
struct ns_group {
 uint64_t program_id,main_size;
 uint32_t program_offset,reserved;
 char prefix[160];
 uint8_t npdm_header[128],main_header[256];
};
struct ns_context {
 uint32_t enabled,magic;
 ns_open_fn open_file,open_directory;
 ns_type_fn get_type;
 void *source_fs;
 ns_read_fn read;
 ns_size_fn size;
 ns_release_fn release;
 uint64_t count;
 const struct ns_group *groups;
 uint64_t calls,matched,errors,active;
};
_Static_assert(sizeof(struct ns_group)==568,"group ABI");
_Static_assert(offsetof(struct ns_group,npdm_header)==184,"NPDM ABI");
_Static_assert(offsetof(struct ns_group,main_header)==312,"main ABI");
_Static_assert(sizeof(struct ns_context)==112,"context ABI");
_Static_assert(offsetof(struct ns_context,active)==104,"counter ABI");
uint32_t lfs_namespace_open(void *,struct ns_out *,const char *,uint32_t,struct ns_context *);
uint32_t lfs_namespace_directory(void *,struct ns_out *,const char *,uint32_t,struct ns_context *);
uint32_t lfs_namespace_type(void *,uint32_t *,const char *,struct ns_context *);
#endif
