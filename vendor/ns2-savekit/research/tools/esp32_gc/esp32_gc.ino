// GameCube adapter (WUP-028) persona, with the official 214-byte report
// descriptor and exactly one byte changed so Espressif's HID parser accepts it.
//
//   GET /gc?a=1&up=1&ms=150     press GameCube buttons
//   GET /gc?mask=0x0001&wire=37 raw bits / report length
//   GET /usb                    link + driver diagnostics
//   GET /parse                  does esp_hid accept the descriptor
//
// The official dump opens with "05 05 09 00" (Usage Page 5, Usage 0). Espressif's
// parser rejects a Usage-0 application collection, and the core returns NULL from
// tud_hid_descriptor_report_cb, so the host never gets a report descriptor and the
// interface is never configured. Byte 3 is the only change: usage 0 -> 1. Every
// report id and length is the adapter's own, including the 37-byte 0x21 state.
#include <WiFi.h>
#include <WebServer.h>
#include <USB.h>
#include <USBHID.h>
#include <ArduinoOTA.h>
#include "esp_hid_common.h"

#include "wifi_secret.h"
static const char *SSID = WIFI_SSID;
static const char *PASS = WIFI_PASS;

static const uint8_t gc_report_desc[] = {
    0x05,0x05,0x09,0x01,0xA1,0x01,0x85,0x11,0x19,0x00,0x2A,0xFF,0x00,0x15,0x00,0x26,
    0xFF,0x00,0x75,0x08,0x95,0x05,0x91,0x00,0xC0,0x09,0x01,0xA1,0x01,0x85,0x21,0x19,
    0x00,0x2A,0xFF,0x00,0x15,0x00,0x26,0xFF,0x00,0x75,0x08,0x95,0x25,0x81,0x00,0xC0,
    0x09,0x01,0xA1,0x01,0x85,0x12,0x19,0x00,0x2A,0xFF,0x00,0x15,0x00,0x26,0xFF,0x00,
    0x75,0x08,0x95,0x01,0x91,0x00,0xC0,0x09,0x01,0xA1,0x01,0x85,0x22,0x19,0x00,0x2A,
    0xFF,0x00,0x15,0x00,0x26,0xFF,0x00,0x75,0x08,0x95,0x19,0x81,0x00,0xC0,0x09,0x01,
    0xA1,0x01,0x85,0x13,0x19,0x00,0x2A,0xFF,0x00,0x15,0x00,0x26,0xFF,0x00,0x75,0x08,
    0x95,0x01,0x91,0x00,0xC0,0x09,0x01,0xA1,0x01,0x85,0x23,0x19,0x00,0x2A,0xFF,0x00,
    0x15,0x00,0x26,0xFF,0x00,0x75,0x08,0x95,0x02,0x81,0x00,0xC0,0x09,0x01,0xA1,0x01,
    0x85,0x14,0x19,0x00,0x2A,0xFF,0x00,0x15,0x00,0x26,0xFF,0x00,0x75,0x08,0x95,0x01,
    0x91,0x00,0xC0,0x09,0x01,0xA1,0x01,0x85,0x24,0x19,0x00,0x2A,0xFF,0x00,0x15,0x00,
    0x26,0xFF,0x00,0x75,0x08,0x95,0x02,0x81,0x00,0xC0,0x09,0x01,0xA1,0x01,0x85,0x15,
    0x19,0x00,0x2A,0xFF,0x00,0x15,0x00,0x26,0xFF,0x00,0x75,0x08,0x95,0x01,0x91,0x00,
    0xC0,0x09,0x01,0xA1,0x01,0x85,0x25,0x19,0x00,0x2A,0xFF,0x00,0x15,0x00,0x26,0xFF,
    0x00,0x75,0x08,0x95,0x02,0x81,0x00,0xC0,
};

#define GC_STATUS 0x10

static volatile uint32_t gcSent = 0, gcOut = 0;
static volatile uint8_t gcLastOut[9] = {0};
static volatile uint8_t gcLastOutLen = 0;

class GCAdapter : public USBHIDDevice {
 public:
  GCAdapter() { hid.addDevice(this, sizeof(gc_report_desc)); }
  void begin() { hid.begin(); }
  uint16_t _onGetDescriptor(uint8_t *dst) override {
    memcpy(dst, gc_report_desc, sizeof(gc_report_desc));
    return sizeof(gc_report_desc);
  }
  void _onOutput(uint8_t report_id, const uint8_t *buffer, uint16_t len) override {
    gcOut++;
    gcLastOut[0] = report_id;
    gcLastOutLen = (uint8_t)(len > 8 ? 8 : len);
    for (uint8_t i = 0; i < gcLastOutLen; i++) gcLastOut[i + 1] = buffer[i];
  }
  bool send(const uint8_t *payload, size_t len) {
    bool ok = hid.SendReport(0x21, payload, len, 3);
    if (ok) gcSent++;
    return ok;
  }
 private:
  USBHID hid;
};

