#ifndef _USBGADGET_USERCLIENT_H
#define _USBGADGET_USERCLIENT_H

#include <IOKit/IOService.h>
#include <IOKit/IOUserClient.h>

#include "usbgadget.h"

/**
 The goal of this User Client is to expose to user space the following selector.
*/
enum {
    gay_bowser_usbgadget_method_poke,

    gay_bowser_usbgadget_method_count  // Keep track of the length of this enum.
};

class gay_bowser_usbgadget_userclient : public IOUserClient {
    OSDeclareDefaultStructors(gay_bowser_usbgadget_userclient);
    
public:
    virtual bool initWithTask(task_t owningTask, void *securityToken,
                              UInt32 type, OSDictionary *properties) override;
    
    virtual bool start(IOService *provider) override;
    virtual void stop(IOService *provider) override;
    
    virtual IOReturn externalMethod(uint32_t selector,
                                    IOExternalMethodArguments *arguments,
                                    IOExternalMethodDispatch *dispatch,
                                    OSObject *target, void *reference) override;
    
    virtual IOReturn setProperties(OSObject *props_obj) override;

protected:
    /**
     * The following methods unpack/handle the given arguments and 
     * call the related driver method.
     */
    virtual IOReturn methodPoke(IOExternalMethodArguments *arguments);

    /**
     *  The following static methods redirect the call to the 'target' instance.
     */
    static IOReturn sMethodPoke(gay_bowser_usbgadget_userclient *target,
                                void *reference,
                                IOExternalMethodArguments *arguments);

private:
    /**
     *  Method dispatch table.
     */
    static const IOExternalMethodDispatch s_methods[gay_bowser_usbgadget_method_count];
    
    /**
     *  Driver provider.
     */
    gay_bowser_usbgadget *m_provider;
};

#endif // _USBGADGET_USERCLIENT_H
