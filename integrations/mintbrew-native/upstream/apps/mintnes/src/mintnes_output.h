#ifndef MINTNES_OUTPUT_H
#define MINTNES_OUTPUT_H

#include "hbx_sdk.h"
#include <stdint.h>

int mintnes_output_open(const struct hbx_ctx *ctx);
int mintnes_output_submit(const struct hbx_ctx *ctx, const int16_t *stereo,
                          uint32_t frames);
int mintnes_output_pause(const struct hbx_ctx *ctx);
int mintnes_output_close(const struct hbx_ctx *ctx);

#endif
