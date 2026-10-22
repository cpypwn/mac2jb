#ifndef _DEBUG_H
#define _DEBUG_H

#include <IOKit/IOLib.h>

#define TAG "usbgadget: "

#define LogD(fmt, ...) IOLog((TAG fmt "\n"), ##__VA_ARGS__); kprintf((TAG fmt "\n"), ##__VA_ARGS__)

#endif // _DEBUG_H
