#!/usr/bin/env python3
"""From a wedged console to an RPC session, with no hands and no screen checks.

  python3 tools/cycle.py                # full cycle: power, launch, host, V=START
  python3 tools/cycle.py --no-power     # console already freshly booted
  python3 tools/cycle.py --status       # just report the newest run

Assumptions, all measured on this console (docs/RESULTS.md, 2026-10-28):
  * a 16 s power press force-offs the console and a 1 s press boots it
  * the home menu keeps the game row with Mario Kart first and the retail
    SMILEBASIC 4 tile second, and the account picker defaults to `doug`
  * the session script already contains LOAD/RUN/REMOVE/V=START for this host

It starts the host, types the session through the Flipper's Bad KB, and leaves
the host running. Nothing here checks the screen: the point is to get RPC up
while other work continues.
"""
import argparse
import os
import re
import subprocess
import sys
import time
import urllib.request

from PIL import Image, ImageStat

FINGERBOT = os.environ.get('FINGERBOT', 'http://127.0.0.1:8080')
PAD = os.environ.get('PAD', 'http://192.168.50.215')
MAC_IP = os.environ.get('MAC_IP', '192.168.50.235')
RPC_DIR = os.path.expanduser('~/ns2jb-rpc')
FLIPPER_DIR = os.path.expanduser('~/flipper2jb')
FLIPPER_HOST = os.environ.get('FLIPPER_HOST', '192.168.50.215')
COMMAND = 'V=START(39380,192,168,50,235,0,0,0,0)'
HOST_LOG = '/tmp/cycle-host.log'

def log(message):
    print('%s  %s' % (time.strftime('%H:%M:%S'), message), flush=True)

def http(url, timeout=25):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read().decode(errors='replace')
    except Exception as e:
        return 'ERR ' + str(e)[:80]

def pad(query, pause=1.0, ms=90):
    # Short taps only: a held direction auto-repeats on the home menu, which is
    # what made the cursor skip tiles.
    reply = http('%s/pro?%s&ms=%d' % (PAD, query, ms))
    time.sleep(pause)
    return reply

def power_cycle():
    log('fingerbot: arm up, then a 16 s press to force off')
    http(FINGERBOT + '/up')
    time.sleep(1)
    http(FINGERBOT + '/press?seconds=16', timeout=45)
    time.sleep(6)
    log('fingerbot: 1 s press to boot')
    http(FINGERBOT + '/press?seconds=1')
    time.sleep(6)
    http(FINGERBOT + '/press?seconds=1')
    log('waiting 30 s for the home menu')
    time.sleep(30)

VISION_OCR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vision', 'ocr')

def screen_brightness(path=None):
    """Mean luma of the newest capture. SmileBASIC is near-black; games are not."""
    path = path or '/tmp/ns2cap/latest.png'
    try:
        image = Image.open(path).convert('L')
        return ImageStat.Stat(image).mean[0]
    except Exception:
        return 255.0

def capture(path):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
                    '-pixel_format', 'uyvy422', '-framerate', '30', '-video_size', '1920x1080',
                    '-i', '0:none', '-frames:v', '1', '-update', '1', '-y', path],
                   timeout=40, check=False)
    return os.path.exists(path)

