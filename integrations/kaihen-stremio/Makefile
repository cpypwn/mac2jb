.SUFFIXES:

ifneq ($(MAKECMDGOALS),test-host)
ifneq ($(MAKECMDGOALS),test-native-syntax)
ifeq ($(strip $(DEVKITPRO)),)
$(error Set DEVKITPRO to the ounce-devkit installation)
endif

TOPDIR ?= $(CURDIR)
include $(DEVKITPRO)/libounce/switch2_rules
export LD := $(CC)

TARGET := kaihen-stremio
BUILD := build
SOURCES := source
INCLUDES := source
APP_TITLE := Stremio
APP_AUTHOR := cpypwn
APP_VERSION := 0.1.0

SWITCH_PKG_CONFIG := $(DEVKITPRO)/portlibs/switch2/bin/aarch64-none-elf-pkg-config
MEDIA_LIBS := $(shell PKG_CONFIG_PATH=$(DEVKITPRO)/portlibs/switch/lib/pkgconfig:$(DEVKITPRO)/portlibs/switch2/lib/pkgconfig $(SWITCH_PKG_CONFIG) --static --libs libavformat libavcodec libswresample libswscale libavutil libcurl 2>/dev/null)
ifeq ($(strip $(MEDIA_LIBS)),)
$(error Install switch-ffmpeg, switch-curl, and their portlibs before building)
endif

ARCH := $(SWITCH2_CPU) -mtp=soft -fPIE
CFLAGS := -O2 -Wall -Wextra -ffunction-sections $(ARCH) $(DEFINES) $(INCLUDE) -D__SWITCH__
LDFLAGS := -specs=$(LIBNX)/switch.specs $(ARCH) -Wl,-Map,$(notdir $*.map)
LIBS := $(MEDIA_LIBS) -lnx
LIBDIRS := $(PORTLIBS) $(LIBNX)

ifneq ($(BUILD),$(notdir $(CURDIR)))
export OUTPUT := $(CURDIR)/$(TARGET)
export TOPDIR := $(CURDIR)
export VPATH := $(foreach dir,$(SOURCES),$(CURDIR)/$(dir))
export DEPSDIR := $(CURDIR)/$(BUILD)
CFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.c)))
export OFILES := $(CFILES:.c=.o)
export INCLUDE := $(foreach dir,$(INCLUDES),-I$(CURDIR)/$(dir)) $(foreach dir,$(LIBDIRS),-I$(dir)/include)
export LIBPATHS := $(foreach dir,$(LIBDIRS),-L$(dir)/lib)
export NROFLAGS += --nacp=$(CURDIR)/$(TARGET).nacp --icon=$(CURDIR)/icon.jpg

.PHONY: all clean $(BUILD)
all: $(BUILD)
$(BUILD):
	@mkdir -p $@
	@$(MAKE) --no-print-directory -C $(BUILD) -f $(CURDIR)/Makefile
clean:
	@rm -rf $(BUILD) $(TARGET).nro $(TARGET).nacp $(TARGET).elf
else
.PHONY: all
all: $(OUTPUT).nro
$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp
$(OUTPUT).elf: $(OFILES)
-include $(OFILES:.o=.d)
endif
endif
endif

.PHONY: test-host
test-host:
	cc -std=c11 -Wall -Wextra -Werror -Isource source/qr.c source/qrcodegen.c tests/qr_test.c -o /tmp/kaihen-stremio-qr-test
	/tmp/kaihen-stremio-qr-test
	cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -Isource source/catalog.c tests/catalog_test.c -o /tmp/kaihen-stremio-catalog-test
	/tmp/kaihen-stremio-catalog-test
	cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -Itests/include -Isource source/playback.c tests/playback_test.c -o /tmp/kaihen-stremio-playback-test
	/tmp/kaihen-stremio-playback-test
	cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -Isource source/media.c tests/media_test.c -o /tmp/kaihen-stremio-media-test
	/tmp/kaihen-stremio-media-test
	cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -Isource source/h264.c tests/h264_test.c -o /tmp/kaihen-stremio-h264-test
	/tmp/kaihen-stremio-h264-test
	cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -Isource source/display.c tests/display_test.c -o /tmp/kaihen-stremio-display-test
	/tmp/kaihen-stremio-display-test
	cc -std=c11 -Wall -Wextra -Werror -D__SWITCH__ -Itests/include -Isource -fsyntax-only source/main.c

.PHONY: test-native-syntax
test-native-syntax:
	@test -n "$(FFMPEG_HEADERS)" -a -n "$(LIBOUNCE_HEADERS)" || { echo 'Set FFMPEG_HEADERS and LIBOUNCE_HEADERS'; exit 1; }
	$(or $(NATIVE_CC),cc) -std=c11 -Wall -Wextra -Werror -D__SWITCH__ -D__SWITCH2__ $(NATIVE_SHIM) -I$(FFMPEG_HEADERS) -I$(LIBOUNCE_HEADERS) -Isource -fsyntax-only source/main.c source/playback.c source/session.c source/display.c source/netio.c source/artwork.c source/account.c source/account_data.c source/qr.c source/qrcodegen.c source/ui.c
