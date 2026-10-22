#ifndef _USBGADGET_H
#define _USBGADGET_H

#include <IOKit/IOService.h>
#include <IOKit/IOCommandGate.h>

class gay_bowser_usbgadget : public IOService {
    OSDeclareDefaultStructors(gay_bowser_usbgadget)
    
    static bool setDictionaryNumber(const char * symbol,
								 UInt32 value,
								 OSDictionary * dictionary);
    static bool setDictionaryString(const char * symbol,
                                     char * value,
                                     OSDictionary * dictionary);
    static bool setDictionaryString(const char * symbol,
                                     const char * value,
                                     OSDictionary * dictionary);
    static bool setDictionaryString(const char * symbol,
                                     const OSSymbol * value,
                                     OSDictionary * dictionary);
    static bool setDictionaryBoolean(const char * symbol,
                                      bool value,
                                      OSDictionary * dictionary);
    static bool setDictionaryArray(const char * symbol,
                                    OSArray * value,
                                    OSDictionary * dictionary);

    static bool setDictionaryDictionary(const char * symbol,
                                         OSDictionary * value,
                                         OSDictionary * dictionary);
    
public:
    virtual bool init(OSDictionary *dictionary = 0) override;
    virtual void free(void) override;
    
    virtual bool start(IOService *provider) override;
    virtual void stop(IOService *provider) override;
    
    virtual void triggerUpdate();
    virtual void doUpdate();
    virtual void threadMain();
    virtual void setConfigurationDict(OSDictionary* pDict);
    
    virtual IOReturn setProperties(OSObject *props_obj) override;

private:
    /**
     *  Keep track of managed/created HID devices.
     */
    IOService *m_controller_provider;
    IOLock *m_pokeLock;
    bool m_needsUpdate;
    bool m_exitThreads;
    thread_t m_thread;
    bool m_threadDone;
    
    OSDictionary *m_configuration;
};

#endif // _USBGADGET_H
