# CivHomebrew app catalogs

CivHomebrew Options → Browse apps downloads `.civapp` packages directly on the Switch over HTTPS. Press A on a selected app to install, update or reinstall it. CivHomebrew checks each download's byte count and SHA-256 before handing the package to its installer. The source catalog can still contain untrusted code; add only sources whose maintainers you trust.

The default source is `https://raw.githubusercontent.com/cpypwn/civapp-db/main/catalog.json`. It loads from the public repository without GitHub Pages. A Cloudflare tunnel can be added as another source if it serves both `catalog.json` and the listed `.civapp` packages over HTTPS.

Additional sources use the same `catalog.json` format. Enter either a direct HTTPS URL ending in `/catalog.json`, or a GitHub repository URL such as `https://github.com/owner/repo`. Repository URLs resolve to `https://raw.githubusercontent.com/owner/repo/HEAD/catalog.json`, so the file must be at the repository root. A GitHub Pages site may also be entered by its direct HTTPS catalog URL. Up to seven additional sources are saved in the Switch's CivHomebrew save. Left/Right changes sources; X removes the selected custom source. The default source cannot be removed.

## `catalog.json` format

```json
{
  "format": "civhomebrew-catalog",
  "version": 1,
  "apps": [
    {
      "id": "sample-app",
      "name": "Sample App",
      "release": "1.0.0",
      "description": "A short description",
      "repository": "https://github.com/owner/sample-app",
      "package": "https://example.org/releases/sample-app-1.0.0.civapp",
      "bytes": 123456,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

`id`, `name`, `release`, `description`, `package`, `bytes`, and `sha256` are required. `repository` is optional and shown as source information. The package's embedded ID and release must match the catalog. The SHA-256 value must be the hex digest of the exact `.civapp` file served at `package`. Catalogs are limited to 64 KiB and 64 apps; each package is limited to CivHomebrew's 12 MiB frame size. All URLs use HTTPS on port 443. HTTP, local files, and automatic installation are unsupported.

This integration overlays a verified pinned CivHomebrew 0.4.3 source copy only while installing or launching CivHomebrew. The original source cache remains unchanged. Upstream source and license information remain in [`packaging/CivHomebrew-source.json`](../../packaging/CivHomebrew-source.json).
