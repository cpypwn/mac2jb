// Networked USB HID device: the WiFi Devboard types into the console and presents
// a HORI Pokken Tournament Pro Pad so the home menu can be driven without hands.
//
// Flash to an ESP32-S2 (Flipper WiFi Devboard) with the Arduino core, then plug
// its USB-C into the Switch dock and power it from the Flipper's header.
//
//   GET /type?text=LOAD%20%22TXT%3ANS2%22%0ARUN   type text, newline = enter
//   GET /key?code=40                              press one HID usage (40 = enter)
//   GET /pad?a=1&up=1&ms=150                      press gamepad buttons for ms
//   GET /pad?mask=0x0001&ms=150                   press raw Pokken button bits
//   GET /usb                                      link/driver diagnostics
//   GET /status                                   {"ok":true,"ip":"...","fw":"..."}
//
// Why this persona: on stock firmware the console only accepts USB controllers it
// ships a driver for. Since system update 3.0.0 it drives the HORI Pokken
// Tournament Pro Pad (0F0D:0092) as a Pro Controller, and that pad's report
// descriptor is a plain 8-byte gamepad report - so a stock ESP32 can present it
// with no pairing and no keys. The report layout below copies that descriptor:
//
//   byte 0   buttons 1-8   (bit 0 = button 1)
//   byte 1   buttons 9-13  (bits 0-4)
//   byte 2   hat switch, low nibble (0 = up ... 7 = up-left, 0xF = centred)
//   byte 3-6 X, Y, Z, Rz   (0x80 = centre; Z/Rz are the right stick)
//   byte 7   vendor byte
//
// The keyboard collection rides in the same HID interface because the Arduino core
// merges every enabled USBHID report descriptor into one interface. Build with
// -DKEY_ONLY for the proven keyboard-only device (Espressif VID) or -DPAD_ONLY for
// the pad alone; that pair is the fallback if the merged device is not accepted.
#include <WiFi.h>
#include <WebServer.h>
#include <USB.h>
#include <USBHIDKeyboard.h>
#include <ArduinoOTA.h>
#include "esp_hid_common.h"
#include "class/hid/hid_device.h"

#include "wifi_secret.h"   // WIFI_SSID / WIFI_PASS - see wifi_secret.h
static const char *SSID = WIFI_SSID;
static const char *PASS = WIFI_PASS;

// Report descriptor of the HORI Pokken Tournament Pro Pad, rebuilt from a
// linux-hardware.org dump (fossephate/switch-controller HORI_Descriptors):
// Generic Desktop / Gamepad, 13 buttons, 4-bit hat with null state, four 8-bit
// axes, one vendor input byte, and an 8-byte output report. Same report layout as
// the real pad; the byte length differs only in how the trailing usage is encoded.
// The core's keyboard descriptor, used as a control when testing the parser below.
static const uint8_t keyboard_report_desc[] = {TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(1))};

static const uint8_t pad_report_desc[] = {
    0x05, 0x01, 0x09, 0x05, 0xA1, 0x01, 0x15, 0x00, 0x25, 0x01, 0x35, 0x00, 0x45, 0x01, 0x75, 0x01,
    0x95, 0x0D, 0x05, 0x09, 0x19, 0x01, 0x29, 0x0D, 0x81, 0x02, 0x95, 0x03, 0x81, 0x01, 0x05, 0x01,
    0x25, 0x07, 0x46, 0x3B, 0x01, 0x75, 0x04, 0x95, 0x01, 0x65, 0x14, 0x09, 0x39, 0x81, 0x42, 0x65,
    0x00, 0x95, 0x01, 0x81, 0x01, 0x26, 0xFF, 0x00, 0x46, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x04, 0x09,
    0x30, 0x09, 0x31, 0x09, 0x32, 0x09, 0x35, 0x81, 0x02, 0x06, 0x00, 0xFF, 0x09, 0x20, 0x95, 0x01,
    0x81, 0x02, 0x0A, 0x21, 0x26, 0x95, 0x08, 0x91, 0x02, 0xC0,
};

#define PAD_LEN 8
#define PAD_HAT_NEUTRAL 0x0F
#define PAD_AXIS_CENTRE 0x80

// Link diagnostics: what the *console* did with us. A device the console has
// configured answers GET_DESCRIPTOR and polls the interrupt IN endpoint, so
// reportsSent climbing while mounted is the evidence that a driver took it.
static volatile uint32_t padReportsSent = 0;
static volatile uint32_t padOutReports = 0;
static volatile uint8_t padLastOut[9] = {0};
static volatile uint8_t padLastOutLen = 0;

