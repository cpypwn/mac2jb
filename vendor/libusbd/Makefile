TARGET = libusbd.dylib

DEBUG   ?= 0
ARCH    ?= arm64
SDK     ?= macosx

SYSROOT  := $(shell xcrun --sdk $(SDK) --show-sdk-path)
ifeq ($(SYSROOT),)
$(error Could not find SDK "$(SDK)")
endif
CLANG    := clang
CC       := $(CLANG) -isysroot $(SYSROOT) -arch $(ARCH)

#CFLAGS  = -O1 -Wall -g -fstack-protector-all -fsanitize=address -fsanitize=float-divide-by-zero -fsanitize=leak
#LDFLAGS = -fsanitize=address -fsanitize=float-divide-by-zero -static-libsan -fsanitize=leak

CFLAGS  = -O1 -Wall -g -fstack-protector-all -I include/ -I src/
LDFLAGS = -shared -Wl,-undefined -Wl,dynamic_lookup -lpthread

ifneq ($(DEBUG),0)
DEFINES += -DDEBUG=$(DEBUG)
endif

FRAMEWORKS = -framework CoreFoundation -framework IOKit

SOURCES = src/libusbd.c src/plat/macos/impl.c src/plat/macos/alt_IOUSBDeviceControllerLib.c

HEADERS = include/libusbd.h src/libusbd_priv.h

all: $(TARGET)

$(TARGET): $(SOURCES) $(HEADERS)
	$(CC) $(CFLAGS) $(FRAMEWORKS) $(DEFINES) $(LDFLAGS) -o $@ $(SOURCES)
	codesign -s - $@

clean:
	rm -f -- $(TARGET)
