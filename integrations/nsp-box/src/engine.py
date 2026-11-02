"""General-purpose portable app engine for complete extracted title snapshots."""
from dataclasses import dataclass
from pathlib import Path
from PIL import Image, ImageOps
import hashlib, io, json, mmap, os, re, shutil, stat, struct, tempfile, time, uuid
import container_format as fmt
import verify_format as verifier
from artwork import artwork_bytes, ArtworkSelection
from compatibility import placeholder_text

VERSION = '3.0.0'

@dataclass
class Snapshot:
    root: Path
    title_id: int
    version: int
    label: str
    title: str
    nacp: Path | None = None

def read_title_id(path):
    data = path.read_bytes()
    if len(data)<0x80 or data[:4] != b'META':
        raise ValueError('main.npdm is not a supported NPDM file.')
    offset, size = struct.unpack_from('<II', data, 0x70)
    if offset<0x80 or offset+size>len(data) or size<0x20 or data[offset:offset+4]!=b'ACI0':
        raise ValueError('The NPDM application metadata is incomplete or invalid.')
    tid=struct.unpack_from('<Q',data,offset+0x10)[0]
    if not tid: raise ValueError('The NPDM has no application title ID.')
    return tid

def clean_title(name):
    return re.sub(r'\s*\[[^\]]*\]', '', name).strip() or 'Extracted game'

def find_snapshots(folder):
    fmt.configure()
    folder=Path(folder).resolve()
    if not folder.is_dir():raise ValueError('Choose an existing game folder.')
    if folder.name.lower() in ('exefs','romfs'): folder=folder.parent
    found=[];invalid=[];skipped=[]
    def scan(path,depth):
        if depth>4: return
        fmt.checkpoint()
        if (path/'exefs'/'main').is_file() and (path/'exefs'/'main.npdm').is_file() and (path/'romfs').is_dir():
            try:
                tid=read_title_id(path/'exefs'/'main.npdm')
                if tid & 0x800: raise ValueError('NPDM identifies a patch, not a main application.')
                rel=path.relative_to(folder)
                nums=[int(p) for p in rel.parts if p.isdecimal()]
                ver=nums[-1] if nums else 0
                if not 0<=ver<=0xffffffff: raise ValueError('Version number is out of range.')
                label=str(rel) if rel.parts else 'Selected folder'
                title=clean_title(folder.name)
                nacp=None
                for parent in dict.fromkeys([path,path/'control',folder,folder/'control']):
                    p=parent/'control.nacp'
                    if p.is_file() and p.stat().st_size==0x4000:
                        nacp=p
                        data=p.read_bytes()
                        if data[0x3215]==0:
                            text=data[:0x200].split(b'\0')[0].decode('utf-8',errors='replace').strip()
                            if text:title=text
                        break
                found.append(Snapshot(path,tid,ver,label,title,nacp))
            except (OSError,ValueError) as e: invalid.append(f'{path}: {e}')
        if depth==4:return
        for p in sorted(path.iterdir()):
            if p.name.lower() in ('romfs','exefs','control'):continue
            if p.name.lower() in ('dlc','aoc','addons','add_on_content'):
                if p.is_dir():skipped.append(p)
                continue
            if p.is_dir() and not p.is_symlink() and not getattr(p.lstat(),'st_file_attributes',0)&stat.FILE_ATTRIBUTE_REPARSE_POINT:
                scan(p,depth+1)
    scan(folder,0)
    found.sort(key=lambda s:(s.version,s.label.lower()),reverse=True)
    if not found:
        details=('\n'+invalid[0]) if invalid else ''
        raise ValueError('No complete exefs + romfs snapshot found. Select the folder containing both, or its main game folder.'+details)
    return found,skipped

def utf8_field(text,size):
    return text.encode('utf-8')[:size-1].decode('utf-8','ignore').encode('utf-8').ljust(size,b'\0')

