#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>

#include <libusbd.h>

#include "usb_hid_keys.h"

volatile sig_atomic_t stop;

void inthand(int signum) {
    stop = 1;
}

int main()
{
    libusbd_ctx_t* pCtx;

    signal(SIGINT, inthand);

    libusbd_init(&pCtx);

    //libusbd_set_vid(pCtx, 0x1234);
    libusbd_set_pid(pCtx, 0x1234);
    libusbd_set_version(pCtx, 0x1234);

    libusbd_set_class(pCtx, 0);
    libusbd_set_subclass(pCtx, 0);
    libusbd_set_protocol(pCtx, 0);

    libusbd_set_manufacturer_str(pCtx, "Manufacturer");
    libusbd_set_product_str(pCtx, "Product");
    libusbd_set_serial_str(pCtx, "Serial");

    uint8_t iface_num = 0;
    uint64_t ep_out;
    libusbd_iface_alloc(pCtx, &iface_num);
    libusbd_config_finalize(pCtx);

    libusbd_iface_set_class(pCtx, iface_num, 3);
    libusbd_iface_set_subclass(pCtx, iface_num, 1);
    libusbd_iface_set_protocol(pCtx, iface_num, 1);

    uint8_t hid_desc[] = {0x09, 0x21, 0x11, 0x01, 0x00, 0x01, 0x22, 0x5D, 0x00};
    uint8_t hid_report_desc[] = { 0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x95, 0x01, 0x75, 0x08, 0x81, 0x01, 0x95, 0x03, 0x75, 0x01,
  0x05, 0x08, 0x19, 0x01, 0x29, 0x03, 0x91, 0x02, 0x95, 0x05, 0x75, 0x01, 0x91, 0x01, 0x95, 0x06,
  0x75, 0x08, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x05, 0x07, 0x19, 0x00, 0x2A, 0xFF, 0x00, 0x81, 0x00,
  0xC0};

    libusbd_iface_standard_desc(pCtx, iface_num, 0x21, 0xF, hid_desc, sizeof(hid_desc));
    libusbd_iface_nonstandard_desc(pCtx, iface_num, 0x22, 0xF, hid_report_desc, sizeof(hid_report_desc));
    libusbd_iface_add_endpoint(pCtx, iface_num, USB_EPATTR_TTYPE_INTR, USB_EP_DIR_IN, 8, 10, 0, &ep_out);
    libusbd_iface_finalize(pCtx, iface_num);

    int enum_waits = 0;
    int idx = 0;
    uint8_t type_stuff[] = {KEY_M, KEY_Y, KEY_SPACE, KEY_L, KEY_A, KEY_P, KEY_T, KEY_O, KEY_P, KEY_SPACE, KEY_I, KEY_S, KEY_SPACE, KEY_A, KEY_SPACE, KEY_K, KEY_E, KEY_Y, KEY_B, KEY_O, KEY_A, KEY_R, KEY_D, KEY_DOT, KEY_SPACE};


    while (!stop)
    {
        int32_t s_ret;
        uint8_t test_send[8] = {0x0, 0x0, type_stuff[idx], 0x0, 0x0, 0x0, 0x0, 0x0};
        uint8_t test_send_2[8] = {0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0};

        // 0xE0000001 = Device not enumerated
        // 0xE00002D6 = Send timed out
        s_ret = libusbd_ep_write(pCtx, iface_num, ep_out, test_send, sizeof(test_send), 100);
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


        s_ret = libusbd_ep_write(pCtx, iface_num, ep_out, test_send_2, sizeof(test_send_2), 100);
        printf("write s_ret %x\n", s_ret);

        idx++;
        if (idx >= sizeof(type_stuff)) {
            idx = 0;
            sleep(1);
        }
    }

    libusbd_free(pCtx);

    printf("asd\n");
}