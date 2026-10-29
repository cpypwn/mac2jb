// mac2jb interactive post-bootstrap command sender
// Reuse the exact key encoding, HID helper functions, and USB descriptor
// setup patterns from the project's verified sender.c.
#define main mac2jb_original_sender_main
#include "sender.c"
#undef main

static bool demo_edition = false;
static int start_argument_count = 5;
static int start_port = 39380;
static char save_name[17] = "NS2";
static char load_name[17] = "NS2";
static char load_command[64] = "LOAD \"TXT:NS2\"";
static char save_command[64] = "SAVE \"NS2\"";
static char demo_load_command[128];
static char demo_save_command[256];
static char start_prefix_text[64] = "V=START(39380,";
static const char *steps[] = {
    load_command,
    "RUN",
    "REMOVE NSR,&H60000000,&H3FFFFFFF",
    NULL // Loaded from the currently running ns2jb host
};


// The host wrapper publishes only the currently active session's START line.
// Never fall back to a previous or hardcoded START command.
static int load_active_start(char *destination, size_t capacity) {
    const char *file = "vendor/ns2jb/runs/mac2jb-active-connect.txt";
    FILE *stream = fopen(file, "r");
    if (!stream) {
        fprintf(stderr, "No active ns2jb command at %s\nStart the host with: bash scripts/host.sh\n", file);
        return -1;
    }
    char pidline[40];
    if (!fgets(pidline, sizeof(pidline), stream) ||
        !fgets(destination, (int)capacity, stream)) {
        fclose(stream);
        fprintf(stderr, "Active host command file is incomplete.\n");
        return -1;
    }
    fclose(stream);
    char *end = NULL;
    errno = 0;
    long pid = strtol(pidline, &end, 10);
    if (errno || end == pidline || (*end != '\n' && *end != '\0') ||
        pid <= 1 || pid > 2147483647L || (kill((pid_t)pid, 0) != 0 && errno != EPERM)) {
        fprintf(stderr, "The recorded ns2jb host is no longer running. Restart bash scripts/host.sh.\n");
        return -1;
    }
    size_t n = strcspn(destination, "\r\n");
    if (destination[n] != '\0' && destination[n+1] != '\0') {
        fprintf(stderr, "Invalid active host command.\n"); return -1;
    }
    destination[n] = '\0';
    if (strncmp(destination, "V=START(", 8) != 0 || n < 10 || destination[n-1] != ')') {
        fprintf(stderr, "Invalid V=START command supplied by host.\n");
        return -1;
    }
    // GUI host selection may opt into the original four-token pairing protocol.
    // The legacy CLI and default profile continue to require exactly five values.
    const char *p = destination + 8;
    for (int i = 0; i < start_argument_count; i++) {
        if (*p < '0' || *p > '9' || (*p == '0' && p[1] >= '0' && p[1] <= '9')) return -1;
        errno = 0;
        char *next;
        unsigned long long value = strtoull(p, &next, 10);
        if (errno == ERANGE || next == p ||
            (i == 0 && value != (unsigned long long)start_port) ||
            (i >= 1 && i <= 4 && value > 255) ||
            (i >= 5 && value > 281474976710655ULL) ||
            (i < start_argument_count - 1 && *next != ',') ||
            (i == start_argument_count - 1 && *next != ')')) {
            fprintf(stderr, "Invalid V=START parameter %d.\n", i+1);
            return -1;
        }
        p = next + 1;
    }
    if (*p != '\0') return -1;
    return 0;
}

static bool approve(const char *message) {
    char buf[40];
    printf("\n%s\nPress Enter to continue (type anything to cancel): ", message);
    fflush(stdout);
    if (!fgets(buf, sizeof(buf), stdin)) return false;
    return buf[0] == '\n' || buf[0] == '\r';
}

