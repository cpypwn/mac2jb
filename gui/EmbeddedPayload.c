#include <mach-o/getsect.h>
#include <mach-o/ldsyms.h>
#include <stdint.h>

// The offline runtime archive is part of this executable, not a sibling file.
const uint8_t *mac2jb_payload_bytes(void) {
    unsigned long size = 0;
    return getsectiondata(&_mh_execute_header, "__DATA", "__mac2jb", &size);
}

unsigned long mac2jb_payload_size(void) {
    unsigned long size = 0;
    (void)getsectiondata(&_mh_execute_header, "__DATA", "__mac2jb", &size);
    return size;
}
