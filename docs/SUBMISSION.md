# SPHEREx Blink: NASA Space Apps Challenge 2026 submission

**Team:** Halal Haemek (Space Valley), Haifa: Daniel Turgeman (team leader) and Maor Buzaglo.
**Challenge:** [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)
**Live app:** https://spherex-blink.github.io/ · **Demo video (30 s):** [`media/spherex-blink-30s.mp4`](../media/spherex-blink-30s.mp4)
**Local result:** 3rd place, NASA Space Apps Haifa 2026.

## Summary
SPHEREx Blink lets anyone hunt for Planet X, hidden brown dwarfs and new comets in NASA's newest infrared sky survey,
right in the browser. NASA's SPHEREx maps the whole sky every six months in 102 infrared colours, and its archive already
holds 1.6 million images. Objects that move or change only reveal themselves when images from different times are
compared, but there was no public tool to blink SPHEREx images. Click any point of the sky and within about two seconds
you see a video of that spot across every SPHEREx visit, aligned to 0.01 pixel and read straight from NASA's archive with
no server, so new data appears automatically. Built-in discovery tools take you from a click to a candidate: a difference
view, a detection filter, motion measurement, shift-and-stack deep stacks for movers too faint for single images, light
curves and spectra, asteroid and comet positions, and shareable links. It also runs on a sky dome and in any VR headset.
On NASA's test targets the tools reproduce Barnard's Star's motion (96% of the catalogue value), reveal the brown dwarf
WISE 0855, and recover R Draconis's 239-day cycle. With Canada's NEOSSat data we show the interstellar comet 3I/ATLAS
crossing the stars in one hour, together with SPHEREx.

## How it works
- **No server, always current:** an index of all 1.63 million SPHEREx images (results identical to NASA's own IRSA
  search, in 15-200 ms instead of up to ~100 s). The browser reads only the pixels it needs straight from NASA's public
  archive, and the index refreshes daily, so new data releases appear automatically.
- **Honest pixels:** every frame is aligned to 0.01 pixel using each image's full distortion model; each frame shows its
  detector and wavelength; exposures are stacked per visit to remove cosmic rays; saturated cores are shown as "no data".
- **Built-in discovery tools:** difference view; a detection filter (above a chosen threshold, or only what changed);
  motion measurement from the pixels; shift-and-stack deep stacks; light curves and spectra from the 102 colours; an
  asteroid and comet mode with positions as seen from SPHEREx (JPL Horizons); saved points and shareable links.
- **Three ways to look:** a 2D view, a sky dome, and VR on any WebXR headset.

## Results on NASA's test targets (measured from raw NASA data)
| Target | What the tool measures |
|---|---|
| Barnard's Star | motion reproduced to 96% of the catalogue value |
| WISE 0855 | invisible in single images; a stack of 45 exposures detects it (S/N ~11) |
| R Draconis | 239-day pulsation (published ~245 days), although it saturates the detector |
| RW Aurigae | 40% fainter at 4-5 µm within a year |
| Epsilon Indi B | steady, as expected (control) |
| All stars | brightness within ~3% of NASA's WISE catalogue |

## Canadian Space Agency data
Canada's NEOSSat took 3,699 images of the interstellar comet 3I/ATLAS, one every 1.7 minutes, so in our tool you watch
the comet cross the stars in one hour. On one timeline we show it in visible light (NEOSSat) and infrared (SPHEREx),
predict its position to 1.2″ using NEOSSat's own orbit, and measure it brightening 86× near the Sun. Of 277 asteroids and
comets we searched, 30 were imaged by both telescopes.

## Tools
Python (Astropy, astroquery, reproject, NumPy) for the pipeline and validation; a dependency-free JavaScript data layer,
tested against the Python reference; three.js and WebXR for the sky dome and VR; GitHub Pages hosting. MIT license.

## Data and references
- NASA SPHEREx data, NASA/IPAC IRSA: https://irsa.ipac.caltech.edu/Missions/spherex.html
- SPHEREx public archive on AWS: https://nasa-irsa-spherex.s3.amazonaws.com/
- SPHEREx all-sky HiPS maps (IRSA): https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube
- IRSA TAP service: https://irsa.ipac.caltech.edu/TAP · IRSA SPHEREx tutorials: https://caltech-ipac.github.io/irsa-tutorials/spherex/
- JPL Horizons: https://ssd.jpl.nasa.gov/horizons/ · JPL SSD Close Approach API: https://ssd-api.jpl.nasa.gov/cad.api
- NASA WISE/AllWISE at IRSA: https://irsa.ipac.caltech.edu/Missions/wise.html
- CSA NEOSSat via the Canadian Astronomy Data Centre: https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/
- ESA Gaia DR3: https://gea.esac.esa.int/archive/ · CDS Sesame/SIMBAD: https://cds.unistra.fr/
- three.js (MIT)

## Use of AI
The code, data pipeline and documentation were written with the help of Anthropic's Claude (Claude Code). The astronaut
cow mascot art in the app is AI-generated (Google Gemini). The idea, design decisions and scientific checks are the team's.
The demo video's background music was generated from code by the team's tools (no samples, no copyrighted material).
