# frely-cli logo exports

Captured from the rendered landing page (`_site/en/`, header brand), not hand-drawn.
Full lockup / wordmark: headless Chrome at 40× device scale, lanczos3 downscaled per size.
Mark series: exact vector tile + glyph captured at 40× (see Re-capture), lanczos3 per size.
Colors as defined in `site/styles.css` (`--accent #d3fa6a`, `--text #f0f3ed`, `--muted #aab6ab`, `--bg #101411`).

## Files

- `frely-cli-logo-{1440,1080,720,360}.png` — full lockup: mark + `frely` wordmark + `CLI` label, exactly as shown in the landing header (page background `#101411` included).
- `frely-cli-mark-{1024,512,256,180,128,64,48,32,16}.png` — the lime terminal tile (`>_`) alone, square. Transparent background: everything outside the rounded tile (incl. the four corner cutouts) is alpha 0, with 10% transparent padding around the tile so nothing is cropped at the edges.
- `frely-cli-wordmark-{1120,560,280}.png` — `frely` + `CLI` text only, no tile.
- `frely-cli-favicon.svg` — the tab icon, extracted verbatim from the favicon data URI in `site/template.html` (inverted variant: dark tile, lime mark). Scales to any size.

## Re-capture

The header brand is rendered text (system fonts: Inter / SFMono-Regular), so any change to
`site/styles.css` or the fonts in use changes the logo. To regenerate after such a change:

1. `node site/build.mjs` (rebuild `_site`)
2. serve `_site`, e.g. `python3 -m http.server 8931 -d _site`
3. run the puppeteer-core capture scripts (see export history / session notes).

### Lockup + wordmark

Measure `.brand` geometry in-page, screenshot at `deviceScaleFactor: 40` (clip = brand box +
8px padding), crop mark/wordmark by the measured rects, trim, then lanczos3 to the ladders.

### Mark (the tricky one)

The element is 29.59375 CSS px. Chrome quantizes screenshot clips to whole CSS px, so a
direct element shot renders the tile as a 30×29 rounded rect: the bottom edge is clipped and
the right-side arcs are displaced. Do NOT use the captured tile shape. Instead:

1. In-page: set `body`, `html` AND `.brand-symbol` backgrounds to `transparent`
   (Chrome's `omitBackground` only drops the default canvas bg, not explicit CSS
   backgrounds; hiding the symbol's own lime bg keeps the shot glyph-only).
2. Screenshot the element clip at `deviceScaleFactor: 40` with `omitBackground: true`.
   The glyph ink (`>_`) sits far from every box edge, so the quantization can't touch it.
   Validate every attempt: underscore bar must be a solid rectangle and the chevron must be
   present (headless Chrome at 40× occasionally drops opaque pixel blocks — transparent
   holes — inside the tile; re-capture until clean).
3. Render the tile as an exact vector with sharp: rounded rect 29.59375² (device 1183.75),
   rx 4 (device 160), fill `#d3fa6a`.
4. Composite the glyph layer (captured at the box origin) onto the vector tile → 1184² master.
5. Validate the master (no resampling, so it's exact): 45° diagonal probes from all four
   corners must hit the arc at 0.2929·R ±2 device px, edge extents must reach the full
   1184 canvas, and no interior holes (arc AA band exempt).
6. Center on a transparent canvas with 10% padding per side (1480²), lanczos3 to the ladder.
   Final files get coarse checks only (transparent corners, symmetric margins, solid bar) —
   lanczos leaves a ±2px halo at hard edges, so don't judge exact shape on the downscaled
   output.
