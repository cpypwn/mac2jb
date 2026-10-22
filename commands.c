// mac2jb interactive post-bootstrap command sender
// Reuse the exact key encoding, HID helper functions, and USB descriptor
// setup patterns from the project's verified sender.c.
#define main mac2jb_original_sender_main
#include "sender.c"
#undef main

static const char *steps[] = {
    "RUN",
    "REMOVE NSR,&H60000000,&H3FFFFFFF",
    "V=START(REDACTED)"
};

static bool approve(const char *message, const char *expected) {
    char buf[40];
    printf("\n%s\nType %s and press Enter to proceed (anything else cancels): ", message, expected);
    fflush(stdout);
    if (!fgets(buf, sizeof(buf), stdin)) return false;
    buf[strcspn(buf, "\r\n")] = 0;
    return strcmp(buf, expected) == 0;
}

static int type_and_submit(libusbd_ctx_t *ctx, uint8_t iface, uint64_t ep,
                           const char *command, int delay_ms) {
    printf("Sending: %s\n", command);
    fflush(stdout);
    for (const unsigned char *p=(const unsigned char *)command; *p; p++) {
        Stroke stroke;
        if (!encode(*p, &stroke)) {
            fprintf(stderr, "unsupported byte 0x%02x\n", *p);
            return -1;
        }
        if (interrupted || send_stroke(ctx, iface, ep, stroke.mods, stroke.key, delay_ms)<0)
            return -1;
    }
    // Explicitly submit the typed command. Waits for host processing happen
    // *outside* this function so the user can inspect the Switch screen.
    if (interrupted || send_stroke(ctx, iface, ep, 0, 40, delay_ms)<0)
        return -1;
    release_all_keys(ctx, iface, ep);
    return 0;
}

