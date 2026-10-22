#ifndef _LIBUSBD_PRIV_H
#define _LIBUSBD_PRIV_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LIBUSBD_MAX_IFACES    (16)
#define LIBUSBD_MAX_IFACE_EPS (16)

typedef struct libusbd_macos_ctx_t libusbd_macos_ctx_t;
typedef struct libusbd_linux_ctx_t libusbd_linux_ctx_t;

typedef struct libusbd_iface_t {
    uint8_t bClass;
    uint8_t bSubclass;
    uint8_t bProtocol;

    bool finalized;
} libusbd_iface_t;

typedef struct libusbd_ctx_t
{
    union
    {
        void* pPlatCtx;
        libusbd_macos_ctx_t* pMacosCtx;
        libusbd_linux_ctx_t* pLinuxCtx;
    };
    uint8_t bNumInterfaces;
    uint16_t vid;
    uint16_t pid;
    uint16_t did;
    uint8_t bClass;
    uint8_t bSubclass;
    uint8_t bProtocol;
    char* pManufacturerStr;
    char* pProductStr;
    char* pSerialStr;
    libusbd_iface_t aInterfaces[16];

    bool finalized;
} libusbd_ctx_t;

#ifdef __cplusplus
}
#endif

#endif // _LIBUSBD_PRIV_H
