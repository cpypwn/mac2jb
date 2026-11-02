"""Data-only extracted DLC repacks. No game executable, rights or keys are created."""
from dataclasses import dataclass
from pathlib import Path
import hashlib, mmap, os, re, shutil, stat, struct, time, uuid
import container_format as fmt
import verify_format as reader

BASE_MASK = 0xffffffffffffe000


def parse_id(value):
    if isinstance(value, int):
        tid = value
    else:
        text = str(value).strip()
        if not re.fullmatch(r'[0-9a-fA-F]{16}', text):
            raise ValueError('DLC title ID must contain exactly 16 hexadecimal digits.')
        tid = int(text, 16)
    if not 0 < tid < 1 << 64 or not 0x1000 <= (tid & 0x1fff) <= 0x17ff:
        raise ValueError('This title ID is not in the add-on-content range (base + 0x1000–0x17FF).')
    return tid


def parse_version(value):
    text = str(value).strip()
    if not text.isascii() or not text.isdecimal() or not 0 <= int(text) <= 0xffffffff:
        raise ValueError('DLC version must be an integer from 0 to 4294967295, as stored in the dump.')
    return int(text)


@dataclass(frozen=True)
class DlcSnapshot:
    root: Path
    title_id: int
    version: int
    label: str

    @property
    def base_id(self):
        return self.title_id & BASE_MASK


