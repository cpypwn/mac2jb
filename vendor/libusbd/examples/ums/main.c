#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>

#include <libusbd.h>
#include <time.h>
#include <errno.h>
#include <pthread.h>  

#include "utils.h"

#define UMS_IN_MAGIC 0x43425355
#define UMS_RESP_MAGIC 0x53425355

// LUN identifier for our disk
enum UMS_LUN
{
    UMS_LUN_DISK0 = 0,
    UMS_LUN_MAX,
};

typedef enum
{
    HOST2DEV_DEVICE     = 0x00,
    HOST2DEV_INTERFACE  = 0x01,
    HOST2DEV_ENDPOINT   = 0x02,
    DEV2HOST_DEVICE     = 0x80,
    DEV2HOST_INTERFACE  = 0x81,
    DEV2HOST_ENDPOINT   = 0x82,

    // Class-specific
    DEV2HOST_INTERFACE_CLASS  = 0xA1,
    HOST2DEV_INTERFACE_CLASS  = 0x21,
} UsbSetupRequestType;

typedef struct __attribute__((__packed__))
{
    uint32_t magic;
    uint32_t tag;
    uint32_t dataTransferLength;
    uint8_t flags;
    struct
    {
        uint8_t lun : 4;
        uint8_t target : 3;
        uint8_t reserved : 1;
    };
    struct
    {
        uint8_t cdbLen : 5;
        uint8_t reserved2 : 3;
    };
} UmsPacketHeader;

typedef struct __attribute__((__packed__))
{
    uint32_t magic;
    uint32_t tag;
    uint32_t dataResidue;
    uint8_t status;
} UmsResponse;

typedef struct __attribute__((__packed__))
{
    uint8_t opcode;
    uint8_t evpdFlags;
    uint8_t pageCode;
    uint8_t allocLen[2];
    uint8_t control;
} ScsiInquiryRequest;

typedef struct __attribute__((__packed__))
{
    uint8_t devtype;
    uint8_t rmbFlags;
    uint8_t version;
    uint8_t acaFlags;
    uint8_t additionalLen;
    uint8_t sccsFlags;
    uint8_t bQueFlags;
    uint8_t relAdrflags;
    char vendor[8];
    char product[16];
    char rev[4];
    char serial[8];
} ScsiInquiryResponse;

typedef struct __attribute__((__packed__))
{
    uint8_t opcode;
    uint8_t reserved[3];
    uint8_t removalAllowed;
    uint8_t control;
} ScsiPreventAllowRemovalRequest;

typedef struct __attribute__((__packed__))
{
    uint8_t opcode;
    uint8_t dbdFlag;
    struct
    {
        uint8_t pageCode : 6;
        uint8_t pageControl : 2;
    };
    uint8_t subpageCode;
    uint8_t allocLen;
    uint8_t control;
} ScsiModeSenseRequest;

typedef struct __attribute__((__packed__))
{
    uint8_t modeDataLength;
    uint8_t mediumType;
    uint8_t devSpecificParam;
    uint8_t blkDescLen;
    uint8_t data[];
} ScsiModeSenseResponse;

typedef struct __attribute__((__packed__))
{
    struct
    {
        uint8_t pageCode : 6;
        uint8_t spf : 1;
        uint8_t ps : 1;
    };
    uint8_t pageLength;
} ScsiModePageHeader;

typedef struct __attribute__((__packed__))
{
    ScsiModePageHeader hdr;
    struct
    {
        uint8_t rcd : 1;
        uint8_t mf : 1;
        uint8_t wce : 1;
        uint8_t size : 1;
        uint8_t disc : 1;
        uint8_t cap : 1;
        uint8_t abpf : 1;
        uint8_t ic : 1;
    };
    struct
    {
        uint8_t writeRetentionPrio : 4;
        uint8_t demandReadRetentionPrio : 4;
    };
    uint8_t disablePrefetchXferLen[2];
    uint8_t minimumPrefetch[2];
    uint8_t maximumPrefetch[2];
    uint8_t maximumPrefetchCeiling[2];
    struct
    {
        uint8_t vendorSpecific : 5;
        uint8_t dra : 1;
        uint8_t lbcss : 1;
        uint8_t fsw : 1;
    };
    uint8_t numCacheSegments;
    uint8_t cacheSegmentSize[2];
    uint8_t unknown;
    uint8_t nonCacheSegmentSize[3];
} ScsiCachingPage;

