# Ground GP0 to GND before connecting to expose CIRCUITPY for maintenance.
import board
import digitalio
import storage
import usb_cdc
import usb_hid

maintenance = digitalio.DigitalInOut(board.GP0)
maintenance.switch_to_input(pull=digitalio.Pull.UP)
if maintenance.value:
    storage.disable_usb_drive()
    usb_cdc.disable()
    usb_hid.enable((usb_hid.Device.KEYBOARD,), boot_device=1)
else:
    usb_hid.disable()
maintenance.deinit()
