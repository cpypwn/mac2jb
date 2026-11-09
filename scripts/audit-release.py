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
    'mac2jb/vendor/ns2jb-hosts/izmysh-legacy/server/host.cjs',
    'mac2jb/packaging/IZMYSH-legacy-SHA256SUMS',
    'mac2jb/packaging/IZMYSH-legacy-provenance.json',
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
    'mac2jb/integrations/mintbrew-iz-exchange/prepare.cjs',
    'mac2jb/integrations/mintbrew-iz-exchange/service.cjs',
    'mac2jb/integrations/mintbrew-native/host.cjs',
    'mac2jb/integrations/mintbrew-stremio/adapter.cjs',
    'mac2jb/scripts/gui-izlauncher.cjs',
    'mac2jb/scripts/izlauncher-modules.cjs',
    'mac2jb/scripts/izlauncher-panel.cjs',
    'mac2jb/scripts/stage-custom-izmodule.cjs',
    'mac2jb/scripts/gui-custom-homebrew.cjs',
    'mac2jb/scripts/custom-rpc-package.cjs',
    'mac2jb/scripts/prepare-izlauncher.cjs',
    'mac2jb/scripts/check-izlauncher-runtime.cjs',
    'mac2jb/vendor/BlitBun/LICENSE',
    'mac2jb/vendor/BlitBun/module.json',
    'mac2jb/integrations/blitbun/prepare.cjs',
    'mac2jb/integrations/mac-stream-host.cjs',
    'mac2jb/integrations/blitbun/mac-panel.cjs',
    'mac2jb/integrations/blitbun/mac-doom.cjs',
    'mac2jb/integrations/blitbun/upstream-SHA256SUMS',
    'mac2jb/integrations/blitbun/ADAPTATION-SHA256SUMS',
    'mac2jb/integrations/blitbun/freedoom-assets.cjs',
    'mac2jb/integrations/blitbun/freedoom-provenance.md',
    'mac2jb/integrations/blitbun/assets/freedoom1.wad',
    'mac2jb/integrations/blitbun/assets/COPYING.txt',
    'mac2jb/integrations/blitbun/assets/CREDITS.txt',
    'mac2jb/integrations/blitbun/assets/CREDITS-MUSIC.txt',
    'mac2jb/integrations/blitbun/doom-engine/source-SHA256SUMS',
    'mac2jb/integrations/blitbun/doom-engine/PROVENANCE.json',
    'mac2jb/integrations/blitbun/doom-engine/source/LICENSE',
    'mac2jb/integrations/blitbun/doom-engine/doom-mac.c',
    'mac2jb/integrations/blitbun/doom-engine/build.cjs',
    'mac2jb/integrations/blitbun/doom-engine/doom-headless',
    'mac2jb/integrations/vacootube/prepare.cjs',
    'mac2jb/integrations/vacootube/PROVENANCE.json',
    'mac2jb/integrations/vacootube/UPSTREAM-SHA256SUMS',
    'mac2jb/integrations/vacootube/ADAPTATION-SHA256SUMS',
    'mac2jb/integrations/vacootube/upstream/LICENSE',
    'mac2jb/integrations/vacootube/upstream/module.json',
    'mac2jb/integrations/vacootube/upstream/app/package-lock.json',
    'mac2jb/integrations/vacootube/overlay/module.json',
    'mac2jb/integrations/izlauncher-shell/prepare.cjs',
    'mac2jb/integrations/izlauncher-shell/provenance.json',
    'mac2jb/integrations/izlauncher-shell/prebuilt-SHA256SUMS',
    'mac2jb/integrations/izdoom/prepare.cjs',
    'mac2jb/vendor/IZDOOM/IZDOOM-v0.17.1-IZ2S.izm',
    'mac2jb/vendor/IZDOOM/IZDOOM-v0.17.1-source.tar.gz',
    'mac2jb/vendor/IZDOOM/SHA256SUMS',
    'mac2jb/vendor/IZDOOM/PROVENANCE.md',
    'mac2jb/vendor/IZ2S-Platform/LICENSE',
    'mac2jb/vendor/IZ2S-Platform/COPYRIGHT',
    'mac2jb/vendor/IZ2S-Platform/LICENSE-SCOPE.md',
    'mac2jb/vendor/IZ2S-Platform/THIRD_PARTY.json',
    'mac2jb/vendor/IZ2S-Platform/shells/izlauncher/server/runtime.cjs',
    'mac2jb/vendor/IZ2S-Platform/modules/iz-exchange/module.json',
    'mac2jb/packaging/IZ2S-Platform-provenance.json',
    'mac2jb/packaging/IZ2S-Platform-SHA256SUMS',
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
    'mac2jb/gui/CivSwitchControlCenterModel.swift',
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
    'mac2jb/vendor/CivSwitch-ControlCenter/LICENSE',
    'mac2jb/vendor/CivSwitch-ControlCenter/README.md',
    'mac2jb/vendor/CivSwitch-ControlCenter/VERSION',
    'mac2jb/vendor/CivSwitch-ControlCenter/SHA256SUMS',
    'mac2jb/vendor/CivSwitch-ControlCenter/control_center.js',
    'mac2jb/vendor/CivSwitch-ControlCenter/send_js.py',
    'mac2jb/vendor/CivSwitch-ControlCenter/tools/save_dump_receiver.py',
    'mac2jb/vendor/CivSwitch-ControlCenter/tools/send_staged_payload.py',
    'mac2jb/integrations/civswitch-control-center/mac-host.py',
    'mac2jb/integrations/civswitch-control-center/verify-source.py',
    'mac2jb/integrations/civswitch-control-center/test_mac_host.py',
    'mac2jb/integrations/civswitch-control-center/provenance.json',
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
    try:
        test_build = json.loads(z.read('mac2jb/packaging/test-build.json')).get('testBuild') is True
    except (KeyError, ValueError, TypeError):
        test_build = False
    personal_required = {
        'mac2jb/integrations/civswitch/hello.js',
        'mac2jb/integrations/civswitch/send-hello.cjs',
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
                'izmysh': 'd7a0df16e7e0c68acf78d2f68da8496ef3d9fd6b',
                'astral': '81d5bb114c856109dadaf1077d927a9f297fe58d',
            }
            profiles = registry['profiles']
            if (registry.get('format') != 'mac2jb-host-profiles-v1' or registry.get('default') != 'kurumuz'
                    or len(profiles) != 6 or {row['id'] for row in profiles} != set(pins)):
                raise ValueError('invalid host profile registry')
            for row in profiles:
                host = row['id']
                folder = ('vendor/ns2jb-hosts/izmysh-legacy' if host == 'izmysh' else
                          'vendor/ns2jb' if host == 'BermTheSequel' else 'vendor/ns2jb-hosts/' + host)
                label = 'IZMYSH' if host == 'izmysh' else 'Cellenseres' if host == 'cellenseres' else 'Astral (custom)' if host == 'astral' else host
                held = host not in ('pepsipu', 'izmysh')
                demo = host in ('kurumuz', 'cellenseres', 'BermTheSequel', 'astral')
                savekit = host in ('kurumuz', 'cellenseres', 'astral')
                modloader = host in ('kurumuz', 'cellenseres')
                arity = 9 if host in ('pepsipu', 'izmysh') else 5
                port = 39395 if host == 'izmysh' else 39380
                save_name = 'NS2I' if host == 'izmysh' else 'NS2'
                if (row['label'] != label or row['revision'] != pins[host] or row['sourceDirectory'] != folder
                        or row['startArgumentCount'] != arity or row.get('startPort', 39380) != port
                        or row.get('saveName', 'NS2') != save_name or row['supportsHeldRPC'] != held
                        or row['supportsDemo'] != demo or bool(row.get('supportsSaveKit')) != savekit
                        or bool(row.get('supportsNativeHBLauncher')) != savekit
                        or bool(row.get('supportsModloader')) != modloader or not row.get('licenseStatus')):
                    raise ValueError('changed host provenance or capabilities')
                prefix = 'mac2jb/' + folder + '/'
                if host == 'izmysh':
                    entries = [name[len(prefix):] for name in names if name.startswith(prefix) and not name.endswith('/')]
                    entries.sort()
                    legacy_manifest = z.read('mac2jb/packaging/IZMYSH-legacy-SHA256SUMS')
                    if hashlib.sha256(legacy_manifest).hexdigest() != '345f6d1f906f8a7e87678ba6b99d1b2e5abb892bf0bf8c274e4b9b860807d0a7':
                        violations.append('changed IZMYSH legacy manifest')
                    expected_legacy = {}
                    for line in legacy_manifest.decode().splitlines():
                        digest, relative = line.split('  ', 1)
                        if (len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest)
                                or relative.startswith('/') or '..' in PurePosixPath(relative).parts
                                or '\\' in relative or relative in expected_legacy):
                            raise ValueError('invalid IZMYSH legacy manifest')
                        expected_legacy[relative] = digest
                    if len(expected_legacy) != 19 or entries != sorted(expected_legacy):
                        violations.append('incomplete or unexpected IZMYSH legacy source')
                    for relative, digest in expected_legacy.items():
                        name = prefix + relative
                        if name not in names or hashlib.sha256(z.read(name)).hexdigest() != digest:
                            violations.append('missing or changed IZMYSH legacy source: ' + name)
                    source_entries = [[name, hashlib.sha256(z.read(prefix + name)).hexdigest()] for name in entries]
                    source_digest = hashlib.sha256(json.dumps(source_entries, separators=(',', ':')).encode()).hexdigest()
                    bootstrap = z.read('mac2jb/' + row['bootstrap'])
                    if (source_digest != row['sourceSha256'] or hashlib.sha256(bootstrap).hexdigest() != row['bootstrapSha256']
                            or bootstrap != z.read(prefix + 'bootstrap.bas') or row.get('distributionManifest') != 'packaging/IZMYSH-legacy-SHA256SUMS'):
                        violations.append('changed IZMYSH host source or bootstrap digest')
                    continue
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
    iz_manifest = 'mac2jb/packaging/IZ2S-Platform-SHA256SUMS'
    iz_prefix = 'mac2jb/vendor/IZ2S-Platform/'
    try:
        manifest_bytes = z.read(iz_manifest)
        if hashlib.sha256(manifest_bytes).hexdigest() != '9ac9995abc40c721362c9117a04a00ee4f0bdc585b93999d8bb28a8ee48d0326':
            raise ValueError('changed IZ2S manifest')
        expected = {}
        for line in manifest_bytes.decode().splitlines():
            digest, relative = line.split('  ', 1)
            if (len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest)
                    or relative.startswith('/') or '..' in PurePosixPath(relative).parts
                    or '\\' in relative or iz_prefix + relative in expected):
                raise ValueError('invalid IZ2S manifest')
            expected[iz_prefix + relative] = digest
        actual = {name for name in names if name.startswith(iz_prefix) and not name.endswith('/')}
        if len(expected) != 1072 or actual != set(expected):
            violations.append('incomplete or unexpected IZ2S source distribution')
        for name, digest in expected.items():
            if name not in names or hashlib.sha256(z.read(name)).hexdigest() != digest:
                violations.append('missing or changed IZ2S source: ' + name)
        provenance = json.loads(z.read('mac2jb/packaging/IZ2S-Platform-provenance.json'))
        modifications = provenance.get('modifications')
        changed_paths = set()
        if (provenance.get('commit') != '73f1b6d98b3fd7c3a44c2b4f6e3b94704ce9435f' or
                provenance.get('version') != '0.21.0' or
                provenance.get('fileCount') != 1072 or
                provenance.get('totalBytes') != sum(z.getinfo(name).file_size for name in expected) or
                provenance.get('integrityManifestSha256') != hashlib.sha256(manifest_bytes).hexdigest() or
                not isinstance(modifications, list) or len(modifications) != len(changed_paths) or
                not all(isinstance(row, dict) and isinstance(row.get('reason'), str) and row['reason']
                        for row in modifications) or
                {row['path'] for row in modifications} != changed_paths):
            violations.append('changed IZ2S upstream provenance')
    except (KeyError, ValueError, UnicodeError):
        violations.append('missing or malformed IZ2S source/provenance')
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
    audit_inventory('BlitBun',
                    'mac2jb/integrations/blitbun/upstream-SHA256SUMS',
                    'mac2jb/vendor/BlitBun/',
                    'c8e6cccddfe9562fa3240cfe01c460905def134dd14daaf4d22d7ea357b6f39d', 78)
    audit_inventory('DoomGeneric source',
                    'mac2jb/integrations/blitbun/doom-engine/source-SHA256SUMS',
                    'mac2jb/integrations/blitbun/doom-engine/source/',
                    'b4900944d294bed9679ec2a87768cc33c7a85f1e93adf056a5f3ddd9458baab1', 194)
    blit_prefix = 'mac2jb/integrations/blitbun/'
    blit_adaptation = audit_inventory('BlitBun adaptation',
                                      blit_prefix + 'ADAPTATION-SHA256SUMS',
                                      blit_prefix,
                                      'b1737094d4ddbba9bc84f3a2c4e7fc079101cb64f5618f7de6877e11f853fdc2',
                                      208, exact=False)
    blit_files = {name[len(blit_prefix):] for name in names
                  if name.startswith(blit_prefix) and not name.endswith('/')}
    if blit_files != set(blit_adaptation) | {'ADAPTATION-SHA256SUMS', 'upstream-SHA256SUMS'}:
        violations.append('incomplete or unexpected BlitBun adaptation')
    blit_assets = {
        'COPYING.txt': '7c62f2c520769c798774f416637eec4921e5f0aafdac1245ae7c8a8cf65fe102',
        'CREDITS-MUSIC.txt': '2bb77677bbc4e587bba44ccb6514ee0f5397c7bb8ae9580b9188d3d6a57c0a31',
        'CREDITS.txt': '72364333d295c598d75ef9553d3b3661ad0b60e27271c87b7637c74b2f46918a',
        'freedoom1.wad': '7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d',
    }
    blit_asset_prefix = blit_prefix + 'assets/'
    asset_files = {name[len(blit_asset_prefix):] for name in names
                   if name.startswith(blit_asset_prefix) and not name.endswith('/')}
    if asset_files != set(blit_assets):
        violations.append('incomplete or unexpected Freedoom assets')
    for relative, digest in blit_assets.items():
        name = blit_asset_prefix + relative
        if name not in names or hashlib.sha256(z.read(name)).hexdigest() != digest:
            violations.append('missing or changed Freedoom asset: ' + name)
    try:
        if z.read(blit_asset_prefix + 'freedoom1.wad')[:4] != b'IWAD':
            violations.append('invalid Freedoom IWAD header')
        if b'Redistribution and use in source and binary forms' not in z.read(blit_asset_prefix + 'COPYING.txt'):
            violations.append('missing Freedoom license notice')
        if b'GNU GENERAL PUBLIC LICENSE' not in z.read(blit_prefix + 'doom-engine/source/LICENSE'):
            violations.append('missing DoomGeneric GPL license text')
        engine_name = blit_prefix + 'doom-engine/doom-headless'
        engine_bytes = z.read(engine_name)
        engine_info = z.getinfo(engine_name)
        if (engine_bytes[:4] != b'\xcf\xfa\xed\xfe' or
                int.from_bytes(engine_bytes[4:8], 'little') != 0x0100000c or
                not stat.S_IMODE(engine_info.external_attr >> 16) & 0o111):
            violations.append('invalid or non-executable arm64 Doom engine')
        engine = json.loads(z.read(blit_prefix + 'doom-engine/PROVENANCE.json'))
        if (engine.get('upstream') != 'https://github.com/ozkl/doomgeneric' or
                engine.get('commit') != 'e257a09527062bfb986b6e5e0780839b6cbd5b71' or
                engine.get('sourceInventorySha256') != 'b4900944d294bed9679ec2a87768cc33c7a85f1e93adf056a5f3ddd9458baab1' or
                engine.get('sourceFileCount') != 194 or
                engine.get('sourceLicense') != 'GPL-2.0-or-later' or
                engine.get('macBinarySha256') != '9521f644a40ad6b020b79a6579a4621710baee562c0002b9e489f90d6cd9efc9' or
                hashlib.sha256(engine_bytes).hexdigest() != engine.get('macBinarySha256') or
                engine.get('gameDataSha256') != blit_assets['freedoom1.wad']):
            violations.append('changed DoomGeneric or Freedoom provenance')
    except (KeyError, ValueError, UnicodeError):
        violations.append('missing Freedoom or DoomGeneric license material')
    upstream_prefix = 'mac2jb/integrations/vacootube/upstream/'
    upstream = audit_inventory('VacooTube upstream',
                               'mac2jb/integrations/vacootube/UPSTREAM-SHA256SUMS',
                               upstream_prefix,
                               '0fd54ec5e75978a54de6a70bdbf2472164f8187df0f603de73851fb85ff43ac8', 272)
    adaptation_prefix = 'mac2jb/integrations/vacootube/'
    adaptation = audit_inventory('VacooTube adaptation',
                                 adaptation_prefix + 'ADAPTATION-SHA256SUMS',
                                 adaptation_prefix,
                                 '63b0c85f150997ca098d63a54190625b63dcddaa74c59c18a1bca87b84e58f16',
                                 13, exact=False)
    overlay_files = {name[len(adaptation_prefix):] for name in names
                     if name.startswith(adaptation_prefix + 'overlay/') and not name.endswith('/')}
    if overlay_files != {name for name in adaptation if name.startswith('overlay/')}:
        violations.append('incomplete or unexpected VacooTube adaptation overlay')
    vacoo_files = {name[len(adaptation_prefix):] for name in names
                   if name.startswith(adaptation_prefix) and not name.endswith('/')}
    vacoo_expected = (set(adaptation) | {'prepare.cjs', 'UPSTREAM-SHA256SUMS', 'ADAPTATION-SHA256SUMS'} |
                      {'upstream/' + name for name in upstream})
    if vacoo_files != vacoo_expected:
        violations.append('incomplete or unexpected VacooTube integration files')
    audit_inventory('IZlauncher prebuilt shell',
                    'mac2jb/integrations/izlauncher-shell/prebuilt-SHA256SUMS',
                    'mac2jb/integrations/izlauncher-shell/prebuilt/',
                    '7a5ad86fe21b111a925c350511b817363cce0c6d83fb5d4f52292d911e4f335f', 107)
    shell_prefix = 'mac2jb/integrations/izlauncher-shell/'
    shell_files = {name[len(shell_prefix):] for name in names
                   if name.startswith(shell_prefix) and not name.endswith('/')}
    shell_manifest = {name[len(shell_prefix):] for name in names
                      if name.startswith(shell_prefix + 'prebuilt/') and not name.endswith('/')}
    if shell_files != shell_manifest | {'prepare.cjs', 'provenance.json', 'prebuilt-SHA256SUMS'}:
        violations.append('incomplete or unexpected IZlauncher shell integration')
    try:
        vacoo = json.loads(z.read(adaptation_prefix + 'PROVENANCE.json'))
        if (vacoo.get('tag') != 'v1.4.1' or
                vacoo.get('commit') != 'f28e762a085c4a4adcd655f12b40f4a68d646a4f' or
                vacoo.get('upstreamInventorySha256') != '0fd54ec5e75978a54de6a70bdbf2472164f8187df0f603de73851fb85ff43ac8' or
                vacoo.get('appPackageLockSha256') != '1591b7219b83241a0f84ceec2d81e89bf627b7ea3d040566f8713e9aa3b12ad2' or
                vacoo.get('electron', {}).get('sha256') != '1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c'):
            violations.append('changed VacooTube upstream provenance')
        shell = json.loads(z.read('mac2jb/integrations/izlauncher-shell/provenance.json'))
        if (shell.get('platformCommit') != '73f1b6d98b3fd7c3a44c2b4f6e3b94704ce9435f' or
                shell.get('moduleCommits') != {
                    'blitbun': '7d4098df26909016ace0fb4760ef9269cd2b4743',
                    'vacootube': 'f28e762a085c4a4adcd655f12b40f4a68d646a4f'} or
                shell.get('variants') != {
                    'iz-shell-59e16342c8dad82a': ['blitbun', 'iz-exchange'],
                    'iz-shell-a41ea85fd4b626aa': ['blitbun', 'iz-exchange', 'vacootube']}):
            violations.append('changed IZlauncher shell provenance')
    except (KeyError, ValueError, TypeError, UnicodeError):
        violations.append('missing or malformed homebrew integration provenance')
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

    try:
        control = json.loads(z.read('mac2jb/integrations/civswitch-control-center/provenance.json'))
        prefix = 'mac2jb/vendor/CivSwitch-ControlCenter/'
        listing = z.read(prefix + 'SHA256SUMS')
        files = control['files']
        if (control.get('upstream') != 'https://github.com/MatthewKuKanich/CivSwitch-ControlCenter' or
                control.get('commit') != '259cbe5e66f2e649a79a16f06db4cdb012017daa' or
                control.get('version') != '1.0.0' or control.get('license') != 'MIT' or
                control.get('sha256sumsSha256') != hashlib.sha256(listing).hexdigest() or
                not isinstance(files, dict) or len(files) != 9):
            raise ValueError('changed Control Center provenance')
        listed = {}
        for line in listing.decode().splitlines():
            digest, path = line.split('  ./', 1)
            if path in listed:
                raise ValueError('duplicate Control Center source')
            listed[path] = digest
        actual = {name[len(prefix):] for name in names if name.startswith(prefix) and not name.endswith('/')}
        if actual != set(files) | {'SHA256SUMS'} or listed != files:
            raise ValueError('incomplete Control Center source')
        for name, digest in files.items():
            member = prefix + name
            if hashlib.sha256(z.read(member)).hexdigest() != digest:
                violations.append('changed Control Center upstream source: ' + name)
    except (KeyError, ValueError, TypeError, UnicodeError):
        violations.append('missing or malformed Control Center source provenance')

if violations:
    for v in violations:
        print('FAIL:', v, file=sys.stderr)
    raise SystemExit(1)
print(f'PASS: {archive} contains expected source, licenses, and the approved unsigned driver without excluded artifacts.')
