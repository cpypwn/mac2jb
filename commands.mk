# Optional post-bootstrap sender build; main Makefile is unchanged.
# Build: make -f Makefile -f commands.mk mac2jb-commands
.PHONY: clean-commands
mac2jb-commands: commands.c commands.mk $(LIBUSBD_DIR)/libusbd.dylib
	$(CC) $(CFLAGS) -o $@ commands.c $(LDFLAGS) -Wl,-rpath,@executable_path/$(LIBUSBD_DIR)
	codesign -s - $@
clean-commands:
	rm -f mac2jb-commands
