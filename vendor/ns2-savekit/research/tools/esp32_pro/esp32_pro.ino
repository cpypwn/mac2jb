// Nintendo Switch Pro Controller (NS1) USB persona for the home menu.
//
//   GET /pro?a=1&down=1&ms=150      press buttons for ms
//   GET /pro?mask=0x0008&raw=1      raw bits, hold until changed
//   GET /usb                        link + handshake diagnostics
//   GET /status                     {"ok":true,...}
//
// The console only drives USB controllers it has a driver for, and the Pro
// Controller is the one it is built around. Identity: 057E:2009, strings
// "Nintendo Co., Ltd." / "Pro Controller", the 203-byte report descriptor a real
// controller reports (espp's hid-rp emits the same items with 2-byte usage
// min/max, 209 bytes). Device, configuration and string descriptors are
// replaced wholesale below so the console sees what a real pad enumerates as.
//
// Protocol (host -> device 0x80/0x01/0x10, device -> host 0x81/0x21/0x30),
// following espp::SwitchPro, which follows dekuNukem and nxbt:
//
//   attach            nothing; the console starts with 0x80 0x05 / 0x80 0x01
//                     (/usb?announce=1 sends an unsolicited 0x81 device info)
//   host 0x80 0x01    reply 0x81 with device info
//   host 0x80 0x02    reply 0x81 echoing the payload (handshake)
//   host 0x80 0x04    enable USB HID -> start streaming 0x30 input reports
//   host 0x01 ...     subcommand -> reply 0x21: [12]=ACK [13]=subcommand [14..]=data
//                     (0x01 = Bluetooth pairing, sent over USB on first attach)
//   host 0x10         rumble only, no reply
//
// All reports are 63-byte payloads; the report id makes them 64 on the wire.
//
// Build with -Wl,--wrap=tud_hid_set_report_cb -Wl,--wrap=tud_hid_get_report_cb
// (compiler.c.elf.extra_flags); without it the core drops the host's writes.
// In games the pad must be Player 1 (Change Grip/Order, L+R).
#include <WiFi.h>
#include <WebServer.h>
#include <USB.h>
#include <USBHID.h>
#include <ArduinoOTA.h>
#include "driver/uart.h"
#include "driver/gpio.h"
#include "esp_rom_sys.h"

#include "wifi_secret.h"
static const char *SSID = WIFI_SSID;
static const char *PASS = WIFI_PASS;

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
struct FlipRes { bool heartbeat, baudOk, rpcOk; };

static const u8 pro_report_desc[] = {
    0x05,0x01,0x15,0x00,0x09,0x04,0xA1,0x01,0x85,0x30,0x05,0x01,0x05,0x09,0x19,0x01,
    0x29,0x0A,0x15,0x00,0x25,0x01,0x75,0x01,0x95,0x0A,0x55,0x00,0x65,0x00,0x81,0x02,
    0x05,0x09,0x19,0x0B,0x29,0x0E,0x15,0x00,0x25,0x01,0x75,0x01,0x95,0x04,0x81,0x02,
    0x75,0x01,0x95,0x02,0x81,0x03,0x0B,0x01,0x00,0x01,0x00,0xA1,0x00,0x0B,0x30,0x00,
    0x01,0x00,0x0B,0x31,0x00,0x01,0x00,0x0B,0x32,0x00,0x01,0x00,0x0B,0x35,0x00,0x01,
    0x00,0x15,0x00,0x27,0xFF,0xFF,0x00,0x00,0x75,0x10,0x95,0x04,0x81,0x02,0xC0,0x0B,
    0x39,0x00,0x01,0x00,0x15,0x00,0x25,0x07,0x35,0x00,0x46,0x3B,0x01,0x65,0x14,0x75,
    0x04,0x95,0x01,0x81,0x02,0x05,0x09,0x19,0x0F,0x29,0x12,0x15,0x00,0x25,0x01,0x75,
    0x01,0x95,0x04,0x81,0x02,0x75,0x08,0x95,0x34,0x81,0x03,0x06,0x00,0xFF,0x85,0x21,
    0x09,0x01,0x75,0x08,0x95,0x3F,0x81,0x03,0x85,0x81,0x09,0x02,0x75,0x08,0x95,0x3F,
    0x81,0x03,0x85,0x01,0x09,0x03,0x75,0x08,0x95,0x3F,0x91,0x83,0x85,0x10,0x09,0x04,
    0x75,0x08,0x95,0x3F,0x91,0x83,0x85,0x80,0x09,0x05,0x75,0x08,0x95,0x3F,0x91,0x83,
    0x85,0x82,0x09,0x06,0x75,0x08,0x95,0x3F,0x91,0x83,0xC0,
};
static_assert(sizeof(pro_report_desc) == 203, "real Pro Controller descriptor is 203 bytes");

// Real Pro Controller enumeration (lsusb -v -d 057e:2009). The Arduino core
// would otherwise send class 0xEF/IAD, self-powered, bInterval 1, OUT before
// IN, and an "TinyUSB HID" interface string. These callbacks are weak in core.
static const tusb_desc_device_t pro_device_desc = {
  .bLength = sizeof(tusb_desc_device_t), .bDescriptorType = TUSB_DESC_DEVICE,
  .bcdUSB = 0x0200, .bDeviceClass = 0x00, .bDeviceSubClass = 0x00, .bDeviceProtocol = 0x00,
  .bMaxPacketSize0 = 64, .idVendor = 0x057E, .idProduct = 0x2009, .bcdDevice = 0x0210,
  .iManufacturer = 1, .iProduct = 2, .iSerialNumber = 3, .bNumConfigurations = 1,
};
static const u8 pro_config_desc[] = {
  0x09, 0x02, 41, 0x00, 0x01, 0x01, 0x00, 0xA0, 0xFA,        // config: bus powered, remote wakeup, 500 mA
  0x09, 0x04, 0x00, 0x00, 0x02, 0x03, 0x00, 0x00, 0x00,      // interface 0: HID, no string
  0x09, 0x21, 0x11, 0x01, 0x00, 0x01, 0x22, 203, 0x00,       // HID 1.11, report descriptor 203 B
  0x07, 0x05, 0x81, 0x03, 0x40, 0x00, 0x08,                  // EP1 IN  interrupt 64 B, 8 ms
  0x07, 0x05, 0x01, 0x03, 0x40, 0x00, 0x08,                  // EP1 OUT interrupt 64 B, 8 ms
};