class PokkenPad : public USBHIDDevice {
 public:
  PokkenPad() { hid.addDevice(this, sizeof(pad_report_desc)); }
  void begin() { hid.begin(); }
  uint16_t _onGetDescriptor(uint8_t *dst) override {
    memcpy(dst, pad_report_desc, sizeof(pad_report_desc));
    return sizeof(pad_report_desc);
  }
  void _onOutput(uint8_t report_id, const uint8_t *buffer, uint16_t len) override {
    padOutReports++;
    padLastOut[0] = report_id;
    padLastOutLen = (uint8_t)(len > 8 ? 8 : len);
    for (uint8_t i = 0; i < padLastOutLen; i++) padLastOut[i + 1] = buffer[i];
  }
  bool send(const uint8_t *payload, size_t len) {
    // A short timeout matters: the default 100 ms blocks the main loop when the
    // host stops polling, which starves the HTTP server and makes an OTA update
    // time out mid-transfer. 3 ms is longer than a 1 ms frame at 125 Hz, so a
    // healthy host never sees a dropped report.
    bool ok = hid.SendReport(0, payload, len, 3);   // no report ID, like the real pad
    if (ok) padReportsSent++;
    return ok;
  }
 private:
  USBHID hid;
};

WebServer server(80);
#ifndef PAD_ONLY
USBHIDKeyboard keyboard;
#endif
#ifndef KEY_ONLY
PokkenPad pad;
#endif

static uint8_t padReport[PAD_LEN];
static uint32_t padSentAt = 0;
static uint8_t padLastSent[PAD_LEN];
static uint32_t padReleaseAt = 0;

struct Key { uint8_t usage; bool shift; };

// US layout, printable ASCII only; everything else is rejected rather than guessed.
static bool mapChar(char c, Key &out) {
  // SmileBASIC inverts letter case on USB keyboards: sending uppercase with SHIFT
  // and lowercase without makes the console show exactly what we asked for.
  if (c >= 'a' && c <= 'z') { out = {uint8_t(4 + (c - 'a')), false}; return true; }
  if (c >= 'A' && c <= 'Z') { out = {uint8_t(4 + (c - 'A')), true}; return true; }
  if (c >= '1' && c <= '9') { out = {uint8_t(30 + (c - '1')), false}; return true; }
  if (c == '0') { out = {39, false}; return true; }
  switch (c) {
    case '\n': case '\r': out = {40, false}; return true;   // enter
    case '\t': out = {43, false}; return true;
    case ' ':  out = {44, false}; return true;
    case '-': out = {45, false}; return true;  case '_': out = {45, true}; return true;
    case '=': out = {46, false}; return true;  case '+': out = {46, true}; return true;
    case '[': out = {47, false}; return true;  case '{': out = {47, true}; return true;
    case ']': out = {48, false}; return true;  case '}': out = {48, true}; return true;
    case '\\': out = {49, false}; return true; case '|': out = {49, true}; return true;
    case ';': out = {51, false}; return true;  case ':': out = {51, true}; return true;
    // The console's USB keyboard layout is UK English, not US: Shift+' gives @
    // and Shift+2 gives ". (Setting the console to US English would flip these.)
    case '\'': out = {52, false}; return true; case '@': out = {52, true}; return true;
    case '"': out = {31, true}; return true;
    case '`': out = {53, false}; return true;  case '~': out = {53, true}; return true;
    case ',': out = {54, false}; return true;  case '<': out = {54, true}; return true;
    case '.': out = {55, false}; return true;  case '>': out = {55, true}; return true;
    case '/': out = {56, false}; return true;  case '?': out = {56, true}; return true;
    case '!': out = {30, true}; return true;   case '£': out = {32, true}; return true;
    case '#': out = {32, true}; return true;   case '$': out = {33, true}; return true;
    case '%': out = {34, true}; return true;   case '^': out = {35, true}; return true;
    case '&': out = {36, true}; return true;   case '*': out = {37, true}; return true;
    case '(': out = {38, true}; return true;   case ')': out = {39, true}; return true;
  }
  return false;
}

// Button bits used by /pad?mask=. The real pad's 13 buttons in descriptor order;
// the console decides what each one means (A, B, X, Y, L, R, ZL, ZR, -, +, ...).
#define PAD_BIT(n) (1u << ((n) - 1))

