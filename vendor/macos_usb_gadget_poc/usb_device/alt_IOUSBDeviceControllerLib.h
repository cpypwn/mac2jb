#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
/*
 * Copyright (c) 2008 Apple Inc. All rights reserved.
 *
 * @APPLE_LICENSE_HEADER_START@
 * 
 * This file contains Original Code and/or Modifications of Original Code
 * as defined in and that are subject to the Apple Public Source License
 * Version 2.0 (the 'License'). You may not use this file except in
 * compliance with the License. Please obtain a copy of the License at
 * http://www.opensource.apple.com/apsl/ and read it before using this
 * file.
 * 
 * The Original Code and all software distributed under the License are
 * distributed on an 'AS IS' basis, WITHOUT WARRANTY OF ANY KIND, EITHER
 * EXPRESS OR IMPLIED, AND APPLE HEREBY DISCLAIMS ALL SUCH WARRANTIES,
 * INCLUDING WITHOUT LIMITATION, ANY WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE, QUIET ENJOYMENT OR NON-INFRINGEMENT.
 * Please see the License for the specific language governing rights and
 * limitations under the License.
 * 
 * @APPLE_LICENSE_HEADER_END@
 */
/*
 *  alt_IOUSBDeviceControllerLib.h
 *  alt_IOUSBDeviceFamily
 *
 *  Created by Paul Chinn on 11/6/07.
 *  Copyright 2007 Apple Inc. All rights reserved.
 *
 */

#ifndef _IOKIT_ALT_IOUSBDEVICECONTROLLERLIB_H_
#define _IOKIT_ALT_IOUSBDEVICECONTROLLERLIB_H_

#include <IOKit/IOTypes.h>
#include <IOKit/IOReturn.h>
#include <CoreFoundation/CoreFoundation.h>

/*!
 @header alt_IOUSBDeviceControllerLib
 alt_IOUSBDeviceControllerLib provides some API to access devicce-mode-usb controllers.
 */

__BEGIN_DECLS


/*! @typedef alt_IOUSBDeviceControllerRef
 @abstract This is the type of a reference to the alt_IOUSBDeviceController.
 */
typedef struct __alt_IOUSBDeviceController* alt_IOUSBDeviceControllerRef;

/*! @typedef alt_IOUSBDeviceDescriptionRef
 @abstract Object that describes the device, configurations and interfaces of a alt_IOUSBDeviceController.
 */
typedef struct __alt_IOUSBDeviceDescription* alt_IOUSBDeviceDescriptionRef;

/*! @typedef alt_IOUSBDeviceArrivalCallback
 @abstract Function callback for notification of asynchronous arrival of an alt_IOUSBDeviceController .
 */
typedef void (*alt_IOUSBDeviceArrivalCallback) ( 
											void *                  context,
											alt_IOUSBDeviceControllerRef    device);

/*!
 @function   alt_IOUSBDeviceControllerCreate
 @abstract   Creates an alt_IOUSBDeviceController object.
 @discussion Creates a CF object that provides access to the kernel's alt_IOUSBDeviceController IOKit object.
 @param      allocator Allocator to be used during creation.
 @param      deviceRef The newly created object. Only valid if the call succeeds.
 @result     The status of the call. The call will fail if no alt_IOUSBDeviceController exists in the kernel.
 */ 
IOReturn alt_IOUSBDeviceControllerCreate(     
								   CFAllocatorRef                  allocator,
									alt_IOUSBDeviceControllerRef* deviceRef
									);

IOReturn alt_IOUSBDeviceControllerCreateFromService(     
                                   CFAllocatorRef          allocator,
                                   io_service_t deviceIOService,
                                    alt_IOUSBDeviceControllerRef* deviceRefPtr
                                   );

void alt_IOUSBDeviceControllerRelease( alt_IOUSBDeviceControllerRef device );
void alt_IOUSBDeviceDescriptionRelease( alt_IOUSBDeviceDescriptionRef desc );

/*!
 @function   alt_IOUSBDeviceControllerGoOffAndOnBus
 @abstract   Cause the controller to drop off bus and return.
 @discussion The controller will drop off USB appearing to the host as if it has been unlugged. After the given msecDelay
 has elapsed, it will come back on bus.
 @param      deviceRef The controller object
 @param      msecDelay The time in milliseconds to stay off-bus.
 @result     The status of the call.
 */
IOReturn alt_IOUSBDeviceControllerGoOffAndOnBus(alt_IOUSBDeviceControllerRef device, uint32_t msecDelay);

/*!
 @function   alt_IOUSBDeviceControllerForceOffBus
 @abstract   Cause the controller to stay off.
 @discussion The controller will drop off USB appearing to the host as if it has been unlugged.
 @param      deviceRef The controller object
 @param      enable If true the controller is dropped off the bus and kept off. When false the controller will no longer be forced off.
 @result     The status of the call.
 */
IOReturn alt_IOUSBDeviceControllerForceOffBus(alt_IOUSBDeviceControllerRef device, int enable);

/*! @function   alt_IOUSBDeviceControllerRegisterArrivalCallback
 @abstract   Schedules async controller arrival with a run loop
 @discussion Establishs a callback to be invoked when an alt_IOUSBDeviceController becomes available in-kernel.
 @param      callback The function invoked when the controller arrives. It receives a alt_IOUSBDeviceControllerRef annd the caller-provided context. 
 @param      context A caller-specified pointer that is provided when the callback is invoked. 
 @param      runLoop RunLoop to be used when scheduling any asynchronous activity.
 @param      runLoopMode Run loop mode to be used when scheduling any asynchronous activity.
 */
IOReturn alt_IOUSBDeviceControllerRegisterArrivalCallback(alt_IOUSBDeviceArrivalCallback callback, void *context, CFRunLoopRef runLoop, CFStringRef runLoopMode);

