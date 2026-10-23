// USB HID text sender based on the libusbd keyboard example by shinyquagsire23.
// This program TYPES a file; it does not execute its contents.
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <libusbd.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <poll.h>

// Automatic controller probing. Each child must enumerate BEFORE any text is sent.
// A child emits one byte after enumeration, then remains the active sender.
// A manual MAC2JB_CONTROLLER bypasses probing entirely.
static int mac2jb_auto_dispatch(char **argv) {
    const char *override = getenv("MAC2JB_CONTROLLER");
    if (getenv("MAC2JB_AUTO_WORKER") || (override && *override && strcmp(override, "auto") != 0)) return -1;
    const char *choices[] = {"usb-drd0", "usb-drd1", "usb-drd3"};
    for (size_t i=0; i<sizeof(choices)/sizeof(choices[0]); i++) {
        int fds[2];
        if (pipe(fds) != 0) { perror("pipe"); return 1; }
        fflush(NULL);
        pid_t pid=fork();
        if (pid < 0) { perror("fork"); close(fds[0]); close(fds[1]); return 1; }
        if (pid == 0) {
            close(fds[0]);
            char fdstr[32]; snprintf(fdstr, sizeof(fdstr), "%d", fds[1]);
            setenv("MAC2JB_CONTROLLER", choices[i], 1);
            setenv("MAC2JB_AUTO_WORKER", "1", 1);
            setenv("MAC2JB_READY_FD", fdstr, 1);
            execvp(argv[0], argv);
            perror("execvp"); _exit(127);
        }
        close(fds[1]);
        fprintf(stderr, "mac2jb auto: trying %s (4-second enumeration window)...\n", choices[i]);
        struct pollfd waitfd={.fd=fds[0], .events=POLLIN|POLLHUP};
        int poll_result=poll(&waitfd, 1, 4000);
        char ready=0;
        ssize_t got=(poll_result>0) ? read(fds[0], &ready, 1) : -1;
        close(fds[0]);
        if (got==1 && ready=='Y') {
            fprintf(stderr, "mac2jb auto: %s enumerated successfully.\n", choices[i]);
            int status=0;
            if (waitpid(pid,&status,0)<0) { perror("waitpid"); return 1; }
            return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
        }
        kill(pid, SIGTERM);
        // Give the sender a chance to release the device before moving on.
        int status=0, reaped=0;
        for(int tries=0;tries<10;tries++) {
            pid_t w=waitpid(pid,&status,WNOHANG);
            if(w==pid || w<0) { reaped=1; break; }
            struct timespec pause={0,100000000L}; nanosleep(&pause,NULL);
        }
        if(!reaped) { kill(pid,SIGKILL); waitpid(pid,&status,0); }
        fprintf(stderr, "mac2jb auto: %s did not enumerate; trying next controller.\n", choices[i]);
    }
    fprintf(stderr,"mac2jb auto: no controller enumerated. Check cable/power direction, or set MAC2JB_CONTROLLER manually.\n");
    return 1;
}
static void mac2jb_auto_ready(void) {
    const char *s=getenv("MAC2JB_READY_FD");
    if(!s || !*s) return;
    char *end=NULL; long fd=strtol(s,&end,10);
    if(!end || *end || fd<0 || fd>1048576) return;
    (void)write((int)fd,"Y",1);
    close((int)fd);
    unsetenv("MAC2JB_READY_FD");
}


typedef struct { uint8_t key, mods; } Stroke;
static volatile sig_atomic_t interrupted = 0;
static void on_interrupt(int signal_number) { (void)signal_number; interrupted = 1; }
static int encode(unsigned char c, Stroke *out) {
    out->mods = 0;
    if (c >= 'a' && c <= 'z') { out->key = 4 + c - 'a'; out->mods = 2; return 1; }
    if (c >= 'A' && c <= 'Z') { out->key = 4 + c - 'A'; return 1; }
    if (c >= '1' && c <= '9') { out->key = 30 + c - '1'; return 1; }
    if (c == '0') { out->key = 39; return 1; }
    if (c == '\n') { out->key = 40; return 1; }
    if (c == '\t') { out->key = 43; return 1; }
    if (c == ' ') { out->key = 44; return 1; }
    const char *unshifted = "-=[]\\;',./`";
    const char *shifted   = "_+{}|:\"<>?~";
    for (int i=0; unshifted[i]; i++) {
        if (c == (unsigned char)unshifted[i] || c == (unsigned char)shifted[i]) {
            static const uint8_t codes[] = {45,46,47,48,49,51,52,54,55,56,53};
            out->key=codes[i]; out->mods=(c == (unsigned char)shifted[i])?2:0; return 1;
        }
    }
    const char *shift_digits = "!@#$%^&*()";
    for (int i=0; i<10; i++) if(c == (unsigned char)shift_digits[i]) {
        out->key=(i==9)?39:(30+i); out->mods=2; return 1;
    }
    return 0;
}
// Monotonic measurements distinguish USB write latency from the user delay.
static double seconds_now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1000000000.0;
}
static double usb_write_seconds = 0.0, pacing_seconds = 0.0;
static unsigned long usb_attempts = 0, usb_retries = 0;

