TARGET = example_nintendo_mitm

DEBUG   ?= 0
ARCH    ?= arm64
SDK     ?= macosx

SYSROOT  := $(shell xcrun --sdk $(SDK) --show-sdk-path)
ifeq ($(SYSROOT),)
$(error Could not find SDK "$(SDK)")
endif
CLANG    := g++
CC       := $(CLANG) -isysroot $(SYSROOT) -arch $(ARCH)

#CFLAGS  = -O1 -Wall -g -fstack-protector-all -fsanitize=address -fsanitize=float-divide-by-zero -fsanitize=leak
#LDFLAGS = -fsanitize=address -fsanitize=float-divide-by-zero -static-libsan -fsanitize=leak

CFLAGS  = -O1 -Wall -g -fstack-protector-all -isystem ../../include --std=c++11 $(shell pkg-config --static --libs --cflags libusb) $(shell pkg-config --libs --cflags hidapi)
LDFLAGS = -L../.. $(shell pkg-config --static --libs libusb) -lusbd -lhidapi

ifneq ($(DEBUG),0)
DEFINES += -DDEBUG=$(DEBUG)
endif

FRAMEWORKS = -framework CoreFoundation -framework IOKit

SOURCES = main.cpp

HEADERS = 

all: $(TARGET)

$(TARGET): $(SOURCES) $(HEADERS)
	$(CC) $(CFLAGS) $(FRAMEWORKS) $(DEFINES) $(LDFLAGS) -o $@ $(SOURCES)
	codesign -s - $@

clean:
	rm -f -- $(TARGET)