static void padIdle() {
  memset(padReport, 0, sizeof(padReport));
  padReport[2] = PAD_HAT_NEUTRAL;
  padReport[3] = PAD_AXIS_CENTRE; padReport[4] = PAD_AXIS_CENTRE;
  padReport[5] = PAD_AXIS_CENTRE; padReport[6] = PAD_AXIS_CENTRE;
}

static void padSet(uint32_t mask, uint8_t hat) {
  padIdle();
  padReport[0] = mask & 0xFF;
  padReport[1] = (mask >> 8) & 0x1F;
  padReport[2] = hat;
}

static volatile uint32_t padReadyChecks = 0;
static volatile uint32_t padMounts = 0;

static void streamPad() {
#ifndef KEY_ONLY
  uint32_t now = millis();
  if (padReleaseAt && now >= padReleaseAt) {
    padIdle();
    padReleaseAt = 0;
  }
  // Only send when the host has finished with the previous report. Queuing into
  // a host that is not reading leaves the endpoint busy forever, which looks
  // exactly like a dead device from the console's side.
  if (!tud_hid_n_ready(0)) return;
  padReadyChecks++;
  const bool changed = memcmp(padReport, padLastSent, sizeof(padReport)) != 0;
  if (!changed && now - padSentAt < 100) return;   // keepalive at 10 Hz when idle
  memcpy(padLastSent, padReport, sizeof(padReport));
  padSentAt = now;
  pad.send(padReport, sizeof(padReport));
#endif
}

static bool flag(const char *name) {
  if (!server.hasArg(name)) return false;
  String value = server.arg(name);
  return value == "1" || value == "true" || value == "on";
}

