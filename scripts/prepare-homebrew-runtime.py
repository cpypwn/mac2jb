#!/usr/bin/env python3
"""Prepare pinned, portable Apple Silicon dependencies for the local HBL test app."""
import argparse, hashlib, json, os, re, shutil, subprocess, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / 'packaging/homebrew-runtime.lock.json'
ADAPTER = ROOT / 'packaging/homebrew/sitecustomize.py'
EXE = {'bin/spirv-val', 'bin/glslangValidator', 'python/bin/python3', 'python/bin/python3.13'}
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def run(args, **kwargs): return subprocess.run(list(map(str,args)), check=True, **kwargs)
def manifest_ok(output):
    try:
        manifest=json.loads((output/'manifest.json').read_text())
        if manifest['lockSha256'] != digest(LOCK) or manifest['fontAdapterSha256'] != digest(ADAPTER): return False
        expected={f['path']:f for f in manifest['files']}
        actual={p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file() and p.name!='manifest.json'}
        if actual != expected.keys(): return False
        return all(not (output/name).is_symlink() and digest(output/name)==item['sha256'] for name,item in expected.items())
    except (OSError, ValueError, KeyError): return False

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'.build-gui/homebrew')
    parser.add_argument('--downloads',type=Path,default=ROOT/'.build-gui/homebrew-downloads')
    parser.add_argument('--spirv-val',type=Path,help='Use an already built matching pinned validator (maintainer only)')
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args(); output=args.output.resolve()
    if manifest_ok(output): print('Verified portable homebrew runtime:',output); return
    if args.check: raise SystemExit('Missing or changed homebrew runtime; run scripts/prepare-homebrew-runtime.py first.')
    if os.uname().sysname!='Darwin' or os.uname().machine!='arm64': raise SystemExit('Build on Apple Silicon macOS.')
    lock=json.loads(LOCK.read_text()); args.downloads.mkdir(parents=True,exist_ok=True)
    archives={}
    for name,item in lock.items():
        if name=='pythonLicenses': continue # Exact full-distribution notices are retained in packaging/licenses/.
        dest=args.downloads/item['filename']
        if not dest.exists() or digest(dest)!=item['sha256']:
            run(['curl','-fL','--retry','2',item['url'],'-o',dest])
        if digest(dest)!=item['sha256']: raise SystemExit('Input hash mismatch: '+name)
        archives[name]=dest.resolve()
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='homebrew-build-',dir=output.parent) as temporary:
        work=Path(temporary); stage=work/'runtime'; stage.mkdir()
        run(['tar','-xzf',archives['python'],'-C',stage])
        python=stage/'python'; site=python/'lib/python3.13/site-packages'
        # Runtime needs only the interpreter and standard library; no pip, IDLE, headers, or build metadata.
        for entry in (python/'bin').iterdir():
            if entry.name not in ('python3','python3.13'): entry.unlink()
        for entry in site.iterdir():
            if entry.name.startswith('pip'):
                shutil.rmtree(entry) if entry.is_dir() else entry.unlink()
        shutil.rmtree(python/'include',ignore_errors=True)
        shutil.rmtree(python/'lib/pkgconfig',ignore_errors=True)
        shutil.rmtree(python/'share',ignore_errors=True)
        with zipfile.ZipFile(archives['pillow']) as wheel: wheel.extractall(site)
        # Dereference the distribution's internal Python links; app archives deliberately contain no links.
        regular=work/'regular'; shutil.copytree(python,regular,symlinks=False)
        shutil.rmtree(python); regular.rename(python)
        for cache in list(python.rglob('__pycache__')): shutil.rmtree(cache,ignore_errors=True)
        for cache in python.rglob('*.pyc'): cache.unlink()
        (stage/'python-custom').mkdir(); shutil.copyfile(ADAPTER,stage/'python-custom/sitecustomize.py')
        (stage/'fonts').mkdir(); (stage/'licenses').mkdir()
        run(['tar','-xjf',archives['font'],'-C',work])
        font=work/'dejavu-fonts-ttf-2.37'
        shutil.copyfile(font/'ttf/DejaVuSans.ttf',stage/'fonts/DejaVuSans.ttf')
        shutil.copyfile(font/'LICENSE',stage/'licenses/DejaVu-LICENSE.txt')
        shutil.copytree(ROOT/'packaging/licenses/python-3.13.17',stage/'licenses/python-3.13.17')
        run(['tar','-xzf',archives['spirvTools'],'-C',work])
        tools=work/('SPIRV-Tools-'+lock['spirvTools']['commit'])
        run(['tar','-xzf',archives['spirvHeaders'],'-C',work])
        headers=work/('SPIRV-Headers-'+lock['spirvHeaders']['commit'])
        shutil.copyfile(tools/'LICENSE',stage/'licenses/SPIRV-Tools-LICENSE.txt')
        shutil.copyfile(headers/'LICENSE',stage/'licenses/SPIRV-Headers-LICENSE.txt')
        shutil.copytree(headers/'LICENSES',stage/'licenses/SPIRV-Headers')
        validator=args.spirv_val
        if validator:
            version=subprocess.check_output([str(validator),'--version'],text=True)
            if lock['spirvTools']['version'] not in version or lock['spirvTools']['commit'][:7] not in version:
                raise SystemExit('Prebuilt validator does not match the pinned SPIRV-Tools version/commit.')
        else:
            shutil.copytree(headers,tools/'external/spirv-headers')
            cmake=shutil.which('cmake')
            if not cmake: raise SystemExit('Install CMake to build the pinned spirv-val dependency.')
            build=work/'spirv-build'
            run([cmake,'-S',tools,'-B',build,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES=arm64',
                 '-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0','-DSPIRV_SKIP_TESTS=ON','-DSPIRV_TOOLS_BUILD_STATIC=ON','-DSPIRV_TOOLS_BUILD_SHARED=OFF'])
            run([cmake,'--build',build,'--target','spirv-val','-j','8'])
            validator=build/'tools/spirv-val'
        (stage/'bin').mkdir(); shutil.copyfile(validator,stage/'bin/spirv-val')
        with tempfile.TemporaryDirectory(prefix='glslang-',dir=work) as directory:
            run(['tar','-xzf',archives['glslang'],'-C',directory])
            run(['lipo',Path(directory)/'bin/glslang','-thin','arm64','-output',stage/'bin/glslangValidator'])
        if digest(stage/'bin/glslangValidator') != lock['glslang']['arm64Sha256']:
            raise SystemExit('Unexpected glslang arm64 executable')
        shutil.copyfile(archives['glslangLicense'],stage/'licenses/glslang-LICENSE.txt')
        native=[]
        for file in sorted(stage.rglob('*')):
            if file.is_symlink(): raise SystemExit('Unexpected runtime link: '+str(file))
            if not file.is_file(): continue
            relative=file.relative_to(stage).as_posix()
            with file.open('rb') as stream: magic=stream.read(4)
            if magic in (b'\xcf\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xca\xfe\xba\xbf'):
                arch=subprocess.check_output(['lipo','-archs',str(file)],text=True).strip()
                if arch != 'arm64': raise SystemExit('Expected arm64 dependency: '+relative)
                deps=subprocess.check_output(['otool','-L',str(file)],text=True).splitlines()[1:]
                identity=subprocess.run(['otool','-D',str(file)],text=True,capture_output=True).stdout.splitlines()[1:]
                own_id=identity[0].strip() if identity else None
                for dep in deps:
                    name=dep.strip().split(' ',1)[0]
                    if name != own_id and not name.startswith(('/usr/lib/','/System/Library/','@')):
                        raise SystemExit('Nonportable library reference '+relative+': '+name)
                info=subprocess.check_output(['xcrun','vtool','-show-build',str(file)],text=True)
                for version in re.findall(r'\bminos\s+(\d+(?:\.\d+)*)',info):
                    parts=tuple(map(int,version.split('.')))
                    if parts+(0,)*(3-len(parts)) > (14,0,0): raise SystemExit('Dependency requires newer macOS: '+relative+' '+version)
                run(['codesign','--force','--sign','-',file],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                native.append(relative)
            file.chmod(0o700 if relative in EXE else 0o600)
        files=[{'path':p.relative_to(stage).as_posix(),'sha256':digest(p)} for p in sorted(stage.rglob('*')) if p.is_file()]
        manifest={'lockSha256':digest(LOCK),'fontAdapterSha256':digest(ADAPTER),'inputs':lock,'nativeFiles':native,'files':files}
        (stage/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        if output.exists(): shutil.rmtree(output)
        shutil.copytree(stage,output)
    if not manifest_ok(output): raise SystemExit('Generated runtime failed verification')
    print('Prepared portable homebrew runtime:',output)

if __name__=='__main__': main()
