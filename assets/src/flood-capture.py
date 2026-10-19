# Renders assets/src/flood.html frame by frame:  python assets/src/flood-capture.py <zh|en> <out_dir> [fps]
# Needs `pip install playwright` + `playwright install chromium`, and `npm i --no-save three@0.170.0`.
# Files are served from the repository root through a Playwright route, so no web server is needed.
import pathlib, sys
from playwright.sync_api import sync_playwright

lang, out = sys.argv[1], pathlib.Path(sys.argv[2])
fps = int(sys.argv[3]) if len(sys.argv) > 3 else 20
root = pathlib.Path(__file__).resolve().parents[2]
out.mkdir(parents=True, exist_ok=True)


def serve(route):
    rel = route.request.url.split('://repo.local/', 1)[1].split('?')[0]
    f = (root / rel).resolve()
    ct = 'text/html' if f.suffix == '.html' else 'text/javascript' if f.suffix == '.js' else 'application/octet-stream'
    route.fulfill(status=200, body=f.read_bytes(), headers={'content-type': ct + '; charset=utf-8'})


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1280, 'height': 720})
    pg.route('http://repo.local/**', serve)
    pg.goto(f'http://repo.local/assets/src/flood.html?lang={lang}&capture=1')
    pg.wait_for_function('window.ready === true', timeout=120000)
    T = pg.evaluate('window.T')
    for i in range(int(T * fps)):
        pg.evaluate(f'window.renderAt({i / fps})')
        pg.screenshot(path=str(out / f'f{i:04d}.png'))
    b.close()
