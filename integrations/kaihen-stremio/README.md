# kaiHEN Stremio

This is a native Switch 2 Stremio client for kaiHEN. It requests addon catalogs, metadata, episode lists, and stream choices from the Switch over HTTPS. For direct HTTPS H.264 MP4 streams, it demuxes with FFmpeg, sends video to the native decoder, renders full-screen output, and decodes audio to the Switch output. It does not use the mac2jb Stremio bridge. Press B or Minus to leave playback.

This source needs [ounce-devkit](https://github.com/ouncebrew/ounce-devkit), the devkitPro `switch-ffmpeg` and `switch-curl` portlibs, and their static dependencies. Build it with:

```sh
make
```

The NRO also builds in the official `devkitpro/devkita64` container with the [ounce-devkit 20261117 release](https://github.com/ouncebrew/ounce-devkit/releases/tag/devkit-20261117) extracted into `/opt/devkitpro`. Mount this directory at `/work`, set `DEVKITPRO=/opt/devkitpro`, and run `make` there.

Run the parser and frame-conversion tests on a Mac without the Switch toolchain:

```sh
make test-host
```

The default addon is Cinemeta, which supplies catalogs and metadata but no playable streams. To use another addon, put its full HTTPS manifest URL on one line in `sdmc:/switch/kaihen-stremio/addon.url`. Put a stream addon's HTTPS manifest URL in `stream-addon.url` in the same folder. Without `stream-addon.url`, the catalog addon is queried for streams too.

Use the D-pad to select a title, episode, or stream, A to open or play it, B to go back, X to change catalogs, Y to refresh, Minus to sign in with a QR code, and Plus to exit. The browse screen displays poster and backdrop artwork when an addon provides it. The player accepts direct HTTPS H.264 MP4 streams with a decodable audio track. Servers that ignore byte-range requests are supported only when the whole media object fits in 16 MiB. Torrents, DRM, subtitles, and other video codecs are outside this implementation.

The stock devkitPro `switch-ffmpeg` 7.1 package does not register the HTTPS protocol used by HLS child segments. FFmpeg checks that protocol before calling this client's libcurl reader, so HLS requires a custom FFmpeg build with HTTPS enabled. With the stock package, an HLS URL reports that requirement instead of attempting playback.

