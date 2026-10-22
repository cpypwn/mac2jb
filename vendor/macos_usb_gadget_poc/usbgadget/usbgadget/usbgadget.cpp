#include <IOKit/IOLib.h>
#include <libkern/OSMalloc.h>

#include "usbgadget.h"
#include "debug.h"

#define super IOService
OSDefineMetaClassAndStructors(gay_bowser_usbgadget, IOService);

// Adding values into the ioreg dictionary
bool
gay_bowser_usbgadget::setDictionaryNumber(const char * symbol,
								 UInt32 value,
								 OSDictionary * dictionary)
{
	OSNumber * number = OSNumber::withNumber(value, 32);
	if (number)
	{
		dictionary->setObject(symbol, number);
		return true;
	}
	return false;
}

bool
gay_bowser_usbgadget::setDictionaryString(const char * symbol,
								 char * value,
								 OSDictionary * dictionary)
{
	OSString * string = OSString::withCString(value);
	if (string)
	{
		dictionary->setObject(symbol, string);
		return true;
	}
	return false;
}

bool
gay_bowser_usbgadget::setDictionaryString(const char * symbol,
								 const char * value,
								 OSDictionary * dictionary)
{
	OSString * string = OSString::withCString(value);
	if (string)
	{
		dictionary->setObject(symbol, string);
		return true;
	}
	return false;
}

bool
gay_bowser_usbgadget::setDictionaryString(const char * symbol,
								 const OSSymbol * value,
								 OSDictionary * dictionary)
{
	dictionary->setObject(symbol, value);
	return true;
}

bool
gay_bowser_usbgadget::setDictionaryBoolean(const char * symbol,
								  bool value,
								  OSDictionary * dictionary)
{
	OSBoolean * boolean = value ? kOSBooleanTrue : kOSBooleanFalse;
	if (boolean)
	{
		dictionary->setObject(symbol, boolean);
		return true;
	}
	return false;
}

bool
gay_bowser_usbgadget::setDictionaryArray(const char * symbol,
								OSArray * value,
								OSDictionary * dictionary)
{
	dictionary->setObject(symbol, value);
	return true;
}

bool
gay_bowser_usbgadget::setDictionaryDictionary(const char * symbol,
									 OSDictionary * value,
									 OSDictionary * dictionary)
{
	dictionary->setObject(symbol, value);
	return true;
}

void gay_bowser_usbgadget::setConfigurationDict(OSDictionary* pDict)
{
    if (!pDict) return;
    
    IOLockLock(m_pokeLock);
    if (m_configuration)
        m_configuration->release();
    m_configuration = OSDictionary::withDictionary(pDict);
    IOLockUnlock(m_pokeLock);
}

void gay_bowser_usbgadget::triggerUpdate()
{
    //m_commandGate->runCommand(NULL);
    IOLockLock(m_pokeLock);
    m_needsUpdate = true;
    IOLockUnlock(m_pokeLock);
}

void gay_bowser_usbgadget::doUpdate()
{
    //setProperty("test", OSString::withCString("updated"));
    
    if (!m_configuration) return;
    
    OSDictionary* pCommandDict = OSDictionary::withCapacity(1);
    setDictionaryString("USBDeviceCommand", "SetDeviceConfiguration", pCommandDict);
    setDictionaryDictionary("USBDeviceCommandParameter", m_configuration, pCommandDict);
    
    // debug
    //setProperty("DeviceDescription", pCommandDict);
    
    // Send it off to IOUSBDeviceInterface
    if (m_controller_provider)
        m_controller_provider->setProperties(pCommandDict);
    
    pCommandDict->release();
}

void gay_bowser_usbgadget::threadMain()
{
    while (!m_exitThreads)
    {
        IOLockLock(m_pokeLock);
        if (m_needsUpdate)
        {
            doUpdate();
            m_needsUpdate = false;
        }
        IOLockUnlock(m_pokeLock);

        IOSleepWithLeeway(100, 1000);
    }
    
    m_threadDone = true;
}

void thread_bootstrap(void* threadArgument )
{
    gay_bowser_usbgadget* driver = (gay_bowser_usbgadget*) threadArgument;
    driver->threadMain();
}

bool gay_bowser_usbgadget::start(IOService *provider) {
    LogD("Executing 'gay_bowser_usbgadget::start()'.");
    
    bool ret = super::start(provider);
    if (ret) {
        LogD("Calling 'gay_bowser_usbgadget:registerService()'.");
        registerService();
    }
    
    m_controller_provider = provider;
    if (!m_controller_provider) {
        return false;
    }

    return ret;
}

