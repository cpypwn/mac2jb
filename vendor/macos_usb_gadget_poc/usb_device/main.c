#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <signal.h>

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <mach/mach.h>
//#include "IOUSBDeviceControllerLib.h"
#include "alt_IOUSBDeviceControllerLib.h"

#include "usb_hid_keys.h"

CFStringRef serial = CFSTR("Look, Custom Serial");

#define USB_EP_TYPE_CTRL (0)
#define USB_EP_TYPE_ISOC (1)
#define USB_EP_TYPE_BULK (2)
#define USB_EP_TYPE_INT  (3)

#define USB_EP_DIR_OUT (0)
#define USB_EP_DIR_IN (1)

const char* some_str = "keyboard_idk";

volatile sig_atomic_t stop;

void inthand(int signum) {
    stop = 1;
}

void make_a_keyboard()
{
    // TODO: A lot more error checking
    io_iterator_t       iter    = 0;
    io_service_t service;
    io_service_t service_kext;
    kern_return_t s_ret;
    IOReturn ret;

    io_connect_t dataPort;
    io_connect_t dataPort_kext;
    kern_return_t open_ret;

    uint64_t output[10] = {0};
    uint32_t outputCount = 0;

    uint64_t args[10] = { 0, 0, 0, 0, 0, 0,0,0,0,0 };

    alt_IOUSBDeviceControllerRef controller;

    //IOUSBDeviceControllerSendCommand(controller, CFSTR("ShowDeviceDebug"), NULL); 

    for (int i = 0; i < 5; i++)
    {
        CFMutableDictionaryRef match = IOServiceMatching("gay_bowser_usbgadget");
        CFMutableDictionaryRef dict = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        //CFDictionarySetValue(dict, CFSTR("USBDeviceFunction"), CFSTR("MyUSBData"));
        CFDictionarySetValue(match, CFSTR("IOPropertyMatch"), dict);

        CFRetain(match);
        ret = IOServiceGetMatchingServices(kIOMainPortDefault, match, &iter);
        if (ret != KERN_SUCCESS || iter == 0) {
            printf("Error matching gay_bowser_usbgadget (%x)...\n", ret);
            sleep(1);
            continue;
        }

        // Get the third port
        while (1)
        {
            service_kext = IOIteratorNext(iter);
            if (!service_kext) break;

            io_string_t path;
            if (IORegistryEntryGetPath(service_kext, kIOServicePlane, path) != KERN_SUCCESS) {
                IOObjectRelease(service_kext);
                continue;
            }

            if (strstr(path, "usb-drd2")) {
                printf("Connecting to: '%s'\n", path);
                break;
            }

            IOObjectRelease(service_kext);
        } 

        CFRelease(match);
        IOObjectRelease(iter);

        if (service_kext) break;
    }

    if (!service_kext) {
        printf("Failed to find gay_bowser_usbgadget, aborting...\n");
        return;
    }

    //open_ret = IOServiceOpen(service_kext, mach_task_self(), 123, &dataPort_kext);
    //printf("open_ret kext %x %x\n", open_ret, dataPort_kext);

    alt_IOUSBDeviceControllerCreateFromService(kCFAllocatorDefault, service_kext, &controller);
    //int configId = 0;
#if 1
    alt_IOUSBDeviceDescriptionRef desc = alt_IOUSBDeviceDescriptionCreate(kCFAllocatorDefault);//alt_IOUSBDeviceDescriptionCreateFromController(kCFAllocatorDefault, controller);
    alt_IOUSBDeviceDescriptionSetSerialString(desc, serial);

    alt_IOUSBDeviceDescriptionSetProductID(desc, 0x1234);

    alt_IOUSBDeviceDescriptionRemoveAllConfigurations(desc);

    int configId = alt_IOUSBDeviceDescriptionAppendConfiguration(desc, CFSTR("JustAKeyboard"), 0, 0);
    alt_IOUSBDeviceDescriptionAppendInterfaceToConfiguration(desc, configId, CFSTR("AppleUSBMux"));
    alt_IOUSBDeviceDescriptionAppendInterfaceToConfiguration(desc, configId, CFSTR("MyUSBData"));
    //alt_IOUSBDeviceDescriptionAppendInterfaceToConfiguration(desc, configId, CFSTR("MyUSBControlAux"));
    //alt_IOUSBDeviceDescriptionAppendInterfaceToConfiguration(desc, configId, CFSTR("MyUSBData"));
    //alt_IOUSBDeviceDescriptionAppendInterfaceToConfiguration(desc, configId, CFSTR("MyUSBDataAux"));
    //CFDictionarySetValue(desc->info, , kCFBooleanTrue);
#endif

    ret = alt_IOUSBDeviceControllerSetDescription(controller, desc);
    printf("%x: system=%x subsystem=%x code=%x\n", ret, err_get_system(ret), err_get_sub(ret), err_get_code(ret));

    //printf("%x\n", IORegistryEntrySetCFProperty(service_kext, CFSTR("AAAA"), CFSTR("BBBB")));

    //IOUSBDeviceControllerSetPreferredConfiguration(controller, configId);

    printf("%x\n", IORegistryEntrySetCFProperty(service_kext, CFSTR("Poke"), CFSTR("Poke")));


    // Poke usbgadget
    //outputCount = 0;
    //s_ret = IOConnectCallScalarMethod(dataPort_kext, 0, args, 0, output, &outputCount);
    //printf("poke s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    //IOServiceClose(dataPort_kext);
    IOObjectRelease(service_kext);

    alt_IOUSBDeviceControllerRelease(controller);
    CFAllocatorDeallocate(kCFAllocatorDefault, controller);

    alt_IOUSBDeviceDescriptionRelease(desc);
    CFAllocatorDeallocate(kCFAllocatorDefault, desc);

    // Wait for the old interface to get nuked
    sleep(1);

    for (int i = 0; i < 10; i++)
    {
        CFMutableDictionaryRef match = IOServiceMatching("IOUSBDeviceInterface");
        CFMutableDictionaryRef dict = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        CFDictionarySetValue(dict, CFSTR("USBDeviceFunction"), CFSTR("MyUSBData"));
        CFDictionarySetValue(match, CFSTR("IOPropertyMatch"), dict);

        CFRetain(match);
        ret = IOServiceGetMatchingServices(kIOMainPortDefault, match, &iter);
        if (ret != KERN_SUCCESS || iter == 0) {
            printf("Error matching IOUSBDeviceInterface (%x)...\n", ret);
            sleep(1);
            continue;
        }

        // Get the third port
        while (1)
        {
            service = IOIteratorNext(iter);
            if (!service) break;

            io_string_t path;
            if (IORegistryEntryGetPath(service, kIOServicePlane, path) != KERN_SUCCESS) {
                IOObjectRelease(service);
                continue;
            }

            if (strstr(path, "usb-drd2")) {
                printf("Connecting to: '%s'\n", path);
                break;
            }
            IOObjectRelease(service);
        } 

        CFRelease(match);
        IOObjectRelease(iter);

        if (service) break;
    }

    if (!service) {
        printf("Failed to find IOUSBDeviceInterface, aborting...\n");
        return;
    }

    open_ret = IOServiceOpen(service, mach_task_self(), 123, &dataPort);
    printf("open_ret %x %x\n", open_ret, dataPort);
    //IOServiceClose(service);
    IOObjectRelease(service);

    
    // Open
    outputCount = 0;
    s_ret = IOConnectCallScalarMethod(dataPort, 0, args, 1, output, &outputCount);
    printf("open s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    // SetClass
    outputCount = 0;
    args[0] = 3; // HID
    args[1] = configId;
    s_ret = IOConnectCallScalarMethod(dataPort, 3, args, 2, output, &outputCount);
    printf("setclass s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    // SetSubclass
    outputCount = 0;
    args[0] = 1; // boot if
    args[1] = configId;
    s_ret = IOConnectCallScalarMethod(dataPort, 4, args, 2, output, &outputCount);
    printf("setsubclass s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    // SetProtocol
    outputCount = 0;
    args[0] = 1; // keyboard
    args[1] = configId;
    s_ret = IOConnectCallScalarMethod(dataPort, 5, args, 2, output, &outputCount);
    printf("setprotocol s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

#if 0
    mach_port_t wakePort;
    mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &wakePort);

    args[0] = 0;
    args[1] = (uint64_t) callback_2;
    args[2] = (uint64_t) 0; // refcon
    IOConnectCallAsyncMethod(dataPort, 8, wakePort, args, 3, NULL, 0, NULL, 0, NULL, 0, NULL, NULL);
    printf("async s_ret %x\n", s_ret, outputCount);
#endif

#if 0
    // CreatePipe
    outputCount = 1;
    output[0] = 0;
    args[0] = USB_EP_TYPE_BULK;
    args[1] = USB_EP_DIR_OUT;
    args[2] = -1;
    args[3] = 0;
    args[4] = 0;
    args[5] = configId;
    s_ret = IOConnectCallScalarMethod(dataPort, 10, args, 6, output, &outputCount);
    printf("s_ret %x %x (%x %x)\n", s_ret, outputCount, output[0], output[1]);

    // CreatePipe
    outputCount = 1;
    output[0] = 0;
    args[0] = USB_EP_TYPE_BULK; // type
    args[1] = USB_EP_DIR_IN; // direction
    args[2] = -1;
    args[3] = 0xff; // interval
    args[4] = 0;
    args[5] = configId;
    s_ret = IOConnectCallScalarMethod(dataPort, 10, args, 6, output, &outputCount);
    printf("s_ret %x %x (%x %x)\n", s_ret, outputCount, output[0], output[1]);

    // CreatePipe
    outputCount = 1;
    output[0] = 0;
    args[0] = USB_EP_TYPE_INT; // type
    args[1] = USB_EP_DIR_OUT; // direction
    args[2] = -1;
    args[3] = 0;
    args[4] = 0;
    args[5] = configId;
    s_ret = IOConnectCallScalarMethod(dataPort, 10, args, 6, output, &outputCount);
    printf("s_ret %x %x (%x %x)\n", s_ret, outputCount, output[0], output[1]);
#endif

    uint8_t hid_desc[] = {0x09, 0x21, 0x11, 0x01, 0x00, 0x01, 0x22, 0x5D, 0x00};
    uint8_t hid_report_desc[] = { 0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x95, 0x01, 0x75, 0x08, 0x81, 0x01, 0x95, 0x03, 0x75, 0x01,
  0x05, 0x08, 0x19, 0x01, 0x29, 0x03, 0x91, 0x02, 0x95, 0x05, 0x75, 0x01, 0x91, 0x01, 0x95, 0x06,
  0x75, 0x08, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x05, 0x07, 0x19, 0x00, 0x2A, 0xFF, 0x00, 0x81, 0x00,
  0xC0};

    // setDesc
    /*outputCount = 0;
    output[0] = some_str;
    args[0] = some_str; // idk
    s_ret = IOConnectCallMethod(dataPort, 2, NULL, 0, args, 1, NULL, NULL, NULL, NULL);
    printf("setdesc s_ret %x %x (%x %x)\n", s_ret, outputCount, output[0], output[1]);*/

    // appendStandardClassOrVendorDescriptor
    // This gets added after the interface and before endpoints
    outputCount = 0;
    args[0] = 0x21; // descriptor type
    args[1] = 0xF;
    s_ret = IOConnectCallMethod(dataPort, 6, args, 2, hid_desc, sizeof(hid_desc), output, &outputCount, NULL, NULL);
    printf("desc s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    // appendNonstandardClassOrVendorDescriptor
    // this has to be asked for manually via the ctrl ep
    outputCount = 0;
    args[0] = 0x22; // class descriptor type
    args[1] = 0xF;
    s_ret = IOConnectCallMethod(dataPort, 7, args, 2, hid_report_desc, sizeof(hid_report_desc), output, &outputCount, NULL, NULL);
    printf("append s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    // CreatePipe
    outputCount = 1;
    output[0] = 0;
    args[0] = USB_EP_TYPE_INT; // type
    args[1] = USB_EP_DIR_IN; // direction
    args[2] = 8;
    args[3] = 10;
    args[4] = 0;
    args[5] = configId;
    s_ret = IOConnectCallScalarMethod(dataPort, 10, args, 6, output, &outputCount);
    printf("createPipe s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    uint64_t pipe_id = output[0];

    // CommitConfiguration
    outputCount = 0;
    s_ret = IOConnectCallScalarMethod(dataPort, 11, args, 0, output, &outputCount);
    printf("CommitConfiguration s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    // createData
    outputCount = 3;
    args[0] = 0x1000;
    s_ret = IOConnectCallScalarMethod(dataPort, 18, args, 1, output, &outputCount);
    printf("createData s_ret %x %x (%llx %llx %llx)\n", s_ret, outputCount, output[0], output[1], output[2]);

    void* dataptr = (void*)output[0];
    uint64_t data_cap = output[1];
    uint64_t map_token = output[2];

    int enum_waits = 0;
    int idx = 0;
    uint8_t type_stuff[] = {KEY_M, KEY_Y, KEY_SPACE, KEY_L, KEY_A, KEY_P, KEY_T, KEY_O, KEY_P, KEY_SPACE, KEY_I, KEY_S, KEY_SPACE, KEY_A, KEY_SPACE, KEY_K, KEY_E, KEY_Y, KEY_B, KEY_O, KEY_A, KEY_R, KEY_D, KEY_DOT, KEY_SPACE};

    // Force the device to re-enumerate
    //IOUSBDeviceControllerGoOffAndOnBus(controller, 1000);

#if 0
    // MapBuffer
    outputCount = 3;
    args[0] = 0;
    args[1] = 0;
    s_ret = IOConnectCallScalarMethod(dataPort, 26, args, 2, output, &outputCount);
    printf("map s_ret %x %x (%llx %llx %llx)\n", s_ret, outputCount, output[0], output[1], output[2]);
#endif

#if 1
    while (!stop)
    {
        
        uint8_t test_send[8] = {0x0, 0x0, type_stuff[idx], 0x0, 0x0, 0x0, 0x0, 0x0};
        //uint8_t test_send[8] = {0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0};
        uint8_t test_send_2[8] = {0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0};

        //printf("%p\n", dataptr);
        memset(dataptr, 0, 0x10);
        memcpy(dataptr, test_send, sizeof(test_send));

        // 0xE0000001 = Device not enumerated
        // 0xE00002D6 = Send timed out
        // WritePort - press the key
        outputCount = 1; // bytes written
        args[0] = pipe_id;
        args[1] = map_token;
        args[2] = sizeof(test_send);
        args[3] = 100; // timeout ms?
        s_ret = IOConnectCallScalarMethod(dataPort, 14, args, 4, output, &outputCount);
        printf("write s_ret %x (%llx)\n", s_ret, output[0]);

        if (s_ret == 0xE0000001) {
            printf("Waiting for device enumeration...\n");

            if (enum_waits++ > 5) {
                // Force the device to re-enumerate
                //IOUSBDeviceControllerGoOffAndOnBus(controller, 1000);

                enum_waits = 0;
            }

            sleep(1);
            continue;
        }
        else if (s_ret == 0xE00002D6) {
            printf("Write timed out.\n");
            sleep(1);
            continue;
        }
        else if (s_ret & 0xFFFF0000)
        {
            printf("Unknown error.\n");
            sleep(1);
        }

        // Write Port - Un-press the key
        //printf("%p\n", dataptr);
        //memset(dataptr, 0, 0x10);
        memcpy(dataptr, test_send_2, sizeof(test_send_2));
        args[0] = pipe_id;
        args[1] = map_token;
        args[2] = sizeof(test_send_2);
        args[3] = 100; // timeout ms?
        s_ret = IOConnectCallScalarMethod(dataPort, 14, args, 4, output, &outputCount);
        printf("write s_ret %x (%llx)\n", s_ret, output[0]);

        idx++;
        if (idx >= sizeof(type_stuff)) {
            idx = 0;
            sleep(1);
        }
    }
#endif

    // ReleaseBuffer
    outputCount = 0;
    args[0] = map_token;
    s_ret = IOConnectCallScalarMethod(dataPort, 19, args, 1, output, &outputCount);
    printf("release s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    // Close
    outputCount = 0;
    output[0] = 0;
    output[1] = 0;
    s_ret = IOConnectCallScalarMethod(dataPort, 1, args, 0, output, &outputCount);
    printf("close s_ret %x %x (%llx %llx)\n", s_ret, outputCount, output[0], output[1]);

    IOServiceClose(dataPort);

    //mach_port_mod_refs(mach_task_self(), wakePort, MACH_PORT_RIGHT_RECEIVE, -1);
}

int main()
{
    signal(SIGINT, inthand);
    
    make_a_keyboard();
}