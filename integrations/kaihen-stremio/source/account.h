#ifndef STREMIO_ACCOUNT_H
#define STREMIO_ACCOUNT_H

#include <stdint.h>

typedef enum {
    STREMIO_AUTH_IDLE,
    STREMIO_AUTH_WAITING,
    STREMIO_AUTH_SIGNED_IN,
    STREMIO_AUTH_EXPIRED,
    STREMIO_AUTH_FAILED
} StremioAuthState;

typedef struct {
    StremioAuthState state;
    char url[4096];
    char code[257];
    char auth_key[4097];
    char message[160];
    uint64_t deadline_seconds;
    uint64_t next_poll_seconds;
} StremioAccountAuth;

void stremio_account_init(StremioAccountAuth *account);
int stremio_account_start(StremioAccountAuth *account);
int stremio_account_poll(StremioAccountAuth *account);
void stremio_account_cancel(StremioAccountAuth *account);

#endif
