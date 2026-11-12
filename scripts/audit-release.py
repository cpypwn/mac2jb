#!/usr/bin/env python3
import hashlib
import json
import stat
import sys
import zipfile
from pathlib import PurePosixPath

if len(sys.argv) != 2:
    raise SystemExit('usage: python3 scripts/audit-release.py mac2jb-complete.zip')

archive = sys.argv[1]
required = {
    'mac2jb/README.md',
    'mac2jb/.github/workflows/build.yml',
    'mac2jb/LICENSE',
    'mac2jb/vendor/libusbd/LICENSE',
    'mac2jb/vendor/libusbd/LICENSE-APSL-2.0.txt',
    'mac2jb/vendor/macos_usb_gadget_poc/LICENSE-APSL-2.0.txt',
    'mac2jb/vendor/macos_usb_gadget_poc/usbgadget/LICENSE',
    'mac2jb/vendor/ns2jb/run.cjs',
    'mac2jb/vendor/ns2jb-hosts/pepsipu/run.cjs',
    'mac2jb/vendor/ns2jb-hosts/kurumuz/run.cjs',
    'mac2jb/vendor/ns2jb-hosts/cellenseres/run.cjs',
    'mac2jb/gui/HostProfile.swift',
    'mac2jb/scripts/host-profiles.cjs',
    'mac2jb/scripts/prepare-host-profiles.cjs',
    'mac2jb/packaging/host-profiles.json',
    'mac2jb/scripts/gui-attach.cjs',
    'mac2jb/scripts/gui-discover-rpc.cjs',
    'mac2jb/scripts/rpc-attachment.cjs',
    'mac2jb/scripts/homebrew-reentry.cjs',
    'mac2jb/vendor/HBLauncher/homebrew-launcher/launcher.cjs',
    'mac2jb/vendor/GPUBrewLauncher/homebrew-launcher/launcher.cjs',
    'mac2jb/vendor/GPUBrewLauncher/CREDITS',
    'mac2jb/vendor/GPUBrewLauncher/REFERENCE.md',
    'mac2jb/vendor/MintBrew/homebrew-launcher/launcher.cjs',
    'mac2jb/vendor/MintBrew/manifest.json',
    'mac2jb/vendor/MintBrew/README.md',
    'mac2jb/vendor/MintBrew/CREDITS',
    'mac2jb/vendor/MintBrew/apps/hello-world/app.json',
    'mac2jb/vendor/MintBrew/apps/froggy-road/app.json',
    'mac2jb/scripts/gui-gpubrewlauncher.cjs',
    'mac2jb/scripts/gui-hblauncher.cjs',
    'mac2jb/scripts/gui-mintbrew.cjs',
    'mac2jb/scripts/prepare-mintbrew.cjs',
    'mac2jb/integrations/mintbrew-native/host.cjs',
    'mac2jb/integrations/mintbrew-stremio/adapter.cjs',
    'mac2jb/scripts/gui-custom-homebrew.cjs',
    'mac2jb/scripts/custom-rpc-package.cjs',
    'mac2jb/packaging/GPUBrewLauncher-provenance.json',
    'mac2jb/packaging/GPUBrewLauncher-SHA256SUMS',
    'mac2jb/scripts/gui-homebrew.cjs',
    'mac2jb/scripts/gui-native-hblauncher.cjs',
    'mac2jb/scripts/gui-savekit-tools.cjs',
    'mac2jb/scripts/seedsow-full-save.cjs',
    'mac2jb/scripts/gui-dnswitch.cjs',
    'mac2jb/scripts/gui-webkit-research.cjs',
    'mac2jb/scripts/gui-bundled-browser-probes.cjs',
    'mac2jb/scripts/gui-nup.cjs',
    'mac2jb/packaging/NUP-source.json',
    'mac2jb/gui/NUPToolsView.swift',
    'mac2jb/scripts/gui-nxformat.cjs',
    'mac2jb/packaging/NXFormat-source.json',
    'mac2jb/gui/NXFormatToolsView.swift',
    'mac2jb/scripts/gui-civhomebrew.cjs',
    'mac2jb/scripts/civhomebrew-catalog-overlay.cjs',
    'mac2jb/integrations/civhomebrew-catalog/catalog.js',
    'mac2jb/integrations/civhomebrew-catalog/catalog-ui.js',
    'mac2jb/packaging/CivHomebrew-source.json',
    'mac2jb/scripts/gui-civswitch-moonlight.cjs',
    'mac2jb/packaging/Moonlight-CivSwitch-source.json',
    'mac2jb/scripts/gui-civswitch-sw2nes.cjs',
    'mac2jb/packaging/SW2NES-source.json',
    'mac2jb/integrations/sw2nes/v1.0.1/sw2nes.civapp',
    'mac2jb/integrations/sw2nes/v1.0.1/LICENSE',
    'mac2jb/integrations/sw2nes/v1.0.1/source/tools/build.sh',
    'mac2jb/integrations/sw2nes/v1.0.1/source/third_party/QuickNES_Core/LICENSE',
    'mac2jb/scripts/gui-civswitch-jellyfin.cjs',
    'mac2jb/scripts/gui-civswitch-package.cjs',
    'mac2jb/packaging/Jellyfin-CivSwitch-source.json',
    'mac2jb/integrations/jellyfin/0.0.1/jellyfin-civswitch.civapp',
    'mac2jb/integrations/jellyfin/0.0.1/THIRD_PARTY.md',
    'mac2jb/integrations/jellyfin/0.0.1/BRANDING.md',
    'mac2jb/gui/CivSwitchAppsModel.swift',
    'mac2jb/integrations/nup-support/site-packages/zstandard/backend_c.cpython-313-darwin.so',
    'mac2jb/integrations/nup-support/site-packages/zstandard-0.25.0.dist-info/licenses/LICENSE',
    'mac2jb/integrations/nsp-box/cli.py',
    'mac2jb/integrations/nsp-box/LICENSE.txt',
    'mac2jb/gui/NSPBoxToolsView.swift',
    'mac2jb/gui/ArtemisHTTPView.swift',
    'mac2jb/integrations/artemis/cpypwn-showcase.lua',
    'mac2jb/integrations/artemis/cpypwn-kaleidoscope.lua',
    'mac2jb/integrations/artemis/seedsowhax-v2-mac2jb.zip',
    'mac2jb/integrations/seedsow-editor-pro/Seedsow_Pro_v2_JKSV.zip',
    'mac2jb/integrations/artemis/norahax-v2-mac2jb.zip',
    'mac2jb/integrations/artemis/norahax-nora1-mac2jb.zip',
    'mac2jb/integrations/artemis/hamihax-v2-mac2jb.zip',
    'mac2jb/packaging/ArtemisLauncher-v2.json',
    'mac2jb/packaging/ArtemisLauncher-seedsow-full.json',
    'mac2jb/packaging/ArtemisLauncher-upstream-saves.json',
    'mac2jb/packaging/SeedsowEditorPro-v0.4.0.json',
    'mac2jb/packaging/ArtemisLauncher-nora1.json',
    'mac2jb/packaging/ArtemisLauncher-bundles.json',
    'mac2jb/integrations/gravcirc-rce/GC-v1.1.zip',
    'mac2jb/integrations/gravcirc-rce/LICENSE',
    'mac2jb/packaging/GravCirc-v1.1.json',
    'mac2jb/packaging/GravCirc-v1.1-SHA256SUMS',
    'mac2jb/scripts/check-webkit-research.cjs',
    'mac2jb/packaging/switch2-browser-research-provenance.json',
    'mac2jb/vendor/switch2-captive-portal-research/LICENSE-NOTICE.md',
    'mac2jb/vendor/switch2-captive-portal-research/serve-switch2-browser-probe.py',
    'mac2jb/vendor/switch2-captive-portal-research/switch2-browser-probe.html',
    'mac2jb/integrations/browser-probes/manifest.json',
    'mac2jb/integrations/browser-probes/index.html',
    'mac2jb/integrations/browser-probes/probes.js',
    'mac2jb/integrations/browser-probes/style.css',
    'mac2jb/scripts/dnswitch-launch.applescript',
    'mac2jb/gui/DNSwitchModel.swift',
    'mac2jb/gui/WebKitResearchModel.swift',
    'mac2jb/gui/SaveKitToolsView.swift',
    'mac2jb/scripts/gui-stremio.cjs',
    'mac2jb/stremio/source-preferences.cjs',
    'mac2jb/scripts/gui-ouncecake.cjs',
    'mac2jb/keyboard.c',
    'mac2jb/civswitch-hid.c',
    'mac2jb/gui/CivSwitchModel.swift',
    'mac2jb/vendor/CivSwitch/LICENSE',
    'mac2jb/vendor/CivSwitch/core.js',
    'mac2jb/vendor/CivSwitch/PicoSwitch/compress.js',
    'mac2jb/integrations/civswitch/payload.txt',
    'mac2jb/integrations/civswitch/provenance.json',
    'mac2jb/integrations/civswitch/verify.cjs',
    'mac2jb/integrations/civswitch/probe.cjs',
    'mac2jb/integrations/civswitch/send-hello.cjs',
    'mac2jb/integrations/civswitch/send-hello.test.cjs',
    'mac2jb/integrations/civswitch/hello.js',
    'mac2jb/gui/PostBootstrapCommand.swift',
    'mac2jb/scripts/gui-keyboard.cjs',
    'mac2jb/scripts/usb-controllers.cjs',
    'mac2jb/vendor/OunceCake/LICENSE',
    'mac2jb/vendor/OunceCake/README.md',
    'mac2jb/vendor/OunceCake/engine/oz-code/native.c',
    'mac2jb/vendor/OunceCake/engine/oz-code/native.h',
    'mac2jb/vendor/OunceCake/engine/oz-code/layout.ld',
    'mac2jb/vendor/OunceCake/engine/oz-code/native.bin',
    'mac2jb/vendor/OunceCake/engine/build-native.cjs',
    'mac2jb/vendor/OunceCake/engine/zip-download.cjs',
    'mac2jb/packaging/OunceCake-provenance.json',
    'mac2jb/packaging/OunceCake-SHA256SUMS',
    'mac2jb/packaging/OunceCake-upstream-SHA256SUMS',
    'mac2jb/stremio/pipeline.cjs',
    'mac2jb/stremio/receiver.cjs',
    'mac2jb/stremio/receiver-program.cjs',
    'mac2jb/stremio/test-receiver.cjs',
    'mac2jb/stremio/test-receiver-program.cjs',
    'mac2jb/stremio/test-receiver-lifecycle.cjs',
    'mac2jb/stremio/benchmark-transport.cjs',
    'mac2jb/stremio/app/app.frag.spv',
    'mac2jb/assets/stremio/bbb-sample.mp4',
    'mac2jb/assets/stremio/ATTRIBUTION.md',
    'mac2jb/packaging/stremio-sample-provenance.json',
    'mac2jb/packaging/homebrew-runtime.lock.json',
    'mac2jb/packaging/HBLauncher-v0.2.0-SHA256SUMS',
    'mac2jb/packaging/ftpd-sb-v0.1.0-SHA256SUMS',
    'mac2jb/packaging/ftpd-sb-v0.1.0-release-SHA256SUMS',
    'mac2jb/packaging/ftpd-sb-v0.1.0-provenance.json',
    'mac2jb/scripts/prepare-homebrew-apps.cjs',
    'mac2jb/assets/homebrew-apps/ftpd-sb/README.md',
    'mac2jb/assets/homebrew-apps/ftpd-sb/app.json',
    'mac2jb/drivers/LICENSE',
    'mac2jb/drivers/LICENSE-APSL-2.0.txt',
    'mac2jb/drivers/SHA256SUMS',
    'mac2jb/scripts/install-driver.sh',
    'mac2jb/scripts/package-gui-payload.py',
    'mac2jb/assets/bootstrap.bas',
    'mac2jb/mac2jb.command',
    'mac2jb/setup.sh',
    'mac2jb/vendor/macos_usb_gadget_poc/usbgadget/usbgadget.xcodeproj/project.pbxproj',
}
block_names = ('mac2jb-send', 'mac2jb-commands', 'mac2jb-keyboard', '.DS_Store',
               'DemoBootstrapSetup.swift', 'demo-save.bas')
