#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>

#include <time.h>
#include <errno.h>  

#include <libusbd.h>

#include "usb_hid_keys.h"
#include "HIDReportData.h"

int msleep(long msec)
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

    return res;
}

const uint8_t JoystickReport[] = {
    HID_RI_USAGE_PAGE(8,1), /* Generic Desktop */
    HID_RI_USAGE(8,5), /* Joystick */
    HID_RI_COLLECTION(8,1), /* Application */
        // Buttons (2 bytes)
        HID_RI_LOGICAL_MINIMUM(8,0),
        HID_RI_LOGICAL_MAXIMUM(8,1),
        HID_RI_PHYSICAL_MINIMUM(8,0),
        HID_RI_PHYSICAL_MAXIMUM(8,1),
        // The Switch will allow us to expand the original HORI descriptors to a full 16 buttons.
        // The Switch will make use of 14 of those buttons.
        HID_RI_REPORT_SIZE(8,1),
        HID_RI_REPORT_COUNT(8,16),
        HID_RI_USAGE_PAGE(8,9),
        HID_RI_USAGE_MINIMUM(8,1),
        HID_RI_USAGE_MAXIMUM(8,16),
        HID_RI_INPUT(8,2),
        // HAT Switch (1 nibble)
        HID_RI_USAGE_PAGE(8,1),
        HID_RI_LOGICAL_MAXIMUM(8,7),
        HID_RI_PHYSICAL_MAXIMUM(16,315),
        HID_RI_REPORT_SIZE(8,4),
        HID_RI_REPORT_COUNT(8,1),
        HID_RI_UNIT(8,20),
        HID_RI_USAGE(8,57),
        HID_RI_INPUT(8,66),
        // There's an additional nibble here that's utilized as part of the Switch Pro Controller.
        // I believe this -might- be separate U/D/L/R bits on the Switch Pro Controller, as they're utilized as four button descriptors on the Switch Pro Controller.
        HID_RI_UNIT(8,0),
        HID_RI_REPORT_COUNT(8,1),
        HID_RI_INPUT(8,1),
        // Joystick (4 bytes)
        HID_RI_LOGICAL_MAXIMUM(16,255),
        HID_RI_PHYSICAL_MAXIMUM(16,255),
        HID_RI_USAGE(8,48),
        HID_RI_USAGE(8,49),
        HID_RI_USAGE(8,50),
        HID_RI_USAGE(8,53),
        HID_RI_REPORT_SIZE(8,8),
        HID_RI_REPORT_COUNT(8,4),
        HID_RI_INPUT(8,2),
        // ??? Vendor Specific (1 byte)
        // This byte requires additional investigation.
        HID_RI_USAGE_PAGE(16,65280),
        HID_RI_USAGE(8,32),
        HID_RI_REPORT_COUNT(8,1),
        HID_RI_INPUT(8,2),
        // Output (8 bytes)
        // Original observation of this suggests it to be a mirror of the inputs that we sent.
        // The Switch requires us to have these descriptors available.
        HID_RI_USAGE(16,9761),
        HID_RI_REPORT_COUNT(8,8),
        HID_RI_OUTPUT(8,2),
    HID_RI_END_COLLECTION(0),
};

typedef struct {
    uint16_t Button; // 16 buttons; see JoystickButtons_t for bit mapping
    uint8_t  HAT;    // HAT switch; one nibble w/ unused nibble
    uint8_t  LX;     // Left  Stick X
    uint8_t  LY;     // Left  Stick Y
    uint8_t  RX;     // Right Stick X
    uint8_t  RY;     // Right Stick Y
    uint8_t  VendorSpec;
} USB_JoystickReport_Input_t;

// The output is structured as a mirror of the input.
// This is based on initial observations of the Pokken Controller.
typedef struct {
    uint16_t Button; // 16 buttons; see JoystickButtons_t for bit mapping
    uint8_t  HAT;    // HAT switch; one nibble w/ unused nibble
    uint8_t  LX;     // Left  Stick X
    uint8_t  LY;     // Left  Stick Y
    uint8_t  RX;     // Right Stick X
    uint8_t  RY;     // Right Stick Y
} USB_JoystickReport_Output_t;

typedef enum {
    SWITCH_Y       = 0x01,
    SWITCH_B       = 0x02,
    SWITCH_A       = 0x04,
    SWITCH_X       = 0x08,
    SWITCH_L       = 0x10,
    SWITCH_R       = 0x20,
    SWITCH_ZL      = 0x40,
    SWITCH_ZR      = 0x80,
    SWITCH_MINUS   = 0x100,
    SWITCH_PLUS    = 0x200,
    SWITCH_LCLICK  = 0x400,
    SWITCH_RCLICK  = 0x800,
    SWITCH_HOME    = 0x1000,
    SWITCH_CAPTURE = 0x2000,
} JoystickButtons_t;

#define HAT_TOP          0x00
#define HAT_TOP_RIGHT    0x01
#define HAT_RIGHT        0x02
#define HAT_BOTTOM_RIGHT 0x03
#define HAT_BOTTOM       0x04
#define HAT_BOTTOM_LEFT  0x05
#define HAT_LEFT         0x06
#define HAT_TOP_LEFT     0x07
#define HAT_CENTER       0x08

#define STICK_MIN      0
#define STICK_CENTER 128
#define STICK_MAX    255

volatile sig_atomic_t stop;

void inthand(int signum) {
    stop = 1;
}

