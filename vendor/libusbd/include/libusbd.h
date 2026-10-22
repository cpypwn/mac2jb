#ifndef _LIBUSBD_H
#define _LIBUSBD_H

#ifdef __cplusplus
extern "C" {
#endif


#include <stdint.h>

// Standard interfaces for `libusbd_iface_alloc_builtin`
//
// These names will alias to common interface functions
// which are implemented using kernel-side drivers.
#define LIBUSBD_STDIF_NCM ("libusbd_std_ncm")

enum libusbd_error
{
    LIBUSBD_SUCCESS = 0,
    LIBUSBD_INVALID_ARGUMENT = -1,
    LIBUSBD_NOT_ENUMERATED = -2,
    LIBUSBD_TIMEOUT = -3,
    LIBUSBD_NOT_IMPLEMENTED = -4,
    LIBUSBD_RESOURCE_LIMIT_REACHED = -5,
    LIBUSBD_ALREADY_FINALIZED = -6,
    LIBUSBD_NONDESCRIPT_ERROR = -1024,
};

// Misc defines
#define USBD_EPNUM_MAX (32)
#define USBD_EPIDX_MAX (16)

#define USBD_CTRL_PKT_MAX (64)

// libusbd_iface_add_endpoint types
#define USB_EPATTR_TTYPE(attr) (attr & 0x3)
#define USB_EPATTR_TTYPE_CTRL (0)
#define USB_EPATTR_TTYPE_ISOC (1)
#define USB_EPATTR_TTYPE_BULK (2)
#define USB_EPATTR_TTYPE_INTR (3)

#define USB_EP_DIR_OUT (0)
#define USB_EP_DIR_IN (1)

//
// bmRequestType
//
#define LIBUSBD_HOST2DEV_DEVICE     (0x00)
#define LIBUSBD_HOST2DEV_INTERFACE  (0x01)
#define LIBUSBD_HOST2DEV_ENDPOINT   (0x02)
#define LIBUSBD_DEV2HOST_DEVICE     (0x80)
#define LIBUSBD_DEV2HOST_INTERFACE  (0x81)
#define LIBUSBD_DEV2HOST_ENDPOINT   (0x82)

// Class-specific
#define LIBUSBD_DEV2HOST_INTERFACE_CLASS  (0xA1)
#define LIBUSBD_HOST2DEV_INTERFACE_CLASS  (0x21)

#define LIBUSBD_HOST2DEV_DIR     (0x00)
#define LIBUSBD_DEV2HOST_DIR     (0x80)

// end bmRequestType

//
// bRequest
//
#define LIBUSBD_GET_STATUS        (0)
#define LIBUSBD_CLEAR_FEATURE     (1)
#define LIBUSBD_SET_FEATURE       (3)
#define LIBUSBD_SET_ADDRESS       (5)
#define LIBUSBD_GET_DESCRIPTOR    (6)
#define LIBUSBD_SET_DESCRIPTOR    (7)
#define LIBUSBD_GET_CONFIGURATION (8)
#define LIBUSBD_SET_CONFIGURATION (9)
#define LIBUSBD_GET_INTERFACE     (10)

// end bRequest

// Plat types
typedef struct libusbd_macos_ctx_t libusbd_macos_ctx_t;

// libusbd internal types
typedef struct libusbd_iface_t libusbd_iface_t;
typedef struct libusbd_ctx_t libusbd_ctx_t;
typedef struct libusbd_setup_callback_info_t libusbd_setup_callback_info_t;

// libusbd public types
typedef int (*libusbd_setup_callback_t)(libusbd_setup_callback_info_t* info);
typedef struct libusbd_setup_callback_info_t
{
    uint8_t bmRequestType;
    uint8_t bRequest;
    uint16_t wValue;
    uint16_t wIndex;
    uint16_t wLength;

    uint64_t out_len;
    void* out_data;
} libusbd_setup_callback_info_t;

int libusbd_init(libusbd_ctx_t** pCtxOut);
int libusbd_free(libusbd_ctx_t* pCtx);

int libusbd_set_vid(libusbd_ctx_t* pCtx, uint16_t val);
int libusbd_set_pid(libusbd_ctx_t* pCtx, uint16_t val);
int libusbd_set_version(libusbd_ctx_t* pCtx, uint16_t val);
int libusbd_set_class(libusbd_ctx_t* pCtx, uint8_t val);
int libusbd_set_subclass(libusbd_ctx_t* pCtx, uint8_t val);
int libusbd_set_protocol(libusbd_ctx_t* pCtx, uint8_t val);
int libusbd_set_manufacturer_str(libusbd_ctx_t* pCtx, const char* pStr);
int libusbd_set_product_str(libusbd_ctx_t* pCtx, const char* pStr);
int libusbd_set_serial_str(libusbd_ctx_t* pCtx, const char* pStr);

int libusbd_config_finalize(libusbd_ctx_t* pCtx);

int libusbd_iface_alloc_builtin(libusbd_ctx_t* pCtx, const char* name);
int libusbd_iface_alloc(libusbd_ctx_t* pCtx, uint8_t* pOut);
int libusbd_iface_finalize(libusbd_ctx_t* pCtx, uint8_t iface_num);
int libusbd_iface_standard_desc(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t descType, uint8_t unk, const uint8_t* pDesc, uint64_t descSz);
int libusbd_iface_nonstandard_desc(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t descType, uint8_t unk, const uint8_t* pDesc, uint64_t descSz);
int libusbd_iface_add_endpoint(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t type, uint8_t direction, uint32_t maxPktSize, uint8_t interval, uint64_t unk, uint64_t* pEpOut);
int libusbd_iface_set_description(libusbd_ctx_t* pCtx, uint8_t iface_num, const char* desc);
int libusbd_iface_set_class(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t val);
int libusbd_iface_set_subclass(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t val);
int libusbd_iface_set_protocol(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t val);
int libusbd_iface_set_class_cmd_callback(libusbd_ctx_t* pCtx, uint8_t iface_num, libusbd_setup_callback_t func);

int libusbd_ep_read(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep, void* data, uint32_t len, uint64_t timeoutMs);
int libusbd_ep_write(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep, const void* data, uint32_t len, uint64_t timeoutMs);
int libusbd_ep_stall(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep);
int libusbd_ep_abort(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep);
int libusbd_ep_get_buffer(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep, void** pOut);
int libusbd_ep_read_start(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep, uint32_t len, uint64_t timeout_ms);
int libusbd_ep_write_start(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep, const void* data, uint32_t len, uint64_t timeout_ms);

int libusbd_ep_transfer_done(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep);
int libusbd_ep_transferred_bytes(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep);

#ifdef __cplusplus
}
#endif


#endif // _LIBUSBD_H