static volatile uint32_t devRequests = 0, cfgRequests = 0;
extern "C" const uint8_t *tud_descriptor_device_cb(void) { devRequests++; return (const uint8_t *)&pro_device_desc; }
extern "C" const uint8_t *tud_descriptor_configuration_cb(uint8_t index) { cfgRequests++; return pro_config_desc; }
extern "C" const uint16_t *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
  static uint16_t buf[32];
  static const char *strs[] = {nullptr, "Nintendo Co., Ltd.", "Pro Controller", "000000000001"};
  uint8_t n;
  if (index == 0) { buf[1] = 0x0409; n = 1; }
  else if (index < 4) {
    const char *str = strs[index];
    for (n = 0; str[n] && n < 31; n++) buf[1 + n] = str[n];
  } else return nullptr;
  buf[0] = (TUSB_DESC_STRING << 8) | (2 * n + 2);
  return buf;
}

// Every OUT / SET_REPORT straight from TinyUSB, before the core's report-id
// lookup (which silently drops ids it did not register). Linked with
// -Wl,--wrap=tud_hid_set_report_cb,--wrap=tud_hid_get_report_cb.
static volatile uint32_t rawSet = 0, rawGet = 0;
static void onHostBytes(uint8_t report_id, const u8 *buffer, uint16_t len);
extern "C" void __real_tud_hid_set_report_cb(uint8_t, uint8_t, hid_report_type_t, const uint8_t *, uint16_t);
extern "C" uint16_t __real_tud_hid_get_report_cb(uint8_t, uint8_t, hid_report_type_t, uint8_t *, uint16_t);
extern "C" void __wrap_tud_hid_set_report_cb(uint8_t itf, uint8_t report_id, hid_report_type_t type,
                                             const uint8_t *buffer, uint16_t len) {
  rawSet++;
  if (report_id == 0 && len > 0) onHostBytes(buffer[0], buffer + 1, len - 1);  // interrupt OUT: id inline
  else onHostBytes(report_id, buffer, len);
}
extern "C" uint16_t __wrap_tud_hid_get_report_cb(uint8_t itf, uint8_t report_id, hid_report_type_t type,
                                                 uint8_t *buffer, uint16_t len) {
  rawGet++;
  return __real_tud_hid_get_report_cb(itf, report_id, type, buffer, len);
}

// SPI flash banks the console reads for calibration (0x60 factory, 0x80 user).
static const u8 spi60[] = {
    0x00,0x80,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,
    0xFF,0xFF,0x10,0xFF,0xFF,0x03,0xA0,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x02,0x01,
    0xFF,0xFF,0xFF,0xFF,0x20,0xF0,0xFF,0x89,0x00,0xF0,0x01,0x00,0x40,0x00,0x40,0x00,
    0x40,0xF9,0xFF,0x06,0x00,0x09,0x00,0xE7,0x3B,0xE7,0x3B,0xE7,0x3B,0x38,0x3C,0xFF,
    0xFF,0xFF,0xFF,0xFF,0x3D,0xFF,0xF7,0x7F,0x00,0x08,0x80,0x00,0x08,0x80,0x00,0x08,
    0x80,0x00,0x08,0x80,0xFF,0xF7,0x7F,0x4F,0xFF,0x50,0x82,0x82,0x82,0x0F,0x0F,0x0F,
    0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x60,0xFF,0xFF,0xFF,0xFF,0xFF,
    0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x70,0xFF,0xFF,0xFF,0xFF,
    0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x80,0x50,0xFD,0x00,
    0x00,0xC6,0x0F,0x0F,0x30,0x61,0x96,0x30,0xF3,0xD4,0x14,0x54,0x41,0x15,0x54,0xC7,
    0x79,0x9C,0x33,0x36,0x63,0x0F,0x30,0x61,0x96,0x30,0xF3,0xD4,0x14,0x54,0x41,0x15,
    0x54,0xC7,0x79,0x9C,0x33,0x36,0x63,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,
};
static const u8 spi80[] = {
    0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,
    0xB2,0xA1,0xFF,0xF7,0x7F,0x00,0x08,0x80,0x00,0x00,0x00,0xB2,0xA1,0xFF,0xF7,0x7F,
    0x00,0x08,0x80,0x00,0x00,0x00,0xB2,0xA1,0xBE,0xFF,0x3E,0x00,0xF0,0x01,0x00,0x40,
    0x00,0x40,0x00,0x40,0xFE,0xFF,0xFE,0xFF,0x08,0x00,0xE7,0x3B,0xE7,0x3B,0xE7,0x3B,
};

#define DEVICE_INIT_REPORT  0x81
#define HOST_INIT_REPORT    0x80
#define HOST_OUTPUT_REPORT  0x01
#define HOST_RUMBLE_REPORT  0x10
#define DEVICE_RESPONSE_REPORT 0x21
#define DEVICE_INPUT_REPORT 0x30

#define PRO_ID 0x03
#define REPORT_SIZE 63

static volatile uint32_t proSent = 0, proOut = 0, descRequests = 0;
static volatile u8 lastOut[16] = {0};
static volatile u8 lastOutLen = 0;

static void onHostReport(const u8 *data, size_t len);
static volatile uint32_t proSetReports = 0, proGetReports = 0;

// Last host commands, "id:cmd" (0x80 init command or 0x01 subcommand id).
static u8 hostLog[24][2];
static volatile u8 hostLogN = 0;
static volatile uint32_t rumbleCount = 0;