void setup() {
  Serial.begin(115200);
  padIdle();
  USB.manufacturerName("HORI CO.,LTD.");
  USB.productName("POKKEN CONTROLLER");
  USB.begin();
#ifndef PAD_ONLY
  keyboard.begin();
#endif
#ifndef KEY_ONLY
  pad.begin();
#endif
  WiFi.begin(SSID, PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  Serial.println(WiFi.localIP());

  // This string used to be unconditional, so every build of this sketch answered
  // "hid-pad-1" - which made a successful OTA look like a failed one, and made a
  // keyboard-only board look like it had a pad. Report what was actually built.
#if defined(KEY_ONLY)
#define FW_BUILD "hid-kb-1"
#elif defined(PAD_ONLY)
#define FW_BUILD "hid-pad-1"
#else
#define FW_BUILD "hid-both-1"
#endif
  server.on("/status", [] {
    server.send(200, "application/json",
      String("{\"ok\":true,\"ip\":\"") + WiFi.localIP().toString() +
      "\",\"fw\":\"" FW_BUILD "\""
#ifdef KEY_ONLY
      ",\"keyboard\":true,\"padEndpoints\":false"
#elif defined(PAD_ONLY)
      ",\"keyboard\":false,\"padEndpoints\":true"
#else
      ",\"keyboard\":true,\"padEndpoints\":true"
#endif
      ",\"padButtons\":" + ((padReport[1] << 8) | padReport[0]) +
      ",\"hat\":" + padReport[2] + "}");
  });

  // Ask the same parser the USB stack uses whether a report descriptor is
  // acceptable. A descriptor it rejects makes the core stall GET_DESCRIPTOR, so
  // the host never configures the interface. This turns that into a WiFi answer.
  server.on("/parse", [] {
    auto describe = [](const uint8_t *desc, size_t len) {
      String out = "{";
      esp_hid_report_map_t *map = esp_hid_parse_report_map(desc, len);
      out += String("\"parsed\":") + (map ? "true" : "false") + ",\"reports\":[";
      if (map) {
        for (uint8_t i = 0; i < map->reports_len; i++) {
          if (i) out += ",";
          out += String("{\"id\":") + map->reports[i].report_id +
                 ",\"type\":" + map->reports[i].report_type +
                 ",\"len\":" + map->reports[i].value_len + "}";
        }
        esp_hid_free_report_map(map);
      }
      out += "]}";
      return out;
    };
    String body = "{\"keyboard\":" + describe(keyboard_report_desc, sizeof(keyboard_report_desc)) +
                  ",\"pad\":" + describe(pad_report_desc, sizeof(pad_report_desc)) +
                  ",\"padDescLen\":" + (int)sizeof(pad_report_desc) + "}";
    server.send(200, "application/json", body);
  });

  server.on("/usb", [] {
    String body = String("{\"mounted\":") + ((bool)USB ? "true" : "false") +
      ",\"hidReady\":" + (tud_hid_n_ready(0) ? "true" : "false") +
      ",\"readyChecks\":" + (uint32_t)padReadyChecks +
      ",\"reportsSent\":" + (uint32_t)padReportsSent +
      ",\"outReports\":" + (uint32_t)padOutReports +
      ",\"lastOut\":\"";
    for (uint8_t i = 0; i <= padLastOutLen; i++) {
      if (i) body += ' ';
      if (padLastOut[i] < 0x10) body += '0';
      body += String(padLastOut[i], HEX);
    }
    body += "\"}";
    server.send(200, "application/json", body);
  });

#ifndef PAD_ONLY
  // /key?code=40[&ms=800] presses one HID usage for ms (default 20). The hold
  // matters for UI that distinguishes tap from hold - SmileBASIC's PLAYMENU
  // advertises "A Hold for Submenu", and a 20 ms tap only starts the project.
  server.on("/key", [] {
    if (!server.hasArg("code")) { server.send(400, "application/json", "{\"ok\":false}"); return; }
    uint8_t code = server.arg("code").toInt();
    long ms = server.hasArg("ms") ? server.arg("ms").toInt() : 20;
    if (ms < 1) ms = 1;
    if (ms > 4000) ms = 4000;
    keyboard.pressRaw(code);
    delay((unsigned long)ms);
    keyboard.releaseRaw(code);
    server.send(200, "application/json",
      String("{\"ok\":true,\"code\":") + code + ",\"ms\":" + ms + "}");
  });

  server.on("/type", [] {
    String text = server.arg("text");
    int typed = 0, skipped = 0;
    for (size_t i = 0; i < text.length(); i++) {
      Key key;
      if (!mapChar(text[i], key)) { skipped++; continue; }
      // Raw HID usages: press()/release() expect ASCII keycodes and silently
      // mangle them, which is what garbled the first attempt into symbols.
      if (key.shift) keyboard.pressRaw(0xE1);   // Left Shift usage
      keyboard.pressRaw(key.usage);
      delay(8);
      keyboard.releaseRaw(key.usage);
      if (key.shift) keyboard.releaseRaw(0xE1);
      delay(8);
      typed++;
    }
    server.send(200, "application/json",
      String("{\"ok\":true,\"typed\":") + typed + ",\"skipped\":" + skipped + "}");
  });
#endif

#ifndef KEY_ONLY
  // Named buttons: a b x y l r zl zr minus plus home capture up down left right,
  // plus mask=<hex> to press descriptor button bits directly.
  server.on("/pad", [] {
    uint32_t mask = 0;
    uint8_t hat = PAD_HAT_NEUTRAL;
    if (server.hasArg("mask")) mask = strtoul(server.arg("mask").c_str(), NULL, 0);
    if (flag("a"))      mask |= PAD_BIT(1);
    if (flag("b"))      mask |= PAD_BIT(2);
    if (flag("x"))      mask |= PAD_BIT(3);
    if (flag("y"))      mask |= PAD_BIT(4);
    if (flag("l"))      mask |= PAD_BIT(5);
    if (flag("r"))      mask |= PAD_BIT(6);
    if (flag("zl"))     mask |= PAD_BIT(7);
    if (flag("zr"))     mask |= PAD_BIT(8);
    if (flag("minus"))  mask |= PAD_BIT(9);
    if (flag("plus"))   mask |= PAD_BIT(10);
    if (flag("home"))   mask |= PAD_BIT(11);
    if (flag("capture"))mask |= PAD_BIT(12);
    if (flag("up"))       hat = 0;
    if (flag("upright"))  hat = 1;
    if (flag("right"))    hat = 2;
    if (flag("downright"))hat = 3;
    if (flag("down"))     hat = 4;
    if (flag("downleft")) hat = 5;
    if (flag("left"))     hat = 6;
    if (flag("upleft"))   hat = 7;
    bool raw = flag("raw");
    long ms = server.hasArg("ms") ? server.arg("ms").toInt() : 120;
    padSet(mask, hat);
    bool pressing = (mask != 0) || (hat != PAD_HAT_NEUTRAL);
    padReleaseAt = (raw || !pressing) ? 0 : millis() + (ms > 0 ? ms : 120);
    streamPad();
    server.send(200, "application/json",
      String("{\"ok\":true,\"mask\":") + mask + ",\"hat\":" + hat + "}");
  });
#endif

  server.begin();

  // Wireless updates, so a mapping fix never needs the board unplugged again.
  ArduinoOTA.setHostname("esp32-hid");
  ArduinoOTA.begin();
}

void loop() {
  server.handleClient();
  ArduinoOTA.handle();
  streamPad();
}