void alt_IOUSBDeviceControllerRemoveArrivalCallback();

/*! @function   alt_IOUSBDeviceControllerSetDescription
 @abstract   Provide the information required to configure the alt_IOUSBDeviceController in kernel
 @param      device The controller instance to receive the description
 @param      description The description to use.
 */
IOReturn alt_IOUSBDeviceControllerSetDescription(alt_IOUSBDeviceControllerRef device, alt_IOUSBDeviceDescriptionRef description);

/*! @function   alt_IOUSBDeviceControllerSendCommand
 @abstract   Issue a command to the in-kernel usb-device stack
 @discussion This sends a command string and optional parameter object into the kernel. Commands are passed to the controller-driver, the
"device", then to the individual interface drivers, until one of those handles it.
 @param      device The controller instance to receive the command
 @param      command A string command. Valid commands are determined by the various in-kernel drivers comprising the usb-device stack
 @param		 param An optional, arbitrary object that is appropriate for the given command
 */
IOReturn alt_IOUSBDeviceControllerSendCommand(alt_IOUSBDeviceControllerRef device, CFStringRef command, CFTypeRef param);

/*! @function   alt_IOUSBDeviceControllerSetPreferredConfiguration
 @abstract   Sets the preferred configuration number to gain desired functionality on the host
 @param      device The controller instance to receive the description
 @param      config Preferred configuration number that will be sent to the host.
 */
IOReturn alt_IOUSBDeviceControllerSetPreferredConfiguration(alt_IOUSBDeviceControllerRef device, int config);


alt_IOUSBDeviceDescriptionRef alt_IOUSBDeviceDescriptionCreate(CFAllocatorRef allocator);

/*! @function   alt_IOUSBDeviceDescriptionCreateFromController
 @abstract   Retrieve the current description from the alt_IOUSBDeviceController
 @discussion This retrieves the currently set description from the kernel's alt_IOUSBDeviceController. It represents the full description of the device as
 it is currently presented on the USB. The call can fail if the controller exists but has not et received a description.
 @param		allocator	The CF allocator to use when creating the description
 @param      device The controller instance from which to receive the description
 */
alt_IOUSBDeviceDescriptionRef alt_IOUSBDeviceDescriptionCreateFromController(CFAllocatorRef allocator, alt_IOUSBDeviceControllerRef);

/*! @function   alt_IOUSBDeviceDescriptionCreateFromDefaults
 @abstract   Create a descripion based on the hardwares default usb description.
 @discussion This retrieves the default description for the device. It describes the main usb functionality provided by the device and is what is used for
 a normal system. Currently the description is retrieved from a plist on disk and is keyed to a sysctl that describes the hardware.
 @param		allocator	The CF allocator to use when creating the description
 */
alt_IOUSBDeviceDescriptionRef alt_IOUSBDeviceDescriptionCreateFromDefaults(CFAllocatorRef allocator);

alt_IOUSBDeviceDescriptionRef alt_IOUSBDeviceDescriptionCreate(CFAllocatorRef allocator);

uint8_t alt_IOUSBDeviceDescriptionGetClass(alt_IOUSBDeviceDescriptionRef ref);

void alt_IOUSBDeviceDescriptionSetClass(alt_IOUSBDeviceDescriptionRef ref, UInt8 bClass);

uint8_t alt_IOUSBDeviceDescriptionGetSubClass(alt_IOUSBDeviceDescriptionRef ref);

uint8_t alt_IOUSBDeviceDescriptionGetProtocol(alt_IOUSBDeviceDescriptionRef ref);

uint16_t alt_IOUSBDeviceDescriptionGetVendorID(alt_IOUSBDeviceDescriptionRef ref);

void alt_IOUSBDeviceDescriptionSetVendorID(alt_IOUSBDeviceDescriptionRef devDesc, UInt16 vendorID);

uint16_t alt_IOUSBDeviceDescriptionGetProductID(alt_IOUSBDeviceDescriptionRef ref);

void alt_IOUSBDeviceDescriptionSetProductID(alt_IOUSBDeviceDescriptionRef devDesc, UInt16 productID);

uint16_t alt_IOUSBDeviceDescriptionGetVersion(alt_IOUSBDeviceDescriptionRef ref);

CFStringRef alt_IOUSBDeviceDescriptionGetManufacturerString(alt_IOUSBDeviceDescriptionRef ref);

CFStringRef alt_IOUSBDeviceDescriptionGetProductString(alt_IOUSBDeviceDescriptionRef ref);

CFStringRef alt_IOUSBDeviceDescriptionGetSerialString(alt_IOUSBDeviceDescriptionRef ref);

void alt_IOUSBDeviceDescriptionSetSerialString(alt_IOUSBDeviceDescriptionRef ref, CFStringRef serial);

int alt_IOUSBDeviceDescriptionAppendInterfaceToConfiguration(alt_IOUSBDeviceDescriptionRef devDesc, int config, CFStringRef name);;

int alt_IOUSBDeviceDescriptionAppendConfiguration(alt_IOUSBDeviceDescriptionRef devDesc, CFStringRef textDescription, UInt8 attributes, UInt8 maxPower);;

void alt_IOUSBDeviceDescriptionRemoveAllConfigurations(alt_IOUSBDeviceDescriptionRef devDesc);

io_service_t alt_IOUSBDeviceControllerGetService(alt_IOUSBDeviceControllerRef controller);;

int alt_IOUSBDeviceDescriptionGetMatchingConfiguration(alt_IOUSBDeviceDescriptionRef devDesc, CFArrayRef interfaceNames);;


__END_DECLS

#endif
#pragma clang diagnostic pop