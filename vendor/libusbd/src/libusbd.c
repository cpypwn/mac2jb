#include "libusbd.h"

#include "libusbd_priv.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "plat/macos/impl.h"

int libusbd_init(libusbd_ctx_t** pCtxOut)
{
    if (!pCtxOut) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    *pCtxOut = malloc(sizeof(libusbd_ctx_t));
    memset(*pCtxOut, 0, sizeof(**pCtxOut));

    int ret = libusbd_impl_init(*pCtxOut);
    if (ret < 0) {
        free(*pCtxOut);
        *pCtxOut = NULL;
        return ret;
    }

    return LIBUSBD_SUCCESS;
}

int libusbd_free(libusbd_ctx_t* pCtx)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    libusbd_set_manufacturer_str(pCtx, NULL);
    libusbd_set_product_str(pCtx, NULL);
    libusbd_set_serial_str(pCtx, NULL);

    libusbd_impl_free(pCtx);

    memset(pCtx, 0, sizeof(*pCtx));
    free(pCtx);

    return LIBUSBD_SUCCESS;
}

int libusbd_set_vid(libusbd_ctx_t* pCtx, uint16_t val)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    pCtx->vid = val;
    return LIBUSBD_SUCCESS;
}

int libusbd_set_pid(libusbd_ctx_t* pCtx, uint16_t val)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    pCtx->pid = val;
    return LIBUSBD_SUCCESS;
}

int libusbd_set_version(libusbd_ctx_t* pCtx, uint16_t val)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    pCtx->did = val;
    return LIBUSBD_SUCCESS;
}

int libusbd_set_class(libusbd_ctx_t* pCtx, uint8_t val)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    pCtx->bClass = val;

    return LIBUSBD_SUCCESS;
}

int libusbd_set_subclass(libusbd_ctx_t* pCtx, uint8_t val)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    pCtx->bSubclass = val;

    return LIBUSBD_SUCCESS;
}

int libusbd_set_protocol(libusbd_ctx_t* pCtx, uint8_t val)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    pCtx->bProtocol = val;

    return LIBUSBD_SUCCESS;
}

int libusbd_set_manufacturer_str(libusbd_ctx_t* pCtx, const char* pStr)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (pCtx->pManufacturerStr) {
        free(pCtx->pManufacturerStr);
    }

    if (!pStr)
    {
        pCtx->pManufacturerStr = NULL;
        return LIBUSBD_SUCCESS;
    }

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    pCtx->pManufacturerStr = malloc(strlen(pStr)+1);
    strcpy(pCtx->pManufacturerStr, pStr);
    return LIBUSBD_SUCCESS;
}

int libusbd_set_product_str(libusbd_ctx_t* pCtx, const char* pStr)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (pCtx->pProductStr) {
        free(pCtx->pProductStr);
    }

    if (!pStr)
    {
        pCtx->pProductStr = NULL;
        return LIBUSBD_SUCCESS;
    }

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    pCtx->pProductStr = malloc(strlen(pStr)+1);
    strcpy(pCtx->pProductStr, pStr);
    return LIBUSBD_SUCCESS;
}

int libusbd_set_serial_str(libusbd_ctx_t* pCtx, const char* pStr)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (pCtx->pSerialStr) {
        free(pCtx->pSerialStr);
    }

    if (!pStr)
    {
        pCtx->pSerialStr = NULL;
        return LIBUSBD_SUCCESS;
    }

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    pCtx->pSerialStr = malloc(strlen(pStr)+1);
    strcpy(pCtx->pSerialStr, pStr);
    return LIBUSBD_SUCCESS;
}

int libusbd_config_finalize(libusbd_ctx_t* pCtx)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    int ret = libusbd_impl_config_finalize(pCtx);

    if (!ret) {
        pCtx->finalized = true;
    }

    return ret;
}

int libusbd_iface_alloc_builtin(libusbd_ctx_t* pCtx, const char* name)
{
    int ret;

    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    if (pCtx->bNumInterfaces >= LIBUSBD_MAX_IFACES) {
        return LIBUSBD_RESOURCE_LIMIT_REACHED;
    }

    if ((ret = libusbd_impl_iface_alloc_builtin(pCtx, name)))
        return ret;

    return LIBUSBD_SUCCESS;
}

int libusbd_iface_alloc(libusbd_ctx_t* pCtx, uint8_t* pOut)
{
    int ret;

    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }
    //printf("aaaaaaaaaa %x\n", pCtx->finalized);

    if (pCtx->finalized) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    if (pCtx->bNumInterfaces >= LIBUSBD_MAX_IFACES) {
        return LIBUSBD_RESOURCE_LIMIT_REACHED;
    }

    if ((ret = libusbd_impl_iface_alloc(pCtx)))
        return ret;

    // TODO oob
    if (pOut) {
        *pOut = pCtx->bNumInterfaces++;
    }

    return LIBUSBD_SUCCESS;
}

