#include <assert.h>
#define libusbd_ep_write diagnostic_mock_write
#define nanosleep diagnostic_mock_sleep
#define libusbd_iface_add_endpoint diagnostic_mock_add_endpoint
#define main diagnostic_sender_main
#include "../sender.c"
#undef main
static int events[64], count;
static int recorded_interval;
int diagnostic_mock_add_endpoint(libusbd_ctx_t *ctx, uint8_t iface, uint8_t type, uint8_t direction, uint32_t size, uint8_t interval, uint64_t unk, uint64_t *ep) {
    (void)ctx; (void)iface; (void)unk; (void)ep;
    assert(type == USB_EPATTR_TTYPE_INTR && direction == USB_EP_DIR_IN && size == 8);
    recorded_interval = interval; return 0;
}
int diagnostic_mock_write(libusbd_ctx_t *ctx, uint8_t iface, uint64_t ep, const void *data, uint32_t len, uint64_t timeout) {
    (void)ctx; (void)iface; (void)ep; (void)timeout; assert(len == 8);
    events[count++] = 10000 + ((const uint8_t *)data)[2]; return 0;
}
int diagnostic_mock_sleep(const struct timespec *req, struct timespec *rem) {
    (void)rem; events[count++] = (int)(req->tv_sec * 1000 + req->tv_nsec / 1000000); return 0;
}
static void expect(const int *wanted, int n) { assert(count == n); for(int i=0;i<n;i++) assert(events[i]==wanted[i]); count=0; }
int main(void) {
    assert(send_stroke(NULL,0,0,0,4,10)==0);
    expect((int[]){10004,10000,10},3);
    key_hold_ms=20; enter_settle_ms=150;
    assert(send_stroke(NULL,0,0,0,4,10)==0);
    expect((int[]){10004,20,10000,10},4);
    assert(send_stroke(NULL,0,0,0,40,10)==0);
    expect((int[]){10040,20,10000,10,150},5);
    assert(send_stroke(NULL,0,0,0,4,10)==0);
    expect((int[]){10004,20,10000,10},4);
    for (int i=1;i<=16;i++) {
        poll_interval=i; assert(add_keyboard_endpoint(NULL,0,NULL)==0);
        assert(recorded_interval==i);
    }
    unsetenv("MAC2JB_POLL_INTERVAL"); assert(read_usb_timing()==0 && poll_interval==10);
    const char *names[] = {"MAC2JB_KEY_HOLD_MS", "MAC2JB_ENTER_SETTLE_MS", "MAC2JB_POLL_INTERVAL"};
    for (int k=0;k<3;k++) {
        const char *bad[] = {"", "-1", "abc", "1.5", " 1", "99999999999999999999999999"};
        for (int j=0;j<6;j++) {
            setenv(names[k], bad[j], 1); assert(read_usb_timing()<0); unsetenv(names[k]);
        }
        setenv(names[k], k==2 ? "17" : "2001", 1); assert(read_usb_timing()<0); unsetenv(names[k]);
    }
    setenv("MAC2JB_POLL_INTERVAL", "0", 1); assert(read_usb_timing()<0); unsetenv("MAC2JB_POLL_INTERVAL");
    setenv("MAC2JB_KEY_HOLD_MS", "2000", 1); setenv("MAC2JB_ENTER_SETTLE_MS", "2000", 1);
    setenv("MAC2JB_POLL_INTERVAL", "16", 1); assert(read_usb_timing()==0);
    assert(key_hold_ms==2000 && enter_settle_ms==2000 && poll_interval==16);
    for (int k=0;k<3;k++) unsetenv(names[k]);
    assert(read_usb_timing()==0 && key_hold_ms==0 && enter_settle_ms==0 && poll_interval==10);
    puts("PASS:4 exact event-order cases +17 endpoint/default cases; USB and waits mocked; no USB inputs.");
}