static int usb_write_once(libusbd_ctx_t *ctx, uint8_t iface,
                          uint64_t endpoint, const uint8_t report[8],
                          uint64_t timeout_ms) {
    double start = seconds_now();
    int32_t r = libusbd_ep_write(ctx, iface, endpoint, report, 8, timeout_ms);
    usb_write_seconds += seconds_now() - start;
    usb_attempts++;
    return r;
}

static int write_report(libusbd_ctx_t *ctx, uint8_t iface,
                        uint64_t endpoint, uint8_t mods, uint8_t key) {
    uint8_t report[8] = {mods,0,key,0,0,0,0,0};
    // Bounded retries: never sleep for seconds while a key may be down.
    for (int attempt = 0; attempt < 2 && !interrupted; attempt++) {
        int32_t r = usb_write_once(ctx, iface, endpoint, report, 250);
        if (r >= 0) return 0;
        if (r == LIBUSBD_TIMEOUT && attempt == 0) { usb_retries++; continue; }
        fprintf(stderr, "USB write failed: 0x%08x%s\\n", (unsigned)r,
                r == LIBUSBD_NOT_ENUMERATED ? " (device disconnected)" : "");
        return -1;
    }
    return -1;
}

// Always attempt a neutral HID report on shutdown, including Ctrl+C.
// It is best-effort: disconnection can prevent the release from reaching the host.
static void release_all_keys(libusbd_ctx_t *ctx, uint8_t iface, uint64_t endpoint) {
    const uint8_t neutral[8] = {0};
    for (int i = 0; i < 3; i++) {
        int32_t r = usb_write_once(ctx, iface, endpoint, neutral, 200);
        if (r >= 0) return;
        if (r == LIBUSBD_NOT_ENUMERATED) break;
    }
    fprintf(stderr, "Warning: could not confirm key release; reconnect cable if a key repeats.\\n");
}
static int send_stroke(libusbd_ctx_t *ctx, uint8_t iface, uint64_t ep,
                       uint8_t mods, uint8_t key, int delay_ms) {
    if (write_report(ctx,iface,ep,mods,key)<0 ||
        write_report(ctx,iface,ep,0,0)<0) return -1;
    struct timespec pause_time = {delay_ms/1000, (long)(delay_ms%1000)*1000000L};
    double pause_start=seconds_now();
    nanosleep(&pause_time, NULL);
    pacing_seconds += seconds_now()-pause_start;
    return 0;
}

