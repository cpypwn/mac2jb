#ifndef NS2_TRACE_H
#define NS2_TRACE_H
#include "lazy.h"
#define LFS_TRACE_PAGE 16384u
#define LFS_TRACE_STATE 49152u
#define LFS_TRACE_PROGRESS_PAGE 4096u
#define LFS_TRACE_DISK (LFS_TRACE_PAGE*2+LFS_TRACE_PROGRESS_PAGE*2)
#define LFS_TRACE_EVENTS 64u
#define LFS_TRACE_PENDING 16u
#define LFS_TRACE_FILES 64u
enum { LFS_T_SOURCE_OPEN=1,LFS_T_SOURCE_READ,LFS_T_STORAGE_READ,LFS_T_STORAGE_SIZE,LFS_T_MOUNT_CURRENT,LFS_T_MOUNT_PROGRAM,LFS_T_MOUNT_DATA,LFS_T_PREPARE,LFS_T_ORIGINAL_READ,LFS_T_SOURCE_LOCK,LFS_T_PLAN_LOCK,
 LFS_T_OBJECT_LOCK,LFS_T_OBJECT_LOCK_HELD,LFS_T_SOURCE_LOCK_HELD,LFS_T_PLAN_LOCK_HELD,LFS_T_OBJECT_RELEASE,LFS_T_SOURCE_CLOSE,LFS_T_SOURCE_RETAIN,LFS_T_SOURCE_NATIVE_OPEN,LFS_T_PROGRAM_LOOKUP,LFS_T_ALLOCATE,LFS_T_FREE,LFS_T_SOURCE_RELEASE,LFS_T_OBJECT_RETAIN,LFS_T_OBJECT_DROP,LFS_T_STORAGE_QUERY,LFS_T_STORAGE_INVALIDATE,LFS_T_STORAGE_BATCH,LFS_T_CODEFS_MOUNT,LFS_T_CODEFS_PREPARE };
struct lfs_trace_record {
 uint64_t sequence,tick,thread,object,offset,requested,actual,duration;
 uint32_t event,operation,file,result;
 uint64_t parent;
 uint8_t sample[32];
 uint32_t sample_size,flags;
};
struct lfs_trace_stats {
 uint32_t file,flags;
 uint64_t reads,bytes,errors,last_offset,last_length,last_tick,index_offset,index_size;
 uint32_t pak_version,reserved;
};
struct lfs_trace_header {
 char magic[8];uint32_t version,size;
 uint64_t generation,tick,frequency,sequence,dropped,completed,errors,bytes;
 uint32_t next_record,pending_count,file_count,status;
 uint64_t checkpoints,write_failures;
 uint32_t checksum,reserved[3];
};
struct lfs_trace_page {
 struct lfs_trace_header h;
 struct lfs_trace_record records[LFS_TRACE_EVENTS],pending[LFS_TRACE_PENDING];
 struct lfs_trace_stats files[LFS_TRACE_FILES];
 struct lfs_trace_record last_completed,first_error,slowest,last_source,last_original,last_prepare,last_wait;
};
enum { LFS_IO_TRACE_WRITE=1,LFS_IO_TRACE_FLUSH,LFS_IO_TEXT_WRITE,LFS_IO_TEXT_FLUSH };
struct lfs_trace_progress {
 char magic[8];uint32_t version,size;
 uint64_t generation,tick,frequency,thread,snapshot_generation,sequence;
 uint32_t operation,phase,result,pending;
 uint64_t offset,length,completed,log_cursor,active;
 uint32_t locks,failed,checksum,reserved;
 struct lfs_trace_record pending_records[LFS_TRACE_PENDING];
 struct lfs_trace_record last_completed,last_source,last_original,last_size;
 uint64_t size_queries;
 uint8_t padding[1392];
};
struct lfs_trace_state {
 const char *path;void *file;uint64_t next_checkpoint;
 uint32_t lock,io_lock;uint64_t writer_thread;
 uint32_t initialized,failed;uint64_t generation;uint64_t reserved,start_tick;
 uint64_t deferred_end[LFS_TRACE_PENDING];
 struct lfs_trace_page live,saved;
 uint32_t progress_lock,progress_failed;
 uint64_t progress_generation,size_queries;
 struct lfs_trace_record last_size;
 struct lfs_trace_progress progress;
 uint64_t plan_lock_trace;
};
_Static_assert(offsetof(struct lfs_trace_progress,checksum)==128,"Trace progress checksum ABI");
_Static_assert(sizeof(struct lfs_trace_progress)==LFS_TRACE_PROGRESS_PAGE,"Trace progress ABI");
_Static_assert(offsetof(struct lfs_trace_state,progress)+sizeof(struct lfs_trace_progress)<=LFS_TRACE_STATE-16,"Trace clock probe scratch ABI");
_Static_assert(sizeof(struct lfs_trace_record)==128,"Trace record ABI");
_Static_assert(sizeof(struct lfs_trace_stats)==80,"Trace file ABI");
_Static_assert(sizeof(struct lfs_trace_header)==128,"Trace header ABI");
_Static_assert(sizeof(struct lfs_trace_page)==LFS_TRACE_PAGE,"Trace page ABI");
_Static_assert(sizeof(struct lfs_trace_state)<=LFS_TRACE_STATE,"Trace allocation ABI");
void lfs_trace_initialize(void);
uint64_t lfs_trace_clock_probe(uint64_t *);
uint32_t lfs_trace_original_read(void *,int64_t,const struct ns_buffer *,int64_t);
uint64_t lfs_trace_begin(uint32_t,void *,uint32_t,uint64_t,uint64_t);
void lfs_trace_end(uint64_t,uint32_t,uint64_t,const void *,uint64_t);
void lfs_trace_checkpoint(int);
void lfs_trace_io_progress(uint32_t,uint32_t,uint64_t,uint64_t,uint32_t);
void lfs_trace_pak(struct lfs_source *,uint64_t,const void *,uint64_t);
#endif