typedef struct __attribute__((__packed__))
{
    ScsiModePageHeader hdr;
    struct
    {
        uint8_t logerr : 1;
        uint8_t unk1 : 1;
        uint8_t test : 1;
        uint8_t dexcpt : 1;
        uint8_t ewasc : 1;
        uint8_t ebf : 1;
        uint8_t unk6 : 1;
        uint8_t perf : 1;
    };
    uint8_t mrie;
    uint8_t intervalTimer[4];
    uint8_t reportCount[4];
} ScsiInfoExceptionsControlPage;

typedef struct __attribute__((__packed__))
{
    uint8_t lbaSize[4];
    uint8_t blockSize[4];
} ScsiReadCapacityResponse;

typedef struct __attribute__((__packed__))
{
    uint8_t lbaSize[8];
    uint8_t blockSize[4];
} ScsiReadCapacityResponse16;

typedef struct __attribute__((__packed__))
{
    uint8_t lbaSize[4];
    uint8_t descriptorCode;
    uint8_t blockSize[3];
} ScsiCapacityDescriptor;

typedef struct __attribute__((__packed__))
{
    uint8_t pad[3];
    uint8_t length;
} ScsiCapacityListHeader;

typedef struct __attribute__((__packed__))
{
    ScsiCapacityListHeader hdr;
    ScsiCapacityDescriptor desc;
} ScsiReadFormatCapacitiesResponse_1x;

typedef struct __attribute__((__packed__))
{
    uint8_t opcode;
    uint8_t flags;
    uint8_t lba[4];
    uint8_t groupFlags;
    uint8_t transferLen[2];
    uint8_t control;
} ScsiReadWriteRequest;

typedef struct __attribute__((__packed__))
{
    uint8_t opcode;
    uint8_t flags;
    uint8_t lba[8];
    uint8_t transferLen[4];
    uint8_t control;
} ScsiReadWriteRequest16;

typedef struct __attribute__((__packed__))
{
    uint8_t responseCode;
    uint8_t segmentNum;
    uint8_t senseKey;
    uint8_t info[4];
    uint8_t extLen;
    uint8_t cmdSpecific[4];
    uint8_t extCode;
    uint8_t extQualifier;
    uint8_t fieldReplacableUnitCode;
    uint8_t specific;
    uint16_t fieldPointer;
    uint16_t reserved;
} ScsiRequestSenseResponse;

#define SCSI_RESPONSECODE_INVALID    (BIT(7))
#define SCSI_RESPONSECODE_FORMAT70   (0x70)

// SCSI device types
#define SCSI_DEVTYPE_DISK    (0x00)
#define SCSI_DEVTYPE_INVALID (0x7F)

// SCSI inquiry flags
#define SCSI_INQUIRY_FLAGS_REMOVABLE BIT(7)

// SCSI inquiry version
#define SCSI_INQUIRY_VERSION_SPC4    (0x6)
#define SCSI_INQUIRY_VERSION_SPC3    (0x5)
#define SCSI_INQUIRY_VERSION_SPC2    (0x4)
#define SCSI_INQUIRY_FORMAT_SPC234   (0x2)

// SCSI page codes
#define SCSI_PAGECODE_CACHING           (0x08)
#define SCSI_PAGECODE_INFOEXCEPTCONTROL (0x1C)
#define SCSI_PAGECODE_ALL               (0x3F)

// SCSI page control
#define SCSI_PAGECONTROL_CURRENT   (0)
#define SCSI_PAGECONTROL_CHANGABLE (1)
#define SCSI_PAGECONTROL_DEFAULT   (2)
#define SCSI_PAGECONTROL_SAVED     (3)

// SCSI commands
#define SCSI_TESTREADY              (0x00)
#define SCSI_REQUESTSENSE           (0x03)
#define SCSI_INQUIRY                (0x12)
#define SCSI_MODESENSE              (0x1A)
#define SCSI_STARTSTOP              (0x1B)
#define SCSI_PREVENTALLOWREMOVAL    (0x1E)
#define SCSI_READCAPACITY           (0x25)
#define SCSI_READFORMATCAPACITIES   (0x23)
#define SCSI_READ                   (0x28)
#define SCSI_READ16                 (0x88)
#define SCSI_WRITE                  (0x2A)
#define SCSI_SYNC_CACHE             (0x35)
#define SCSI_READCAPACITY16         (0x9E)
#define SCSI_ATA_PASSTHROUGH        (0x85)