int main(int argc, char **argv) {
    int delay_ms=50;
    bool dry_run=false;
    for (int a=1; a<argc; a++) {
        if (strcmp(argv[a], "--dry-run") == 0) dry_run=true;
        else if (strcmp(argv[a], "--delay-ms") == 0 && a+1<argc) {
            char *end=NULL;
            long value=strtol(argv[++a], &end, 10);
            if (!end || *end || value<1 || value>2000) {
                fprintf(stderr, "delay must be between 1 and 2000 ms\n");
                return 2;
            }
            delay_ms=(int)value;
        } else if (!strcmp(argv[a], "--help") || !strcmp(argv[a], "-h")) {
            puts("usage: ./mac2jb-commands [--dry-run] [--delay-ms N]");
            return 0;
        } else {
            fprintf(stderr, "unknown argument: %s\n", argv[a]);
            return 2;
        }
    }
    for (size_t i=0; i<3; ++i) {
        for (const unsigned char *p=(const unsigned char *)steps[i]; *p; ++p) {
            Stroke dummy;
            if (!encode(*p, &dummy)) {
                fprintf(stderr, "step %zu contains unsupported input 0x%02x\n", i+1, *p);
                return 2;
            }
        }
    }
    if (dry_run) {
        puts("These commands will be typed and submitted separately:");
        for (size_t i=0; i<3; ++i) printf("%zu: %s [Enter]\n", i+1, steps[i]);
        return 0;
    }

    puts("mac2jb post-bootstrap command sender");
    puts("This sends keyboard input only; it does not start run.cjs on the Mac.");
    puts("Each approved command is submitted with Enter, in order.");
    puts("Keep the macOS host running in a separate Terminal window.");
    if (!approve("First, start run.cjs on your Mac; open fresh SmileBASIC, load the saved bootstrap, and focus its command entry.", "READY"))
        return 1;

    signal(SIGINT, on_interrupt);
    signal(SIGTERM, on_interrupt);
    libusbd_ctx_t *ctx=NULL;
    uint8_t iface=0;
    uint64_t ep=0;
    bool endpoint_ready=false;
    int result=1;
    if (libusbd_init(&ctx)<0 || !ctx) {
        fprintf(stderr, "libusbd_init failed; check usbgadget.kext\n");
        goto done;
    }
    libusbd_set_pid(ctx,0x1234);
    libusbd_set_version(ctx,0x0100);
    libusbd_set_class(ctx,0);
    libusbd_set_subclass(ctx,0);
    libusbd_set_protocol(ctx,0);
    libusbd_set_manufacturer_str(ctx,"USB text sender");
    libusbd_set_product_str(ctx,"USB HID Keyboard");
    libusbd_set_serial_str(ctx,"TEXTSENDER01");
    if (libusbd_iface_alloc(ctx,&iface)<0 || libusbd_config_finalize(ctx)<0) {
        fprintf(stderr, "USB configuration failed\n"); goto done;
    }
    libusbd_iface_set_class(ctx,iface,3);
    libusbd_iface_set_subclass(ctx,iface,1);
    libusbd_iface_set_protocol(ctx,iface,1);
    uint8_t hid_desc[]={0x09,0x21,0x11,0x01,0x00,0x01,0x22,0,0};
    uint8_t hid_report_desc[]={
        0x05,0x01,0x09,0x06,0xA1,0x01,0x05,0x07,0x19,0xE0,0x29,0xE7,0x15,0x00,0x25,0x01,
        0x75,0x01,0x95,0x08,0x81,0x02,0x95,0x01,0x75,0x08,0x81,0x01,0x95,0x03,0x75,0x01,
        0x05,0x08,0x19,0x01,0x29,0x03,0x91,0x02,0x95,0x05,0x75,0x01,0x91,0x01,0x95,0x06,
        0x75,0x08,0x15,0x00,0x26,0xFF,0x00,0x05,0x07,0x19,0x00,0x2A,0xFF,0x00,0x81,0x00,0xC0
    };
    hid_desc[7]=(uint8_t)(sizeof(hid_report_desc)&0xff);
    hid_desc[8]=(uint8_t)(sizeof(hid_report_desc)>>8);
    libusbd_iface_standard_desc(ctx,iface,0x21,0xF,hid_desc,sizeof(hid_desc));
    libusbd_iface_nonstandard_desc(ctx,iface,0x22,0xF,hid_report_desc,sizeof(hid_report_desc));
    if (libusbd_iface_add_endpoint(ctx,iface,USB_EPATTR_TTYPE_INTR,USB_EP_DIR_IN,8,10,0,&ep)<0 ||
        libusbd_iface_finalize(ctx,iface)<0) {
        fprintf(stderr, "USB interface setup failed\n"); goto done;
    }
    endpoint_ready=true;
    puts("Waiting for USB host enumeration...");
    {
        bool ready=false;
        uint8_t empty[8]={0};
        for (int attempt=0;attempt<30 && !interrupted;attempt++) {
            int32_t r=libusbd_ep_write(ctx,iface,ep,empty,sizeof(empty),500);
            if (r>=0) { ready=true; break; }
            if (r!=LIBUSBD_NOT_ENUMERATED && r!=LIBUSBD_TIMEOUT) {
                fprintf(stderr,"USB enumeration error 0x%08x\n",(unsigned)r); break;
            }
            sleep(1);
        }
        if (!ready) { fprintf(stderr,"USB host did not enumerate a keyboard\n"); goto done; }
    }

    if (!approve("STEP 1/3: With the saved bootstrap loaded, focus the command entry. Send RUN and Enter?", "SEND")) goto done;
    if (type_and_submit(ctx,iface,ep,steps[0],delay_ms)<0) goto done;
    if (!approve("STEP 2/3: Wait until RUN has finished. Focus the command entry. Send REMOVE NSR,... and Enter?", "SEND")) goto done;
    if (type_and_submit(ctx,iface,ep,steps[1],delay_ms)<0) goto done;
    if (!approve("STEP 3/3: Confirm the console displayed the EXPECTED 'Out of memory' message. Continue?", "OOM")) goto done;
    if (!approve("Focus the SmileBASIC command entry. Send V=START(...) and Enter?", "SEND")) goto done;
    if (type_and_submit(ctx,iface,ep,steps[2],delay_ms)<0) goto done;
    puts("All three commands sent. Check the console and macOS host for actual results.");
    result=0;
done:
    if (ctx) {
        if (endpoint_ready) release_all_keys(ctx,iface,ep);
        libusbd_free(ctx);
    }
    return result;
}
