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
- Heightmap (single file): `/{VERSION}/0/heightmap.png`. **Format changed at
  patch 41.00**: it's now **16-bit grayscale** (PIL mode `I;16`, native
  ~2033×2033) where `altitude_cm = pixel − 32256` (sea level = 32256). Older
  patches (≤40.40) served an RGB PNG (~1887×1887) encoding `altitude_cm =
  (R<<8)|G` directly (sea = 0). Step 3 normalizes either into the repo format.
- Locations / POIs: `/{VERSION}/0/data/locations.json`
- Map tiles: `/{VERSION}/0/map/{z}/{x}/{y}.png`
- Height tiles (not used by Dropmap): `/{VERSION}/0/height/{z}/{x}/{y}.png`

Tile grid is `2^z × 2^z` (z=1→2×2 … z=5→32×32), each tile 256×256.

## What lives in the repo

- `data/map.png` — **2048×2048**, the **zoom-3** tile grid (8×8 = 64 tiles)
  stitched together: tile `(x,y)` pasted at pixel `(x*256, y*256)`.
- `data/heightmap.png` — heightmap in **RGB `(R<<8)|G` centimetre** encoding
  (sea = 0), which app.js decodes via canvas `getImageData`. For patch ≥41.00
  this is **converted** from Embenco's 16-bit grayscale (see step 3), not
  verbatim. Native size is whatever Embenco serves — the app samples by
  normalized fraction, so it need not match `map.png`.
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

3. **Download + stitch + normalize the new assets** into a temp dir:
   - Download all 64 zoom-3 tiles `…/{V}/0/map/3/{x}/{y}.png` for x,y in 0..7.
     Validate each is a 256×256 PNG. Stitch into a 2048×2048 **RGB** image
     (paste `(x,y)` at `(x*256, y*256)`; the repo's `map.png` is RGB).
   - Download `…/{V}/0/data/locations.json` (keep verbatim).
   - Download `…/{V}/0/heightmap.png` and **normalize it to the repo's RGB cm
     format** based on its PIL mode:
     - 16-bit (`I;16`/`I`, patch ≥41.00): `cm = clip(pixel − 32256, 0, 0xFFFF)`,
       then `R = (cm>>8)&0xFF, G = cm&0xFF, B = 0`; save RGB. (Encoding verified
       against 40_40, which Embenco served in both formats — `cm = v16 − 32256`,
       corr 0.99998, sea = 32256.)
     - already RGB (older patches): use as-is.
     Keep native dimensions — never resize the heightmap.

4. **Compare against the committed files — only update what changed.** Compare
   PNGs with **numpy**, NOT `ImageChops.difference(...).getbbox()` — on RGBA
   images `getbbox()` defaults to `alpha_only=True`, so it bounds only the alpha
   channel and falsely reports "identical" when just the RGB differs (this caused
   a real false-negative on the 41.00 tiles). Use e.g.
   `np.abs(np.asarray(a.convert("RGB")).astype(int) − np.asarray(b.convert("RGB")).astype(int)).max()`
   (0 = identical). Compare the **normalized** heightmap (step 3 output) against
   the committed one, and a byte diff for `locations.json`. Embenco sometimes
   keeps identical map data across point releases (e.g. 40.20–40.40), so:
   - If an asset is identical to what's committed, **leave it** — don't overwrite
     it (a re-encode is pointless binary churn).
   - Only write `data/map.png` / `data/heightmap.png` / `data/locations.json`
     that genuinely differ. Save the stitched map and normalized heightmap via
     PIL; write `locations.json` as Embenco serves it (verbatim).

5. **Bump the label** in `index.html`: replace the old version literal after the
   `credit-patch` span with the new one.

6. **Report** what changed: the new patch number, which assets actually changed
   vs. were identical, and the `Last-Modified` date of the new patch.

## Guardrails

- Do not `git commit` or `git push` unless the user explicitly asks (per the
  user's global git rules).
- The committed heightmap must be RGB `(R<<8)|G` cm (sea = 0) — that's what
  app.js decodes via canvas `getImageData`. **Never commit Embenco's raw 16-bit
  heightmap**: canvas downsamples it to 8-bit and altitude breaks. Don't resize.
- Sanity-check before claiming an update: `map.png` is 2048×2048; the heightmap
  decodes to sane altitudes (sea = 0 m, peaks roughly 150–230 m) and its sea mask
  (`cm == 0`) aligns with the map's water.
