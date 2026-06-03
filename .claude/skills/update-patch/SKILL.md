---
name: update-patch
description: Update Dropmap to the latest Embenco patch — find the newest map version on embenco.nl, refresh data/map.png, data/heightmap.png, data/locations.json if they changed, and bump the patch label in index.html. Use when the user says to check embenco for a new patch, update the map data, or bump the patch version.
---

# Update Dropmap to the latest Embenco patch

Dropmap mirrors map assets from the Embenco drop calculator
(`https://www.embenco.nl/drop-calculator/`). This skill finds the latest patch,
re-downloads the assets, updates only what actually changed, and bumps the patch
label. Always verify before asserting — re-download and pixel-compare, don't
assume the data changed just because the patch number did.

## How Embenco serves assets

Assets live under `https://www.embenco.nl/fndropcalc/{VERSION}/{MAPTYPE}/...`

- `{VERSION}` is the patch as `MM_NN`, e.g. patch `40.40` → `40_40`.
- `{MAPTYPE}` — **always use `0`** (Battle Royale). `1` is "Battle Royale OG" and
  is not always present; Dropmap only uses `0`.

Asset paths (mapType 0):
- Heightmap (single file, native **1887×1887**): `/{VERSION}/0/heightmap.png`
- Locations / POIs: `/{VERSION}/0/data/locations.json`
- Map tiles: `/{VERSION}/0/map/{z}/{x}/{y}.png`
- Height tiles (not used by Dropmap): `/{VERSION}/0/height/{z}/{x}/{y}.png`

Tile grid is `2^z × 2^z` (z=1→2×2 … z=5→32×32), each tile 256×256.

## What lives in the repo

- `data/map.png` — **2048×2048**, the **zoom-3** tile grid (8×8 = 64 tiles)
  stitched together: tile `(x,y)` pasted at pixel `(x*256, y*256)`.
- `data/heightmap.png` — Embenco's `heightmap.png` verbatim (pixels unchanged).
- `data/locations.json` — Embenco's `locations.json` verbatim.
- `index.html` — patch number is the literal text right after
  `<span id="credit-patch">Patch</span>` (e.g. `40.40`). That's the only place
  the version appears in the repo.

Use `curl -A "Mozilla/5.0"` for all requests. Tools: `python3` has PIL; there is
**no** ImageMagick — stitch with PIL.

## Procedure

1. **Read the current patch** from `index.html` (text after `credit-patch` span).

2. **Find the latest version.** Probe `…/{VERSION}/0/data/locations.json` with
   `curl -o /dev/null -w "%{http_code}"`. Start from the current patch and walk
   the minor up by 10 (`40_30`, `40_40`, …) and the major up (`41_00`, `42_00`),
   probing around boundaries until you find the highest one returning `200`.
   Confirm it's newest via the `Last-Modified` header on its `heightmap.png`
   (should be the most recent). If the latest equals the current patch, stop —
   nothing to do.

3. **Download + stitch the new assets** into a temp dir:
   - Download all 64 zoom-3 tiles `…/{V}/0/map/3/{x}/{y}.png` for x,y in 0..7.
     Validate each is a 256×256 PNG. Stitch into a 2048×2048 RGBA image
     (paste `(x,y)` at `(x*256, y*256)`).
   - Download `…/{V}/0/heightmap.png` and `…/{V}/0/data/locations.json`.

4. **Compare against the committed files — only update what changed.** Use PIL
   `ImageChops.difference(...).getbbox()` (None = pixel-identical) for the PNGs,
   and a byte diff for `locations.json`. Embenco often keeps identical map data
   across point releases (e.g. 40.20–40.40 were pixel-identical), so:
   - If an asset is pixel/byte-identical to what's committed, **leave it** — do
     not overwrite it (a re-encode produces different bytes for zero real change
     and is pointless binary churn).
   - Only write `data/map.png` / `data/heightmap.png` / `data/locations.json`
     that genuinely differ. Save the stitched map and the heightmap via PIL;
     write `locations.json` as Embenco serves it (verbatim).

5. **Bump the label** in `index.html`: replace the old version literal after the
   `credit-patch` span with the new one.

6. **Report** what changed: the new patch number, which assets actually changed
   vs. were identical, and the `Last-Modified` date of the new patch.

## Guardrails

- Do not `git commit` or `git push` unless the user explicitly asks (per the
  user's global git rules).
- Don't resize or re-encode the heightmap's pixels — the app reads its RGBA
  values to compute altitude; resizing would corrupt the encoding.
- Sanity-check before claiming an update: the new map/heightmap should be valid
  images of the expected dimensions (2048×2048 and 1887×1887).
