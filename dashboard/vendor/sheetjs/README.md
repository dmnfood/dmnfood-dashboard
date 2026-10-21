# SheetJS Community Edition 0.20.3

Vendored unchanged from the official, authoritative SheetJS CDN on 2026-10-21.

- Script: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
- License: https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE (Apache-2.0)
- Official installation and vendoring guide: https://docs.sheetjs.com/docs/getting-started/installation/standalone/
- Script SHA-256: `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`
- License SHA-256: `4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64`

The full build is used for legacy Korean XLS codepage support. It runs only in a
dedicated, terminated-on-timeout worker. Workbook bytes stay in this application's
authenticated download/browser path; no online document conversion is used.

SheetJS formats cached cell values. This application never evaluates formulas,
executes macros, follows workbook hyperlinks, or inserts cell HTML into the DOM.