def control_data(snapshot,title,version,artwork):
    existing=snapshot.nacp.read_bytes() if snapshot.nacp else None
    nacp=bytearray(existing or bytes(0x4000))
    if existing is None or nacp[0x3215]==0:
        for i in range(16):nacp[i*0x300:i*0x300+0x200]=utf8_field(title,0x200)
    if existing is None:
        nacp[0x3025]=1
        struct.pack_into('<I',nacp,0x302c,0xffff)
        struct.pack_into('<Q',nacp,0x3038,snapshot.title_id)
        struct.pack_into('<QQ',nacp,0x3070,snapshot.title_id+0x1000,snapshot.title_id)
        if snapshot.title_id>>56==4:
            nacp[0x3214]=3  # Switch 2 application-error prefix.
            nacp[0x3217]=1  # ApparentPlatform::Ounce.
    nacp[0x3060:0x3070]=utf8_field(version,0x10)
    entries=[('control.nacp',bytes(nacp))]
    if artwork:
        entries += [(f'icon_{lang}.dat',artwork) for lang in ('AmericanEnglish','BritishEnglish','Japanese','French','German',
            'LatinAmericanSpanish','Spanish','Italian','Dutch','CanadianFrench','Portuguese','Russian','Korean',
            'TraditionalChinese','SimplifiedChinese','BrazilianPortuguese','Polish','Thai')]
    return entries,existing is not None

def source_inventory(root,notify=None):
    inventory={}
    def scan(folder):
        with os.scandir(folder) as entries:
            for entry in entries:
                fmt.checkpoint();path=Path(entry.path);st=entry.stat(follow_symlinks=False)
                if entry.is_symlink() or getattr(st,'st_file_attributes',0)&stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    raise ValueError(f'Linked files/folders are not supported: {path}')
                if entry.is_dir(follow_symlinks=False):scan(path)
                elif entry.is_file(follow_symlinks=False):
                    inventory[path]=(st.st_size,st.st_mtime_ns)
                    if notify and len(inventory)%256==0:notify(f'Checking source files · {len(inventory):,} found',1)
    for sub in ('exefs','romfs'):scan(root/sub)
    if not any(p.parent==root/'romfs' or root/'romfs' in p.parents for p in inventory):
        raise ValueError('The RomFS folder is empty.')
    return inventory

def verify_image(path,snapshot,inventory,notify,cancel,source_hashes=None):
    verifier.checkpoint=lambda:fmt.checkpoint()
    with path.open('rb') as f:
        with mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as mm:
            return _verify_region(verifier.Region(mm),snapshot,inventory,notify,source_hashes)

def _verify_region(buf,snapshot,inventory,notify,source_hashes=None):
    assert bytes(buf[:4])==b'PFS0','NSP/PFS0 header'
    ncas=verifier.partition(buf);distribution=0
    parsed={};nca_hashes={}
    for name,data in ncas.items():
        fmt.checkpoint()
        assert data[0x204]==distribution,'NCA distribution type'
        nca_hashes[name]=verifier.digest(data)
        assert nca_hashes[name][:16].hex()==name[:32],'NCA content hash'
        parsed[name]=verifier.nca_sections(data)
    program=next(v for v in parsed.values() if v[1]==0)
    assert program[0]==snapshot.title_id,'Program ID mismatch'
    exefs=verifier.partition(next(b for kind,b in program[2] if kind=='pfs'))
    romfs=verifier.romfs_files(next(b for kind,b in program[2] if kind=='romfs'))
    checked=[];total=sum(v[0] for v in inventory.values());done=0
    for folder,packed in [('exefs',exefs),('romfs',romfs)]:
        originals={p.relative_to(snapshot.root/folder).as_posix():p for p in inventory if snapshot.root/folder in p.parents}
        assert set(originals)==set(packed),'Packed file list differs from source'
        for name,p in originals.items():
            fmt.checkpoint()
            if source_hashes is None:
                h=hashlib.sha256()
                with p.open('rb') as source:
                    while b:=source.read(4*1024*1024):
                        fmt.checkpoint();h.update(b)
                expected=h.digest()
            else:
                expected=source_hashes.get(p)
                assert expected is not None,f'Source hash was not captured: {folder}/{name}'
            assert expected==verifier.digest(packed[name]),f'Packed file differs: {folder}/{name}'
            done+=inventory[p][0];notify('Comparing source files',82+17*done/max(total,1))
            checked.append({'path':folder+'/'+name,'size':inventory[p][0],'sha256':expected.hex()})
    meta=next(v for v in parsed.values() if v[1]==1)
    cnmt=next(iter(verifier.partition(meta[2][0][1]).values()))
    tid,ver,ctype,_,extra,count=verifier.u('QIBBHH',cnmt)
    assert tid==snapshot.title_id and ver==snapshot.version and ctype==0x80,'CNMT title or version'
    assert verifier.digest(cnmt[:-32])==bytes(cnmt[-32:]),'CNMT digest'
    for i in range(count):
        at=0x20+extra+i*0x38;digest=bytes(cnmt[at:at+32]);nid=bytes(cnmt[at+32:at+48]).hex()
        size=int.from_bytes(cnmt[at+48:at+54],'little');data=ncas[nid+'.nca']
        assert len(data)==size and nca_hashes[nid+'.nca']==digest,'CNMT content record'
    control=next(v for v in parsed.values() if v[1]==2)
    cfiles=verifier.romfs_files(control[2][0][1]);assert 'control.nacp' in cfiles
    return checked

