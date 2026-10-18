# README art sources

Everything under `assets/` is rendered from these files with a headless Chromium browser (Edge or Chrome) at 2× scale.

| Output | Source |
|---|---|
| `hero.{zh,en}.png` | `hero.html?lang=zh|en` at 1280×800, cropped to 1280×720 |
| `gate.{zh,en}.png`, `admission.{zh,en}.png` | `diagrams.html?d=gate|admit&lang=zh|en` at 1280×720, cropped to 1280×640 |
| `screenshots/*.png` | `page.html?lang=zh|en&tab=0..4` (add `&dialog=1` for the archive dialog) |

The screenshots render the **real** panel component (`src/client/ReviewPage.tsx`) with demo data from `panel-demo.tsx`:

```bash
npm i --no-save react@19 react-dom@19
npx esbuild assets/src/panel-demo.tsx --bundle --minify --jsx=automatic --define:process.env.NODE_ENV='"production"' --outfile=assets/src/panel-demo.js
msedge --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=1280,800 \
  --screenshot=overview.png "file:///<repo>/assets/src/page.html?lang=en&tab=0"
```
