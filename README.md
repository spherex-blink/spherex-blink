# SPHEREx Blink

**Team Halal Haemek (חלל העמק), NASA Space Apps Challenge 2026, Haifa (Technion).**
Daniel Turgeman (team leader) and Maor Buzaglo. Powered by Space Valley.
Challenge: [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)

**Live app: https://spherex-blink.github.io/** · **30-second demo video: [media/spherex-blink-30s.mp4](media/spherex-blink-30s.mp4)**

With SPHEREx Blink, anyone with a browser can hunt for a Planet X, a hidden brown dwarf or a new comet in NASA's newest
infrared sky survey, with the discovery tools built in. Project texts for the judges: [docs/SUBMISSION.md](docs/SUBMISSION.md).

## What it does
Pick any spot in the sky (click the all-sky map, type a name or RA/Dec) and within about two seconds you see a
"blink" video of that spot across all of NASA SPHEREx's visits, so moving and varying objects stand out.
The browser reads only the pixels it needs straight from NASA's public archive (no server), using an index of all
1.63 million SPHEREx images that refreshes daily, so new data releases appear automatically.

- **Blink and compare:** frames aligned to 0.01 pixel with each image's full distortion model; every frame shows
  its detector (D1-D6) and wavelength; saturated cores are shown as "no data"; difference view.
- **Sky dome and VR:** a 3D infrared sky you can look around, also in VR on any WebXR headset (tested on Meta Quest 3).
- **Asteroid and comet mode:** positions computed as seen from SPHEREx itself (JPL Horizons).
- **Light curves and spectra** on the fly from SPHEREx's 102 colours.
- **Deep stack:** stacks many exposures to reveal objects invisible in single images, optionally following a
  target's motion ("shift-and-stack").
- **Canadian NEOSSat data:** Canada's NEOSSat images of the interstellar comet 3I/ATLAS shown with SPHEREx on one timeline.
- **Guided walkthrough:** a ~1-minute self-playing tour (welcome screen, menu, or `?walkthrough=1`).
- Shareable links with the coordinates in the URL.

## NASA's test targets: what we found (from the raw NASA data)
- **Barnard's Star:** its motion reproduced to 96% of the catalogue value (1.64 px measured vs 1.71 px predicted), direction within 4°.
- **WISE 0855:** invisible in every single image; a deep stack of 45 exposures detects it at signal-to-noise ~11
  (11.6 when the stack follows its motion, 11.0 for the normal stars-aligned stack).
- **R Draconis:** pulsation period 239 days (published ~245), even though the star saturates the detector.
- **RW Aurigae:** variable, 40% fainter at 4-5 µm over one year.
- **Epsilon Indi B** (and Barnard's Star): steady, as expected.
- Our brightness measurements agree with NASA's WISE catalogue to about 3%.
- **3I/ATLAS (NEOSSat):** 3,699 NEOSSat images; position predicted to 1.2″ using NEOSSat's own orbit; 86× brightening near the Sun.

Detections are candidates, not discoveries. Details: [`docs/SUBMISSION.md`](docs/SUBMISSION.md), [`docs/DATA.md`](docs/DATA.md).

## Run locally
Static site, no build step, no backend:
```
cd web
python -m http.server 8000
```
then open http://localhost:8000 (on Windows you can double-click `web/start.bat`). VR needs HTTPS, so use the live site on the headset.

## Repository layout
| Path | What |
|---|---|
| `web/` | the app (HTML/JS, three.js for the sky dome and VR) |
| `web/lib/spherex/` | the dependency-free JavaScript data layer (archive index, cutouts, alignment, light curves, NEOSSat) |
| `pipeline/` | Python data pipeline and validation (astropy, astroquery, reproject): index, photometry, light curves, movers, NEOSSat, HiPS mirror |
| `notebooks/` | exploration notebooks |
| `docs/` | submission texts (`SUBMISSION.md`), data findings (`DATA.md`), build plan, setup |
| `media/` | the 30-second demo video |

## Use of AI
The code, data pipeline and documentation were written with the help of Anthropic's Claude (Claude Code).
The astronaut cow mascot art is AI-generated (Google Gemini). The team designed, directed, reviewed and tested the work.
Scientific results were checked against catalogues and independent data, for example Barnard's Star's motion against
its catalogue proper motion, our photometry against NASA's WISE catalogue (~3%), our archive index against NASA's own
IRSA search (identical results), and NEOSSat comet positions against JPL Horizons predictions.

## Credits and data
- NASA SPHEREx data: NASA/JPL-Caltech/IPAC, via the IRSA archive and its public S3 bucket; SPHEREx all-sky HiPS map (IRSA).
- JPL Horizons (NASA/JPL) for asteroid and comet positions.
- CDS Sesame name resolver (CDS, Strasbourg).
- ESA Gaia DR3 (European Space Agency, Gaia mission, processed by DPAC).
- NEOSSat data courtesy of the Canadian Space Agency (CSA), via the Canadian Astronomy Data Centre (CADC, NRC Canada);
  SSOIS by CADC. Contains information licensed under the Open Government Licence – Canada.
- three.js (MIT License, see `web/vendor/LICENSE`).

## License
The team's own code is released under the [MIT License](LICENSE). Third-party data and libraries listed above keep
their own terms.
