/*
 *  alt_IOUSBDeviceLib.c
 *  alt_IOUSBDeviceFamily
 *
 *  Created by Paul Chinn on 11/6/07.
 *  Copyright 2008 Apple Inc. All rights reserved.
 *
 */

#include <pthread.h>
//#include <CoreFoundation/CFRuntime.h>
#include <IOKit/IOKitLib.h>
#include <sys/sysctl.h>

#include "alt_IOUSBDeviceControllerLib.h"

#define CONFIG_FILE_PATH		CFSTR("/System/Library/AppleUSBDevice/USBDeviceConfiguration.plist")

static void __alt_IOUSBDeviceControllerRelease( CFTypeRef object );
static alt_IOUSBDeviceControllerRef __deviceRefFromService(CFAllocatorRef allocator, io_service_t service);

static void __alt_IOUSBDeviceDescriptionRelease( CFTypeRef object );
static CFStringRef __alt_IOUSBDeviceDescriptionSerializeDebug(CFTypeRef cf);
static pthread_once_t __deviceDescriptionTypeInit = PTHREAD_ONCE_INIT;
#define DESTROY(thing) if(thing) CFRelease(thing)

static alt_IOUSBDeviceDescriptionRef __alt_IOUSBDeviceDescriptionCreateFromDictionary(CFAllocatorRef allocator, CFMutableDictionaryRef descDict);
static alt_IOUSBDeviceDescriptionRef __alt_IOUSBDeviceDescriptionCreateFromFile( CFAllocatorRef allocator, CFStringRef filePath );

typedef struct __alt_IOUSBDeviceDescription
	{
		CFMutableDictionaryRef			info;
		CFAllocatorRef					allocator;
	}__alt_IOUSBDeviceDescription;

typedef struct __alt_IOUSBDeviceController
{
	io_service_t					deviceIOService; //io service represeniting the underlying device controller
	
} __alt_IOUSBDeviceController, *__alt_IOUSBDeviceControllerRef;

static alt_IOUSBDeviceControllerRef __deviceRefFromService(CFAllocatorRef allocator, io_service_t service)
{
    alt_IOUSBDeviceControllerRef device = NULL;
	void *          offset  = NULL;
    uint32_t        size;
	size    = sizeof(__alt_IOUSBDeviceController);
    device = (alt_IOUSBDeviceControllerRef)CFAllocatorAllocate(
															allocator, 
															size, 
															0);
    
    if (!device)
		return NULL;
	
    offset = device;
    bzero(offset, size);
    
	device->deviceIOService = service;
	//IOObjectRetain(service);
    return device;
}

IOReturn alt_IOUSBDeviceControllerCreate(     
								   CFAllocatorRef          allocator,
									alt_IOUSBDeviceControllerRef* deviceRefPtr
								   )
{    
    CFMutableDictionaryRef 	matchingDict;
	io_service_t		deviceIOService;
	alt_IOUSBDeviceControllerRef		deviceRef;
	matchingDict = IOServiceMatching("alt_IOUSBDeviceController");
	if (!matchingDict)
		return kIOReturnNoMemory;
	
	deviceIOService = IOServiceGetMatchingService(kIOMainPortDefault, matchingDict);
	if(!deviceIOService)
		return kIOReturnNotFound;
	deviceRef = __deviceRefFromService(allocator, deviceIOService);
	IOObjectRelease(deviceIOService);
	if(deviceRef == NULL)
		return kIOReturnNoMemory;
	*deviceRefPtr = deviceRef;
	return kIOReturnSuccess;
}

IOReturn alt_IOUSBDeviceControllerCreateFromService(     
								   CFAllocatorRef          allocator,
								   io_service_t deviceIOService,
									alt_IOUSBDeviceControllerRef* deviceRefPtr
								   )
{    
    CFMutableDictionaryRef 	matchingDict;
	alt_IOUSBDeviceControllerRef		deviceRef;
	matchingDict = IOServiceMatching("alt_IOUSBDeviceController");
	if (!matchingDict)
		return kIOReturnNoMemory;
	
	if(!deviceIOService)
		return kIOReturnNotFound;
	deviceRef = __deviceRefFromService(allocator, deviceIOService);
	//IOObjectRelease(deviceIOService);
	if(deviceRef == NULL)
		return kIOReturnNoMemory;
	*deviceRefPtr = deviceRef;
	return kIOReturnSuccess;
}