def ocr_text(image='/tmp/cycle-label.png'):
    """All OCR text from one capture, lower-cased."""
    if not capture(image):
        return ''
    try:
        out = subprocess.run([VISION_OCR, image], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return ''
    return ' '.join(line.split('\t', 1)[1] for line in out.splitlines() if '\t' in line).lower()

def title_labels(image='/tmp/cycle-label.png'):
    """OCR the home menu and return the strings on the title-label row.

    The label sits just above the tile row (Vision's origin is bottom-left, so
    y ~0.71-0.81). Tile artwork text is lower, around y 0.5, and is ignored.
    """
    if not capture(image):
        return []
    try:
        out = subprocess.run([VISION_OCR, image], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return []
    labels = []
    for line in out.splitlines():
        parts = line.split('\t', 1)
        if len(parts) != 2:
            continue
        try:
            x, y, w, h = [float(v) for v in parts[0].split()]
        except ValueError:
            continue
        if 0.70 <= y <= 0.82:
            labels.append(parts[1].strip())
    return labels

def launch_smilebasic():
    """Select SmileBASIC by reading the home menu, not by counting tiles.

    The game row reorders with recency and skips virtual-game-card tiles, so a
    fixed offset launches the wrong title. Instead OCR the title label, step one
    tile at a time until it names SmileBASIC (the retail tile, not the DEMO one),
    then launch.
    """
    http(PAD + '/stream?on=1')   # a previous attempt may have silenced the pad
    time.sleep(1)
    # A fixed 30 s wait is not always enough for a cold boot; wait for actual
    # on-screen text before navigating (a black screen yields no OCR text).
    for _ in range(20):
        if ocr_text():
            break
        time.sleep(3)
    # The console boots onto the news view, where no tile is selected and the
    # title label is absent. B (or HOME) leaves it for the game row, which is
    # where the label lives. No DOWN presses: they were what pushed focus onto
    # the icon row and made the row look empty.
    log('pad: B (leave the news view for the game row)')
    pad('b=1', 2.5)
    if not title_labels():
        log('pad: HOME (reset focus)')
        pad('home=1', 2.5)

    found = False
    for step in range(16):
        labels = title_labels()
        text = ' | '.join(labels)
        log('  label[%d]: %s' % (step, text or '(none)'))
        if any('smilebasic' in l.lower() for l in labels):
            if any('demo' in l.lower() for l in labels):
                log('  that is the DEMO tile; stepping past it')
            else:
                found = True
                break
        pad('right=1', 1.7)
    if not found:
        raise SystemExit('could not select the retail SmileBASIC tile')

    log('pad: A (launch SmileBASIC)')
    pad('a=1', 11)

    # Drive the rest by what the screen says: account picker, tag-info dialog,
    # TOPMENU with "Make a Program" preselected, then direct mode. Brightness
    # cannot tell these apart (the account picker is as bright as the menu).
    for step in range(9):
        text = ocr_text()
        short = ' '.join(text.split())[:90]
        log('  screen[%d]: %s' % (step, short or '(no text)'))
        if 'free' in text or 'bytes' in text:
            break
        pad('a=1', 6)
    else:
        raise SystemExit('never reached the direct-mode prompt')
    if not any(w in ocr_text() for w in ('free', 'bytes')):
        raise SystemExit('direct-mode prompt not confirmed')
    log('direct mode reached; silencing the pad for the session')
    http(PAD + '/stream?on=0')

def start_host():
    log('host: node run.cjs --rpc %s' % MAC_IP)
    handle = open(HOST_LOG, 'w')
    proc = subprocess.Popen(['node', 'run.cjs', '--rpc', MAC_IP], cwd=RPC_DIR,
                            stdout=handle, stderr=subprocess.STDOUT)
    run = None
    for _ in range(60):
        time.sleep(0.5)
        try:
            text = open(HOST_LOG).read()
        except OSError:
            continue
        match = re.search(r'Run folder: (\S+)', text)
        if match:
            run = match.group(1)
            break
    if not run:
        raise SystemExit('host did not print a run folder; see ' + HOST_LOG)
    log('host: run folder %s (pid %d)' % (run, proc.pid))
    return proc, run

def session_script():
    sys.path.insert(0, FLIPPER_DIR)
    from flipper2jb.rpc import RPC, blob, integer
    from flipper2jb.targets.ns2jb import session_script as build
    from flipper2jb.transfer import upload
    from flipper2jb.autoclose import is_locked

    data, seconds = build(COMMAND)
    remote = '/ext/badusb/CY-%d.txt' % int(time.time())
    rpc = RPC(FLIPPER_HOST, 8080)
    try:
        if is_locked(rpc):
            log('flipper: Bad KB is open, sending Back')
            for event in (0, 2, 1):
                rpc.request(23, integer(1, 5) + integer(2, event))
                time.sleep(0.2)
            time.sleep(2)
        log('flipper: uploading %s (%d bytes of key script)' % (remote, len(data)))
        upload(rpc, remote, data)
        try:
            rpc.request(16, blob(1, 'Bad KB') + blob(2, remote))
        except RuntimeError as error:
            log('flipper: start refused (%s); pressing Run on the open app' % error)
        time.sleep(3)
        for event in (0, 2, 1):
            rpc.request(23, integer(1, 4) + integer(2, event))
            time.sleep(0.25)
        log('flipper: Run pressed; script types for %.0f s' % seconds)
    finally:
        rpc.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-power', action='store_true')
    parser.add_argument('--no-launch', action='store_true')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--wait', type=int, default=1200)
    args = parser.parse_args()

    if args.status:
        runs = sorted((os.path.join(RPC_DIR, 'runs', name)
                       for name in os.listdir(os.path.join(RPC_DIR, 'runs'))),
                      key=os.path.getmtime)
        run = runs[-1]
        print(subprocess.run(['node', os.path.join(RPC_DIR, 'rpc.cjs'), run, 'status'],
                             capture_output=True, text=True).stdout)
        return

    if not args.no_power:
        power_cycle()
    if not args.no_launch:
        launch_smilebasic()

    proc, run = start_host()
    session_script()

    # Success is the held FS root, not "ready": `ready` only means the RPC link
    # answered at stage 1. The host writes 4/4 and drops current-root.json when
    # it holds the root.
    proof = os.path.join(run, 'switch2', 'ro', 'root', 'current-root.json')
    log_path = os.path.join(run, 'run.log')
    deadline = time.time() + args.wait
    last = ''
    while time.time() < deadline:
        time.sleep(10)
        try:
            text = open(log_path).read()
        except OSError:
            text = ''
        if os.path.exists(proof) or '4/4' in text:
            stage = [l for l in text.splitlines() if l.strip().startswith('4/4')]
            log('4/4 REACHED' + (' - ' + stage[0].strip() if stage else ''))

            return
        if 'Error:' in text:
            log('failed: ' + [l for l in text.splitlines() if 'Error:' in l][-1][:140])
            raise SystemExit(2)
        stage = re.findall(r'^\s*([1-4])/4 .*$', text, re.M)
        line = 'stage %s' % (stage[-1] + '/4' if stage else 'none')
        if line != last:
            log(line)
            last = line
    log('timed out after %d s without 4/4' % args.wait)
    raise SystemExit(3)

if __name__ == '__main__':
    main()
