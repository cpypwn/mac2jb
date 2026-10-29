# Release preparation

Maintainer: **NiftyNova**. GPUBrewLauncher is a fork of
[HBLauncher](https://github.com/ravensclawx/HBLauncher) by **RavensClawX**.

A release is a clean source snapshot with the required runtime assets. Do not
include retained debug sessions, local tool copies, credentials, Wi-Fi settings or
compiled test executables; `.gitignore` excludes these.

Checks:

```sh
node scripts/doctor.cjs --build
bash homebrew-launcher/build-launcher.sh --check
node sdk/tests/launcher.cjs
node apps/hello-world/check.cjs
git diff --check
```

`build-launcher.sh --check` rebuilds the text atlas and launcher shaders, builds
the desktop check helpers, and runs the Node tests and desktop GPU launcher check.

The launcher, right-stick pointer and Joy-Con 2 optical pointer were tested on the
supported console. Native-timed vibration returned nonzero in-stream amplitudes
and requested frequencies. NFC enumeration/detection and a console-to-PC UDP echo
passed; actual NFC tag reads, external keyboard/mouse events, microphone
recording and other listed unimplemented surfaces are not certified. See the SDK
capability matrix.

Create a distributable archive from committed files only:

```sh
mkdir -p dist
git archive --format=zip --prefix=GPUBrewLauncher/ \
  --output=dist/GPUBrewLauncher-source.zip HEAD
sha256sum dist/GPUBrewLauncher-source.zip
```

The archive includes compiled GPU shaders, icons, font atlases, source,
documentation, CREDITS and legacy reference files. It excludes ignored tools,
retained debug sessions, connection records, Wi-Fi settings and local test
executables. Users supply their own supported console software and install host
dependencies. README.md covers setup and normal use, REFERENCE.md contains the
technical reference, and the third-party notices are retained there.
No blanket license has been assigned to third-party material.

Publish a prepared source snapshot deliberately. Do not use
`git push --mirror` or `git push --all` for a release.