int main()
{
    libusbd_ctx_t* pCtx;

    signal(SIGINT, inthand);

    libusbd_init(&pCtx);

    libusbd_set_vid(pCtx, 0x0f0d);
    libusbd_set_pid(pCtx, 0x0092);
    libusbd_set_version(pCtx, 0x0100);

    libusbd_set_class(pCtx, 0);
    libusbd_set_subclass(pCtx, 0);
    libusbd_set_protocol(pCtx, 0);

    libusbd_set_manufacturer_str(pCtx, "HORI CO.,LTD.");
    libusbd_set_product_str(pCtx, "POKKEN CONTROLLER");
    libusbd_set_serial_str(pCtx, "");

    uint8_t iface_num = 0;
    uint64_t ep_out;
    uint64_t ep_in;
    libusbd_iface_alloc(pCtx, &iface_num);
    libusbd_config_finalize(pCtx);

    libusbd_iface_set_class(pCtx, iface_num, 3);
    libusbd_iface_set_subclass(pCtx, iface_num, 0);
    libusbd_iface_set_protocol(pCtx, iface_num, 0);

    uint8_t hid_desc[] = {0x09, 0x21, 0x11, 0x01, 0x00, 0x01, 0x22, 0x5A, 0x00};

    libusbd_iface_standard_desc(pCtx, iface_num, 0x21, 0xF, hid_desc, sizeof(hid_desc));
    libusbd_iface_nonstandard_desc(pCtx, iface_num, 0x22, 0xF, JoystickReport, sizeof(JoystickReport));
    libusbd_iface_add_endpoint(pCtx, iface_num, USB_EPATTR_TTYPE_INTR, USB_EP_DIR_IN, 64, 5, 0, &ep_out);
    //libusbd_iface_add_endpoint(pCtx, iface_num, USB_EPATTR_TTYPE_INTR, USB_EP_DIR_OUT, 64, 5, 0, &ep_in);
    libusbd_iface_finalize(pCtx, iface_num);

    int enum_waits = 0;
    int idx = 0;
    uint8_t type_stuff[] = {KEY_M, KEY_Y, KEY_SPACE, KEY_L, KEY_A, KEY_P, KEY_T, KEY_O, KEY_P, KEY_SPACE, KEY_I, KEY_S, KEY_SPACE, KEY_A, KEY_SPACE, KEY_K, KEY_E, KEY_Y, KEY_B, KEY_O, KEY_A, KEY_R, KEY_D, KEY_DOT, KEY_SPACE};


    while (!stop)
    {
        int32_t s_ret;
        uint8_t test_send[8] = {0x0, 0x0, type_stuff[idx], 0x0, 0x0, 0x0, 0x0, 0x0};
        uint8_t test_send_2[8] = {0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0};

        uint8_t read_buf[64];

#if 0
        // 0xE0000001 = Device not enumerated
        // 0xE00002D6 = Send timed out
        s_ret = libusbd_ep_read(pCtx, iface_num, ep_in, read_buf, sizeof(read_buf), 100);
        printf("read s_ret %x\n", s_ret);
        if (s_ret == LIBUSBD_NOT_ENUMERATED) {
            printf("Waiting for device enumeration...\n");

            if (enum_waits++ > 5) {
                // Force the device to re-enumerate
                //IOUSBDeviceControllerGoOffAndOnBus(controller, 1000);

                enum_waits = 0;
            }

            sleep(1);
            continue;
        }
        else if (s_ret == LIBUSBD_TIMEOUT) {
            printf("Write timed out.\n");
            sleep(1);
            continue;
        }
        else if (s_ret < 0)
        {
            printf("Unknown error.\n");
            sleep(1);
        }
#endif

        USB_JoystickReport_Input_t out;
        memset(&out, 0, sizeof(out));
        out.Button |= (idx & 1) ? SWITCH_A : SWITCH_B;
        out.HAT = HAT_CENTER;
        out.LX = STICK_CENTER;
        out.LY = STICK_CENTER;
        out.RX = STICK_CENTER;
        out.RY = STICK_CENTER;

        // 0xE0000001 = Device not enumerated
        // 0xE00002D6 = Send timed out
        s_ret = libusbd_ep_write(pCtx, iface_num, ep_out, &out, sizeof(out), 16);
        printf("write s_ret %x\n", s_ret);

        if (s_ret == LIBUSBD_NOT_ENUMERATED) {
            printf("Waiting for device enumeration...\n");

            if (enum_waits++ > 5) {
                // Force the device to re-enumerate
                //IOUSBDeviceControllerGoOffAndOnBus(controller, 1000);

                enum_waits = 0;
            }

            sleep(1);
            continue;
        }
        else if (s_ret == LIBUSBD_TIMEOUT) {
            printf("Write timed out.\n");
            sleep(1);
            continue;
        }
        else if (s_ret < 0)
        {
            printf("Unknown error.\n");
            sleep(1);
        }

        msleep(2);

        memset(&out, 0, sizeof(out));
        out.HAT = HAT_CENTER;
        out.LX = STICK_CENTER;
        out.LY = STICK_CENTER;
        out.RX = STICK_CENTER;
        out.RY = STICK_CENTER;

        s_ret = libusbd_ep_write(pCtx, iface_num, ep_out, &out, sizeof(out), 16);
        printf("write s_ret %x\n", s_ret);

        msleep(2);

        idx++;
    }

    libusbd_free(pCtx);

    printf("asd\n");
}