IOReturn alt_IOUSBDeviceControllerGoOffAndOnBus(alt_IOUSBDeviceControllerRef device, uint32_t msecdelay)
{
	CFNumberRef delay = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &msecdelay);
	if(!delay)
		return kIOReturnNoMemory;
	return alt_IOUSBDeviceControllerSendCommand(device, CFSTR("GoOffAndOnBus"), delay);
}

IOReturn alt_IOUSBDeviceControllerForceOffBus(alt_IOUSBDeviceControllerRef device, int enable)
{
	if(enable)
		return alt_IOUSBDeviceControllerSendCommand(device, CFSTR("ForceOffBusEnable"), NULL);
	else
		return alt_IOUSBDeviceControllerSendCommand(device, CFSTR("ForceOffBusDisable"), NULL);
}

void alt_IOUSBDeviceControllerRelease( alt_IOUSBDeviceControllerRef device )
{
    if ( device->deviceIOService )
        IOObjectRelease(device->deviceIOService);
	device->deviceIOService = 0;
}

IOReturn alt_IOUSBDeviceControllerSendCommand(alt_IOUSBDeviceControllerRef device, CFStringRef command, CFTypeRef param)
{
	CFMutableDictionaryRef dict;
	IOReturn kr;
	
	dict = CFDictionaryCreateMutable(NULL, 0,
								 &kCFTypeDictionaryKeyCallBacks,
								 &kCFTypeDictionaryValueCallBacks);
	if(!dict)
		return kIOReturnNoMemory;
	
	CFDictionarySetValue(dict, CFSTR("USBDeviceCommand"), command);
	if(param)
		CFDictionarySetValue(dict, CFSTR("USBDeviceCommandParameter"), param);

	kr = IORegistryEntrySetCFProperties(device->deviceIOService, dict);
	CFRelease(dict);
	return kr;
}

IOReturn alt_IOUSBDeviceControllerSetDescription(alt_IOUSBDeviceControllerRef device, alt_IOUSBDeviceDescriptionRef	description)
{
	//return alt_IOUSBDeviceControllerSendCommand(device, CFSTR("SetDeviceDescription"), description->info);

	CFMutableDictionaryRef dict;
	IOReturn kr;
	
	dict = CFDictionaryCreateMutable(NULL, 0,
								 &kCFTypeDictionaryKeyCallBacks,
								 &kCFTypeDictionaryValueCallBacks);
	if(!dict)
		return kIOReturnNoMemory;
	
	CFDictionarySetValue(dict, CFSTR("PublishConfiguration"), description->info);

	kr = IORegistryEntrySetCFProperties(device->deviceIOService, dict);
	CFRelease(dict);
	return kr;
}

void alt_IOUSBDeviceDescriptionRelease( alt_IOUSBDeviceDescriptionRef desc )
{
	DESTROY(desc->info);
}

static CFStringRef __alt_IOUSBDeviceDescriptionSerializeDebug(CFTypeRef cf)	// str with retain
{
	alt_IOUSBDeviceDescriptionRef desc = (alt_IOUSBDeviceDescriptionRef)cf;
	
	return CFStringCreateWithFormat(NULL, NULL, CFSTR("alt_IOUSBDeviceDescription: pid/vid/ver=%04x/%04x/%d class/sub/prot=%d/%d/%d Mfg:%@ Prod:%@ Ser:%@\n%@"), 
									alt_IOUSBDeviceDescriptionGetProductID(desc), alt_IOUSBDeviceDescriptionGetVendorID(desc), alt_IOUSBDeviceDescriptionGetVersion(desc), 
									alt_IOUSBDeviceDescriptionGetClass(desc), alt_IOUSBDeviceDescriptionGetSubClass(desc), alt_IOUSBDeviceDescriptionGetProtocol(desc), 
									alt_IOUSBDeviceDescriptionGetManufacturerString(desc), alt_IOUSBDeviceDescriptionGetProductString(desc), alt_IOUSBDeviceDescriptionGetSerialString(desc),
	desc->info);
}

