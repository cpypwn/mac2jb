from bleak import BleakClient
import asyncio
import struct

from ns2_common_enums import *
from ns2_controller import NS2Controller

controller = NS2Controller()
controller._verbose = True
controller._disable_slam = True

async def do_stuff():
    await controller.find_controller()
    await controller.async_start()
asyncio.run(do_stuff())