WebServer server(80);
GCAdapter gc;
static uint8_t report[37];
static size_t reportLen = 36;      // wire = id + 36 = 37 bytes, like the adapter
static uint32_t sentAt = 0, releaseAt = 0;

static void idle() {
  memset(report, 0, sizeof(report));
  report[0] = GC_STATUS;
  report[3] = 0x80; report[4] = 0x80; report[5] = 0x80; report[6] = 0x80;
}

static void stream() {
  uint32_t now = millis();
  if (releaseAt && now >= releaseAt) { idle(); releaseAt = 0; }
  if (!tud_hid_n_ready(0)) return;
  if (now - sentAt < 8) return;
  sentAt = now;
  gc.send(report, reportLen);
}

static bool flag(const char *n) {
  if (!server.hasArg(n)) return false;
  String v = server.arg(n); return v == "1" || v == "true" || v == "on";
}

void setup() {
  Serial.begin(115200);
  idle();
  USB.manufacturerName("Nintendo");
  USB.productName("WUP-028");
  USB.begin();
  gc.begin();
  WiFi.begin(SSID, PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);

  server.on("/status", [] {
    server.send(200, "application/json", String("{\"ok\":true,\"ip\":\"") +
      WiFi.localIP().toString() + "\",\"fw\":\"gc-official\"}");
  });
  server.on("/parse", [] {
    esp_hid_report_map_t *m = esp_hid_parse_report_map(gc_report_desc, sizeof(gc_report_desc));
    String body = String("{\"parsed\":") + (m ? "true" : "false") + ",\"descLen\":" +
      (int)sizeof(gc_report_desc) + ",\"reports\":[";
    if (m) {
      for (uint8_t i = 0; i < m->reports_len; i++) {
        if (i) body += ",";
        body += String("{\"id\":") + m->reports[i].report_id + ",\"type\":" +
                m->reports[i].report_type + ",\"len\":" + m->reports[i].value_len + "}";
      }
      esp_hid_free_report_map(m);
    }
    body += "]}";
    server.send(200, "application/json", body);
  });
  server.on("/usb", [] {
    String body = String("{\"mounted\":") + ((bool)USB ? "true" : "false") +
      ",\"hidReady\":" + (tud_hid_n_ready(0) ? "true" : "false") +
      ",\"reportsSent\":" + (uint32_t)gcSent + ",\"outReports\":" + (uint32_t)gcOut +
      ",\"uptimeMs\":" + (uint32_t)millis() + ",\"lastOut\":\"";
    for (uint8_t i = 0; i <= gcLastOutLen; i++) {
      if (i) body += ' ';
      if (gcLastOut[i] < 0x10) body += '0';
      body += String(gcLastOut[i], HEX);
    }
    body += "\"}";
    server.send(200, "application/json", body);
  });
  server.on("/gc", [] {
    uint16_t b = 0;
    if (server.hasArg("mask")) b = (uint16_t)strtoul(server.arg("mask").c_str(), NULL, 0);
    if (flag("a")) b |= 0x0001;
    if (flag("b")) b |= 0x0002;
    if (flag("x")) b |= 0x0004;
    if (flag("y")) b |= 0x0008;
    if (flag("start")) b |= 0x0010;
    if (flag("z")) b |= 0x0020;
    if (flag("r")) b |= 0x0040;
    if (flag("l")) b |= 0x0080;
    if (flag("up")) b |= 0x0800;
    if (flag("down")) b |= 0x0400;
    if (flag("left")) b |= 0x0100;
    if (flag("right")) b |= 0x0200;
    if (server.hasArg("wire")) {
      long w = server.arg("wire").toInt();
      if (w >= 2 && w <= 38) reportLen = (size_t)w - 1;
    }
    idle();
    report[1] = (b >> 8) & 0xff; report[2] = b & 0xff;
    if (server.hasArg("lx")) report[3] = (uint8_t)server.arg("lx").toInt();
    if (server.hasArg("ly")) report[4] = (uint8_t)server.arg("ly").toInt();
    bool raw = flag("raw");
    long ms = server.hasArg("ms") ? server.arg("ms").toInt() : 150;
    bool pressing = b != 0 || report[3] != 0x80 || report[4] != 0x80;
    releaseAt = (raw || !pressing) ? 0 : millis() + (ms > 0 ? ms : 150);
    stream();
    server.send(200, "application/json", String("{\"ok\":true,\"mask\":") + b +
      ",\"wire\":" + (int)(reportLen + 1) + "}");
  });

  server.begin();
  ArduinoOTA.setHostname("esp32-hid");
  ArduinoOTA.begin();
}

void loop() { server.handleClient(); ArduinoOTA.handle(); stream(); }
