#ifndef _LIBUSBD_PLAT_MACOS_IMPL_PRIV_H
#define _LIBUSBD_PLAT_MACOS_IMPL_PRIV_H

#include <IOKit/IOKitLib.h>

#include "alt_IOUSBDeviceControllerLib.h"

typedef struct libusbd_macos_buffer_t
{
    void* data;
    uint64_t size;
    uint64_t token;
} libusbd_macos_buffer_t;

typedef struct libusbd_macos_ep_t
{
    uint64_t last_transferred;
    uint64_t ep_async_done;
    int32_t last_error;
    uint64_t maxPktSize;

    libusbd_macos_buffer_t buffer;
    IONotificationPortRef notification_port;
    mach_port_t mnotification_port;
} libusbd_macos_ep_t;

typedef struct libusbd_macos_iface_t
{
    char* pName;
    io_service_t service;
    io_connect_t port;
    
    mach_port_t async_port;
    IONotificationPortRef notification_port;
    mach_port_t mnotification_port;
    libusbd_macos_buffer_t setup_buffer;

    libusbd_setup_callback_t setup_callback;
    libusbd_setup_callback_info_t setup_callback_info;
    int class_async_done;

    int is_builtin;

    uint8_t bNumEndpoints;
    libusbd_macos_ep_t aEndpoints[16];
} libusbd_macos_iface_t;

typedef struct libusbd_macos_ctx_t
{
    io_service_t service_usbgadget;
    io_connect_t port_usbgadget;
    int configId;
    uint32_t iface_rand32;

    alt_IOUSBDeviceControllerRef controller;
    alt_IOUSBDeviceDescriptionRef desc;

    IONotificationPortRef notification_port;
    mach_port_t mnotification_port;

    libusbd_macos_iface_t aInterfaces[16];
    
} libusbd_macos_ctx_t;

#endif // _LIBUSBD_PLAT_MACOS_IMPL_PRIV_H