// UMS status returns
#define UMS_STATUS_OK   (0)
#define UMS_STATUS_FAIL (1)

#define SCSI_NO_SENSE                               0
#define SCSI_COMMUNICATION_FAILURE                  0x040800
#define SCSI_INVALID_COMMAND                        0x052000
#define SCSI_INVALID_FIELD_IN_CDB                   0x052400
#define SCSI_LOGICAL_BLOCK_ADDRESS_OUT_OF_RANGE     0x052100
#define SCSI_LOGICAL_UNIT_NOT_SUPPORTED             0x052500
#define SCSI_MEDIUM_NOT_PRESENT                     0x023a00
#define SCSI_MEDIUM_REMOVAL_PREVENTED               0x055302
#define SCSI_NOT_READY_TO_READY_TRANSITION          0x062800
#define SCSI_RESET_OCCURRED                         0x062900
#define SCSI_SAVING_PARAMETERS_NOT_SUPPORTED        0x053900
#define SCSI_UNRECOVERED_READ_ERROR                 0x031100
#define SCSI_WRITE_ERROR                            0x030c02
#define SCSI_WRITE_PROTECTED                        0x072700

// Setup class-specific
#define UMS_SETUPREQ_RESET  (0xFF)
#define UMS_SETUPREQ_MAXLUN (0xFE)

#define UMS_USB_BULKSIZE (0x200)
#define UMS_BLOCKSIZE (0x200)
#define UMS_WRITE_TIMEOUT (50)

#define UMS_BYTES_TO_LBA(bytes) ((u64)((u64)(bytes) / UMS_BLOCKSIZE))
#define UMS_LBA_TO_BYTES(lba)   ((u64)((u64)(lba) * UMS_BLOCKSIZE))

uint8_t ums_status = UMS_STATUS_OK;
uint32_t ums_sense = SCSI_NO_SENSE;
uint32_t ums_residue = 0;

volatile sig_atomic_t stop;

void inthand(int signum) {
    stop = 1;
}

static int msleep(long msec)
{
    struct timespec ts;
    int res;

    if (msec < 0)
    {
        errno = EINVAL;
        return -1;
    }

    ts.tv_sec = msec / 1000;
    ts.tv_nsec = (msec % 1000) * 1000000;

    do {
        res = nanosleep(&ts, &ts);
    } while (res && errno == EINTR);

    pthread_yield_np();

    return res;
}

static uint8_t currentHandledCommand = 0;
static uint32_t currentTag = 0;

libusbd_ctx_t* ums_ctx = NULL;
uint8_t ums_interface = 0;
uint64_t ums_epBulkOut = 0;
uint64_t ums_epBulkIn = 0;
uint8_t ums_readBuf[UMS_BLOCKSIZE];
uint8_t ums_writeBuf[UMS_BLOCKSIZE];

typedef struct ums_lun_info_t
{
    bool valid;
    uint32_t max_lba;
    bool read_only;
    FILE* file;
    //istorage_t* storage;
} ums_lun_info_t;

static ums_lun_info_t g_LUNs[UMS_LUN_MAX];

static ums_lun_info_t* ums_get_lun(int lun)
{
    if (lun >= UMS_LUN_MAX)
        return NULL;

    ums_lun_info_t* luninfo = &g_LUNs[lun];
    if (!luninfo->valid)
        return NULL;

    return luninfo;
}

void ums_send_status(uint32_t tag)
{
    UmsResponse okResp =
    {
        .magic = UMS_RESP_MAGIC,
        .tag = tag,
        .dataResidue = ums_residue,
        .status = ums_status,
    };

    libusbd_ep_write(ums_ctx, ums_interface, ums_epBulkIn, (void*)&okResp, sizeof(okResp), UMS_WRITE_TIMEOUT);
}

