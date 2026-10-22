# Optional additional target; keep the existing Makefile unchanged.
# Build: make -f Makefile -f commands.mk mac2jb-commands
.PHONY: clean-commands
mac2jb-commands: commands.c sender.c Makefile $(LIBUSBD_DIR)/libusbd.dylib
	$(CC) $(CFLAGS) -o $@ commands.c $(LDFLAGS)
	codesign -s - $@
clean-commands:
	rm -f mac2jb-commands
