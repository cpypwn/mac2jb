#ifndef NS2_LFS_LAZY_H
#define NS2_LFS_LAZY_H
#include "namespace.h"

struct lfs_shared { void *object,*control; };
struct lfs_lazy_api {
 void *registry;
 uint32_t (*program_info)(void *,struct lfs_shared *,uint64_t);
 void (*release_weak)(void *);
};
uint32_t lfs_program_for_pid(const struct lfs_lazy_api *,uint64_t,uint64_t *);

/* All entries describe files already on SD. No original game data is retained
 * in the activation manifest. The mount owns any metadata built from it. */
struct lfs_lazy_file {
 const char *name;
 struct lfs_source source;
 uint64_t offset,size;
 uint32_t kind,reserved;
};
enum { LAZY_DIRECTORY,LAZY_ROMFS,LAZY_EXEFS,LAZY_STUB,LAZY_ROMFS_IMAGE,LAZY_EXEFS_IMAGE,LAZY_PATCH,LAZY_INLINE_PATCH };
struct lfs_lazy_game {
 uint64_t program_id,count;
 const struct lfs_lazy_file *files;
};
struct lfs_lazy_config {
 struct lfs_lazy_api api;
 void *memory_manager;
 uint32_t (*allocate_block)(void *,void **,uint64_t);
 uint32_t (*free_block)(void *,void *,uint64_t);
 uint32_t (*mount_current)(void *,struct ns_out *);
 uint32_t (*mount_program)(void *,struct ns_out *,uint64_t);
 uint32_t (*mount_data)(void *,struct ns_out *,uint64_t,uint32_t);
 uint64_t count;
 const struct lfs_lazy_game *games;
 uint64_t patch_count;
 const struct lfs_lazy_file *patches;
 uint32_t (*set_log_size)(void *,uint64_t);
 uint64_t log_cursor,log_limit;
 uint32_t log_lock,log_failed;
 uint8_t *log_buffer;
 uint64_t log_buffered;
 uint32_t plan_lock,reserved;
 uint64_t unconfigured_mounts;
 struct lfs_trace_state *trace;
 uint64_t log_dropped;
 uint32_t (*storage_range)(void *,void *,int32_t,int64_t,int64_t);
 uint32_t (*storage_batch)(void *,const struct ns_buffer *,const struct ns_buffer *,const struct ns_buffer *,const struct ns_buffer *,const struct ns_buffer *,const struct ns_buffer *,const struct ns_buffer *,const struct ns_buffer *);
};
_Static_assert(sizeof(struct lfs_lazy_config)==200,"Lazy mount configuration ABI");
_Static_assert(offsetof(struct lfs_lazy_config,trace)==168,"Lazy trace pointer ABI");
_Static_assert(sizeof(struct lfs_lazy_file)==80,"Lazy mod entry ABI");
struct lfs_lazy_config *lfs_lazy_config(void);
struct lfs_arena;
void *lfs_system_allocate(uint64_t);
void lfs_system_free(void *);
void *lfs_arena_allocate(struct lfs_arena **,uint64_t);
void lfs_arena_free(struct lfs_arena *);
void *lfs_lazy_plan_allocate(struct lfs_arena **,uint64_t);
void lfs_lazy_plan_finish(void *,struct lfs_arena *);
void lfs_copy(void *,const void *,uint64_t);
uint64_t lfs_text_length(const char *);
int lfs_text_equal(const char *,const char *);
const struct lfs_lazy_game *lfs_lazy_game(uint64_t);
uint32_t lfs_lazy_attach_storage(void *,uint64_t);
const struct ns_group *lfs_lazy_codefs(void *,struct ns_context *,uint64_t);
void lfs_lazy_log(const char *,uint64_t,uint64_t,uint32_t,const char *);
void lfs_lazy_log_flush(void);
void lfs_lazy_unconfigured(uint64_t,uint64_t);
void lfs_lazy_plan_lock(void);
void lfs_lazy_plan_unlock(void);
uint32_t lfs_lazy_mount_current(void *,struct ns_out *);
uint32_t lfs_lazy_mount_program(void *,struct ns_out *,uint64_t);
uint32_t lfs_lazy_mount_data(void *,struct ns_out *,uint64_t,uint32_t);
void lfs_lazy_owner_retain(const void *);
void lfs_lazy_owner_release(const void *);
uint32_t lfs_lazy_source_read(const void *,struct lfs_source *,uint64_t,void *,uint64_t);
void lfs_lazy_stream_release(void *);
uint32_t lfs_lazy_patch_file(void *,struct lfs_life *,const struct ns_file *,const struct lfs_lazy_game *);
uint32_t lfs_lazy_probe_nso(void *,const struct ns_file *,uint64_t,uint64_t *);
uint64_t lfs_lazy_patch_count(const struct lfs_lazy_game *);
uint32_t lfs_lazy_nso_read(struct lfs_life *,uint64_t *,int64_t,const struct ns_buffer *,int64_t,uint32_t);
uint32_t lfs_lazy_nso_size(struct lfs_life *,uint64_t *);
uint32_t lfs_lazy_directory_size(void *,const struct ns_file *,const struct ns_group *,uint64_t *);
#endif