static void onHostBytes(uint8_t report_id, const u8 *buffer, uint16_t len) {
  static u8 buf[REPORT_SIZE + 1];
  if (len > REPORT_SIZE) len = REPORT_SIZE;
  buf[0] = report_id;
  memcpy(buf + 1, buffer, len);
  lastOutLen = (u8)(len > 15 ? 15 : len);
  for (u8 i = 0; i <= lastOutLen; i++) lastOut[i] = buf[i];
  if (report_id == HOST_RUMBLE_REPORT) {
    rumbleCount++;               // too frequent to log; it would flush the subcommands
  } else {
    u8 slot = hostLogN % 24;
    hostLog[slot][0] = report_id;
    hostLog[slot][1] = report_id == HOST_OUTPUT_REPORT ? buf[10] : buf[1];
    hostLogN++;
  }
  onHostReport(buf, len + 1);
}

class ProController : public USBHIDDevice {
 public:
  ProController() { hid.addDevice(this, sizeof(pro_report_desc)); }
  void begin() { hid.begin(); }
  uint16_t _onGetDescriptor(u8 *dst) override {
    descRequests++;
    memcpy(dst, pro_report_desc, sizeof(pro_report_desc));
    return sizeof(pro_report_desc);
  }
  // The core strips the report id before calling us (interrupt OUT and
  // SET_REPORT alike); onHostReport wants it back in front.
  void _onOutput(uint8_t report_id, const u8 *buffer, uint16_t len) override {
    proOut++;
    onHostBytes(report_id, buffer, len);
  }
  void _onSetFeature(uint8_t report_id, const u8 *buffer, uint16_t len) override {
    proSetReports++;
    onHostBytes(report_id, buffer, len);
  }
  uint16_t _onGetFeature(uint8_t report_id, u8 *buffer, uint16_t len) override {
    proGetReports++;
    return 0;
  }
  bool send(uint8_t id, const u8 *payload, size_t len) {
    bool ok = hid.SendReport(id, payload, len, 4);
    if (ok) proSent++;
    return ok;
  }
 private:
  USBHID hid;
};

WebServer server(80);
ProController pro;

static u8 inputReport[REPORT_SIZE];      // 0x30 payload
static u8 reply[REPORT_SIZE];            // 0x81 / 0x21 payload
static bool hidReady = false;
static bool announced = false;
static bool streamPaused = false;
static bool announce = false;             // /usb?announce=1 sends an unsolicited 0x81 until the host talks
static uint32_t announcedAt = 0;
static uint32_t sentAt = 0, releaseAt = 0;
static uint32_t buttons = 0;
static u8 counter = 0;
static const u8 mac[6] = {0x98, 0xB6, 0xE9, 0xEC, 0x5E, 0xFD};

// Button bits used by /pro?mask=
#define B_Y 0x0001
#define B_X 0x0002
#define B_B 0x0004
#define B_A 0x0008
#define B_DOWN 0x0100
#define B_UP 0x0200
#define B_RIGHT 0x0400
#define B_LEFT 0x0800
#define B_SR 0x1000
#define B_SL 0x2000
#define B_R 0x4000
#define B_ZR 0x8000
#define B_MINUS 0x00010000u
#define B_PLUS  0x00020000u
#define B_R3    0x00040000u
#define B_L3    0x00080000u
#define B_HOME  0x00100000u
#define B_CAPTURE 0x00200000u
#define B_L     0x00400000u
#define B_ZL    0x00800000u

// Replies are built in the TinyUSB callback but sent from loop(): sending from
// the callback races the 125 Hz input stream for the IN endpoint and blocks on
// a completion semaphore only that same task can release.
#define QLEN 8
static u8 qBuf[QLEN][REPORT_SIZE];
static u8 qId[QLEN];
static volatile u8 qHead = 0, qTail = 0;
static volatile uint32_t qDropped = 0;
static volatile u8 pairStep = 0;
static void queueReply(u8 id, const u8 *payload) {
  u8 next = (qHead + 1) % QLEN;
  if (next == qTail) { qDropped++; return; }
  memcpy(qBuf[qHead], payload, REPORT_SIZE);
  qId[qHead] = id;
  qHead = next;
}

static void rebuildInput() {
  memset(inputReport, 0, sizeof(inputReport));
  inputReport[0] = counter++;              // timer
  inputReport[1] = 0x8E;                   // battery full, USB powered
  uint32_t m = buttons;
  // [2] right: Y X B A SR SL R ZR   [3] shared: - + R3 L3 HOME CAPTURE
  // [4] left:  DOWN UP RIGHT LEFT SR SL L ZL
  u8 r = 0, sh = 0, l = 0;
  if (m & B_Y) r |= 0x01;
  if (m & B_X) r |= 0x02;
  if (m & B_B) r |= 0x04;
  if (m & B_A) r |= 0x08;
  if (m & B_R) r |= 0x40;
  if (m & B_ZR) r |= 0x80;
  if (m & B_MINUS) sh |= 0x01;
  if (m & B_PLUS) sh |= 0x02;
  if (m & B_R3) sh |= 0x04;
  if (m & B_L3) sh |= 0x08;
  if (m & B_HOME) sh |= 0x10;
  if (m & B_CAPTURE) sh |= 0x20;
  if (m & B_DOWN) l |= 0x01;
  if (m & B_UP) l |= 0x02;
  if (m & B_RIGHT) l |= 0x04;
  if (m & B_LEFT) l |= 0x08;
  if (m & B_L) l |= 0x40;
  if (m & B_ZL) l |= 0x80;
  inputReport[2] = r; inputReport[3] = sh; inputReport[4] = l;
  // sticks centred: 12-bit x,y -> 3 bytes each
  inputReport[5] = 0x00; inputReport[6] = 0x08; inputReport[7] = 0x80;
  inputReport[8] = 0x00; inputReport[9] = 0x08; inputReport[10] = 0x80;
  inputReport[11] = 0x00;                  // vibrator
}

static void sendDeviceInfo() {
  memset(reply, 0, sizeof(reply));
  reply[0] = 0x01;                         // device info command
  reply[1] = 0x00;
  reply[2] = PRO_ID;
  for (int i = 0; i < 6; i++) reply[3 + i] = mac[5 - i];   // reversed order
  queueReply(DEVICE_INIT_REPORT, reply);
}

