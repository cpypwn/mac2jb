from bleak import BleakClient, BleakScanner
import asyncio
import platform
import sys
import struct
import numpy as np
import time

from ns2_common_enums import *

from pynput.mouse import Button, Controller
#import macmouse as mouse

# Notes:
# - timestamps are in nanoseconds

def device_details_to_dict(raw_details):
    # Format device details into string. Accommodate errors caused by lack of data.
    dict_ = {
        'address': None,
        'details': None,
        'metadata': None,
        'name': None,
        'rssi': None
    }
    try:
        dict_['address'] = raw_details.address
    except Exception:
        print(f'Address not found for device with the following data: {raw_details}')
    try:
        dict_['details'] = raw_details.details
    except Exception:
        print(f'Details not found for device with the following data: {raw_details}')
    try:
        dict_['metadata'] = raw_details.metadata
    except Exception:
        print(f'Metadata not found for device with the following data: {raw_details}')
    try:
        dict_['name'] = raw_details.name
    except Exception:
        print(f'Name not found for device with the following data: {raw_details}')
    try:
        dict_['rssi'] = raw_details.rssi
    except Exception:
        print(f'RSSI not found for device with the following data: {raw_details}')

    return dict_

class NS2Controller:

    def __init__(self):
        self.seq_idx = 1
        self._address = None
        self._device_name = ""
        self._full_services = []
        self.controller_pos = np.array([0.0, 0.0, 0.0])
        self.controller_quat = np.array([0.0, 0.0, 0.0, 1.0])
        self.controller_ts = 0
        self._disable_slam = False
        self._verbose = False
        self._tlv_callbacks = {}
        self._num_6dof = 0
        self._vid = 0
        self._pid = 0
        self._pending_responses = {}

    def add_tlv_callback(self, type, fn):
        if self._tlv_callbacks.get(type, None) is None:
            self._tlv_callbacks[type] = []
        self._tlv_callbacks[type] += [fn]

    async def find_controller(self):
        print('///////////////////////////////////////////////')
        print('\t\tDevice scan')
        print('///////////////////////////////////////////////')
        print('Scanning for Bluetooth LE devices...')

        while self._address is None:
            devices = await BleakScanner.discover()
            #print(f'Devices found (raw data):\n\t{devices}')
            #print(f'Number of devices found: {textcolor.CYAN}{len(list(devices))}{textcolor.END}')
            #print(f'Details of devices found:')
            for device in devices:
                #if not (NS2_SERVICE_UUID in device.metadata.get("uuids", [])):
                #    continue
                device_dict = device_details_to_dict(device)
                manufacturer_data = device_dict["metadata"]["manufacturer_data"]
                if not (0x553 in manufacturer_data):
                    continue

                #print(manufacturer_data[0x553])

                unk0, unk1, unk2, vid, pid = struct.unpack("<BBBHH", manufacturer_data[0x553][:7])
                
                client = BleakClient(device.address, services=NS2_SERVICES)
                
                '''
                try:
                    async with client:
                        device_name = "".join(map(chr, await client.read_gatt_char(DEVICE_NAME_UUID)))
                        print(f"\tDevice Name: {device_name}")
                except Exception as e:
                    print("Exception reading name?", device.address, device, device.metadata.get("uuids", []), device_dict)
                    print(e)
                    continue
                '''
                print("idk", device.address, device, device.metadata.get("uuids", []), device_dict)

                self._address = device.address
                self._device_name = device.name
                self._full_services = device.metadata.get("uuids", [])
                self._client = client
                self._vid = vid
                self._pid = pid

                print('Device found:')
                print(f'\tAddress: {textcolor.GOLD}{device.address}{textcolor.END}')
                print(f'\tName: {textcolor.GREEN}{device.name}{textcolor.END}')
                print(f'\tDetails: {device.details}')
                print(f'\tMetadata: {device.metadata}')
                print(f'\tRSSI: {device.rssi}')
                print(f'\tVID:', hex(self._vid))
                print(f'\tPID:', hex(self._pid))

    async def async_start(self):
        print("Async start")
        client = BleakClient(self._address, services=NS2_SERVICES)
        self.seq_idx = 1

        self.last_mouse_set = False
        self.last_mouse_x = 0
        self.last_mouse_y = 0
        self.last_time = time.time()
        self.last_button_l = False
        self.last_button_r = False

        async def process_hid_data(hid_data):
            print((time.time() - self.last_time) * 1000.0)
            self.last_time = time.time()

            if self._pid not in NS2_JOYCON_PIDS:
                return

            mouse_data = hid_data[0x9:0xd]
            delta_x, delta_y = struct.unpack("<hh", mouse_data)
            if abs(delta_x) > 1000:
                delta_x = 0
            if abs(delta_y) > 1000:
                delta_y = 0
            
            #print("mouse", (delta_x, delta_y))
            button_l = (hid_data[2] & NS2_JC_BUTTON_BUMPER) == NS2_JC_BUTTON_BUMPER
            button_r = (hid_data[2] & NS2_JC_BUTTON_TRIGGER) == NS2_JC_BUTTON_TRIGGER

            stick_x = hid_data[0x5] | ((hid_data[0x6] & 0xF)<<8)
            stick_y = (hid_data[0x7]<<4) | ((hid_data[0x6] & 0xF0)>>4)

            scroll_x = -(((stick_x - 0x300) / (0xd00 - 0x300)) - 0.5)
            scroll_y = (((stick_y - 0x300) / (0xd00 - 0x300)) - 0.5)

            print(hex(stick_x), hex(stick_y), scroll_x, scroll_y)
            scroll_x = int(scroll_x * 6)
            scroll_y = int(scroll_y * 6)

            mouse.move(delta_x, delta_y)
            if button_l and not self.last_button_l:
                mouse.press(Button.left)
            elif not button_l and self.last_button_l:
                mouse.release(Button.left)
            if button_r and not self.last_button_r:
                mouse.press(Button.right)
            elif not button_r and self.last_button_r:
                mouse.release(Button.right)
            mouse.scroll(scroll_x, scroll_y)

            self.last_button_l = button_l
            self.last_button_r = button_r

            hexdump(hid_data)

        async def _disconnected(*args, **kwargs):
            print("DISCONNECT", args, kwargs)
            while True:
                await client.connect()
                await asyncio.sleep(0.01)

        async def _callback_nop(*args, **kargs):
            pass

        async def _callback_generic(*args, **kargs):
            print("NOTIFY", args, kargs)
            resp_data = args[1]
            hexdump(resp_data)

        async def _callback_sidechannel_response(*args, **kargs):
            #print("NOTIFY", args, kargs)
            resp_data = args[1]
            #hexdump(resp_data)

            cmd, unk1, unk2, subcmd, unk3, extra_len_lo, extra_len_hi = struct.unpack("<BBBBBHB", resp_data[:8])
            extra_len = (extra_len_lo | (extra_len_hi << 16)) & 0xFFFFFF
            extra_data = resp_data[8:]

            future_key = (cmd & 0xFF, subcmd & 0xFF)
            future = self._pending_responses.get(future_key)
            if future and not future.done():
                future.set_result(resp_data)
                #hexdump(resp_data)
                print("Resp time:", (time.time() - future._creation_time) * 1000.0)
            else:
                print("Missing future???", future_key)

            

        async def _callback_hid_full(*args, **kargs):
            #print("NOTIFY HID FULL", args, kargs)

            hid_data = args[1]
            #hexdump(hid_data)
            await process_hid_data(hid_data)

        async def send_cmd(cmd, subcmd, extra=bytes()):
            data = struct.pack("<BBBBBHB", cmd & 0xFF, 0x91, 0x01, subcmd, 0x00, len(extra) & 0xFFFF, (((len(extra) & 0xFFFFFF) >> 16) & 0xFF)) + extra
            
            future_key = (cmd & 0xFF, subcmd & 0xFF)
            future = asyncio.get_event_loop().create_future()
            future._creation_time = time.time()
            self._pending_responses[future_key] = future

            print("Sending:")
            hexdump(data)
            await client.write_gatt_char(NS2_SIDECHANNEL_IN, data, False)
            #await client.write_gatt_char(self._alt_sidechannel_input, bytes([0x00]*32)+data, False)

            response = None
            try:
                response = await asyncio.wait_for(future, timeout=2.0)
            finally:
                self._pending_responses.pop(future_key, None)

            #print("Future returned:")
            #hexdump(response)

            return response
            

        client.set_disconnected_callback(_disconnected)

        mouse = Controller()

        async with client:
            #print(client.metadata.get("uuids", []))

            is_next = False
            sidechannel_alt_next = False
            sidechannel_alt_out_next = False
            full_hid_output = NS2_BASIC_INPUT_UUID
            self._alt_sidechannel_input = NS2_SIDECHANNEL_IN
            self._alt_sidechannel_output = NS2_SIDECHANNEL_OUT
            services = await client.get_services()
            for idx in services.characteristics:
                c = services.characteristics[idx]
                if c.uuid == NS2_BASIC_INPUT_UUID:
                    is_next = True
                elif c.uuid == NS2_SIDECHANNEL_IN:
                    sidechannel_alt_next = True
                elif c.uuid == NS2_SIDECHANNEL_OUT:
                    sidechannel_alt_out_next = True
                elif is_next:
                    full_hid_output = c.uuid
                    is_next = False
                elif sidechannel_alt_next:
                    self._alt_sidechannel_input = c.uuid
                    sidechannel_alt_next = False
                elif sidechannel_alt_out_next:
                    self._alt_sidechannel_output = c.uuid
                    sidechannel_alt_out_next = False
                print(is_next, sidechannel_alt_next, sidechannel_alt_out_next, c.uuid, c.properties)
                for desc in c.descriptors:
                    print("    ", desc)

                    # Switch 2 does this before setting notify, idk why
                    if c.uuid == full_hid_output and full_hid_output != NS2_BASIC_INPUT_UUID and desc.uuid == NS2_UNK_CHARACTERISTIC:
                        await client.write_gatt_descriptor(desc.handle, struct.pack("<H", 0x85))
                        
            print(full_hid_output)

            #await client.write_gatt_char(NS2_UNK_CHARACTERISTIC, struct.pack("<H", 0x85), False)
            #print(services.characteristics)
            #print(services.descriptors)
            #print(client.characteristics)
            
            #await client.start_notify(NS2_UNKNOWN_NOTIFY, _callback_generic)
            #await client.start_notify(NS2_BASIC_INPUT_UUID, _callback_generic)
            await client.start_notify(NS2_SIDECHANNEL_OUT, _callback_sidechannel_response)
            #await client.start_notify(self._alt_sidechannel_output, _callback_generic)

            #await send_cmd(0x03, 0x0d, bytes([0x01, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])) # skipped for BTLE?
            await send_cmd(0x07, 0x01)
            #await send_cmd(0x16, 0x01) #moved for BTLE?
            # skip pairing
            await send_cmd(0x03, 0x09)
            await send_cmd(0x09, 0x07, struct.pack("<LL", 0xFF, 0)) # all LEDs
            await send_cmd(0x0c, 0x02, struct.pack("<L", 0x37))
            #spi reads
            await send_cmd(0x11, 0x03)
            #spi reads
            await send_cmd(0x0a, 0x08, bytes([0x01, 0x55, 0x09, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x35, 0x00, 0x46, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
            await send_cmd(0x0c, 0x04, struct.pack("<L", 0x37))
            await send_cmd(0x03, 0x0a, struct.pack("<L", 0x8))
            await send_cmd(0x10, 0x01)
            await send_cmd(0x16, 0x01) #moved for BTLE? Happens before pairing cmds and after SPI reads
            #await send_cmd(0x15, 0x03, bytes([0x00]))
            await send_cmd(0x01, 0x0c)

            # on seeing input
            await send_cmd(0x03, 0x0c, struct.pack("<L", 0x1))
            await send_cmd(0x09, 0x07, struct.pack("<LL", 0x1, 0)) # player 1
            await send_cmd(0x08, 0x02, struct.pack("<L", 0x1))

            # Post encryption, BTLE

            await client.start_notify(full_hid_output, _callback_hid_full)

            while True:
                start = time.time()
                
                '''
                try:
                    hid_data = await client.read_gatt_char(full_hid_output)
                    #await process_hid_data(hid_data)
                    print(hid_data)
                    end = time.time()
                    print("Heartbeat:", (end-start)*1000.0, client.mtu_size)
                except Exception as e:
                    print(e)
                '''

                '''
                await send_cmd(0x07, 0x01)
                end = time.time()
                print("Heartbeat:", (end-start)*1000.0, client.mtu_size)
                '''
                
                await asyncio.sleep(0.001)