block_suffixes = ('.o', '.dylib', '.log', '.xcuserstate', '.pyc', '.bak', '.kate-swp')
violations = []
with zipfile.ZipFile(archive) as z:
    names = set(z.namelist())
    removed_components = (
        'gui/CivSwitchControlCenterModel.swift',
        'vendor/CivSwitch-ControlCenter',
        'integrations/civswitch-control-center',
        'vendor/IZ2S-Platform', 'vendor/IZDOOM', 'vendor/BlitBun',
        'vendor/ns2jb-hosts/izmysh-legacy', 'integrations/izlauncher-shell',
        'integrations/blitbun', 'integrations/vacootube', 'integrations/izdoom',
        'integrations/mintbrew-iz-exchange', 'integrations/super-file-bros',
        'integrations/civswitch/izlauncher-save',
        'vendor/MintBrew/apps/izdoom', 'vendor/MintBrew/apps/iz-exchange',
        'scripts/gui-izlauncher.cjs', 'scripts/gui-civswitch-izlauncher.cjs',
        'scripts/gui-civswitch-izlauncher-save.cjs', 'scripts/prepare-izlauncher.cjs',
        'scripts/check-izlauncher-runtime.cjs', 'scripts/izlauncher-modules.cjs',
        'scripts/izlauncher-panel.cjs', 'scripts/stage-custom-izmodule.cjs',
        'packaging/IZ2S-Platform-provenance.json',
        'packaging/IZ2S-Platform-SHA256SUMS',
        'packaging/IZMYSH-legacy-provenance.json',
        'packaging/IZMYSH-legacy-SHA256SUMS',
        'packaging/IZCIVSwitch-izlauncher-save.json',
    )
    for name in names:
        relative = name.removeprefix('mac2jb/').rstrip('/')
        if any(relative == component or relative.startswith(component + '/')
               for component in removed_components):
            violations.append('removed component remains in source: ' + name)
    try:
        test_build = json.loads(z.read('mac2jb/packaging/test-build.json')).get('testBuild') is True
    except (KeyError, ValueError, TypeError):
        test_build = False
    personal_required = {
        'mac2jb/integrations/civswitch/hello.js',
        'mac2jb/integrations/civswitch/send-hello.cjs',
        'mac2jb/integrations/civswitch/send-hello.test.cjs',
        'mac2jb/integrations/artemis/cpypwn-showcase.lua',
        'mac2jb/integrations/artemis/cpypwn-kaleidoscope.lua',
        'mac2jb/integrations/artemis/seedsowhax-v2-mac2jb.zip',
        'mac2jb/integrations/artemis/norahax-v2-mac2jb.zip',
        'mac2jb/integrations/artemis/norahax-nora1-mac2jb.zip',
        'mac2jb/integrations/artemis/hamihax-v2-mac2jb.zip',
    }
    if not test_build:
        required.difference_update(personal_required)
        required.update({
            'mac2jb/integrations/artemis/upstream-v2/seedsow_save.zip',
            'mac2jb/integrations/artemis/upstream-v2/nora2_save.zip',
            'mac2jb/integrations/artemis/upstream-v2/hamidashi_save.zip',
            'mac2jb/integrations/artemis/upstream-nora1-save.zip',
        })
        for name in names:
            if ('cpypwn' in name.lower() or 'showcase' in name.lower()) and name.startswith('mac2jb/integrations/'):
                violations.append('personal showcase in public source: ' + name)
            if name in personal_required:
                violations.append('personal demo in public source: ' + name)
            if name == 'mac2jb/scripts/build-seedsow-full-showcase.cjs':
                violations.append('personal showcase builder in public source')
    def audit_inventory(label, manifest, prefix, manifest_sha256, count, exact=True):
        try:
            data = z.read(manifest)
            if hashlib.sha256(data).hexdigest() != manifest_sha256:
                raise ValueError('changed inventory manifest')
            expected = {}
            for line in data.decode().splitlines():
                digest, relative = line.split('  ', 1)
                parts = relative.split('/')
                if (len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest)
                        or not relative or relative.startswith('/') or '\\' in relative
                        or any(part in ('', '.', '..') for part in parts)
                        or any(ord(character) < 32 for character in relative)
                        or relative in expected):
                    raise ValueError('invalid inventory entry')
                expected[relative] = digest
            if len(expected) != count:
                raise ValueError('unexpected inventory length')
            actual = {name[len(prefix):] for name in names if name.startswith(prefix) and not name.endswith('/')}
            if exact and actual != set(expected):
                violations.append('incomplete or unexpected ' + label + ' source distribution')
            for relative, digest in expected.items():
                name = prefix + relative
                if name not in names or hashlib.sha256(z.read(name)).hexdigest() != digest:
                    violations.append('missing or changed ' + label + ' source: ' + name)
                elif stat.S_IFMT(z.getinfo(name).external_attr >> 16) not in (0, stat.S_IFREG):
                    violations.append('non-regular ' + label + ' source: ' + name)
            return expected
        except (KeyError, ValueError, UnicodeError):
            violations.append('missing or malformed ' + label + ' inventory')
            return {}

    for missing in sorted(required - names):
        violations.append('missing required file: ' + missing)
    for path in sorted(names):
        p = PurePosixPath(path)
        if path.startswith('/') or '..' in p.parts or '\\' in path:
            violations.append('unsafe archive path: ' + path)
        if ('.git' in p.parts or '__MACOSX' in p.parts or
                any(name in p.parts for name in ('runs', 'dumps')) and any(vendor in path for vendor in ('vendor/ns2jb/', 'vendor/ns2jb-hosts/', 'vendor/HBLauncher/', 'vendor/GPUBrewLauncher/'))):
            violations.append('Git metadata or ns2jb runtime data: ' + path)
        if p.parts[:2] == ('mac2jb', 'vendor') and len(p.parts)>3 and p.parts[2] in ('HBLauncher', 'GPUBrewLauncher') and p.parts[3] in ('tools', 'dist'):
            violations.append('generated Homebrew artifact: ' + path)
        approved_driver = path.startswith('mac2jb/drivers/usbgadget.kext/')
        if ('usbgadget.kext' in p.parts and not approved_driver or 'usb_device' in p.parts or
            'xcuserdata' in p.parts or 'project.xcworkspace' in p.parts or p.name.startswith('._') or
            p.name in block_names or p.suffix in block_suffixes or any(part.endswith('.dSYM') for part in p.parts)):
            violations.append('excluded binary/local/unused file: ' + path)
    try:
        provenance = json.loads(z.read('mac2jb/packaging/switch2-browser-research-provenance.json'))
        files = provenance['files']
        if (provenance['revision'] != '07cd867af2f1dc8f7b6ce59d964c3827cc3997b3'
                or not isinstance(files, dict) or len(files) != 28):
            raise ValueError('changed browser research provenance')
        research_prefix = 'mac2jb/vendor/switch2-captive-portal-research/'
        actual = {name[len(research_prefix):] for name in names
                  if name.startswith(research_prefix) and not name.endswith('/')}
        if actual != set(files):
            violations.append('incomplete or unexpected browser research distribution')
        for relative, digest in files.items():
            parts = relative.split('/')
            if (not parts or any(part in ('', '.', '..') for part in parts)
                    or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest)):
                raise ValueError('invalid browser research provenance entry')
            name = research_prefix + relative
            if name not in names or hashlib.sha256(z.read(name)).hexdigest() != digest:
                violations.append('missing or changed browser research file: ' + name)
    except (KeyError, ValueError, TypeError, UnicodeError):
        violations.append('missing or malformed browser research provenance')
    driver_files = {
        'Contents/Info.plist': 'c38786b3eb1b51055505bca54c88df77b797e1785c146ec1d54ee3273a934faf',
        'Contents/MacOS/usbgadget': 'a32119c7908098c49c2540a17aad4d172378de969885ad4f4a752bdb8ef91308',
    }
    prefix = 'mac2jb/drivers/usbgadget.kext/'
    for suffix, expected in driver_files.items():
        name = prefix + suffix
        if name not in names or hashlib.sha256(z.read(name)).hexdigest() != expected:
            violations.append('missing or changed approved unsigned driver: ' + name)
    for name in names:
        if name.startswith(prefix) and not name.endswith('/') and name[len(prefix):] not in driver_files:
            violations.append('unexpected driver file or signing metadata: ' + name)
    host_profiles = 'mac2jb/packaging/host-profiles.json'
    if host_profiles in names:
        try:
            registry = json.loads(z.read(host_profiles))
            pins = {
                'pepsipu': '95f5525089273c5fce0b95047f3600f8442e96ae',
                'kurumuz': '81d5bb114c856109dadaf1077d927a9f297fe58d',
                'cellenseres': '2f686045ff88e5a97f959d19752e00ef3b62011f',
                'BermTheSequel': '9accf75508f4e7033ffc6912b2ebb7e0b6704e84',
                'astral': '81d5bb114c856109dadaf1077d927a9f297fe58d',
            }
            profiles = registry['profiles']
            if (registry.get('format') != 'mac2jb-host-profiles-v1' or registry.get('default') != 'kurumuz'
                    or len(profiles) != 5 or {row['id'] for row in profiles} != set(pins)):
                raise ValueError('invalid host profile registry')
            for row in profiles:
                host = row['id']
                folder = 'vendor/ns2jb' if host == 'BermTheSequel' else 'vendor/ns2jb-hosts/' + host
                label = 'Cellenseres' if host == 'cellenseres' else 'Astral (custom)' if host == 'astral' else host
                held = host != 'pepsipu'
                demo = host in ('kurumuz', 'cellenseres', 'BermTheSequel', 'astral')
                savekit = host in ('kurumuz', 'cellenseres', 'astral')
                modloader = host in ('kurumuz', 'cellenseres')
                arity = 9 if host == 'pepsipu' else 5
                port = 39380
                save_name = 'NS2'
                if (row['label'] != label or row['revision'] != pins[host] or row['sourceDirectory'] != folder
                        or row['startArgumentCount'] != arity or row.get('startPort', 39380) != port
                        or row.get('saveName', 'NS2') != save_name or row['supportsHeldRPC'] != held
                        or row['supportsDemo'] != demo or bool(row.get('supportsSaveKit')) != savekit
                        or bool(row.get('supportsNativeHBLauncher')) != savekit
                        or bool(row.get('supportsModloader')) != modloader or not row.get('licenseStatus')):
                    raise ValueError('changed host provenance or capabilities')
                prefix = 'mac2jb/' + folder + '/'
                expected = {}
                for line in z.read(prefix + 'SHA256SUMS').decode().splitlines():
                    digest, relative = line.split('  ', 1)
                    if (len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest)
                            or relative.startswith('/') or '..' in PurePosixPath(relative).parts
                            or '\\' in relative or relative in expected):
                        raise ValueError('invalid host checksum manifest')
                    expected[relative] = digest
                actual = {name[len(prefix):] for name in names if name.startswith(prefix) and not name.endswith('/')}
                if actual != set(expected) | {'SHA256SUMS'}:
                    violations.append('incomplete or unexpected host distribution: ' + host)
                for relative, digest in expected.items():
                    name = prefix + relative
                    if name not in names or hashlib.sha256(z.read(name)).hexdigest() != digest:
                        violations.append('missing or changed host source: ' + name)
                source_names = ['run.cjs', 'bootstrap.bas'] + (['rpc.cjs', 'dump-firmware.cjs'] if row['supportsHeldRPC'] else [])
                source_names += [name for name in expected if name.startswith('engine/')]
                entries = [[name, hashlib.sha256(z.read(prefix + name)).hexdigest()] for name in sorted(source_names)]
                source_digest = hashlib.sha256(json.dumps(entries, separators=(',', ':')).encode()).hexdigest()
                bootstrap = z.read('mac2jb/' + row['bootstrap'])
                if (source_digest != row['sourceSha256'] or hashlib.sha256(bootstrap).hexdigest() != row['bootstrapSha256']
                        or bootstrap != z.read(prefix + 'bootstrap.bas')):
                    violations.append('changed host source or bootstrap digest: ' + host)
                if 'mac2jb/' + row['upstreamManifest'] not in names or prefix + 'README.md' not in names:
                    violations.append('missing original host notices or integrity manifest: ' + host)
        except (KeyError, ValueError, TypeError, UnicodeError):
            violations.append('missing or malformed pinned host sources/provenance')
    ounce_manifest = 'mac2jb/packaging/OunceCake-SHA256SUMS'
    ounce_prefix = 'mac2jb/vendor/OunceCake/'
    if ounce_manifest in names:
        try:
            expected = {}
            for line in z.read(ounce_manifest).decode().splitlines():
                digest, relative = line.split('  ', 1)
                if (len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest)
                        or relative.startswith('/') or '..' in PurePosixPath(relative).parts
                        or '\\' in relative or ounce_prefix + relative in expected):
                    raise ValueError('invalid OunceCake manifest')
                expected[ounce_prefix + relative] = digest
            actual = {name for name in names if name.startswith(ounce_prefix) and not name.endswith('/')}
            upstream_manifest = 'mac2jb/packaging/OunceCake-upstream-SHA256SUMS'
            bundled_upstream_manifest = ounce_prefix + 'SHA256SUMS'
            if (len(expected) != 36 or actual != set(expected) | {bundled_upstream_manifest}
                    or z.read(bundled_upstream_manifest) != z.read(upstream_manifest)):
                violations.append('incomplete or unexpected OunceCake source distribution')
            for name, digest in expected.items():
                if name not in names or hashlib.sha256(z.read(name)).hexdigest() != digest:
                    violations.append('missing or changed OunceCake source: ' + name)
            native = ounce_prefix + 'engine/oz-code/native.bin'
            if hashlib.sha256(z.read(native)).hexdigest() != 'aa2ca4e1351217dbd8d16940672552632d3275f8d313dc4cc0a75e6af534e525':
                violations.append('changed pinned OunceCake native image')
            provenance = json.loads(z.read('mac2jb/packaging/OunceCake-provenance.json'))
            if provenance.get('commit') != '6dfd7750752f8b6c18f2c40b34fdadc628cd9a6e' or provenance.get('license') != 'GPLv2':
                violations.append('changed OunceCake upstream provenance')
            if b'GNU GENERAL PUBLIC LICENSE' not in z.read(ounce_prefix + 'LICENSE'):
                violations.append('missing OunceCake GPL license text')
        except (KeyError, ValueError, UnicodeError):
            violations.append('missing or malformed OunceCake source/provenance')
    gpu_manifest = 'mac2jb/packaging/GPUBrewLauncher-SHA256SUMS'
    gpu_prefix = 'mac2jb/vendor/GPUBrewLauncher/'
    if gpu_manifest in names:
        try:
            expected = {}
            for line in z.read(gpu_manifest).decode().splitlines():
                digest, relative = line.split('  ', 1)
                if (len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest)
                        or relative.startswith('/') or '..' in PurePosixPath(relative).parts
                        or '\\' in relative or gpu_prefix + relative in expected):
                    raise ValueError('invalid GPUBrewLauncher manifest')
                expected[gpu_prefix + relative] = digest
            actual = {name for name in names if name.startswith(gpu_prefix) and not name.endswith('/')}
            if not expected or actual != set(expected):
                violations.append('incomplete or unexpected GPUBrewLauncher source distribution')
            for name, digest in expected.items():
                if name not in names or hashlib.sha256(z.read(name)).hexdigest() != digest:
                    violations.append('missing or changed GPUBrewLauncher source: ' + name)
            provenance = json.loads(z.read('mac2jb/packaging/GPUBrewLauncher-provenance.json'))
            if provenance.get('commit') != 'f35ff64ea4b9b42cf2a75095d24662fe250f03e4':
                violations.append('changed GPUBrewLauncher upstream provenance')
        except (KeyError, ValueError, UnicodeError):
            violations.append('missing or malformed GPUBrewLauncher source/provenance')
    audit_inventory('Gravity Circuit RCE',
                    'mac2jb/packaging/GravCirc-v1.1-SHA256SUMS',
                    'mac2jb/integrations/gravcirc-rce/upstream-v1.1/',
                    'b0fa4f71298e45ed274943df83e843462fc35c70e913f7c3042c26ffb43fd15e', 21)
    try:
        gravcirc = json.loads(z.read('mac2jb/packaging/GravCirc-v1.1.json'))
        packaged_save = z.read('mac2jb/integrations/gravcirc-rce/GC-v1.1.zip')
        if (gravcirc.get('repository') != 'https://github.com/figurophobia/GravCirc-Switch-rce' or
                gravcirc.get('revision') != '3bc0851863f2d2b586e73bec822ce1fa31d23b43' or
                gravcirc.get('release') != 'v1.1' or
                gravcirc.get('titleId') != '01008d9019128000' or
                gravcirc.get('sourceManifest') != 'packaging/GravCirc-v1.1-SHA256SUMS' or
                gravcirc.get('sourceManifestSha256') != 'b0fa4f71298e45ed274943df83e843462fc35c70e913f7c3042c26ffb43fd15e' or
                gravcirc.get('sourceFileCount') != 21 or
                gravcirc.get('archive', {}).get('path') != 'integrations/gravcirc-rce/GC-v1.1.zip' or
                gravcirc.get('archive', {}).get('installableFiles') != 18 or
                hashlib.sha256(packaged_save).hexdigest() !=
                'ab018f3e9947dba3750f18b64100fb76366559fce94bd45db3799fcf9028709e'):
            violations.append('changed Gravity Circuit save or provenance')
        if (z.read('mac2jb/integrations/gravcirc-rce/LICENSE') !=
                z.read('mac2jb/integrations/gravcirc-rce/upstream-v1.1/LICENSE')):
            violations.append('changed Gravity Circuit license notice')
    except (KeyError, ValueError, TypeError, AttributeError, UnicodeError):
        violations.append('missing or malformed Gravity Circuit save/provenance')
    # The app overlay must be the exact published package, independently of
    # the frozen GPUBrewLauncher tree and its unchanged integrity manifest.
    ftpd_manifest = 'mac2jb/packaging/ftpd-sb-v0.1.0-SHA256SUMS'
    ftpd_published = 'mac2jb/packaging/ftpd-sb-v0.1.0-release-SHA256SUMS'
    if (ftpd_published not in names or hashlib.sha256(z.read(ftpd_published)).hexdigest() !=
            'a162967e19d004564301f0607690ebae1cea7b3acf402345016607e9409b2381'):
        violations.append('missing or changed published ftpd-sb archive checksums')
    if ftpd_manifest in names:
        manifest_bytes = z.read(ftpd_manifest)
        if hashlib.sha256(manifest_bytes).hexdigest() != '0f085741f5707a41458be681eb7d2241cbc49f0574f5b0a4b3abba907f20214b':
            violations.append('changed pinned ftpd-sb integrity manifest')
        else:
            app_prefix = 'mac2jb/assets/homebrew-apps/ftpd-sb/'
            expected = {}
            for line in manifest_bytes.decode().splitlines():
                digest, relative = line.split('  ', 1)
                expected[app_prefix + relative] = digest
            actual = {name for name in names if name.startswith(app_prefix) and not name.endswith('/')}
            if actual != set(expected):
                violations.append('missing or unexpected ftpd-sb package files')
            for name, digest in expected.items():
                if name not in names or hashlib.sha256(z.read(name)).hexdigest() != digest:
                    violations.append('missing or changed released ftpd-sb file: ' + name)
                elif stat.S_IFMT(z.getinfo(name).external_attr >> 16) not in (0, stat.S_IFREG):
                    violations.append('non-regular ftpd-sb archive member: ' + name)
            try:
                provenance = json.loads(z.read('mac2jb/packaging/ftpd-sb-v0.1.0-provenance.json'))
                if (provenance.get('commit') != 'ab2123cfb97d492264bf6609cb410e285d6d9b5f' or
                        provenance.get('asset', {}).get('digest') != 'sha256:e3c0e0387d2cdaa6b9345cd8e601cab584f7e46c5f16a285a39c368b5d33140e'):
                    violations.append('changed ftpd-sb release provenance')
            except (KeyError, ValueError):
                violations.append('missing or malformed ftpd-sb release provenance')

    try:
        civ = json.loads(z.read('mac2jb/integrations/civswitch/provenance.json'))
        payload = z.read('mac2jb/integrations/civswitch/payload.txt')
        if (civ.get('upstream') != 'https://github.com/Gezine/CivSwitch' or
                civ.get('commit') != '10b38e9f5abfd13a4b0bec8af24b026e44567da3' or
                civ.get('license') != 'MIT' or civ.get('payloadLines') != 87 or
                civ.get('payloadSha256') != '6ea468ca392558ab2f8f2384200745a8619187cebc5357d5e985fd3ffdada37d' or
                hashlib.sha256(payload).hexdigest() != civ['payloadSha256'] or
                len(payload.splitlines()) != 87):
            violations.append('changed CivSwitch source or payload provenance')
        for name, expected in civ.get('files', {}).items():
            member = 'mac2jb/vendor/CivSwitch/' + name
            if member not in names or hashlib.sha256(z.read(member)).hexdigest() != expected:
                violations.append('changed CivSwitch upstream source: ' + name)
    except (KeyError, ValueError, TypeError):
        violations.append('missing or malformed CivSwitch source provenance')

if violations:
    for v in violations:
        print('FAIL:', v, file=sys.stderr)
    raise SystemExit(1)
print(f'PASS: {archive} contains expected source, licenses, and the approved unsigned driver without excluded artifacts.')