void gay_bowser_usbgadget::stop(IOService *provider) {
    m_needsUpdate = false;
    m_exitThreads = true;
    
    IOLockLock(m_pokeLock);
    IOLockUnlock(m_pokeLock);
    
    while (!m_threadDone) {
        IOSleepWithLeeway(100, 1000);
    }
    
    LogD("Executing 'gay_bowser_usbgadget:stop()'.");
    
    super::stop(provider);
}

bool gay_bowser_usbgadget::init(OSDictionary *dictionary) {
    LogD("Executing 'gay_bowser_usbgadget:init()'.");
    
    bool ret = super::init(dictionary);
    
    m_controller_provider = NULL;
    m_configuration = NULL;
    
    m_threadDone = false;

#if 0
    // root.ConfigurationDescriptors[0].Interfaces[0]
    OSArray* pInterfaceArray = OSArray::withCapacity(4);
    pInterfaceArray->setObject(0, OSString::withCString("AppleUSBNCMControl"));
    pInterfaceArray->setObject(1, OSString::withCString("AppleUSBNCMControlAux"));
    pInterfaceArray->setObject(2, OSString::withCString("AppleUSBNCMData"));
    pInterfaceArray->setObject(3, OSString::withCString("AppleUSBNCMDataAux"));
    
    // root.ConfigurationDescriptors[0]
    OSDictionary* pConfigDict = OSDictionary::withCapacity(1);
    setDictionaryNumber("Attributes", 0xE0, pConfigDict);
    setDictionaryNumber("MaxPower", 0, pConfigDict);
    setDictionaryArray("Interfaces", pInterfaceArray, pConfigDict);
    
    // root.ConfigurationDescriptors
    OSArray* pDescArray = OSArray::withCapacity(1);
    pDescArray->setObject(0, pConfigDict);
    
    // root
    OSDictionary* pConfigWrapDict = OSDictionary::withCapacity(1);
    setDictionaryArray("ConfigurationDescriptors", pDescArray, pConfigWrapDict);
    setDictionaryBoolean("AllowMultipleCreates", true, pConfigWrapDict);
    //setDictionaryString("serialNumber", "My Serial", pConfigWrapDict);
    //setDictionaryNumber("productID", 0x1234, pConfigWrapDict);
    
    m_configuration = pConfigWrapDict;


    pInterfaceArray->release();
    pConfigDict->release();
    pDescArray->release();
    //pConfigWrapDict->release();
#endif

    m_needsUpdate = false;
    m_exitThreads = false;
    m_pokeLock = IOLockAlloc();
    //StartThreadWithArgument(this);
    
    kern_return_t kr = kernel_thread_start( (thread_continue_t)thread_bootstrap, this, &m_thread );
    if( kr != KERN_SUCCESS )
    {
        LogD("Failed to start thread in 'gay_bowser_usbgadget:init()' (%x).", kr);
    }
    
    return ret;
}

void gay_bowser_usbgadget::free() {
    LogD("Executing 'gay_bowser_usbgadget:free()'.");
    
    m_needsUpdate = false;
    m_exitThreads = true;
    
    //if (m_configuration)
    //    m_configuration->release();
    
    thread_deallocate( m_thread );
    
    IOLockLock(m_pokeLock);
    IOLockUnlock(m_pokeLock);
    
    IOLockFree(m_pokeLock);
    m_pokeLock = NULL;
    
    super::free();
}

IOReturn gay_bowser_usbgadget::setProperties(OSObject *props_obj)
{
    IOReturn        return_value = kIOReturnSuccess;
	OSDictionary    *dict = OSDynamicCast(OSDictionary, props_obj);
	const OSSymbol  *key = NULL;
	OSObject        *obj = NULL;
	OSCollectionIterator* iter;

	if (!dict) {
		return kIOReturnBadArgument;
	}

	const OSSymbol* publish_configuration_string        = OSSymbol::withCString("PublishConfiguration");
    const OSSymbol* poke_string        = OSSymbol::withCString("Poke");

	iter = OSCollectionIterator::withCollection(dict);
	if (!iter) {
		return_value = kIOReturnNoMemory;
		goto exit;
	}

	while ((key = (const OSSymbol *) iter->getNextObject()) &&
	    (obj = dict->getObject(key))) {
		if (key->isEqualTo(publish_configuration_string)) {
        
            OSDictionary* value = OSDynamicCast(OSDictionary, obj);
			if (value) {
                setConfigurationDict(value);
                
				setProperty(key, obj);
			}
		}
        else if (key->isEqualTo(poke_string)) {
            triggerUpdate();
		}
        else {
			LogD("setProperties(%s) not handled\n", key->getCStringNoCopy());
		}
	}
 
    

exit:
    iter->release();
    publish_configuration_string->release();
	return return_value;
}
