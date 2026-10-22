# mac2jb post-bootstrap command sender
# keep this file beside Makefile and commands.c
# build: make -f Makefile -f commands.mk mac2jb-commands

.PHONY: clean-commands

mac2jb-commands: commands.c commands.mk Makefile $(LIBUSBD_DIR)/libusbd.dylib
	$(CC) $(CFLAGS) -o $@ commands.c $(LDFLAGS)
	install_name_tool -change libusbd.dylib @rpath/libusbd.dylib $@
	codesign -f -s - $@

clean-commands:
	rm -f mac2jb-commands