static unsigned char *read_text(const char *path, size_t *length) {
    FILE *f=fopen(path,"rb"); if(!f){perror(path);return NULL;}
    if(fseek(f,0,SEEK_END)!=0){fclose(f);return NULL;}
    long count=ftell(f); if(count<0 || count>10*1024*1024){fprintf(stderr,"File too large or unreadable\n");fclose(f);return NULL;}
    rewind(f);
    unsigned char *buf=malloc((size_t)count+1); if(!buf){fclose(f);return NULL;}
    if(fread(buf,1,(size_t)count,f)!=(size_t)count){fprintf(stderr,"Cannot read file\n");free(buf);fclose(f);return NULL;}
    fclose(f); *length=(size_t)count; return buf;
}
static void usage(const char *exe) { fprintf(stderr,"usage: %s <file> [--dry-run] [--delay-ms N]\n",exe); }
int main(int argc, char **argv) {
    if(argc == 2 && (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "-h") == 0)) { usage(argv[0]); return 0; }
    if(argc < 2){usage(argv[0]);return 2;}
    int dry=0, delay_ms=50;
    for(int a=2;a<argc;a++) {
        if(strcmp(argv[a],"--dry-run")==0) dry=1;
        else if(strcmp(argv[a],"--delay-ms")==0 && a+1<argc) {
            char *end=NULL; long v=strtol(argv[++a],&end,10);
            if(!end || *end || v<1 || v>2000){fprintf(stderr,"Delay must be 1..2000 ms\n");return 2;}
            delay_ms=(int)v;
        } else {usage(argv[0]);return 2;}
    }
    size_t bytes=0; unsigned char *data=read_text(argv[1],&bytes); if(!data)return 1;
    size_t characters=0, lines=0;
    for(size_t i=0;i<bytes;i++) {
        if(data[i]=='\r' && i+1<bytes && data[i+1]=='\n')continue;
        Stroke stroke;
        if(!encode(data[i],&stroke)) {
            fprintf(stderr,"Unsupported byte 0x%02X at offset %zu (line %zu). ASCII US keyboard layout required.\n",data[i],i,lines+1);
            free(data);return 1;
        }
        characters++; if(data[i]=='\n')lines++;
    }
    printf("Verified %zu input bytes, %zu keystrokes, %zu newline(s).\n",bytes,characters,lines);
    if(dry){puts("Dry run complete; no USB device created and no keys sent.");free(data);return 0;}
    printf("This will TYPE the file into the connected device. It will NOT press RUN.\n");
    if (!getenv("MAC2JB_AUTO_WORKER")) {
        printf("Focus the intended EMPTY text editor, then press Enter to begin (type anything to cancel): ");fflush(stdout);
        char approval[32];
        if(!fgets(approval,sizeof(approval),stdin) || (approval[0]!='\n' && approval[0]!='\r')){free(data);puts("Cancelled.");return 1;}
        int automatic=mac2jb_auto_dispatch(argv);
        if(automatic>=0) { free(data); return automatic; }
    }
    signal(SIGINT,on_interrupt);
    signal(SIGTERM,on_interrupt);
    libusbd_ctx_t *ctx=NULL;
    int result=1;
    uint8_t iface=0; uint64_t ep=0; bool endpoint_ready=false;
    double transfer_start=0.0;
    if(libusbd_init(&ctx)<0 || !ctx){fprintf(stderr,"libusbd_init failed; check usbgadget.kext.\n");goto done;}
    libusbd_set_pid(ctx,0x1234); libusbd_set_version(ctx,0x0100);
    libusbd_set_class(ctx,0);libusbd_set_subclass(ctx,0);libusbd_set_protocol(ctx,0);
    libusbd_set_manufacturer_str(ctx,"USB text sender");libusbd_set_product_str(ctx,"USB HID Keyboard");
    libusbd_set_serial_str(ctx,"TEXTSENDER01");
    if(libusbd_iface_alloc(ctx,&iface)<0 || libusbd_config_finalize(ctx)<0){fprintf(stderr,"USB configuration failed\n");goto done;}
    libusbd_iface_set_class(ctx,iface,3);libusbd_iface_set_subclass(ctx,iface,1);libusbd_iface_set_protocol(ctx,iface,1);
    uint8_t hid_desc[]={0x09,0x21,0x11,0x01,0x00,0x01,0x22,0x00,0x00};
    uint8_t hid_report_desc[]={
        0x05,0x01,0x09,0x06,0xA1,0x01,0x05,0x07,0x19,0xE0,0x29,0xE7,0x15,0x00,0x25,0x01,
        0x75,0x01,0x95,0x08,0x81,0x02,0x95,0x01,0x75,0x08,0x81,0x01,0x95,0x03,0x75,0x01,
        0x05,0x08,0x19,0x01,0x29,0x03,0x91,0x02,0x95,0x05,0x75,0x01,0x91,0x01,0x95,0x06,
        0x75,0x08,0x15,0x00,0x26,0xFF,0x00,0x05,0x07,0x19,0x00,0x2A,0xFF,0x00,0x81,0x00,0xC0
    };
    // Keep the HID descriptor's report length in sync with the actual bytes.
    // Upstream's example declared 93 bytes but the report is 65 bytes long.
    hid_desc[7] = (uint8_t)(sizeof(hid_report_desc) & 0xff);
    hid_desc[8] = (uint8_t)((sizeof(hid_report_desc) >> 8) & 0xff);
    libusbd_iface_standard_desc(ctx,iface,0x21,0xF,hid_desc,sizeof(hid_desc));
    libusbd_iface_nonstandard_desc(ctx,iface,0x22,0xF,hid_report_desc,sizeof(hid_report_desc));
    if(libusbd_iface_add_endpoint(ctx,iface,USB_EPATTR_TTYPE_INTR,USB_EP_DIR_IN,8,10,0,&ep)<0 || libusbd_iface_finalize(ctx,iface)<0){fprintf(stderr,"USB interface setup failed\n");goto done;}
    endpoint_ready=true;
    puts("Waiting for USB host enumeration...");
    uint8_t empty[8]={0};int ready=0;
    for(int attempt=0;attempt<30 && !interrupted;attempt++){
        int32_t r=libusbd_ep_write(ctx,iface,ep,empty,sizeof(empty),500);
        if(r>=0){ready=1;break;}
        if(r!=LIBUSBD_NOT_ENUMERATED && r!=LIBUSBD_TIMEOUT){fprintf(stderr,"USB enumeration error: 0x%08x\n",(unsigned)r);break;}
        sleep(1);
    }
    if(!ready){fprintf(stderr,"USB host did not enumerate a keyboard on selected controller. Check data role, cable, and host USB descriptors.\n");goto done;}
    mac2jb_auto_ready();
    puts("Keyboard enumerated. Sending...");fflush(stdout);
    transfer_start=seconds_now();
    size_t sent_lines=0, adjustments=0;
    size_t inherited_indent=0; // Spaces SmileBASIC carries after Enter.
    bool line_start=true;
    for(size_t i=0;i<bytes && !interrupted;) {
        // A Windows CRLF is one Enter; not an extra keypress.
        if(data[i]=='\r' && i+1<bytes && data[i+1]=='\n') { i++; continue; }
        if(line_start) {
            size_t desired=0;
            while(i+desired<bytes && data[i+desired]==' ') desired++;
            // Only delete whitespace that is expected to exist after Enter.
            while(inherited_indent>desired && !interrupted) {
                if(send_stroke(ctx,iface,ep,0,42,delay_ms)<0) {
                    fprintf(stderr,"Backspace failed at line %zu\n",sent_lines+1);
                    goto done;
                }
                inherited_indent--; adjustments++;
            }
            while(inherited_indent<desired && !interrupted) {
                if(send_stroke(ctx,iface,ep,0,44,delay_ms)<0) {
                    fprintf(stderr,"Space failed at line %zu\n",sent_lines+1);
                    goto done;
                }
                inherited_indent++; adjustments++;
            }
            // Spaces have already been added or retained in the editor.
            i += desired;
            line_start=false;
            if(i>=bytes || interrupted) break;
        }
        unsigned char c=data[i++];
        if(c=='\r' && i<bytes && data[i]=='\n') continue;
        Stroke key;
        if(!encode(c,&key) || send_stroke(ctx,iface,ep,key.mods,key.key,delay_ms)<0) {
            fprintf(stderr,"Transfer stopped at input offset %zu; target content may be partial.\n",i-1);
            goto done;
        }
        if(c=='\n') {
            sent_lines++;
            printf("\rSent line %zu",sent_lines); fflush(stdout);
            // Enter carries this line's leading indentation unchanged.
            line_start=true;
        }
    }
    printf("\nindent adjustments: %zu (inherited-space mode)\n", adjustments);
    if(interrupted){fprintf(stderr,"\nInterrupted; target content may be partial.\n");goto done;}
    puts("\nFinished sending. Verify the text on the target before saving it."); result=0;
done:
    if(ctx) {
        if(endpoint_ready) release_all_keys(ctx, iface, ep);
        libusbd_free(ctx);
    }
    if(transfer_start > 0.0) {
        double elapsed=seconds_now()-transfer_start;
        printf("\ntransfer stats: elapsed %.2fs | usb writes %lu (%.2fs) | "
               "pacing %.2fs | retries %lu\n", elapsed, usb_attempts,
               usb_write_seconds, pacing_seconds, usb_retries);
    }
    free(data);return result;
}
