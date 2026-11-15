# web/ : the SPHEREx Blink app

Static files, no build step, no backend. Published automatically to https://spherex-blink.github.io/ from `main`.

**Run locally:** double-click `start.bat` (Windows). It starts a static server and opens http://localhost:8000.
Any static server works too: `python -m http.server 8000` inside `web/`.

| File | What |
|---|---|
| `index.html`, `style.css`, `app.js` | the app (Maor) |
| `lib/spherex/` | **Daniel's data layer. Do not edit here.** |
| `vendor/` | three.js 0.160 (MIT), VRButton |
| `assets/allsky_17.jpg` | one colour of NASA's SPHEREx all-sky map, so the sky dome works offline |
| `USER_GUIDE.pdf` | user guide (Hebrew) |

URL parameters: `?target=barnard`, `?ra=..&dec=..`, `?explore=..`, `?walkthrough=1`. Written with the help of Claude (AI).