static void replySubcommand(const u8 *data, size_t len) {
  // data: [0]=0x01 [1]=counter [2..9]=rumble [10]=subcommand id [11..]=subcommand data
  if (len < 11) return;
  u8 id = data[10];
  const u8 *sub = data + 11;
  size_t subLen = len > 11 ? len - 11 : 0;

  memcpy(reply, inputReport, REPORT_SIZE);
  reply[12] = 0x80;             // ACK
  reply[13] = id;
  reply[14] = 0x00;

  switch (id) {
    case 0x02: {                // request device info
      hidReady = true;
      static const u8 info[] = {0x03, 0x48, PRO_ID, 0x02,
                                0x98, 0xB6, 0xE9, 0xEC, 0x5E, 0xFD,
                                0x03, 0x02, 0x00, 0x00};
      reply[12] = 0x82;
      reply[13] = 0x02;
      memcpy(reply + 14, info, sizeof(info));
      break;
    }
    case 0x03:                  // set input report mode
      reply[12] = 0x80; reply[13] = 0x03;
      break;
    case 0x08:                  // set shipment
      reply[12] = 0x80; reply[13] = 0x08;
      break;
    case 0x10: {                // SPI flash read
      if (subLen < 5) { reply[12] = 0x83; reply[13] = 0x00; break; }
      u8 bank = sub[1];
      u8 addr = sub[0];
      u8 readLen = sub[4];
      const u8 *src = nullptr; size_t srcLen = 0;
      if (bank == 0x60) { src = spi60; srcLen = sizeof(spi60); }
      else if (bank == 0x80) { src = spi80; srcLen = sizeof(spi80); }
      if (!src || addr >= srcLen) { reply[12] = 0x83; reply[13] = 0x00; break; }
      size_t n = readLen;
      if (addr + n > srcLen) n = srcLen - addr;
      if (n > REPORT_SIZE - 19) n = REPORT_SIZE - 19;
      memcpy(reply + 19, src + addr, n);
      reply[12] = 0x90; reply[13] = 0x10;
      reply[14] = addr; reply[15] = bank;
      reply[16] = 0; reply[17] = 0;
      reply[18] = (u8)n;
      break;
    }
    case 0x01: {                // Bluetooth manual pairing, sent over USB on attach
      u8 step = subLen ? sub[0] : 0;
      reply[12] = 0x81; reply[13] = 0x01;
      reply[14] = step;
      if (step == 0x01) {       // our BD_ADDR (LE), name, class of device
        for (int i = 0; i < 6; i++) reply[15 + i] = mac[5 - i];
        static const char name[] = "Pro Controller";
        memcpy(reply + 21, name, sizeof(name) - 1);   // 20-byte zero-padded field
        reply[41] = 0x68; reply[42] = 0x00; reply[43] = 0x20; // trailer per dekuNukem notes; unverified
      } else if (step == 0x02) { // XORed LTK
        for (int i = 0; i < 16; i++) reply[15 + i] = (u8)(0x11 * (i + 1)) ^ 0xAA;
      }
      pairStep = step;
      break;
    }
    case 0x30:                  // player lights
      reply[12] = 0x80; reply[13] = 0x30;
      break;
    case 0x40:                  // toggle IMU
      reply[12] = 0x80; reply[13] = 0x40;
      break;
    case 0x48:                  // enable vibration
      reply[12] = 0x82; reply[13] = 0x48;
      break;
    case 0x22:                  // NFC/IR state
      reply[12] = 0x80; reply[13] = 0x22;
      break;
    case 0x21: {                // NFC/IR config
      static const u8 params[] = {0x01, 0x00, 0xFF, 0x00, 0x08, 0x00, 0x1B, 0x01};
      reply[12] = 0xA0; reply[13] = 0x21;
      memcpy(reply + 14, params, sizeof(params));
      reply[47] = 0xC8;
      break;
    }
    default:
      reply[12] = 0x80; reply[13] = id; reply[14] = 0x03;
      break;
  }
  queueReply(DEVICE_RESPONSE_REPORT, reply);
}

static void onHostReport(const u8 *data, size_t len) {
  if (len < 1) return;
  switch (data[0]) {
    case HOST_INIT_REPORT: {
      u8 cmd = len > 1 ? data[1] : 0;
      if (cmd == 0x01) {
        sendDeviceInfo();
      } else if (cmd == 0x02) {
        memset(reply, 0, sizeof(reply));
        size_t n = len - 1; if (n > REPORT_SIZE) n = REPORT_SIZE;
        memcpy(reply, data + 1, n);
        queueReply(DEVICE_INIT_REPORT, reply);
      } else if (cmd == 0x03) {
        memset(reply, 0, sizeof(reply));
        reply[0] = 0x03;
        queueReply(DEVICE_INIT_REPORT, reply);
      } else if (cmd == 0x04) {
        hidReady = true;
        memset(reply, 0, sizeof(reply));
        reply[0] = 0x04;
        queueReply(DEVICE_INIT_REPORT, reply);
      }
      break;
    }
    case HOST_OUTPUT_REPORT:
      replySubcommand(data, len);
      break;
    case HOST_RUMBLE_REPORT:
    default:
      break;
  }
}

static void streamInput() {
  uint32_t now = millis();
  if (releaseAt && now >= releaseAt) { buttons = 0; releaseAt = 0; rebuildInput(); }
  if (!(bool)USB) { announced = false; hidReady = false; return; }
  // Announce until the host answers: the console expects the controller to send
  // its 0x81 device info, but the endpoint is not ready the instant we mount.
  if (announce && rawSet == 0 && now - announcedAt >= 200 && tud_hid_n_ready(0)) {
    announcedAt = now;
    sendDeviceInfo();
  }
  if (!tud_hid_n_ready(0)) return;
  if (qTail != qHead) {
    if (tud_hid_n_report(0, qId[qTail], qBuf[qTail], REPORT_SIZE)) { proSent++; qTail = (qTail + 1) % QLEN; }
    return;
  }
  if (!hidReady) return;
  if (streamPaused) return;       // silenced while the exploit grooms the heap
  if (now - sentAt < 8) return;   // 125 Hz
  sentAt = now;
  inputReport[0] = counter++;
  if (tud_hid_n_report(0, DEVICE_INPUT_REPORT, inputReport, REPORT_SIZE)) proSent++;
}