def build(snapshot,output,title,display_version,artwork_path=None,verify=True,notify=lambda *a:None,cancel=None,output_format=None,package_folder=False):
    started=time.perf_counter();timings={};tick=started
    output=Path(output).resolve();root=snapshot.root.resolve()
    if package_folder:output=(output.parent/output.stem/output.name).resolve()
    if not title.strip():raise ValueError('Enter a game title.')
    if len(display_version.encode('utf-8'))>15:raise ValueError('Display version must fit within 15 UTF-8 bytes.')
    kind=(output_format or output.suffix.lstrip('.')).lower()
    if kind!='nsp':raise ValueError('NSP Box supports NSP output only.')
    if output.suffix.lower()!='.'+kind:raise ValueError(f'Output filename must end in .{kind} for {kind.upper()} output.')
    distribution=0
    if any(output.is_relative_to(root/p) for p in ('exefs','romfs')):
        raise ValueError('Save the NSP outside the source exefs and romfs folders.')
    if output.exists():raise FileExistsError('An output with that name already exists. Choose another filename.')
    if read_title_id(root/'exefs/main.npdm')!=snapshot.title_id:raise ValueError('Source title ID changed. Scan the folder again.')
    companion=output.parent/'main.npdm' if package_folder and snapshot.title_id>>56==4 else None
    companion_data=(root/'exefs/main.npdm').read_bytes() if companion else None
    if companion and companion.exists() and companion.read_bytes()!=companion_data:
        raise ValueError('A different main.npdm already exists in the output folder. Choose a separate folder for this game/snapshot; existing metadata will not be overwritten.')
    phase=[0,0,'Preparing']
    def on_progress(done,total):
        notify(phase[2],phase[0]+(phase[1]-phase[0])*done/max(total,1))
    fmt.configure(cancel,on_progress)
    notify('Checking source files',1)
    inventory=source_inventory(root,notify)
    timings['source_scan']=time.perf_counter()-tick;tick=time.perf_counter()
    output.parent.mkdir(parents=True,exist_ok=True)
    estimate=int(sum(v[0] for v in inventory.values())*1.02)+32*1024*1024
    if shutil.disk_usage(output.parent).free<estimate:raise ValueError('Not enough free disk space for this NSP.')
    art=artwork_bytes(artwork_path)
    notify('Building RomFS file tables',2)
    source_manifest=[];rblob=fmt.romfs(root/'romfs',source_manifest,
        lambda count:notify(f'Building RomFS file tables · {count:,} files',2))
    exblob=fmt.filesystem([(p.name,p) for p in sorted((root/'exefs').iterdir()) if p.is_file()])
    if any(p.is_dir() for p in (root/'exefs').iterdir()):raise ValueError('ExeFS must contain files directly, not nested directories.')
    phase[:]=[2,22,'Building RomFS integrity tree'];notify(phase[2],2)
    program=fmt.nca([fmt.pfs_section(exblob),fmt.romfs_section(rblob)],snapshot.title_id,0,distribution)
    timings['filesystems_and_integrity_tree']=time.perf_counter()-tick;tick=time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='nsp-box-control-') as tmp:
        entries,preserved=control_data(snapshot,title,display_version,art)
        for name,data in entries:(Path(tmp)/name).write_bytes(data)
        phase[:]=[22,23,'Preparing artwork and metadata'];notify(phase[2],22)
        control=fmt.nca([fmt.romfs_section(fmt.romfs(Path(tmp),[]))],snapshot.title_id,2,distribution)
        records=[];entries=[]
        phase[:]=[23,44,'Hashing game content'];notify(phase[2],23)
        for blob,ctype in [(program,1),(control,3)]:
            digest=blob.digest();name=digest[:16].hex()+'.nca';entries.append((name,blob))
            records.append(digest+digest[:16]+blob.size.to_bytes(6,'little')+bytes([ctype,0]))
        cnmt=bytearray(0x20);struct.pack_into('<QIBBHHH',cnmt,0,snapshot.title_id,snapshot.version,0x80,0,16,len(records),0)
        cnmt+=fmt.pack('QII',snapshot.title_id+0x800,0,0)+b''.join(records);cnmt+=fmt.sha(cnmt)
        meta=fmt.nca([fmt.pfs_section(fmt.filesystem([(f'Application_{snapshot.title_id:016x}.cnmt',bytes(cnmt))]))],snapshot.title_id,1,distribution)
        entries.append((meta.digest()[:16].hex()+'.cnmt.nca',meta))
        timings['metadata_and_content_hashing']=time.perf_counter()-tick;tick=time.perf_counter()
        result=fmt.package(entries,kind)
        temp_path=output.parent/(output.name+'.'+uuid.uuid4().hex[:10]+'.partial')
        committed=False;companion_created=False
        try:
            h=hashlib.sha256();done=0;notify('Writing '+kind.upper(),45)
            captured={p:None for p in inventory} if verify else None
            fmt.capture_sources(captured)
            try:
                with temp_path.open('xb') as f:
                    for b in result.chunks(4*1024*1024):
                        f.write(b);h.update(b);done+=len(b);notify('Writing '+kind.upper(),45+29*done/result.size)
                    f.flush();os.fsync(f.fileno())
            finally:fmt.capture_sources(None)
            timings['writing']=time.perf_counter()-tick;tick=time.perf_counter()
            checked=None
            if verify:
                notify('Verifying container integrity',75)
                checked=verify_image(temp_path,snapshot,inventory,notify,cancel,captured)
            timings['verification']=time.perf_counter()-tick
            for p,expected in inventory.items():
                st=p.stat()
                if (st.st_size,st.st_mtime_ns)!=expected:raise ValueError('A source file changed during packaging. Try again with the dump idle.')
            fmt.checkpoint()
            if companion:
                companion_temp=output.parent/('.main.npdm.'+uuid.uuid4().hex[:10]+'.partial')
                try:
                    with companion_temp.open('xb') as f:
                        f.write(companion_data);f.flush();os.fsync(f.fileno())
                    try:
                        os.link(companion_temp, companion);companion_created=True
                    except FileExistsError:
                        if companion.read_bytes()!=companion_data:
                            raise ValueError('Output main.npdm changed during packaging. Choose a separate output folder.')
                finally:
                    if companion_temp.exists():companion_temp.unlink()
            os.link(temp_path, output);committed=True
            temp_path.unlink()
            report={'app':'NSP Box','version':VERSION,'title':title,'title_id':f'{snapshot.title_id:016X}',
                    'snapshot':str(root),'snapshot_version':snapshot.version,'display_version':display_version,
                    'size':result.size,'sha256':h.hexdigest(),'original_control_preserved':preserved,
                    'source_file_count':len(inventory),'verified':verify,'files':checked,
                    'timings_seconds':{**timings,'total':time.perf_counter()-started},
                    'verification_method':'Source SHA-256 captured during writing; full independent output readback.' if verify else 'Skipped',
                    'output_format':kind.upper(),'output':str(output),'package_folder':bool(package_folder),
                    'switch2_companion':{'file':'main.npdm','sha256':hashlib.sha256(companion_data).hexdigest(),
                        'purpose':'Keep beside the package for Eglantine/PokeDinner Switch 2 memory/clock detection.'} if companion else None,
                    'format':f'Unsigned plaintext emulator {kind.upper()}; one complete snapshot; no automatic DLC merge.'}
            if package_folder:
                report_path=output.with_suffix('.'+kind+'.report.json')
                if report_path.exists():report_path=output.with_name(output.name+'.'+uuid.uuid4().hex[:8]+'.report.json')
                with report_path.open('x',encoding='utf-8') as f:f.write(json.dumps(report,indent=2))
            notify('Complete',100);return report
        finally:
            if not committed and temp_path.exists():temp_path.unlink()
            if not committed and companion_created and companion.exists() and companion.read_bytes()==companion_data:
                companion.unlink()

def placeholder_keys():
    return placeholder_text()