int libusbd_iface_finalize(libusbd_ctx_t* pCtx, uint8_t iface_num)
{
    if (!pCtx) {
        return LIBUSBD_ALREADY_FINALIZED;
    }

    if (!pCtx->finalized) {
        return LIBUSBD_NONDESCRIPT_ERROR; // TODO specific error for this
    }

    return libusbd_impl_iface_finalize(pCtx, iface_num);
}

int libusbd_iface_standard_desc(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t descType, uint8_t unk, const uint8_t* pDesc, uint64_t descSz)
{
    return libusbd_impl_iface_standard_desc(pCtx, iface_num, descType, unk, pDesc, descSz);
}

int libusbd_iface_nonstandard_desc(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t descType, uint8_t unk, const uint8_t* pDesc, uint64_t descSz)
{
    return libusbd_impl_iface_nonstandard_desc(pCtx, iface_num, descType, unk, pDesc, descSz);
}

int libusbd_iface_add_endpoint(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t type, uint8_t direction, uint32_t maxPktSize, uint8_t interval, uint64_t unk, uint64_t* pEpOut)
{
    return libusbd_impl_iface_add_endpoint(pCtx, iface_num, type, direction, maxPktSize, interval, unk, pEpOut);
}

int libusbd_iface_set_description(libusbd_ctx_t* pCtx, uint8_t iface_num, const char * desc)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (iface_num >= LIBUSBD_MAX_IFACES) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    libusbd_impl_iface_set_description(pCtx, iface_num, desc);

    return LIBUSBD_SUCCESS;
}

int libusbd_iface_set_class(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t val)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (iface_num >= LIBUSBD_MAX_IFACES) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    libusbd_iface_t* pIface = &pCtx->aInterfaces[iface_num];

    pIface->bClass = val;
    libusbd_impl_iface_set_class(pCtx, iface_num, val);

    return LIBUSBD_SUCCESS;
}

int libusbd_iface_set_subclass(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t val)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (iface_num >= LIBUSBD_MAX_IFACES) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    libusbd_iface_t* pIface = &pCtx->aInterfaces[iface_num];

    pIface->bSubclass = val;
    libusbd_impl_iface_set_subclass(pCtx, iface_num, val);

    return LIBUSBD_SUCCESS;
}

int libusbd_iface_set_protocol(libusbd_ctx_t* pCtx, uint8_t iface_num, uint8_t val)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (iface_num >= LIBUSBD_MAX_IFACES) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    libusbd_iface_t* pIface = &pCtx->aInterfaces[iface_num];

    pIface->bProtocol = val;
    libusbd_impl_iface_set_protocol(pCtx, iface_num, val);

    return LIBUSBD_SUCCESS;
}

int libusbd_iface_set_class_cmd_callback(libusbd_ctx_t* pCtx, uint8_t iface_num, libusbd_setup_callback_t func)
{
    if (!pCtx) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    if (iface_num >= LIBUSBD_MAX_IFACES) {
        return LIBUSBD_INVALID_ARGUMENT;
    }

    libusbd_iface_t* pIface = &pCtx->aInterfaces[iface_num];

    libusbd_impl_iface_set_class_cmd_callback(pCtx, iface_num, func);

    return LIBUSBD_SUCCESS;
}

int libusbd_ep_read(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep, void* data, uint32_t len, uint64_t timeoutMs)
{
    return libusbd_impl_ep_read(pCtx, iface_num, ep, data, len, timeoutMs);
}

int libusbd_ep_write(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep, const void* data, uint32_t len, uint64_t timeoutMs)
{
    return libusbd_impl_ep_write(pCtx, iface_num, ep, data, len, timeoutMs);
}

int libusbd_ep_stall(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep)
{
    return libusbd_impl_ep_stall(pCtx, iface_num, ep);
}

int libusbd_ep_abort(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep)
{
    return libusbd_impl_ep_abort(pCtx, iface_num, ep);
}

int libusbd_ep_get_buffer(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep, void** pOut)
{
    return libusbd_impl_ep_get_buffer(pCtx, iface_num, ep, pOut);
}

int libusbd_ep_read_start(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep,uint32_t len, uint64_t timeout_ms)
{
    return libusbd_impl_ep_read_start(pCtx, iface_num, ep, len, timeout_ms);
}

int libusbd_ep_write_start(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep, const void* data, uint32_t len, uint64_t timeout_ms)
{
    return libusbd_impl_ep_write_start(pCtx, iface_num, ep, data, len, timeout_ms);
}

int libusbd_ep_transfer_done(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep)
{
    return libusbd_impl_ep_transfer_done(pCtx, iface_num, ep);
}

int libusbd_ep_transferred_bytes(libusbd_ctx_t* pCtx, uint8_t iface_num, uint64_t ep)
{
    return libusbd_impl_ep_transferred_bytes(pCtx, iface_num, ep);
}