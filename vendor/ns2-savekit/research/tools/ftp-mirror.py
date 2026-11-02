#!/usr/bin/env python3
"""Mirror a directory tree from the OunceCake FTP server to a local directory.

  python3 ftp-mirror.py <host> <port> <remote-dir> <local-dir>

Skips files that are already present with the same size, so an interrupted run
can be restarted. Prints one line per completed file plus a running total.
"""
import ftplib
import os
import sys
import time


def main(argv):
    if len(argv) != 5:
        sys.exit(__doc__)
    host, port, remote, local = argv[1], int(argv[2]), argv[3], argv[4]
    ftp = ftplib.FTP()
    ftp.connect(host, port, timeout=120)
    ftp.login()
    ftp.voidcmd('TYPE I')
    state = {'files': 0, 'bytes': 0, 'skipped': 0, 'started': time.time()}

    def walk(rdir, ldir):
        os.makedirs(ldir, exist_ok=True)
        ftp.cwd(rdir)
        names = sorted(ftp.nlst())
        for name in names:
            if name in ('.', '..'):
                continue
            rpath = rdir.rstrip('/') + '/' + name
            lpath = os.path.join(ldir, name)
            try:
                ftp.cwd(rpath)
                walk(rpath, lpath)
                ftp.cwd(rdir)
                continue
            except ftplib.error_perm:
                pass
            try:
                size = ftp.size(rpath)
            except ftplib.error_perm:
                size = None
            if size is not None and os.path.exists(lpath) and os.path.getsize(lpath) == size:
                state['skipped'] += 1
                continue
            tmp = lpath + '.part'
            with open(tmp, 'wb') as handle:
                ftp.retrbinary('RETR ' + rpath, handle.write, blocksize=1 << 18)
            os.replace(tmp, lpath)
            state['files'] += 1
            state['bytes'] += os.path.getsize(lpath)
            elapsed = time.time() - state['started']
            print('%9d  %6.2f MiB/s  %s' % (os.path.getsize(lpath),
                  state['bytes'] / 1048576.0 / max(elapsed, 1e-6), rpath), flush=True)

    try:
        walk(remote, local)
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()
    print('mirrored %d files, %d skipped, %.1f MiB in %.0fs'
          % (state['files'], state['skipped'], state['bytes'] / 1048576.0,
             time.time() - state['started']), flush=True)


if __name__ == '__main__':
    main(sys.argv)