static void ums_on_data_recv(void* pkt_data)
{
    int ret = 0;

    UmsPacketHeader* hdr = (UmsPacketHeader*)pkt_data;
    if (hdr->magic != UMS_IN_MAGIC) {
        printf("ums: malformed magic! got %08x, expected %08x\n", hdr->magic, UMS_IN_MAGIC);
        return;
    }

    ums_sense = SCSI_NO_SENSE;
    ums_status = UMS_STATUS_OK;
    ums_residue = hdr->dataTransferLength;
    uint8_t* scsiPacket = (uint8_t*)(&hdr[1]);
    uint8_t scsiCmd = *scsiPacket;

    currentHandledCommand = scsiCmd;
    currentTag = hdr->tag;

    //printf("Got data? %x\n", scsiCmd);
    libusbd_ep_abort(ums_ctx, ums_interface, ums_epBulkOut);

    if (scsiCmd == SCSI_INQUIRY) // inquiry
    {
        ScsiInquiryRequest req;
        uint16_t allocLen = 0;
        memcpy(&req, scsiPacket, sizeof(req));
        allocLen = getbe16(req.allocLen);

        ScsiInquiryResponse resp = {0};
        ums_lun_info_t* luninfo = ums_get_lun(hdr->lun);

        if (luninfo == NULL)
        {
            resp.devtype = SCSI_DEVTYPE_INVALID;
            resp.additionalLen = sizeof(ScsiInquiryResponse) - 4;
        }
        else
        {
            resp.devtype = SCSI_DEVTYPE_DISK,
            resp.rmbFlags = SCSI_INQUIRY_FLAGS_REMOVABLE,
            resp.version = SCSI_INQUIRY_VERSION_SPC2;
            resp.acaFlags = SCSI_INQUIRY_FORMAT_SPC234;
            resp.additionalLen = sizeof(ScsiInquiryResponse) - 4;
            resp.sccsFlags = 0;
            resp.bQueFlags = 0;
            resp.relAdrflags = 0;
            strncpy(resp.vendor,  "libusbd",       sizeof(resp.vendor));
            strncpy(resp.product, "UMS gadget", sizeof(resp.product));
            memcpy(resp.rev,      "1.00",       sizeof(resp.rev));
            strncpy(resp.serial,  "libusbd",    sizeof(resp.serial));
        }

        //printf("%x %x %x\n", allocLen, sizeof(resp), ums_residue);

        size_t transferLen = (allocLen < sizeof(resp) ? allocLen : sizeof(resp));
        ret = libusbd_ep_write(ums_ctx, ums_interface, ums_epBulkIn, &resp, transferLen, UMS_WRITE_TIMEOUT);
        if (ret >= 0)
            ums_residue -= ret;
        //printf("%x\n", ums_residue);

        ums_status = UMS_STATUS_OK;
    }
    else if (scsiCmd == SCSI_REQUESTSENSE)
    {
        ScsiRequestSenseResponse resp = {0};

        resp.responseCode = SCSI_RESPONSECODE_FORMAT70;
        ums_lun_info_t* luninfo = ums_get_lun(hdr->lun);

        if (luninfo == NULL)
        {
            resp.responseCode |= SCSI_RESPONSECODE_INVALID;
            ums_sense = SCSI_LOGICAL_UNIT_NOT_SUPPORTED;
        }

        resp.senseKey = ((ums_sense) >> 16) & 0xFF;
        resp.extLen = 18 - 8;
        resp.extCode = ((ums_sense) >> 8) & 0xFF;
        resp.extQualifier = ((ums_sense) >> 0) & 0xFF;

        

        size_t transferLen = (ums_residue < sizeof(resp) ? ums_residue : sizeof(resp));
        //printf("%x %x %x\n", sizeof(resp), ums_residue, transferLen);
        ret = libusbd_ep_write(ums_ctx, ums_interface, ums_epBulkIn, &resp, transferLen, UMS_WRITE_TIMEOUT);
        if (ret >= 0)
            ums_residue -= ret;
        //printf("%x\n", ums_residue);

        ums_status = UMS_STATUS_OK;
    }
    else if (scsiCmd == SCSI_TESTREADY)
    {
        ums_status = UMS_STATUS_OK;
    }
    else if (scsiCmd == SCSI_PREVENTALLOWREMOVAL)
    {
        ScsiPreventAllowRemovalRequest req;
        memcpy(&req, scsiPacket, sizeof(req));

        ums_status = UMS_STATUS_OK;
    }
    else if (scsiCmd == SCSI_READCAPACITY) // read capacity
    {
        ScsiReadCapacityResponse resp;

        ums_lun_info_t* luninfo = ums_get_lun(hdr->lun);
        if (luninfo == NULL)
            putbe32(resp.lbaSize, 0); // TODO error?
        else
            putbe32(resp.lbaSize, luninfo->max_lba - 1);
        putbe32(resp.blockSize, UMS_BLOCKSIZE);

        size_t transferLen = (ums_residue < sizeof(resp) ? ums_residue : sizeof(resp));
        ret = libusbd_ep_write(ums_ctx, ums_interface, ums_epBulkIn, &resp, transferLen, UMS_WRITE_TIMEOUT);
        if (ret >= 0)
            ums_residue -= ret;

        ums_status = UMS_STATUS_OK;
    }
    else if (scsiCmd == SCSI_READFORMATCAPACITIES) // read format capacities
    {
        ScsiReadFormatCapacitiesResponse_1x resp;
        memset(&resp, 0, sizeof(resp));

        resp.hdr.length = sizeof(ScsiCapacityDescriptor) * 1;

        ums_lun_info_t* luninfo = ums_get_lun(hdr->lun);
        //if (luninfo == NULL) // TODO: error?

        putbe32(resp.desc.lbaSize, luninfo->max_lba);
        putbe16(&resp.desc.blockSize[1], UMS_BLOCKSIZE);
        resp.desc.blockSize[0] = UMS_BLOCKSIZE >> 16; // be24
        resp.desc.descriptorCode = 0b10; // formatted media

        size_t transferLen = (ums_residue < sizeof(resp) ? ums_residue : sizeof(resp));
        ret = libusbd_ep_write(ums_ctx, ums_interface, ums_epBulkIn, &resp, transferLen, UMS_WRITE_TIMEOUT);
        if (ret >= 0)
            ums_residue -= ret;
        //usbd_ep_idle(ums_epBulkIn);
        ums_status = UMS_STATUS_OK;
    }
    else if (scsiCmd == SCSI_MODESENSE) // mode sense
    {
        ScsiModeSenseRequest req;
        memcpy(&req, scsiPacket, sizeof(req));

        ums_lun_info_t* luninfo = ums_get_lun(hdr->lun);
        if (luninfo == NULL)
        {
            ums_sense = SCSI_INVALID_COMMAND;
            ums_status = UMS_STATUS_FAIL;
            goto ums_do_send;
        }

        if (req.pageControl == SCSI_PAGECONTROL_SAVED)
        {
            ums_sense = SCSI_SAVING_PARAMETERS_NOT_SUPPORTED;
            ums_status = UMS_STATUS_FAIL;
            goto ums_do_send;
        }

        size_t packetSize = sizeof(ScsiModeSenseResponse);
        uint8_t outPacket[0x120];

        ScsiModeSenseResponse* resp = (ScsiModeSenseResponse*)&outPacket[0];
        resp->modeDataLength = 3;
        resp->mediumType = 0;
        resp->devSpecificParam = luninfo->read_only ? (1<<7) : 0;
        resp->blkDescLen = 0;

        bool sendAll = (req.pageCode == SCSI_PAGECODE_ALL);
        if (sendAll || req.pageCode == SCSI_PAGECODE_CACHING)
        {
            ScsiCachingPage* page = (ScsiCachingPage*)&outPacket[packetSize];
            packetSize += sizeof(ScsiCachingPage);
            resp->modeDataLength += sizeof(ScsiCachingPage);

            memset(page, 0, sizeof(ScsiCachingPage));

            page->hdr.pageCode = SCSI_PAGECODE_CACHING;
            page->hdr.pageLength = sizeof(ScsiCachingPage) - sizeof(ScsiModePageHeader);
        }
        if (sendAll || req.pageCode == SCSI_PAGECODE_INFOEXCEPTCONTROL)
        {
            ScsiInfoExceptionsControlPage* page = (ScsiInfoExceptionsControlPage*)&outPacket[packetSize];
            packetSize += sizeof(ScsiInfoExceptionsControlPage);
            resp->modeDataLength += sizeof(ScsiInfoExceptionsControlPage);

            memset(page, 0, sizeof(ScsiInfoExceptionsControlPage));

            page->hdr.pageCode = SCSI_PAGECODE_INFOEXCEPTCONTROL;
            page->hdr.pageLength = sizeof(ScsiInfoExceptionsControlPage) - sizeof(ScsiModePageHeader);
        }

        //printf("%x %x\n", packetSize, ums_residue);
        if (packetSize > ums_residue)
            packetSize = ums_residue;
        ret = libusbd_ep_write(ums_ctx, ums_interface, ums_epBulkIn, outPacket, packetSize, UMS_WRITE_TIMEOUT);
        if (ret >= 0)
            ums_residue -= ret;
        
        ums_status = UMS_STATUS_OK;
    }
    else if (scsiCmd == SCSI_READ || scsiCmd == SCSI_READ16)
    {
        uint16_t sectors = 0;
        uint32_t lba = 0;

        if (scsiCmd == SCSI_READ)
        {
            ScsiReadWriteRequest req;
            memcpy(&req, scsiPacket, sizeof(req));
            
            sectors = getbe16(req.transferLen);
            lba = getbe32(req.lba);
            
            //sectors = sectors & 0xFFFF;
            //lba &= 0xFFFFFFFF;
        }
        else if (scsiCmd == SCSI_READ16)
        {
            ScsiReadWriteRequest16 req;
            memcpy(&req, scsiPacket, sizeof(req));
            
            sectors = getbe32(req.transferLen);
            lba = getbe64(req.lba);
            
            //printf("read 16 %016lx %08x\n", lba, sectors);
        }

        ums_lun_info_t* luninfo = ums_get_lun(hdr->lun);
        if (luninfo == NULL)
        {
            ums_sense = SCSI_INVALID_COMMAND;
            ums_status = UMS_STATUS_FAIL;
            goto ums_do_send;
        }

        if (lba >= luninfo->max_lba)
        {
            ums_sense = SCSI_LOGICAL_BLOCK_ADDRESS_OUT_OF_RANGE;
            ums_status = UMS_STATUS_FAIL;
            goto ums_do_send;
        }


        u64 actual_sectors = sectors;
        if (lba+actual_sectors > luninfo->max_lba)
        {
            actual_sectors = luninfo->max_lba - lba;
        }

        fseeko(luninfo->file, UMS_LBA_TO_BYTES(lba), SEEK_SET);
        

        printf("file read %i (LUN %i) %x %llx %x\n", ret, hdr->lun, lba, actual_sectors, sectors);

        void* buf;
        libusbd_ep_get_buffer(ums_ctx, ums_interface, ums_epBulkIn, &buf);
        for (int i = 0; i < actual_sectors; i++)
        {
            int ret = fread(buf, 1, UMS_BLOCKSIZE, luninfo->file);
            if (ret != UMS_BLOCKSIZE)
            {
                printf("file read failed! %i (LUN %i)\n", ret, hdr->lun);
                //ums_sense = SCSI_UNRECOVERED_READ_ERROR;
                //ums_status = UMS_STATUS_FAIL;
                //goto ums_do_send;
            }

            ret = libusbd_ep_write(ums_ctx, ums_interface, ums_epBulkIn, buf, UMS_BLOCKSIZE, UMS_WRITE_TIMEOUT);
            //printf("write ret %i, %i\n", ret, i);
            if (ret >= 0)
                ums_residue -= ret;
            else
                break;
        }

#if 0
        for (int i = 0; i < actual_sectors; i++)
        {
            void* buf = (void*)((intptr_t)f_readbuf + (i * UMS_BLOCKSIZE));
            ret = libusbd_ep_write(ums_ctx, ums_interface, ums_epBulkIn, buf, UMS_BLOCKSIZE, UMS_WRITE_TIMEOUT);
            //printf("write ret %i, %i\n", ret, i);
            if (ret >= 0)
                ums_residue -= ret;
        }
#endif

        if (actual_sectors != sectors)
        {
            printf("UMS read - tried to read invalid sector!\n");
            ums_sense = SCSI_LOGICAL_BLOCK_ADDRESS_OUT_OF_RANGE;
            ums_status = UMS_STATUS_FAIL;
            goto ums_do_send;
        }

    }
    else if (scsiCmd == SCSI_WRITE)
    {
        ScsiReadWriteRequest req;
        memcpy(&req, scsiPacket, sizeof(req));

        ums_lun_info_t* luninfo = ums_get_lun(hdr->lun);

        uint16_t sectors = getbe16(req.transferLen);
        uint32_t lba = getbe32(req.lba);

        // Don't write beyond actual bounds
        uint32_t actual_sectors = sectors;
        if (lba+actual_sectors > luninfo->max_lba)
        {
            actual_sectors = luninfo->max_lba - lba;
        }

        // Allow blocking write requests Just In Case
        if (luninfo == NULL || luninfo->read_only)
        {
            //usbd_ep_idle(ums_epBulkIn);
            //libusbd_ep_read(ums_ctx, ums_interface, ums_epBulkOut, NULL, 0, -1);
            libusbd_ep_stall(ums_ctx, ums_interface, ums_epBulkOut);

            //ums_residue -= (actual_sectors * UMS_BLOCKSIZE);
            ums_sense = SCSI_INVALID_COMMAND;
            ums_status = UMS_STATUS_FAIL;
            goto ums_do_send;
        }

        if (lba >= luninfo->max_lba)
        {
            ums_sense = SCSI_LOGICAL_BLOCK_ADDRESS_OUT_OF_RANGE;
            ums_status = UMS_STATUS_FAIL;
            goto ums_do_send;
        }
        
        fseeko(luninfo->file, UMS_LBA_TO_BYTES(lba), SEEK_SET);
        printf("file write (LUN %i) %x %x %x\n", hdr->lun, lba, actual_sectors, sectors);

        void* buf;
        libusbd_ep_get_buffer(ums_ctx, ums_interface, ums_epBulkOut, &buf);

        u64 bytes_written = 0;
        for (int i = 0; i < actual_sectors; i++)
        {
            for (int j = 0; j < 50; j++) {
                ret = libusbd_ep_read(ums_ctx, ums_interface, ums_epBulkOut, buf, UMS_BLOCKSIZE, UMS_WRITE_TIMEOUT);
                libusbd_ep_abort(ums_ctx, ums_interface, ums_epBulkOut);
                if (!ret) continue;
                break;
            }
            //printf("UMS write - read ret %i, %i residue %i\n", ret, i, ums_residue);

            if (ret >= 0) {
                ums_residue -= ret;
                bytes_written += ret;

                if (ret != UMS_BLOCKSIZE) {
                    printf("UMS write - incomplete read of %i bytes (%i)\n", ret, i);
                    break;
                }
            }
            else {
                printf("UMS write - errored\n");
                break;
            }

            int fret = fwrite(buf, 1, UMS_BLOCKSIZE, luninfo->file);
            if (fret != UMS_BLOCKSIZE) {
                printf("UMS write - incomplete file write %x\n", fret);
                break;
            }

        }
        

        if (bytes_written != actual_sectors*UMS_BLOCKSIZE) {
            printf("UMS write - bytes written is not expected value\n");
            ums_sense = SCSI_WRITE_ERROR;
            ums_status = UMS_STATUS_FAIL;
            goto ums_do_send;
        }

        if (actual_sectors != sectors)
        {
            printf("UMS write - tried to write invalid sector!\n");
            ums_sense = SCSI_LOGICAL_BLOCK_ADDRESS_OUT_OF_RANGE;
            ums_status = UMS_STATUS_FAIL;
            goto ums_do_send;
        }
    }
    else if (scsiCmd == SCSI_ATA_PASSTHROUGH)
    {
        ums_sense = SCSI_INVALID_COMMAND;
        ums_status = UMS_STATUS_FAIL;
    }
    else
    {
        ums_sense = SCSI_INVALID_COMMAND;
        ums_status = UMS_STATUS_FAIL;
        printf("ums: unhandled SCSI cmd %02x!\n", scsiCmd);
    }

ums_do_send:
    ums_send_status(currentTag);
}

