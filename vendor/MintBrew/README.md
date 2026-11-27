# MintBrew

MintBrew is mac2jb's internal on-console GPU runtime for OunceCake. It uses the GPUBrewLauncher held-RPC runtime and the shared HBLauncher GPU app ABI.

Start it from mac2jb after a held RPC session is available. The host runs `homebrew-launcher/start-launcher.cjs` from this directory and serves apps from `apps/`. Apps must be compatible `hblauncher.gpu-app` ABI 1 packages; this is not an NRO loader.

Compatible app folders can be added to or removed from `apps/` while the launcher is open. Refresh the app list on the Switch to see the changes. Hold B or Minus for 900 ms to return from a running app.

To verify the imported source in the mac2jb checkout, run `node scripts/prepare-mintbrew.cjs --check-source`. To prepare a copied runtime, run `node scripts/prepare-mintbrew.cjs --prepare PATH_TO_RUNTIME`. The same script's `--check-runtime [PATH_TO_RUNTIME]` checks the packaged catalog and pinned app overlays.

This Mac adaptation has offline shader and package validation. Console operation still needs a held-RPC hardware test.

See [CREDITS](CREDITS) for the source ancestry and attribution. The imported HBLauncher and GPUBrewLauncher snapshots do not include license files. Check upstream licensing terms before publishing this derivative.
