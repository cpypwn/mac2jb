# MintBrew

MintBrew is mac2jb's combined on-console GPU homebrew launcher. It uses the GPUBrewLauncher held-RPC runtime and the shared HBLauncher GPU app ABI. The menu uses mac2jb's dark and mint colors. The bundled app catalog includes Hello World, Froggy Road and an experimental CPU to GPU timer probe. mac2jb adds ftpd-sb v0.1.0, IZDOOM v0.17.1 and Stremio when preparing the Mac app.

Start it from mac2jb after a held RPC session is available. The host runs `homebrew-launcher/start-launcher.cjs` from this directory and serves apps from `apps/`. Apps must be compatible `hblauncher.gpu-app` ABI 1 packages; this is not an NRO loader.

Compatible app folders can be added to or removed from `apps/` while the launcher is open. Refresh the app list on the Switch to see the changes. Hold B or Minus for 900 ms to return from a running app. Stremio requires the Stremio desktop app's video tools on this Mac.

To verify the imported source in the mac2jb checkout, run `node scripts/prepare-mintbrew.cjs --check-source`. To prepare a copied runtime, run `node scripts/prepare-mintbrew.cjs --prepare PATH_TO_RUNTIME`. The same script's `--check-runtime [PATH_TO_RUNTIME]` checks the packaged catalog and pinned app overlays.

This Mac adaptation has offline shader and package validation. Console operation still needs a held-RPC hardware test.

See [CREDITS](CREDITS) for the source ancestry and attribution. The imported HBLauncher and GPUBrewLauncher snapshots do not include license files. Check upstream licensing terms before publishing this derivative.