static bool flag(const char *n) {
  if (!server.hasArg(n)) return false;
  String v = server.arg(n); return v == "1" || v == "true" || v == "on";
}

// --- Flipper Zero expansion-module RPC -----------------------------------
// The WiFi devboard's ESP32-S2 is wired to the Flipper GPIO USART (Flipper
// pin 13 TX -> ESP32 RX, pin 14 RX <- ESP32 TX). On the devboard those are
// UART0's GPIO44(RX)/43(TX); we drive them from UART1 via the pin matrix so
// Serial (UART0) is left alone, and /flipper/ping?tx=&rx= can probe others.
// Protocol: expansion_protocol.h + Flipper RPC (protobuf, length-delimited).
// Momentum's BadUSB app is name "Bad KB" (appid bad_kb), scripts in /ext/badusb.
static HardwareSerial Flip(0);   // UART0: the pins physically wired to the Flipper
static int flipTx = 43, flipRx = 44;

enum { FF_HEARTBEAT = 1, FF_STATUS = 2, FF_BAUD = 3, FF_CONTROL = 4, FF_DATA = 5 };

static int flipByte(uint32_t toMs) {
  uint32_t t0 = millis();
  while (!Flip.available()) { if (millis() - t0 > toMs) return -1; delay(0); }
  return Flip.read();
}

static void flipSend(u8 type, const u8 *content, u8 clen) {
  u8 buf[70]; u8 n = 0; buf[n++] = type;
  for (u8 i = 0; i < clen; i++) buf[n++] = content[i];
  u8 x = 0; for (u8 i = 0; i < n; i++) x ^= buf[i];
  buf[n++] = x;
  Flip.write(buf, n); Flip.flush();
}

// Read one frame into content[], returns frame type or -1 on timeout/error.
static int flipRecv(u8 *content, u8 *clen, uint32_t toMs) {
  int h = flipByte(toMs); if (h < 0) return -1;
  u8 n = 0;
  int need = (h == FF_HEARTBEAT) ? 0 : (h == FF_STATUS || h == FF_CONTROL) ? 1
           : (h == FF_BAUD) ? 4 : (h == FF_DATA) ? -1 : 0;
  if (need == -1) {               // DATA: first byte is the size
    int sz = flipByte(toMs); if (sz < 0) return -1;
    for (int i = 0; i < sz; i++) { int b = flipByte(toMs); if (b < 0) return -1; content[n++] = b; }
  } else {
    for (int i = 0; i < need; i++) { int b = flipByte(toMs); if (b < 0) return -1; content[n++] = b; }
  }
  int ck = flipByte(toMs); if (ck < 0) return -1;
  u8 x = h; if (h == FF_DATA) x ^= n;        // size byte is part of the checksum
  for (u8 i = 0; i < n; i++) x ^= content[i];
  if ((u8)ck != x) return -1;
  *clen = n; return h;
}

static void flipSendData(const u8 *data, u8 len) {
  u8 c[65]; c[0] = len; for (u8 i = 0; i < len; i++) c[i + 1] = data[i];
  flipSend(FF_DATA, c, len + 1);
}

// Read frames until one of type `want` arrives, skipping heartbeats.
static bool flipWait(u8 want, u8 *content, u8 *clen, uint32_t toMs) {
  uint32_t t0 = millis();
  while (millis() - t0 < toMs) {
    int t = flipRecv(content, clen, 60);
    if (t == (int)want) return true;
  }
  return false;
}

static void flipDrain() { while (Flip.available()) Flip.read(); }

// RPC command id: the Flipper matches responses by it, so each request needs a
// fresh one (flipper2jb increments; command_id 0 confuses the sequencing).
static uint32_t flipCmdId = 0;

// Consume (and STATUS-ack) incoming frames for `ms`, keeping the UART in sync
// while Bad KB loads. Replaces a blind delay that would leave responses unread.
static void flipDrainMs(uint32_t ms) {
  u8 c[72], cl; uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    int t = flipRecv(c, &cl, 60);
    if (t == FF_DATA) { u8 ok = 0; flipSend(FF_STATUS, &ok, 1); }
  }
}

// Full handshake: wake -> heartbeat -> baud (9600, no switch) -> start RPC.
// Retried as a unit; stale bytes between sessions would otherwise misalign
// framing, and the Flipper needs a >Tto (250 ms) idle gap to reset.
static bool flipBegun = false;