int start_stuff = 0;

int ums_setup_callback(libusbd_setup_callback_info_t* info)
{
    printf("UMS setup callback! %02x %02x\n", info->bmRequestType, info->bRequest);

    if (info->bmRequestType == DEV2HOST_INTERFACE_CLASS)
    {
        if (info->bRequest == UMS_SETUPREQ_MAXLUN) // max LUN
        {
            // Start requesting packets...

            msleep(10);

            start_stuff = 1;

            const uint8_t maxLun = UMS_LUN_MAX - 1;
            memcpy(info->out_data, &maxLun, sizeof(maxLun));
            info->out_len = sizeof(maxLun);

            return 0;
        }
    }
    else if (info->bmRequestType == HOST2DEV_INTERFACE_CLASS)
    {
        if (info->bRequest == UMS_SETUPREQ_RESET) // UMS reset
        {
            // ACK
            // set_stall
            // ack
            return 0;
        }
    }

    return 0;
}

void print_usage()
{
    printf("Usage: example_ums [-w] <path_to_disk.img>\n");
    printf(" -w: Allow writing to image\n");
}

int main(int argc, char *argv[])
{
    int opt;
    bool is_read_only = true;
    while ((opt = getopt(argc, argv, "w")) != -1) {
        switch (opt) {
        case 'w': is_read_only = false; break;
        default:
            print_usage();
            exit(EXIT_FAILURE);
        }
    }

    if (optind >= argc) {
        print_usage();
        exit(EXIT_FAILURE);
    }

    const char* pImgPath = argv[optind];

    signal(SIGINT, inthand);
    ums_lun_info_t* luninfo = &g_LUNs[0];

    luninfo->valid = true;
    luninfo->read_only = is_read_only;
    luninfo->file = fopen(pImgPath, is_read_only ? "rb" : "rb+");

    if (!luninfo->file) {
        printf("Error: File `%s` not found or could not be opened!\n", pImgPath);
        exit(EXIT_FAILURE);
    }

    fseek(luninfo->file, 0L, SEEK_END);
    uint64_t storage_size = ftell(luninfo->file);
    fseek(luninfo->file, 0L, SEEK_SET);

    luninfo->max_lba = storage_size / UMS_BLOCKSIZE;
    if (storage_size & (UMS_BLOCKSIZE-1)) {
        luninfo->max_lba += 1; // If we're not block-aligned, round up
    }
    if (!luninfo->max_lba)
        luninfo->max_lba = 0xFFFFFF;

    printf("Starting UMS with image `%s`, max LBA 0x%x\n", pImgPath, luninfo->max_lba);

    libusbd_init(&ums_ctx);

    libusbd_set_vid(ums_ctx, 0x0781); // Sandisk. Apple's VID shows up an an iPod on macOS.
    libusbd_set_pid(ums_ctx, 0x5599); // Cruzer
    libusbd_set_version(ums_ctx, 0x100);

    libusbd_set_class(ums_ctx, 0);
    libusbd_set_subclass(ums_ctx, 0);
    libusbd_set_protocol(ums_ctx, 0);

    libusbd_set_manufacturer_str(ums_ctx, "Manufacturer");
    libusbd_set_product_str(ums_ctx, "Product");
    libusbd_set_serial_str(ums_ctx, "Serial");

    // Allocate an interface
    libusbd_iface_alloc(ums_ctx, &ums_interface);

    // All of the above is finalized, but the interface still needs building
    libusbd_config_finalize(ums_ctx);

    // Set up the interface and endpoints
    libusbd_iface_set_class(ums_ctx, ums_interface, 8); // USB Mass Storage
    libusbd_iface_set_subclass(ums_ctx, ums_interface, 6); // SCSI
    libusbd_iface_set_protocol(ums_ctx, ums_interface, 80); // Bulk-Only
    libusbd_iface_set_class_cmd_callback(ums_ctx, ums_interface, ums_setup_callback);

    libusbd_iface_add_endpoint(ums_ctx, ums_interface, USB_EPATTR_TTYPE_BULK, USB_EP_DIR_IN, UMS_USB_BULKSIZE, 0, 0, &ums_epBulkIn);
    libusbd_iface_add_endpoint(ums_ctx, ums_interface, USB_EPATTR_TTYPE_BULK, USB_EP_DIR_OUT, UMS_USB_BULKSIZE, 1, 0, &ums_epBulkOut);
    libusbd_iface_finalize(ums_ctx, ums_interface);

    printf("Waiting for enumeration...\n");

    // After each iface is finalized, the device will enumerate and we can send/recv data

    /*while (!start_stuff) {
        msleep(1);
        if (stop) {
            exit(0);
        }
    }*/

    u64 idx2 = 0;
    u64 idx = 0;
    while (!stop)
    {
        uint8_t tmp[0x200];
        int ret = libusbd_ep_read(ums_ctx, ums_interface, ums_epBulkOut, tmp, 0x1F, 10);
        if (ret > 0 && !(ret & 0xF0000000)) {
            //printf("read %x\n", ret);
            ums_on_data_recv(tmp);
        }

        if (ret == LIBUSBD_NOT_ENUMERATED) {
            msleep(100);
        }

        if (idx2 >= 4) {
            char speen[4] = {'/', '-', '\\', '|'};
            printf("%c\r", speen[idx % 4]);
            if (!ret || ret < 0)
                fflush(stdout);
            idx++;
            idx2 = 0;
        }
        idx2++;
    }

    libusbd_free(ums_ctx);
}