#include <IOKit/IOLib.h>
#include <IOKit/IOKitKeys.h>
#include <libkern/c++/OSContainers.h>

#include "usbgadget_userclient.h"
#include "debug.h"
#include <string.h>


#define super IOUserClient
OSDefineMetaClassAndStructors(gay_bowser_usbgadget_userclient, IOUserClient)

bool gay_bowser_usbgadget_userclient::initWithTask(task_t owningTask, void *securityToken,
                                              UInt32 type, OSDictionary *properties) {
    LogD("Executing 'gay_bowser_usbgadget_userclient::initWithTask()'.");
    
    if (!owningTask) {
        return false;
    }
    
    if (!super::initWithTask(owningTask, securityToken, type, properties)) {
        return false;
    }
    
    return true;
}

bool gay_bowser_usbgadget_userclient::start(IOService *provider) {
    LogD("Executing 'gay_bowser_usbgadget_userclient::start()'.");
    
    if (!super::start(provider)) {
        return false;
    }
    
    m_provider = OSDynamicCast(gay_bowser_usbgadget, provider);
    if (!m_provider) {
        return false;
    }
    
    return true;
}

void gay_bowser_usbgadget_userclient::stop(IOService *provider) {
    LogD("Executing 'gay_bowser_usbgadget_userclient::stop()'.");
    super::stop(provider);
}

/**
 * A dispatch table for this User Client interface, used by 'gay_bowser_usbgadget_userclient::externalMethod()'.
 * The fields of the IOExternalMethodDispatch type follows:
 *
 *  struct IOExternalMethodDispatch
 *  {
 *      IOExternalMethodAction function;
 *      uint32_t		   checkScalarInputCount;
 *      uint32_t		   checkStructureInputSize;
 *      uint32_t		   checkScalarOutputCount;
 *      uint32_t		   checkStructureOutputSize;
 *  };
 */
const IOExternalMethodDispatch gay_bowser_usbgadget_userclient::s_methods[gay_bowser_usbgadget_method_count] = {
    {(IOExternalMethodAction)&gay_bowser_usbgadget_userclient::sMethodPoke, 0, 0, 0, 0},
};

IOReturn gay_bowser_usbgadget_userclient::externalMethod(uint32_t selector, IOExternalMethodArguments *arguments,
                                                    IOExternalMethodDispatch *dispatch, OSObject *target, void *reference) {
    LogD("Executing 'gay_bowser_usbgadget_userclient::externalMethod()' with selector #%d.", selector);
    
    if (selector >= gay_bowser_usbgadget_method_count) {
        return kIOReturnUnsupported;
    }
    
    dispatch = (IOExternalMethodDispatch *)&s_methods[selector];
    target = this;
    reference = nullptr;
    
    return super::externalMethod(selector, arguments, dispatch, target, reference);
}

IOReturn gay_bowser_usbgadget_userclient::sMethodPoke(gay_bowser_usbgadget_userclient *target, void *reference,
                                                 IOExternalMethodArguments *arguments) {
    return target->methodPoke(arguments);
}

IOReturn gay_bowser_usbgadget_userclient::methodPoke(IOExternalMethodArguments *arguments) {
    m_provider->triggerUpdate();
    
    return kIOReturnSuccess;
}