// Wake the Flipper exactly like flipper2jb's tcp_uart_bridge: a 100 us GPIO low
// pulse on TX (pulls the Flipper's RX low), then hand the pad straight back to
// the UART. The RX driver stays alive, and NO data bytes are sent -- the 0x00
// "wake bytes" the old code used poisoned the session and broke baud/start.
static void flipSignalPresence(int tx, int rx) {
  uart_wait_tx_done(UART_NUM_0, pdMS_TO_TICKS(50));
  gpio_reset_pin((gpio_num_t)tx);
  gpio_set_direction((gpio_num_t)tx, GPIO_MODE_OUTPUT);
  gpio_set_level((gpio_num_t)tx, 0);
  esp_rom_delay_us(100);
  gpio_set_level((gpio_num_t)tx, 1);
  uart_set_pin(UART_NUM_0, tx, rx, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
}

static bool flipOpen(FlipRes *r, int tx, int rx) {
  r->heartbeat = r->baudOk = r->rpcOk = false;
  u8 c[72], cl;
  if (!flipBegun) { Flip.begin(9600, SERIAL_8N1, rx, tx); flipBegun = true; delay(10); }
  else { Flip.updateBaudRate(9600); }
  for (int session = 0; session < 6; session++) {
    flipDrain();
    flipSignalPresence(tx, rx);
    if (!flipWait(FF_HEARTBEAT, c, &cl, 400)) { delay(260); continue; }   // Tto ~250 ms
    r->heartbeat = true;
    uint32_t baud = 9600; u8 p[4]; memcpy(p, &baud, 4);                   // stay at 9600 (no switch)
    flipSend(FF_BAUD, p, 4);
    if (!(flipWait(FF_STATUS, c, &cl, 500) && c[0] == 0)) { delay(260); continue; }
    r->baudOk = true;
    u8 start = 0x00; flipSend(FF_CONTROL, &start, 1);                     // start RPC
    if (flipWait(FF_STATUS, c, &cl, 500) && c[0] == 0) { r->rpcOk = true; return true; }
    delay(260);
  }
  return false;
}

static void flipClose() {
  u8 stop = 0x01; flipSend(FF_CONTROL, &stop, 1);
  u8 c[72], cl; flipWait(FF_STATUS, c, &cl, 200);
  delay(300);                 // > Tto so the Flipper resets to detection; UART stays up
}

// Send one RPC Main message (length-delimited), chunked into DATA frames,
// ack each returned DATA, and drain the response for a short window.
static void flipRpc(const u8 *main, uint16_t mlen) {
  static u8 stream[1600]; uint16_t n = 0; uint32_t v = mlen;
  while (v >= 0x80) { stream[n++] = (v & 0x7F) | 0x80; v >>= 7; } stream[n++] = v;
  memcpy(stream + n, main, mlen); n += mlen;
  uint16_t off = 0; u8 c[72], cl;
  while (off < n) {
    u8 chunk = (n - off > 64) ? 64 : (n - off);
    flipSendData(stream + off, chunk);
    flipWait(FF_STATUS, c, &cl, 400);      // STATUS ack (skip heartbeats)
    off += chunk;
  }
  uint32_t t0 = millis();
  while (millis() - t0 < 300) {
    int t = flipRecv(c, &cl, 60);
    if (t == FF_DATA) { u8 ok = 0; flipSend(FF_STATUS, &ok, 1); }
  }
}

// Minimal protobuf writers (proto3, wire types 0 varint / 2 length-delimited).
static void pbVar(u8 *&p, uint32_t v) { while (v >= 0x80) { *p++ = (v & 0x7F) | 0x80; v >>= 7; } *p++ = v; }
static void pbTag(u8 *&p, uint32_t f, uint32_t w) { pbVar(p, (f << 3) | w); }
static void pbU(u8 *&p, uint32_t f, uint32_t v) { pbTag(p, f, 0); pbVar(p, v); }
static void pbBytes(u8 *&p, uint32_t f, const u8 *d, uint32_t n) { pbTag(p, f, 2); pbVar(p, n); memcpy(p, d, n); p += n; }
static void pbStr(u8 *&p, uint32_t f, const char *s) { pbBytes(p, f, (const u8 *)s, strlen(s)); }

// Main{ command_id=1, storage_write_request=11: Write{ path=1, file=2: File{ data=4 } } }
static uint16_t flipBuildWrite(u8 *out, const char *path, const u8 *data, uint16_t dlen) {
  static u8 file[1400]; u8 *fp = file; pbBytes(fp, 4, data, dlen); uint16_t flen = fp - file;
  static u8 wr[1500]; u8 *wp = wr; pbStr(wp, 1, path);
  pbTag(wp, 2, 2); pbVar(wp, flen); memcpy(wp, file, flen); wp += flen; uint16_t wlen = wp - wr;
  u8 *o = out; pbU(o, 1, ++flipCmdId); pbTag(o, 11, 2); pbVar(o, wlen); memcpy(o, wr, wlen); o += wlen;
  return o - out;
}
// Main{ command_id=1, app_start_request=16: Start{ name=1, args=2 } }
static uint16_t flipBuildStart(u8 *out, const char *name, const char *args) {
  static u8 sr[260]; u8 *sp = sr; pbStr(sp, 1, name); if (args && *args) pbStr(sp, 2, args);
  uint16_t slen = sp - sr;
  u8 *o = out; pbU(o, 1, ++flipCmdId); pbTag(o, 16, 2); pbVar(o, slen); memcpy(o, sr, slen); o += slen;
  return o - out;
}
// Main{ command_id=1, gui_send_input_event_request=23: Input{ key=1, type=2 } }
static uint16_t flipBuildInput(u8 *out, uint32_t key, uint32_t type) {
  static u8 ir[16]; u8 *ip = ir; pbU(ip, 1, key); pbU(ip, 2, type); uint16_t ilen = ip - ir;
  u8 *o = out; pbU(o, 1, ++flipCmdId); pbTag(o, 23, 2); pbVar(o, ilen); memcpy(o, ir, ilen); o += ilen;
  return o - out;
}

static u8 flipScript[1200];
static uint16_t flipScriptLen = 0;

// --- Raw RPC bridge -------------------------------------------------------
// TCP:8080 <-> expansion UART, so the proven flipper2jb Mac tool can drive the
// Flipper THROUGH this board while the ESP32 stays a Pro Controller. Mirrors
// flipper2jb/firmware/tcp_uart_bridge: pipe raw RPC bytes both ways, wrapping
// them in DATA frames, and keep the session alive with heartbeats. The Mac
// side (flipper2jb) owns the RPC (command ids, response waiting, upload+run).
WiFiServer flipBridge(8080);
WiFiClient flipCli;
static bool flipBridgeUp = false;
static uint32_t flipBridgeHb = 0;
static uint32_t brOpens = 0, brFails = 0, brTcpRx = 0, brTxFrames = 0, brRxData = 0, brHb = 0;

static void flipBridgeTick() {
  if (flipCli && flipCli.connected()) {
    u8 c[72], cl;
    bool activity = false;
    // TCP -> UART: RPC request bytes become DATA frames.
    while (flipCli.available()) {
      u8 buf[64]; int n = flipCli.read(buf, 64);
      if (n <= 0) break;
      flipSendData(buf, (u8)n); brTcpRx += n; brTxFrames++;
      flipWait(FF_STATUS, c, &cl, 300);
      activity = true;
    }
    // UART -> TCP: DATA frames become RPC response bytes (ack each, drop heartbeats).
    while (Flip.available()) {
      int t = flipRecv(c, &cl, 40);
      if (t == FF_DATA) { flipCli.write(c, cl); brRxData++; u8 ok = 0; flipSend(FF_STATUS, &ok, 1); activity = true; }
      else if (t < 0) break;
    }
    if (activity) flipBridgeHb = millis();
    else if (millis() - flipBridgeHb > 120) {   // idle heartbeat (< Tto 250 ms)
      flipSend(FF_HEARTBEAT, nullptr, 0); brHb++;
      flipWait(FF_HEARTBEAT, c, &cl, 60);
      flipBridgeHb = millis();
    }
    return;
  }
  // No client, or it just closed: tear down any open session, accept a new one.
  if (flipBridgeUp) { flipClose(); flipBridgeUp = false; }
  if (flipCli) flipCli.stop();
  WiFiClient nc = flipBridge.accept();
  if (nc) {
    flipCli = nc; flipCli.setNoDelay(true);
    FlipRes r;
    if (flipOpen(&r, flipTx, flipRx)) { flipBridgeUp = true; flipBridgeHb = millis(); brOpens++; }
    else { flipCli.stop(); brFails++; }
  }
}

void setup() {
  // Serial debug removed: UART0 pins 43/44 are the Flipper link (see above).
  rebuildInput();
  USB.manufacturerName("Nintendo Co., Ltd.");
  USB.productName("Pro Controller");
  USB.firmwareVersion(0x0210);   // bcdDevice: a real Pro Controller reports 2.10
  USB.usbVersion(0x0200);        // bcdUSB 2.0
  USB.begin();
  pro.begin();
  WiFi.begin(SSID, PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);

  server.on("/status", [] {
    server.send(200, "application/json",
      String("{\"ok\":true,\"ip\":\"") + WiFi.localIP().toString() +
      "\",\"fw\":\"pro-2\",\"ready\":" + (hidReady ? "true" : "false") + "}");
  });
  server.on("/reboot", [] {
    server.send(200, "application/json", "{\"ok\":true,\"reboot\":true}");
    delay(150);
    ESP.restart();
  });

  // /stream?on=0 silences the 0x30 stream (handshake and subcommands continue).
  // The console's FS acquisition is timing sensitive and a 125 Hz interrupt
  // stream during it is the one load we can remove.
  server.on("/stream", [] {
    bool on = server.hasArg("on") ? server.arg("on") != "0" : true;
    streamPaused = !on;
    server.send(200, "application/json",
      String("{\"ok\":true,\"streaming\":") + (on ? "true" : "false") + "}");
  });

  server.on("/usb", [] {
    if (server.hasArg("announce")) announce = server.arg("announce") != "0";
    String body = String("{\"mounted\":") + ((bool)USB ? "true" : "false") +
      ",\"hidReady\":" + (tud_hid_n_ready(0) ? "true" : "false") +
      ",\"handshake\":" + (hidReady ? "true" : "false") +
      ",\"reportsSent\":" + (uint32_t)proSent +
      ",\"outReports\":" + (uint32_t)proOut +
      ",\"setReports\":" + (uint32_t)proSetReports +
      ",\"getReports\":" + (uint32_t)proGetReports +
      ",\"rawSet\":" + (uint32_t)rawSet +
      ",\"rawGet\":" + (uint32_t)rawGet +
      ",\"descRequests\":" + (uint32_t)descRequests +
      ",\"devRequests\":" + (uint32_t)devRequests +
      ",\"cfgRequests\":" + (uint32_t)cfgRequests +
      ",\"announce\":" + String(announce ? "true" : "false") +
      ",\"uptimeMs\":" + (uint32_t)millis() + ",\"lastOut\":\"";
    for (u8 i = 0; i <= lastOutLen; i++) {
      if (i) body += ' ';
      if (lastOut[i] < 0x10) body += '0';
      body += String(lastOut[i], HEX);
    }
    body += "\",\"qDropped\":" + String((uint32_t)qDropped) + ",\"pairStep\":" + String((uint32_t)pairStep) + ",\"rumble\":" + String((uint32_t)rumbleCount) + ",\"log\":\"";
    u8 n = hostLogN < 24 ? hostLogN : 24;
    for (u8 i = 0; i < n; i++) {
      u8 slot = (hostLogN - n + i) % 24;
      if (i) body += ' ';
      body += String(hostLog[slot][0], HEX) + ":" + String(hostLog[slot][1], HEX);
    }
    body += "\"}";
    server.send(200, "application/json", body);
  });
  server.on("/pro", [] {
    if (server.hasArg("mask")) buttons = (uint32_t)strtoul(server.arg("mask").c_str(), NULL, 0);
    if (flag("a")) buttons |= B_A;
    if (flag("b")) buttons |= B_B;
    if (flag("x")) buttons |= B_X;
    if (flag("y")) buttons |= B_Y;
    if (flag("l")) buttons |= B_L;
    if (flag("r")) buttons |= B_R;
    if (flag("zl")) buttons |= B_ZL;
    if (flag("zr")) buttons |= B_ZR;
    if (flag("plus")) buttons |= B_PLUS;
    if (flag("minus")) buttons |= B_MINUS;
    if (flag("home")) buttons |= B_HOME;
    if (flag("capture")) buttons |= B_CAPTURE;
    if (flag("up")) buttons |= B_UP;
    if (flag("down")) buttons |= B_DOWN;
    if (flag("left")) buttons |= B_LEFT;
    if (flag("right")) buttons |= B_RIGHT;
    rebuildInput();
    bool raw = flag("raw");
    long ms = server.hasArg("ms") ? server.arg("ms").toInt() : 150;
    releaseAt = (raw || buttons == 0) ? 0 : millis() + (ms > 0 ? ms : 150);
    streamInput();
    server.send(200, "application/json", String("{\"ok\":true,\"mask\":") + (uint32_t)buttons + "}");
  });

  // --- Flipper endpoints. The pad keeps streaming except during the ~1 s
  // exchange, which blocks loop(); the console does not drop the pad for it.
  // Raw diagnostic: wake, then hex-dump whatever arrives on rx within 600 ms.
  server.on("/flipper/raw", [] {
    int tx = server.hasArg("tx") ? server.arg("tx").toInt() : flipTx;
    int rx = server.hasArg("rx") ? server.arg("rx").toInt() : flipRx;
    long baud = server.hasArg("baud") ? server.arg("baud").toInt() : 9600;
    Flip.end();
    pinMode(tx, OUTPUT); digitalWrite(tx, LOW); delay(15);   // GPIO wake blip
    Flip.begin(baud, SERIAL_8N1, rx, tx);
    for (int i = 0; i < 8; i++) Flip.write((u8)0x00);         // clean start-bit edges
    uint32_t bb = 9600; u8 bp[6]; bp[0] = FF_BAUD; memcpy(bp + 1, &bb, 4);
    u8 x = 0; for (int i = 0; i < 5; i++) x ^= bp[i]; bp[5] = x;
    Flip.write(bp, 6);                                        // a valid baud frame
    Flip.flush();
    String hex; int count = 0; uint32_t t0 = millis();
    while (millis() - t0 < 600) {
      if (Flip.available()) {
        int b = Flip.read(); count++;
        char h[4]; snprintf(h, sizeof(h), "%02x ", b & 0xFF); hex += h;
        if (count >= 64) break;
      }
    }
    Flip.end();
    server.send(200, "application/json",
      String("{\"tx\":") + tx + ",\"rx\":" + rx + ",\"baud\":" + baud +
      ",\"count\":" + count + ",\"hex\":\"" + hex + "\"}");
  });
  server.on("/bridge", [] {
    server.send(200, "application/json",
      String("{\"up\":") + (flipBridgeUp ? "true" : "false") +
      ",\"client\":" + ((flipCli && flipCli.connected()) ? "true" : "false") +
      ",\"opens\":" + brOpens + ",\"fails\":" + brFails +
      ",\"tcpRx\":" + brTcpRx + ",\"txFrames\":" + brTxFrames +
      ",\"rxData\":" + brRxData + ",\"hb\":" + brHb + "}");
  });
  server.on("/flipper/ping", [] {
    int tx = server.hasArg("tx") ? server.arg("tx").toInt() : flipTx;
    int rx = server.hasArg("rx") ? server.arg("rx").toInt() : flipRx;
    FlipRes r; bool ok = flipOpen(&r, tx, rx);
    if (ok) { flipTx = tx; flipRx = rx; }
    flipClose();
    server.send(200, "application/json",
      String("{\"ok\":") + (ok ? "true" : "false") +
      ",\"tx\":" + tx + ",\"rx\":" + rx +
      ",\"heartbeat\":" + (r.heartbeat ? "true" : "false") +
      ",\"baudOk\":" + (r.baudOk ? "true" : "false") +
      ",\"rpcOk\":" + (r.rpcOk ? "true" : "false") + "}");
  });
  // POST a ready BadUSB script (raw text) to stage it.
  server.on("/flipper/script", HTTP_POST, [] {
    String b = server.arg("plain");
    flipScriptLen = b.length() > sizeof(flipScript) ? sizeof(flipScript) : b.length();
    memcpy(flipScript, b.c_str(), flipScriptLen);
    server.send(200, "application/json", String("{\"ok\":true,\"bytes\":") + flipScriptLen + "}");
  });
  // POST plain text to type: build a BadUSB script (one STRING+ENTER per line).
  server.on("/flipper/type", HTTP_POST, [] {
    String t = server.arg("plain");
    u8 *p = flipScript; const char *hdr = "DELAY 500\n";
    memcpy(p, hdr, strlen(hdr)); p += strlen(hdr);
    int i = 0, n = t.length();
    while (i < n && (p - flipScript) < (int)sizeof(flipScript) - 80) {
      int e = t.indexOf('\n', i); if (e < 0) e = n;
      String line = t.substring(i, e);
      String out = String("STRING ") + line + "\nENTER\n";
      int ol = out.length(); if ((p - flipScript) + ol > (int)sizeof(flipScript)) break;
      memcpy(p, out.c_str(), ol); p += ol;
      i = e + 1;
    }
    flipScriptLen = p - flipScript;
    server.send(200, "application/json", String("{\"ok\":true,\"bytes\":") + flipScriptLen + "}");
  });
  // Write the staged script to the SD card and launch BadUSB on it.
  server.on("/flipper/run", [] {
    String path = server.hasArg("path") ? server.arg("path") : String("/ext/badusb/ns2.txt");
    String name = server.hasArg("name") ? server.arg("name") : String("Bad KB");
    bool press = flag("ok");
    FlipRes r;
    if (!flipOpen(&r, flipTx, flipRx)) {
      flipClose();
      server.send(200, "application/json", "{\"ok\":false,\"stage\":\"open\"}");
      return;
    }
    static u8 mb[1600];
    uint16_t ml = flipBuildWrite(mb, path.c_str(), flipScript, flipScriptLen);
    flipRpc(mb, ml);
    ml = flipBuildStart(mb, name.c_str(), path.c_str());
    flipRpc(mb, ml);
    if (press) {
      // Bad KB needs ~1-2 s to init USB HID before its view takes input, so
      // spray the OK press across a window; OK is ignored once it is running.
      delay(1500);
      // Match flipper2jb exactly: wait ~2 s for Bad KB to load (draining
      // responses so the UART stays in sync), then one OK press as
      // PRESS -> SHORT -> RELEASE (the Flipper resets the sequence on RELEASE,
      // so SHORT must come before it).
      flipDrainMs(2000);
      ml = flipBuildInput(mb, 4 /*OK*/, 0 /*PRESS*/);   flipRpc(mb, ml);
      ml = flipBuildInput(mb, 4 /*OK*/, 2 /*SHORT*/);   flipRpc(mb, ml);
      ml = flipBuildInput(mb, 4 /*OK*/, 1 /*RELEASE*/); flipRpc(mb, ml);
    }
    flipClose();
    server.send(200, "application/json",
      String("{\"ok\":true,\"wrote\":") + flipScriptLen + ",\"path\":\"" + path + "\",\"app\":\"" + name + "\"}");
  });

  server.begin();
  flipBridge.begin();
  ArduinoOTA.setHostname("esp32-hid");
  ArduinoOTA.begin();
}

void loop() {
  server.handleClient();
  ArduinoOTA.handle();
  flipBridgeTick();
  if (!(flipCli && flipCli.connected())) streamInput();  // pad pauses during a bridge session
}
