# README art sources

Everything under `assets/` is rendered from these files with a headless Chromium browser (Edge or Chrome) at 2× scale.

| Output | Source |
|---|---|
| `hero.{zh,en}.png` | `hero.html?lang=zh|en` at 1280×800, cropped to 1280×720 |
| `gate.{zh,en}.png`, `admission.{zh,en}.png` | `diagrams.html?d=gate|admit&lang=zh|en` at 1280×720, cropped to 1280×640 |
| `screenshots/*.png` | `page.html?lang=zh|en&tab=0..4` (add `&dialog=1` for the archive dialog) |
| `flood.{zh,en}.webp` | `flood.html?lang=zh|en` (Three.js), 18 s loop rendered by `flood-capture.py` at 20 fps, encoded at 800 px / 12 fps |

The flood animation uses the headworks discharge table of the *Sichuan Dujiangyan Irrigation District Engineering Handbook* (1993) (Min River 1000 / 2000 / 4000 / 5500 m³/s split into inner and outer river, Bottle-Neck and Flying Sand Weir), interpolated between rows. Water levels follow the broad-crested weir formula Q = 1.7·L·H^1.5 (L = 240 m, crest about 2 m above the inner riverbed) and the wide-channel Manning relation; the terrain is schematic with vertical exaggeration.

```bash
npm i --no-save three@0.170.0
python assets/src/flood-capture.py en frames_en
ffmpeg -framerate 20 -i frames_en/f%04d.png -vf "fps=12,scale=800:-1:flags=lanczos" -c:v libwebp -quality 60 -compression_level 6 -loop 0 assets/flood.en.webp
```

The screenshots render the **real** panel component (`src/client/ReviewPage.tsx`) with demo data from `panel-demo.tsx`:

```bash
npm i --no-save react@19 react-dom@19
npx esbuild assets/src/panel-demo.tsx --bundle --minify --jsx=automatic --define:process.env.NODE_ENV='"production"' --outfile=assets/src/panel-demo.js
msedge --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=1280,800 \
  --screenshot=overview.png "file:///<repo>/assets/src/page.html?lang=en&tab=0"
```