#ifdef MAC2JB_GUI
// The native GUI build opts into timing controls and structured progress.
// A normal `make` retains the v0.2.1 command-line behavior below.
static int manual_start(const char *text, char *destination, size_t capacity) {
    size_t length=strlen(text);
    if (length>=capacity || length<10 || strncmp(text,"V=START(",8) || text[length-1]!=')') return -1;
    const char *p=text+8;
    for (int i=0;i<start_argument_count;i++) {
        if (*p<'0' || *p>'9' || (*p=='0' && p[1]>='0' && p[1]<='9')) return -1;
        char *next; errno=0; unsigned long long value=strtoull(p,&next,10);
        if (errno || next==p || (i==0 ? value!=(unsigned long long)start_port : i<5 ? value>255 : value>281474976710655ULL) ||
            (i<start_argument_count-1 ? *next!=',' : *next!=')')) return -1;
        p=next+1;
    }
    if (*p) return -1;
    memcpy(destination,text,length+1);return 0;
}
static int gui_selection[4]={0,1,2,3},gui_command_count=4;
static bool gui_start_prefix=false;
static bool gui_save_bootstrap=false;
static bool valid_program_name(const char *name) {
    size_t length = strlen(name);
    if (length < 1 || length > 16) return false;
    for (const unsigned char *p = (const unsigned char *)name; *p; ++p)
        if (!((*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '_')) return false;
    return true;
}
static int command_selection(const char *text) {
    const char *names[]={"load","run","remove","start"};
    const char *p=text;int count=0,previous=-1;
    if (!*p) return -1;
    for (;;) {
        size_t length=strcspn(p,",");int selected=-1;
        for (int i=0;i<4;i++) if (strlen(names[i])==length && !strncmp(p,names[i],length)) selected=i;
        if (selected<=previous || count>=4) return -1;
        gui_selection[count++]=selected;previous=selected;p+=length;
        if (!*p) break;
        p++;if (!*p) return -1;
    }
    gui_command_count=count;return 0;
}
static bool gui_events = false;
static int gui_load_wait_ms = 1000, gui_run_wait_ms = 0;
static int gui_remove_wait_ms = 0, gui_load_confirm_wait_ms = 0;
static int gui_enumeration_seconds = 4;
static const char *gui_command_names[] = {"LOAD", "RUN", "REMOVE", "START"};
static void gui_command_event(const char *type, int step) {
    if (!gui_events) return;
    printf("MAC2JB_GUI {\"type\":\"%s\",\"step\":%d,\"completed\":%d,\"total\":%d,\"label\":\"%s\"}\n",
           type, step, strcmp(type, "command-complete") == 0 ? step : step-1,
           gui_command_count,gui_save_bootstrap ? "SAVE" : gui_command_names[gui_selection[step-1]]);
    fflush(stdout);
}
static void gui_prefix_event(int step) {
    if (!gui_events) return;
    printf("MAC2JB_GUI {\"type\":\"command-prefix-complete\",\"step\":%d,\"completed\":%d,\"total\":%d,\"label\":\"START\",\"prefix\":\"%s\",\"startPending\":true}\n",step,step-1,gui_command_count,start_prefix_text);
    fflush(stdout);
}
static int gui_wait(int milliseconds, const char *label, int completed) {
    if (milliseconds == 0) return interrupted ? -1 : 0;
    double deadline = seconds_now() + (double)milliseconds / 1000.0;
    for (;;) {
        double left = deadline - seconds_now();
        int remaining = left > 0 ? (int)(left * 1000.0 + 0.999) : 0;
        if (gui_events) {
            printf("MAC2JB_GUI {\"type\":\"wait\",\"completed\":%d,\"total\":%d,\"label\":\"%s\",\"remainingMs\":%d,\"durationMs\":%d}\n",
                   completed, gui_command_count,label, remaining, milliseconds);
            fflush(stdout);
        }
        if (interrupted) return -1;
        if (remaining == 0) return 0;
        int tick = remaining < 100 ? remaining : 100;
        struct timespec pause = {0, (long)tick * 1000000L};
        nanosleep(&pause, NULL);
    }
}
static int gui_milliseconds(const char *text, int maximum, int *destination) {
    char *end = NULL; errno = 0;
    long value = strtol(text, &end, 10);
    if (errno || end == text || *end || value < 0 || value > maximum) return -1;
    *destination = (int)value; return 0;
}
static int gui_timing_test(void) {
    const int waits[] = {gui_load_wait_ms, gui_run_wait_ms, gui_remove_wait_ms};
    for (int step=1; step<=gui_command_count && !interrupted; step++) {
        int selected=gui_selection[step-1];
        gui_command_event("command-start", step);
        if (selected==3 && gui_start_prefix) gui_prefix_event(step);
        else gui_command_event("command-complete", step);
        if (selected == 0 && gui_wait(gui_load_confirm_wait_ms, "LOAD confirmation", step)<0) return 1;
        if ((selected == 0 || step < gui_command_count) && gui_wait(waits[selected], gui_command_names[selected], step)<0) return 1;
    }
    return interrupted ? 1 : 0;
}
#endif

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

#ifdef MAC2JB_GUI
static int type_selected(libusbd_ctx_t *ctx, uint8_t iface, uint64_t ep, int delay_ms, bool automatic) {
    const int waits[]={gui_load_wait_ms,gui_run_wait_ms,gui_remove_wait_ms};
    if (gui_events) {
        printf("MAC2JB_GUI {\"type\":\"typing\",\"completed\":0,\"total\":%d}\n",gui_command_count);fflush(stdout);
    }
    for (int position=0;position<gui_command_count && !interrupted;position++) {
        int selected=gui_selection[position],step=position+1;
        gui_command_event("command-start",step);
        if (!automatic) {
            char prompt[640];snprintf(prompt,sizeof(prompt),"STEP %d/%d: Focus SmileBASIC Direct mode. Send %s?",step,gui_command_count,steps[selected]);
            if (!approve(prompt)) return 1;
        }
        if (selected==3 && gui_start_prefix) {
            puts("Typing the START prefix. Enter will not be sent.");fflush(stdout);
            for (const unsigned char *p=(const unsigned char *)start_prefix_text;*p;p++) {
                Stroke stroke;
                if (!encode(*p,&stroke) || interrupted || send_stroke(ctx,iface,ep,stroke.mods,stroke.key,delay_ms)<0) return 1;
            }
            if (interrupted) return 1;
            gui_prefix_event(step);continue;
        }
        if (type_and_submit(ctx,iface,ep,steps[selected],delay_ms)<0) return 1;
        gui_command_event("command-complete",step);
        if (selected==0) {
            puts(demo_edition ? "Confirming SmileBASIC LOADV prompt (OK) with Enter..." : "Confirming SmileBASIC LOAD prompt (YES) with Enter...");fflush(stdout);
            if (gui_wait(gui_load_confirm_wait_ms,"LOAD confirmation",step)<0 || interrupted ||
                send_stroke(ctx,iface,ep,0,40,delay_ms)<0) return 1;
            release_all_keys(ctx,iface,ep);
            if (gui_wait(gui_load_wait_ms,"LOAD",step)<0) return 1;
        }
        if (automatic && selected!=0 && step<gui_command_count && gui_wait(waits[selected],gui_command_names[selected],step)<0) return 1;
    }
    return interrupted ? 1 : 0;
}
#endif

int main(int argc, char **argv) {
    int delay_ms=10;
    bool dry_run=false;
    bool automatic=false;
#ifdef MAC2JB_GUI
    bool timing_test=false;
    bool start_arity_set=false;
    const char *selection_text=NULL,*start_command=NULL;
    gui_enumeration_seconds=mac2jb_gui_enumeration_timeout();
    if(gui_enumeration_seconds<0) return 2;
#endif

    for (int a=1; a<argc; a++) {
        if (strcmp(argv[a], "--dry-run") == 0) dry_run=true;
        else if (strcmp(argv[a], "--auto") == 0) automatic=true;
        else if (strcmp(argv[a], "--demo") == 0) {
            demo_edition=true;
            steps[0]="PRGEDIT 0:LOADV \"TXT:NS2\" OUT C$:PRGSET C$";
        }
        else if (strcmp(argv[a], "--delay-ms") == 0 && a+1<argc) {
            char *end=NULL;
            long value=strtol(argv[++a], &end, 10);
            if (!end || *end || value<1 || value>2000) {
                fprintf(stderr, "delay must be between 1 and 2000 ms\n");
                return 2;
            }
            delay_ms=(int)value;
        }
#ifdef MAC2JB_GUI
        else if (strcmp(argv[a], "--gui-events") == 0) gui_events=true;
        else if (strcmp(argv[a], "--start-arity") == 0 && a+1<argc) {
            const char *value=argv[++a];
            if (start_arity_set || (strcmp(value,"5") && strcmp(value,"9"))) {
                fputs("--start-arity requires exactly one supported host arity (5 or 9).\n",stderr);return 2;
            }
            start_argument_count=!strcmp(value,"9") ? 9 : 5;start_arity_set=true;
        }
        else if (strcmp(argv[a], "--gui-timing-test") == 0) timing_test=true;
        else if (strcmp(argv[a], "--save-bootstrap") == 0) {
            if (gui_save_bootstrap) { fputs("Duplicate --save-bootstrap.\n",stderr); return 2; }
            gui_save_bootstrap=true;
        }
        else if (strcmp(argv[a],"--start-prefix")==0) {
            if (gui_start_prefix) { fputs("Duplicate --start-prefix.\n",stderr); return 2; }
            gui_start_prefix=true;
        }
        else if (!strcmp(argv[a], "--start-port") && a+1<argc) {
            char *end=NULL;long value=strtol(argv[++a],&end,10);
            if (!end || *end || value<1024 || value>65535) {fputs("--start-port must be 1024..65535.\n",stderr);return 2;}
            start_port=(int)value;
        }
        else if (!strcmp(argv[a], "--save-name") && a+1<argc) {
            const char *value=argv[++a];
            if (!valid_program_name(value)) {fputs("--save-name must contain 1..16 uppercase letters, digits or underscores.\n",stderr);return 2;}
            snprintf(save_name,sizeof(save_name),"%s",value);
        }
        else if (!strcmp(argv[a], "--load-name") && a+1<argc) {
            const char *value=argv[++a];
            if (!valid_program_name(value)) {fputs("--load-name must contain 1..16 uppercase letters, digits or underscores.\n",stderr);return 2;}
            snprintf(load_name,sizeof(load_name),"%s",value);
        }
        else if ((!strcmp(argv[a],"--commands") || !strcmp(argv[a],"--start-command")) && a+1<argc) {
            const char *option=argv[a];const char **destination=!strcmp(option,"--commands") ? &selection_text : &start_command;
            if (*destination) { fprintf(stderr,"Duplicate %s.\n",option); return 2; }
            *destination=argv[++a];
        }
        else if ((!strcmp(argv[a], "--load-wait-ms") || !strcmp(argv[a], "--run-wait-ms") ||
                  !strcmp(argv[a], "--remove-wait-ms") || !strcmp(argv[a], "--load-confirm-wait-ms") ||
                  !strcmp(argv[a], "--enumeration-timeout")) && a+1<argc) {
            const char *option = argv[a];
            int *destination = !strcmp(option, "--load-wait-ms") ? &gui_load_wait_ms :
                !strcmp(option, "--run-wait-ms") ? &gui_run_wait_ms :
                !strcmp(option, "--remove-wait-ms") ? &gui_remove_wait_ms :
                !strcmp(option, "--load-confirm-wait-ms") ? &gui_load_confirm_wait_ms : &gui_enumeration_seconds;
            int maximum = destination == &gui_enumeration_seconds ? 120 : 120000;
            if (gui_milliseconds(argv[++a], maximum, destination)<0 ||
                (destination == &gui_enumeration_seconds && *destination < 1)) {
                fprintf(stderr, "invalid value for %s\n", option); return 2;
            }
        }
#endif
        else if (!strcmp(argv[a], "--help") || !strcmp(argv[a], "-h")) {
            puts("usage: ./mac2jb-commands [--auto] [--demo] [--dry-run] [--delay-ms N]");
#ifdef MAC2JB_GUI
            puts("GUI build: [--gui-events] [--enumeration-timeout 1..120] [--load-confirm-wait-ms N] [--load-wait-ms N] [--run-wait-ms N] [--remove-wait-ms N]");
            puts("Developer option: --commands load,run,remove,start selects a nonempty ordered subset; selected START requires --start-command with the exact host command. --start-arity 5|9 selects its pinned protocol (default 5).");
            puts("--start-prefix instead types only V=START(39380, without Enter, for manual completion.");
            puts("--save-bootstrap types only the edition's fixed SAVE command and one Enter from Direct mode; confirm any save prompt on the Switch.");
#endif
            return 0;
        } else {
            fprintf(stderr, "unknown argument: %s\n", argv[a]);
            return 2;
        }
    }
    char session_start[512] = {0};
#ifdef MAC2JB_GUI
    snprintf(load_command,sizeof(load_command),"LOAD \"TXT:%s\"",load_name);
    snprintf(save_command,sizeof(save_command),"SAVE \"%s\"",save_name);
    snprintf(demo_load_command,sizeof(demo_load_command),"PRGEDIT 0:LOADV \"TXT:%s\" OUT C$:PRGSET C$",load_name);
    snprintf(demo_save_command,sizeof(demo_save_command),"PRGEDIT 0:C$=\"\":FOR I=0 TO PRGSIZE(0)-1:C$=C$+PRGGET$() :NEXT:SAVEV \"TXT:%s\",C$",save_name);
    snprintf(start_prefix_text,sizeof(start_prefix_text),"V=START(%d,",start_port);
    steps[0]=load_command;
    if (demo_edition) steps[0]=demo_load_command;
    if (gui_save_bootstrap) {
        if (selection_text || start_command || gui_start_prefix || timing_test) {
            fputs("--save-bootstrap cannot be combined with command selection, START options or timing tests.\n",stderr); return 2;
        }
        gui_command_count=1;
        steps[0]=demo_edition ? demo_save_command : save_command;
    }
    if (selection_text && command_selection(selection_text)<0) {
        fputs("--commands requires a nonempty unique subset in load,run,remove,start order.\n",stderr); return 2;
    }
    bool selected_start=selection_text && gui_selection[gui_command_count-1]==3;
    if ((start_command && gui_start_prefix) || ((start_command || gui_start_prefix) && !selected_start) ||
        (selected_start && !start_command && !gui_start_prefix) ||
        (start_command && manual_start(start_command,session_start,sizeof(session_start))<0)) {
        fputs("Selected START requires exactly one of --start-prefix or --start-command with the exact selected host command; leave START unselected to type it yourself.\n",stderr); return 2;
    }
    if (timing_test) {
        signal(SIGINT,on_interrupt); signal(SIGTERM,on_interrupt);
        return gui_timing_test(); // Protocol check only: never initializes USB.
    }
    if (gui_save_bootstrap) {
        puts("Saving the current bootstrap only. No active host record was read.");
    } else if (selection_text) {
        if (selected_start) steps[3]=gui_start_prefix ? start_prefix_text : session_start;
        puts("Using only the selected commands. No active host record was read.");
    } else
#endif
    if (!dry_run) {
        if (load_active_start(session_start, sizeof(session_start)) != 0) return 1;
        steps[3] = session_start;
        puts("Loaded V=START from the active ns2jb host session.");
    } else {
        steps[3] = "V=START(<generated for each host session>)";
    }
    for (size_t i=0; i<4; ++i) {
#ifdef MAC2JB_GUI
        if (gui_save_bootstrap && i > 0) continue;
        if (selection_text) {
            bool included=false;for (int position=0;position<gui_command_count;position++) if (gui_selection[position]==(int)i) included=true;
            if (!included) continue;
        }
#endif
        if (dry_run && i == 3) continue;
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
#ifdef MAC2JB_GUI
        if (gui_save_bootstrap) {
            printf("1: %s [Enter]\n",steps[0]);
            puts("No extra Enter is sent. Confirm any save or overwrite prompt on the Switch.");
        } else if (selection_text) {
            for (int position=0;position<gui_command_count;position++) printf("%d: %s %s\n",position+1,steps[gui_selection[position]],gui_selection[position]==3 && gui_start_prefix ? "[no Enter; finish manually]" : "[Enter]");
            if (gui_selection[0]==0) puts(demo_edition ? "LOADV receives one additional Enter to accept its OK confirmation." : "LOAD receives one additional Enter to accept its YES confirmation.");
        } else
#endif
        {
            for (size_t i=0; i<4; ++i) printf("%zu: %s [Enter]\n", i+1, steps[i]);
            puts(demo_edition ? "LOADV receives one additional Enter to accept its OK confirmation before RUN." : "LOAD receives one additional Enter to accept its YES confirmation before RUN.");
        }
        return 0;
    }

    puts("mac2jb post-bootstrap command sender");
    puts("This sends keyboard input only; it does not start run.cjs on the Mac.");
    puts("Each approved command is submitted with Enter, in order.");
    const char *first_prompt="First, start run.cjs on your Mac; open fresh SmileBASIC and focus its Direct-mode command entry.";
#ifdef MAC2JB_GUI
    if (gui_save_bootstrap) first_prompt="Keep the complete bootstrap in slot 0 and focus SmileBASIC Direct mode. Only the SAVE command will be sent.";
    else if (selection_text) first_prompt="Selected commands only: open fresh SmileBASIC and focus its Direct-mode command entry. No host will be started or checked.";
    else
#endif
    puts("Keep the macOS host running in a separate Terminal window.");
    if (!getenv("MAC2JB_AUTO_WORKER") && !approve(first_prompt))
        return 1;

    if (!getenv("MAC2JB_AUTO_WORKER")) {
        int automatic=mac2jb_auto_dispatch(argv);
        if (automatic>=0) return automatic;
    }
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
#ifdef MAC2JB_GUI
        double deadline = seconds_now() + gui_enumeration_seconds;
        while (!interrupted && seconds_now() < deadline) {
#else
        for (int attempt=0;attempt<30 && !interrupted;attempt++) {
#endif
            int32_t r=libusbd_ep_write(ctx,iface,ep,empty,sizeof(empty),500);
            if (r>=0) { ready=true; break; }
            if (r!=LIBUSBD_NOT_ENUMERATED && r!=LIBUSBD_TIMEOUT) {
                fprintf(stderr,"USB enumeration error 0x%08x\n",(unsigned)r); break;
            }
#ifdef MAC2JB_GUI
            struct timespec retry_pause = {0,100000000L}; nanosleep(&retry_pause,NULL);
#else
            sleep(1);
#endif
        }
        if (!ready) { fprintf(stderr,"USB host did not enumerate a keyboard\n"); goto done; }
    }

    mac2jb_auto_ready();
#ifdef MAC2JB_GUI
    if (gui_save_bootstrap) {
        if (gui_events) { puts("MAC2JB_GUI {\"type\":\"typing\",\"kind\":\"save-bootstrap\",\"completed\":0,\"total\":1}"); fflush(stdout); }
        gui_command_event("command-start",1);
        if (!automatic && !approve("STEP 1/1: Focus SmileBASIC Direct mode. Send the bootstrap SAVE command?")) goto done;
        if (type_and_submit(ctx,iface,ep,steps[0],delay_ms)<0 || interrupted) goto done;
        gui_command_event("command-complete",1);
        puts("SAVE command submitted. Confirm any save or overwrite prompt on the Switch; no extra Enter was sent.");
        result=0;
        goto done;
    }
    if (selection_text) {
        result=type_selected(ctx,iface,ep,delay_ms,automatic);
        if (!result) puts(gui_start_prefix ? "Selected commands typed. Finish START manually; Enter has not been sent. No host was started or result checked." :
            "Selected commands sent. No host was started and no exploit result was checked.");
        goto done;
    }
    if (gui_events) { puts("MAC2JB_GUI {\"type\":\"typing\",\"completed\":0,\"total\":4}"); fflush(stdout); }
    gui_command_event("command-start",1);
#endif
    if (!automatic && !approve(
        demo_edition ? "STEP 1/4: Focus SmileBASIC Direct mode. Load NS2 with LOADV?" :
        "STEP 1/4: Focus SmileBASIC Direct mode. Send LOAD \"TXT:NS2\"?")) goto done;
    if (type_and_submit(ctx,iface,ep,steps[0],delay_ms)<0) goto done;
#ifdef MAC2JB_GUI
    gui_command_event("command-complete",1);
#endif
    // Full LOAD asks for YES; demo LOADV asks for OK before RUN can be typed.
    puts(demo_edition ? "Confirming SmileBASIC LOADV prompt (OK) with Enter..." : "Confirming SmileBASIC LOAD prompt (YES) with Enter...");
    fflush(stdout);
#ifdef MAC2JB_GUI
    if (gui_wait(gui_load_confirm_wait_ms,"LOAD confirmation",1)<0) goto done;
#endif
    if (interrupted || send_stroke(ctx, iface, ep, 0, 40, delay_ms)<0) goto done;
    release_all_keys(ctx, iface, ep);
#ifdef MAC2JB_GUI
    if (gui_wait(gui_load_wait_ms,"LOAD",1)<0) goto done;
    gui_command_event("command-start",2);
#else
    sleep(1);
#endif
    if (!automatic && !approve("STEP 2/4: Confirm the bootstrap loaded into slot 0. Send RUN?")) goto done;
    if (type_and_submit(ctx,iface,ep,steps[1],delay_ms)<0) goto done;
#ifdef MAC2JB_GUI
    gui_command_event("command-complete",2);
    if (automatic && gui_wait(gui_run_wait_ms,"RUN",2)<0) goto done;
    gui_command_event("command-start",3);
#endif
    if (!automatic && !approve("STEP 3/4: Wait until RUN finishes. Send REMOVE NSR,...?")) goto done;
    if (type_and_submit(ctx,iface,ep,steps[2],delay_ms)<0) goto done;
#ifdef MAC2JB_GUI
    gui_command_event("command-complete",3);
    if (automatic && gui_wait(gui_remove_wait_ms,"REMOVE",3)<0) goto done;
    gui_command_event("command-start",4);
#endif
    if (!automatic && !approve("STEP 4/4: Confirm expected Out of memory, then send V=START?")) goto done;
    if (type_and_submit(ctx,iface,ep,steps[3],delay_ms)<0) goto done;
#ifdef MAC2JB_GUI
    gui_command_event("command-complete",4);
#endif
    puts("All four commands sent. Check the console and macOS host for actual results.");
    result=0;
done:
    if (ctx) {
        if (endpoint_ready) release_all_keys(ctx,iface,ep);
        libusbd_free(ctx);
    }
    return result;
}