def linked(path):
    st = path.lstat()
    return path.is_symlink() or bool(getattr(st, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def find_snapshots(folder, title_id=None):
    folder = Path(folder).absolute()
    if not folder.is_dir() or linked(folder):
        raise ValueError('Choose an existing, unlinked extracted DLC folder.')
    if folder.name.lower() == 'romfs':
        folder = folder.parent
    override = parse_id(title_id) if title_id else None
    found = []

    def scan(path, depth):
        fmt.checkpoint()
        if linked(path):
            raise ValueError('Linked folders are not supported: ' + str(path))
        romfs = path / 'romfs'
        if romfs.is_dir():
            if linked(romfs):
                raise ValueError('Linked RomFS folders are not supported.')
            if (path / 'exefs' / 'main').is_file():
                raise ValueError('This contains a game executable. Use the Game tab for full game snapshots.')
            ancestors = list(path.parents)[:4]
            candidates = [p for p in [path] + ancestors if re.fullmatch(r'[0-9a-fA-F]{16}', p.name)]
            detected = parse_id(candidates[0].name) if candidates else None
            if override and detected and override != detected and path == folder:
                raise ValueError('Entered DLC title ID differs from the dump folder title ID.')
            tid = detected or override
            if tid is None:
                raise ValueError('No DLC title ID in the folder names. Enter its original DLC title ID and scan again.')
            version = parse_version(path.name) if path.name.isdecimal() and len(path.name) < 11 else 0
            label = str(path.relative_to(folder)) if path != folder else 'Selected folder'
            found.append(DlcSnapshot(path.resolve(), tid, version, label))
            return
        if depth >= 4:
            return
        for child in sorted(path.iterdir()):
            if child.is_dir():
                scan(child, depth + 1)

    scan(folder, 0)
    if not found:
        raise ValueError('No extracted DLC RomFS found. Select dlc, a title/version folder, or its romfs folder.')
    found.sort(key=lambda s: (s.title_id, -s.version, s.label))
    return found


def inventory(snapshot, notify=lambda *a: None):
    result = {}
    root = snapshot.root / 'romfs'
    if linked(root):
        raise ValueError('Linked source folders are not supported.')

    def visit(folder):
        with os.scandir(folder) as entries:
            for entry in entries:
                fmt.checkpoint()
                p = Path(entry.path)
                st = entry.stat(follow_symlinks=False)
                if entry.is_symlink() or getattr(st, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    raise ValueError('Linked source files/folders are not supported: ' + str(p))
                if entry.is_dir(follow_symlinks=False):
                    visit(p)
                elif entry.is_file(follow_symlinks=False):
                    result[p] = (st.st_size, st.st_mtime_ns)
                    if len(result) % 256 == 0:
                        notify(f'Checking DLC source files · {len(result):,} found', 1)
    visit(root)
    if not result:
        raise ValueError('The DLC RomFS folder is empty.')
    return result


def container_files(buf):
    if bytes(buf[:4]) != b'PFS0':
        raise ValueError('Choose a plaintext NSP produced by NSP Box.')
    return reader.partition(buf), 0


def base_game_info(path):
    """Inspect headers/control only; never hash or copy the base game's payload."""
    p = Path(path)
    with p.open('rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        files, _ = container_files(reader.Region(mm))
        programs = set()
        control = None
        for data in files.values():
            if bytes(data[0x200:0x204]) != b'NCA3':
                continue
            tid = reader.u('Q', data, 0x210)[0]
            if data[0x205] == 0:
                programs.add(tid)
            elif data[0x205] == 2 and len(data) <= 8 * 1024 * 1024:
                _, _, sections = reader.nca_sections(data)
                nacp = reader.romfs_files(next(b for k, b in sections if k == 'romfs')).get('control.nacp')
                if nacp is not None and len(nacp) == 0x4000:
                    control = (tid, bytes(nacp))
        if len(programs) != 1:
            raise ValueError('Expected one plaintext base-game Program NCA; encrypted/multi-program inputs are not supported.')
        tid = programs.pop()
        if tid & 0x1fff:
            raise ValueError('Choose a complete base-game snapshot, not an update/DLC package.')
        result = {'title_id': tid, 'dlc_base_id': tid + 0x1000, 'title': p.stem}
        if control and control[0] == tid:
            n = control[1]
            result['dlc_base_id'] = struct.unpack_from('<Q', n, 0x3070)[0]
            if n[0x3215] == 0:
                result['title'] = n[:0x200].split(b'\0')[0].decode('utf-8', 'replace') or p.stem
        return result


def validate_base(snapshot, info):
    if info['title_id'] != snapshot.base_id or info['dlc_base_id'] != snapshot.base_id + 0x1000:
        raise ValueError('DLC title ID does not match this base game or its control metadata DLC base ID.')


def verify(path, snapshot, sources, notify=lambda *a: None, captured=None):
    reader.checkpoint = fmt.checkpoint
    with Path(path).open('rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        files, distribution = container_files(reader.Region(mm))
        assert len(files) == 2, 'Expected exactly Data and Meta NCAs'
        parsed = {}
        hashes = {}
        for name, data in files.items():
            fmt.checkpoint()
            assert data[0x204] == distribution, 'NCA distribution type'
            hashes[name] = reader.digest(data)
            assert hashes[name][:16].hex() == name[:32], 'NCA content ID'
            tid, kind, sections = reader.nca_sections(data)
            assert tid == snapshot.title_id, 'DLC title ID'
            assert kind not in parsed, 'Duplicate content type'
            parsed[kind] = sections
        assert set(parsed) == {1, 4}, 'DLC must contain Meta and Data, no game executable'
        cfiles = reader.partition(parsed[1][0][1])
        assert list(cfiles) == [f'AddOnContent_{snapshot.title_id:016x}.cnmt'], 'CNMT filename'
        c = next(iter(cfiles.values()))
        tid, version, kind, platform, extra, count, metas = reader.u('QIBBHHH', c)
        assert (tid, version, kind, extra, count, metas) == (snapshot.title_id, snapshot.version, 0x82, 0x18, 1, 0), 'CNMT identity/type'
        assert reader.u('Q', c, 0x20)[0] == snapshot.base_id, 'CNMT application mapping'
        assert len(c) == 0x20 + extra + 0x38 + 32, 'CNMT size'
        assert reader.digest(c[:-32]) == bytes(c[-32:]), 'CNMT digest'
        at = 0x20 + extra
        name = bytes(c[at+32:at+48]).hex() + '.nca'
        assert name in files and hashes[name] == bytes(c[at:at+32]), 'CNMT Data hash'
        assert int.from_bytes(bytes(c[at+48:at+54]), 'little') == len(files[name]), 'CNMT Data size'
        assert (c[at+54], c[at+55]) == (2, 0), 'CNMT Data record type/index'
        packed = reader.romfs_files(next(b for k, b in parsed[4] if k == 'romfs'))
        original = {p.relative_to(snapshot.root/'romfs').as_posix(): p for p in sources}
        assert set(original) == set(packed), 'DLC RomFS file list'
        total = sum(st[0] for st in sources.values())
        done = 0
        for name, p in original.items():
            fmt.checkpoint()
            expected = captured[p] if captured is not None else reader.file_digest(p)
            assert expected is not None and reader.digest(packed[name]) == expected, 'DLC file hash: ' + name
            done += sources[p][0]
            notify('Comparing DLC source files', 82 + 17 * done / max(1, total))
    return len(sources)


def build(snapshot, output, output_format=None, verify_output=True, base_game=None,
          notify=lambda *a: None, cancel=None):
    started = time.perf_counter()
    fmt.configure(cancel)
    snapshot = DlcSnapshot(snapshot.root.resolve(), parse_id(snapshot.title_id), parse_version(snapshot.version), snapshot.label)
    output = Path(output).resolve()
    kind = (output_format or output.suffix.lstrip('.')).lower()
    if kind != 'nsp' or output.suffix.lower() != '.nsp':
        raise ValueError('NSP Box supports .nsp output only.')
    if output.is_relative_to(snapshot.root):
        raise ValueError('Save the DLC package outside its source snapshot folder.')
    if output.exists():
        raise FileExistsError('Output already exists. Choose another filename; nothing is overwritten.')
    info = base_game_info(base_game) if base_game else None
    if info:
        validate_base(snapshot, info)
    notify('Checking DLC source files', 1)
    sources = inventory(snapshot, notify)
    output.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(output.parent).free < sum(s[0] for s in sources.values()) * 1.02 + 32*1024*1024:
        raise ValueError('Not enough free disk space for the DLC package.')
    phase = [2, 24, 'Building DLC integrity tree']
    fmt.configure(cancel, lambda done, total: notify(phase[2], phase[0]+(phase[1]-phase[0])*done/max(1,total)))
    romfs = fmt.romfs(snapshot.root/'romfs', [], lambda n: notify(f'Building DLC RomFS · {n:,} files', 2))
    data = fmt.nca([fmt.romfs_section(romfs)], snapshot.title_id, 4, 0)
    phase[:] = [24, 44, 'Hashing DLC content']
    digest = data.digest()
    name = digest[:16].hex()+'.nca'
    c = bytearray(0x20)
    struct.pack_into('<QIBBHHH', c, 0, snapshot.title_id, snapshot.version, 0x82, 0, 0x18, 1, 0)
    # Minimal AddOnContent extended header: original application ID, unknown
    # required application version/accessibilities/data-patch ID left at zero.
    c += struct.pack('<QIB3xQ', snapshot.base_id, 0, 0, 0)
    c += digest + digest[:16] + data.size.to_bytes(6, 'little') + bytes([2, 0])
    c += fmt.sha(c)
    meta = fmt.nca([fmt.pfs_section(fmt.filesystem([(f'AddOnContent_{snapshot.title_id:016x}.cnmt', c)]))],
                   snapshot.title_id, 1, 0)
    image = fmt.package([(name, data), (meta.digest()[:16].hex()+'.cnmt.nca', meta)], kind)
    temporary = output.with_name(output.name+'.'+uuid.uuid4().hex[:10]+'.partial')
    captured = {p: None for p in sources} if verify_output else None
    h = hashlib.sha256()
    try:
        fmt.capture_sources(captured)
        try:
            with temporary.open('xb') as f:
                done = 0
                for b in image.chunks(4*1024*1024):
                    fmt.checkpoint(); f.write(b); h.update(b); done += len(b)
                    notify('Writing DLC '+kind.upper(), 45+29*done/image.size)
                f.flush(); os.fsync(f.fileno())
        finally:
            fmt.capture_sources(None)
        if verify_output:
            notify('Verifying DLC container integrity', 75)
            verify(temporary, snapshot, sources, notify, captured)
        for p, old in sources.items():
            st = p.stat()
            if (st.st_size, st.st_mtime_ns) != old:
                raise ValueError('A DLC source file changed during packaging. Retry with the dump idle.')
        fmt.checkpoint()
        # Commit without replacement or a second payload copy. Windows rename
        # supports NTFS/exFAT; POSIX uses an exclusive same-filesystem hard link.
        if os.name == 'nt':
            temporary.rename(output)  # Windows MoveFile refuses replacement, including on exFAT.
        else:
            os.link(temporary, output)
        report = {'output': str(output), 'output_format': kind.upper(), 'title_id': f'{snapshot.title_id:016X}',
                  'base_title_id': f'{snapshot.base_id:016X}', 'dlc_index': snapshot.title_id & 0x7ff,
                  'dlc_version': snapshot.version, 'size': image.size, 'sha256': h.hexdigest(),
                  'source_file_count': len(sources), 'verified': verify_output, 'base_validated': info is not None,
                  'metadata': 'Generated minimal AddOnContent CNMT; original requirements unavailable.',
                  'seconds': time.perf_counter()-started}
        notify('DLC package ready', 100)
        return report
    finally:
        if temporary.exists():
            temporary.unlink()
