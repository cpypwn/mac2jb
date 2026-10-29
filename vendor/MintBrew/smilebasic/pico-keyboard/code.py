"""Pico 2 W keyboard for the ns2jb bootstrap and Direct-mode launch."""

import board
import digitalio
import os
import supervisor
import time
import usb_hid

supervisor.runtime.autoreload = False

led = digitalio.DigitalInOut(board.LED)
led.switch_to_output(value=False)

# GP0 is reserved by boot.py for maintenance. Ground GP1 while connecting
# to select the long bootstrap typing mode. Normal connection selects commands.
mode_pin = digitalio.DigitalInOut(board.GP1)
mode_pin.switch_to_input(pull=digitalio.Pull.UP)
bootstrap_mode = not mode_pin.value
mode_pin.deinit()

START_DELAY = 15
KEY_HOLD = 0.025
KEY_GAP = 0.035
LINE_DELAY = 0.25
HELLO = 'CLS:PRINT "HELLO WORLD!"'

COMMANDS = (
    ('LOAD "TXT:NS2"', 3),
    # LOAD may show a confirmation dialog. ENTER confirms it; if no dialog
    # appears, this is just an empty Direct-mode command.
    ('', 3),
    ('RUN', 3),
    ('REMOVE NSR,&H60000000,&H3FFFFFFF', 6),
)


def valid_launch(line, host):
    if not line.startswith('V=START(') or not line.endswith(')'):
        return False
    words = line[8:-1].split(',')
    if len(words) != 9 or any(not word.isdigit() for word in words):
        return False
    numbers = [int(word) for word in words]
    return (numbers[0] == 39380 and
            all(0 <= part <= 255 for part in numbers[1:5]) and
            '.'.join(str(part) for part in numbers[1:5]) == host and
            all(0 <= part < 1 << 48 for part in numbers[5:]))


def read_line(connection):
    line = bytearray()
    chunk = bytearray(192)
    while len(line) < 192:
        received = connection.recv_into(chunk)
        if not received:
            raise RuntimeError('Host closed the keyboard connection')
        line.extend(chunk[:received])
        end = bytes(line).find(b'\n')
        if end >= 0:
            return bytes(line[:end]).decode('ascii')
    raise RuntimeError('Host keyboard command is too long')


def connect_host():
    import wifi
    import socketpool

    ssid = os.getenv('CIRCUITPY_WIFI_SSID')
    password = os.getenv('CIRCUITPY_WIFI_PASSWORD')
    host = os.getenv('NS2_HOST')
    key = os.getenv('NS2_PICO_KEY')
    if not ssid or not password or not host or not key or len(key) != 32:
        raise RuntimeError('Complete Wi-Fi and NS2 settings.toml first')
    wifi.radio.connect(ssid, password)
    pool = socketpool.SocketPool(wifi.radio)
    while True:
        connection = pool.socket(pool.AF_INET, pool.SOCK_STREAM)
        try:
            connection.settimeout(10)
            connection.connect((host, 39381))
            connection.sendall(('NS2KEY1 ' + key + '\n').encode('ascii'))
            command = read_line(connection)
            if command != HELLO and not valid_launch(command, host):
                raise RuntimeError('Host sent an invalid or mismatched launch command')
            connection.sendall(b'READY\n')
            return connection, command
        except OSError:
            connection.close()
            time.sleep(2)
        except Exception as error:
            try:
                connection.sendall(('ERROR ' + str(error)[:90] + '\n').encode('ascii'))
            except Exception:
                pass
            connection.close()
            raise


def blink(count):
    for _ in range(count):
        led.value = True
        time.sleep(0.15)
        led.value = False
        time.sleep(0.15)


def type_text(keyboard, table, content):
    for char in content:
        code = table[ord(char)]
        keys = (0xE1, code & 0x7f) if code & 0x80 else (code,)
        keyboard.press(*keys)
        time.sleep(KEY_HOLD)
        keyboard.release_all()
        time.sleep(LINE_DELAY if char == '\n' else KEY_GAP)


def main():
    # GP0 maintenance mode has no HID device and cannot send keypresses.
    if not usb_hid.devices:
        return

    from adafruit_hid.keyboard import Keyboard
    from adafruit_hid.keyboard_layout_us import KeyboardLayoutUS

    table = KeyboardLayoutUS.ASCII_TO_KEYCODE
    connection = None
    if bootstrap_mode:
        content = open('/program.bas', 'r').read()
    else:
        connection, command = connect_host()
        commands = ((command, 0),) if command == HELLO else COMMANDS + ((command, 0),)
        content = '\n'.join(line for line, _ in commands) + '\n'
    for char in content:
        if ord(char) >= len(table) or table[ord(char)] == 0:
            raise ValueError('Unsupported character: ' + repr(char))

    keyboard = Keyboard(usb_hid.devices)
    time.sleep(START_DELAY)
    try:
        if bootstrap_mode:
            led.value = True
            type_text(keyboard, table, content)
            led.value = False
        else:
            connection.sendall(b'TYPING\n')
            for index, (line, pause) in enumerate(commands):
                led.value = True
                type_text(keyboard, table, line + '\n')
                led.value = False
                if pause:
                    blink(index + 1)
                    time.sleep(pause)
            connection.sendall(b'DONE\n')
    finally:
        keyboard.release_all()
        led.value = False
        if connection:
            connection.close()
    blink(2)


try:
    main()
except Exception as error:
    print(error)
    while True:
        led.value = not led.value
        time.sleep(0.1)
while True:
    time.sleep(1)