alt_IOUSBDeviceDescriptionRef alt_IOUSBDeviceDescriptionCreate(CFAllocatorRef allocator)
{
    alt_IOUSBDeviceDescriptionRef devdesc = NULL;
	void *          offset  = NULL;
    uint32_t        size;
	size    = sizeof(__alt_IOUSBDeviceDescription);
    devdesc = (alt_IOUSBDeviceDescriptionRef)CFAllocatorAllocate(
																		allocator, 
																		size, 
																		0);
    
    if (!devdesc)
		return NULL;
	
    offset = devdesc;
    bzero(offset, size);
	devdesc->info = CFDictionaryCreateMutable(allocator, 8, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	devdesc->allocator = allocator;
	
	//ensure we have a config descriptor array
	CFMutableArrayRef configs = CFArrayCreateMutable(allocator, 4, &kCFTypeArrayCallBacks);
	CFDictionarySetValue(devdesc->info, CFSTR("ConfigurationDescriptors"), configs);
	CFRelease(configs);
	return devdesc;
}	

alt_IOUSBDeviceDescriptionRef alt_IOUSBDeviceDescriptionCreateFromController(CFAllocatorRef allocator, alt_IOUSBDeviceControllerRef controllerRef)
{
	CFMutableDictionaryRef descDict;
	alt_IOUSBDeviceDescriptionRef descRef = NULL;
	
	if((descDict = (CFMutableDictionaryRef)IORegistryEntryCreateCFProperty(controllerRef->deviceIOService, CFSTR("DeviceDescription"), kCFAllocatorDefault, 0)))
	{
		descRef = __alt_IOUSBDeviceDescriptionCreateFromDictionary(allocator, descDict);
		CFRelease(descDict);
	}
	return descRef;
}
		
static alt_IOUSBDeviceDescriptionRef __alt_IOUSBDeviceDescriptionCreateFromDictionary(CFAllocatorRef allocator, CFMutableDictionaryRef descDict)
{
	alt_IOUSBDeviceDescriptionRef descRef = NULL;
	
	if((descRef = alt_IOUSBDeviceDescriptionCreate(allocator)))
	{
		if(descDict != descRef->info)
		{
			CFRelease(descRef->info);
			descRef->info = (CFMutableDictionaryRef)CFRetain(descDict);
		}
	}	
	return descRef;
}

uint32_t __getDictNumber(alt_IOUSBDeviceDescriptionRef ref, CFStringRef key)
{
	CFNumberRef aNumber;
	uint32_t val=0;
	if((aNumber = CFDictionaryGetValue(ref->info, key )))
		CFNumberGetValue(aNumber, kCFNumberSInt32Type, &val);
	return val;
}

uint8_t alt_IOUSBDeviceDescriptionGetClass(alt_IOUSBDeviceDescriptionRef ref)
{
	return __getDictNumber(ref, CFSTR("deviceClass"));	
}

void alt_IOUSBDeviceDescriptionSetClass(alt_IOUSBDeviceDescriptionRef devDesc, UInt8 class)
{
	CFNumberRef aNumber = CFNumberCreate(devDesc->allocator, kCFNumberCharType, &class);
	CFDictionarySetValue(devDesc->info, CFSTR("deviceClass"), aNumber);
	CFRelease(aNumber);
}

uint8_t alt_IOUSBDeviceDescriptionGetSubClass(alt_IOUSBDeviceDescriptionRef ref)
{
	return __getDictNumber(ref, CFSTR("deviceSubClass"));	
}

uint8_t alt_IOUSBDeviceDescriptionGetProtocol(alt_IOUSBDeviceDescriptionRef ref)
{
	return __getDictNumber(ref, CFSTR("deviceProtocol"));	
}

uint16_t alt_IOUSBDeviceDescriptionGetVendorID(alt_IOUSBDeviceDescriptionRef ref)
{
	return __getDictNumber(ref, CFSTR("vendorID"));	
}

void alt_IOUSBDeviceDescriptionSetVendorID(alt_IOUSBDeviceDescriptionRef devDesc, UInt16 vendorID)
{
	CFNumberRef aNumber = CFNumberCreate(devDesc->allocator, kCFNumberShortType, &vendorID);
	CFDictionarySetValue(devDesc->info, CFSTR("vendorID"), aNumber);
	CFRelease(aNumber);
}

uint16_t alt_IOUSBDeviceDescriptionGetProductID(alt_IOUSBDeviceDescriptionRef ref)
{
	return __getDictNumber(ref, CFSTR("productID"));	
}

void alt_IOUSBDeviceDescriptionSetProductID(alt_IOUSBDeviceDescriptionRef devDesc, UInt16 productID)
{
	CFNumberRef aNumber = CFNumberCreate(devDesc->allocator, kCFNumberShortType, &productID);
	CFDictionarySetValue(devDesc->info, CFSTR("productID"), aNumber);
	CFRelease(aNumber);
}

uint16_t alt_IOUSBDeviceDescriptionGetVersion(alt_IOUSBDeviceDescriptionRef ref)
{
	return __getDictNumber(ref, CFSTR("deviceID"));	
}

CFStringRef alt_IOUSBDeviceDescriptionGetManufacturerString(alt_IOUSBDeviceDescriptionRef ref)
{
	return CFDictionaryGetValue(ref->info, CFSTR("manufacturerString"));
}
CFStringRef alt_IOUSBDeviceDescriptionGetProductString(alt_IOUSBDeviceDescriptionRef ref)
{
	return CFDictionaryGetValue(ref->info, CFSTR("productString"));
}
CFStringRef alt_IOUSBDeviceDescriptionGetSerialString(alt_IOUSBDeviceDescriptionRef ref)
{
	return CFDictionaryGetValue(ref->info, CFSTR("serialNumber"));
}
void alt_IOUSBDeviceDescriptionSetSerialString(alt_IOUSBDeviceDescriptionRef ref, CFStringRef serial)
{
	CFDictionarySetValue(ref->info, CFSTR("serialNumber"), serial);
}

void alt_IOUSBDeviceDescriptionRemoveAllConfigurations(alt_IOUSBDeviceDescriptionRef devDesc)
{
	CFArrayRemoveAllValues((CFMutableArrayRef)CFDictionaryGetValue(devDesc->info,	CFSTR("ConfigurationDescriptors")));
}

int alt_IOUSBDeviceDescriptionAppendConfiguration(alt_IOUSBDeviceDescriptionRef devDesc, CFStringRef textDescription, UInt8 attributes, UInt8 maxPower)
{
	CFMutableArrayRef configs = (CFMutableArrayRef)CFDictionaryGetValue(devDesc->info, CFSTR("ConfigurationDescriptors"));
	CFMutableDictionaryRef theConfig;
	CFNumberRef aNumber;
	CFMutableArrayRef interfaces;
	
	//hack to allow manually created descriptions to be sent into the kernel even when its already got one. See the comment
	//in the family's createUSBDevice() function.
	CFDictionarySetValue(devDesc->info, CFSTR("AllowMultipleCreates"), kCFBooleanTrue);
	
	theConfig = CFDictionaryCreateMutable(devDesc->allocator, 3, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	
	interfaces = CFArrayCreateMutable(devDesc->allocator, 4, &kCFTypeArrayCallBacks);
	CFDictionaryAddValue(theConfig, CFSTR("Interfaces"), interfaces);
	CFRelease(interfaces);

	if(textDescription)
		CFDictionaryAddValue(theConfig, CFSTR("Description"), textDescription);
						   
	aNumber = CFNumberCreate(devDesc->allocator, kCFNumberCharType, &attributes);
	CFDictionaryAddValue(theConfig, CFSTR("Attributes"), aNumber);
	CFRelease(aNumber);
	aNumber = CFNumberCreate(devDesc->allocator, kCFNumberCharType, &maxPower);
	CFDictionaryAddValue(theConfig, CFSTR("MaxPower"), aNumber);
	CFRelease(aNumber);
	CFArrayAppendValue(configs, theConfig);
	CFRelease(theConfig);
	return CFArrayGetCount(configs) - 1;
}

int alt_IOUSBDeviceDescriptionAppendInterfaceToConfiguration(alt_IOUSBDeviceDescriptionRef devDesc, int config, CFStringRef name)
{
	CFMutableDictionaryRef theConfig;
	CFMutableArrayRef configs = (CFMutableArrayRef)CFDictionaryGetValue(devDesc->info, CFSTR("ConfigurationDescriptors"));
	CFMutableArrayRef interfaces;
	
	theConfig = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(configs, config);
	if(NULL == theConfig)
		return -1;
	interfaces = (CFMutableArrayRef)CFDictionaryGetValue(theConfig, CFSTR("Interfaces"));
	CFArrayAppendValue(interfaces, name);
	return CFArrayGetCount(interfaces) - 1;
}

static alt_IOUSBDeviceDescriptionRef __alt_IOUSBDeviceDescriptionCreateFromFile( CFAllocatorRef allocator, CFStringRef filePath )
{
	alt_IOUSBDeviceDescriptionRef devDesc = NULL;

	CFURLRef fileURL = CFURLCreateWithFileSystemPath( allocator, filePath, kCFURLPOSIXPathStyle, false );
	if(fileURL)
	{
		CFDataRef resourceData = NULL;
		SInt32 errorCode;
		
		CFURLCreateDataAndPropertiesFromResource(allocator, fileURL, &resourceData, NULL, NULL, &errorCode);
		if(resourceData)
		{
			CFDictionaryRef allDescriptions;
			allDescriptions = CFPropertyListCreateFromXMLData( allocator,resourceData,kCFPropertyListImmutable, NULL);
			if(allDescriptions)
			{
				int rval;
				char machineName[64];
				size_t maxSize=sizeof(machineName);
				CFMutableDictionaryRef thisDeviceDescription = NULL;
				CFStringRef machineNameKey;
				CFDictionaryRef devices;
				
				//find out the name of this machine
				rval = sysctlbyname("hw.machine", machineName, &maxSize, NULL, 0);
				if(rval != 0)
					strncpy(machineName, "sysctl hw.machine failed", sizeof(machineName));

				machineNameKey = CFStringCreateWithCString(kCFAllocatorDefault, (const char *)machineName, kCFStringEncodingASCII);
				devices = CFDictionaryGetValue(allDescriptions, CFSTR("devices"));
				if(!devices) //must be the old-school way...
					thisDeviceDescription = (CFMutableDictionaryRef)CFDictionaryGetValue(allDescriptions, machineNameKey);
				else
				{
					thisDeviceDescription = (CFMutableDictionaryRef)CFDictionaryGetValue(devices, machineNameKey);
					if(!thisDeviceDescription) //can't find a config keyed to this machine...try to load the default
						thisDeviceDescription = (CFMutableDictionaryRef)CFDictionaryGetValue(devices, CFSTR("unknownHardware"));
					if(thisDeviceDescription)
					{
						//check if the configuration descriptor is actually a key into the list of stock configs
						CFStringRef configName = CFDictionaryGetValue(thisDeviceDescription, CFSTR("ConfigurationDescriptors"));
						if(CFGetTypeID(configName) == CFStringGetTypeID()) //yes, it's a string that is a key into the config dict
						{
							CFDictionaryRef configs = CFDictionaryGetValue(allDescriptions, CFSTR("configurations"));
							CFDictionaryRef thisConfig = CFDictionaryGetValue(configs, configName);
							CFDictionarySetValue(thisDeviceDescription, CFSTR("ConfigurationDescriptors"), thisConfig);
						}
					}
				}
				if(thisDeviceDescription)
					devDesc = __alt_IOUSBDeviceDescriptionCreateFromDictionary(NULL, thisDeviceDescription);	
				CFRelease(machineNameKey);
				CFRelease(allDescriptions);
			}
			CFRelease(resourceData);
		}
		CFRelease(fileURL);
	}
	return devDesc;
}


alt_IOUSBDeviceDescriptionRef alt_IOUSBDeviceDescriptionCreateFromDefaults(CFAllocatorRef allocator) 
{
	return __alt_IOUSBDeviceDescriptionCreateFromFile(allocator, CONFIG_FILE_PATH);
}