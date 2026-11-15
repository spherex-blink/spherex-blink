# Build plan (draft, 14.11 morning)

Status: **proposal**. Change it freely. The milestone dates match `docs/stages/`.

## 1. The one design decision that matters: a "bundle" between backend and viewers

The Python side turns a sky position into a **bundle**: a folder holding `manifest.json` plus PNG frames
(and small JSON files for light curves and spectra). Every viewer only reads bundles:
the 2D blink viewer, the Aladin panel, and later the VR mode on Maor's Quest 3.

Why:
- **We can work in parallel.** Once the bundle format is agreed (`docs/BUNDLE_FORMAT.md`, written in Phase 0),
  the viewer can be built against a fake bundle while the pipeline is still being written.
- **Offline demo.** The five test targets are baked into bundles ahead of time, so judging never
  waits on IRSA or the venue Wi-Fi.
- **Cheap hosting.** Pre-baked bundles are static files, so they can be served from any HTTPS static host.
  A live mode for any RA/Dec adds one small backend endpoint that returns the same bundle.
- **VR comes almost free.** three.js loads the same PNGs as textures, and the same manifest drives the blink.

## 2. Phase 0: walk through the data together (first, ~2 h, before the kickoff)

Neither of us has looked at SPHEREx data yet, and several facts below change the design.
We do this **together**, on one screen, in a notebook: `notebooks/01_data_walkthrough.ipynb`.
The answers go into `docs/DATA.md`.

**Setup:** done on Daniel's laptop (`docs/SETUP.md`). The notebook already ran once end to end (14.11),
and its first answers are in `docs/DATA.md`. The big ones:
- frames are rotated up to 180° relative to each other, so reprojection is mandatory
- the movers shift less than 1 px per 6 months, so the blink must span the whole ~1.4-year baseline and use difference images
- each 29×29 cutout is 3.9 MB because of the PSF table, so downloading is the bottleneck

The walkthrough together is now about *understanding* these, not discovering them from scratch.

**Steps, following the IRSA tutorials** (https://caltech-ipac.github.io/irsa-tutorials/spherex/):
1. Run the intro tutorial and the cutouts tutorial as written.
2. Point the same query at our targets. Start with **R Draconis**: bright, slow-moving, and near the north ecliptic
   pole, where SPHEREx revisits often. Then **Barnard's Star**.
3. Open one cutout and look at every HDU: IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE.
4. Blink two cutouts by hand in matplotlib. That's the core of the product, done crudely.

**Questions we must answer (each becomes a line in `DATA.md`):**
- [ ] How many exposures per target, per detector? Over what time span? Do they cluster into "visits"
      we can call epochs (roughly every 6 months, with many more near the ecliptic poles)?
- [ ] Releases: how to tell QR2 / QR3 / DR1 apart in the tables, and how to keep only DR1 + QR3
- [ ] Orientation: is each exposure rotated differently on the sky? (Probably yes.) If so,
      every frame has to be **reprojected onto one common grid** before blinking, or the stars dance.
- [ ] **Wavelength trap:** each exposure sees our target at a different wavelength (linear variable filter).
      So two frames from the same detector can differ in brightness just because the wavelength differs,
      not because the star changed. How big is that effect? How do we compare like with like?
      (This is the key Validity point for RW Aur and R Dra.)
- [ ] Units, pixel scale (~6.2"), and what ZODI subtraction looks like in practice
- [ ] FLAGS: which bits matter (saturation, cosmic rays, ...), and how to show them
- [ ] Speed: TAP query time, cutout size in KB, download time, and how many parallel downloads IRSA tolerates
- [ ] Proper motion: SIMBAD positions and proper motions for all five targets, and the predicted shift per epoch
      in pixels. Is Barnard's Star's motion visible? (~10"/yr against 6.2" pixels: yes, over a year.)
- [ ] Can a browser call IRSA directly (CORS)? Is there a SPHEREx HiPS we can show in Aladin Lite?
- [ ] Gaia DR3 for the overlay: via Aladin Lite's built-in catalogs, or a query of our own?

**Done when** `DATA.md` answers these, and we've agreed `BUNDLE_FORMAT.md` and the roles below.

## 3. Architecture

```
pipeline/        Python (owner: backend)
  resolve.py     name or RA/Dec → position, with proper motion applied per epoch (SIMBAD)
  query.py       IRSA TAP → list of exposures (cached as JSON)
  fetch.py       parallel cutout download, disk cache keyed by exposure + size
  process.py     ZODI subtract, mask flags, reproject to a common grid, group into epochs,
                 co-add per epoch per detector, stretch → PNG
  measure.py     flux at the target in every exposure → light curve; wavelength from WCS-WAVE → spectrum
  bake.py        CLI: python -m pipeline.bake "Barnard's Star" --fov 4 → web/data/<slug>/
  server.py      (later) FastAPI: /api/bundle?ra=&dec=&fov= runs the same code live

web/             static HTML + JS, no build step (owner: front end)
  index.html     search box (name or RA/Dec), buttons for the five test targets
  player.js      blink state: frames, current index, speed, detector, difference mode.
                 Pure logic with no DOM, so the VR mode can reuse it.
  view2d.js      canvas blink viewer, frame slider, dates, metadata and flags panel
  sky.js         Aladin Lite: context image, Gaia overlay, target marker and its motion track
  charts.js      light curve and spectrum (small charting library from a CDN)
  vr.js          (later) WebXR scene with three.js
  data/<slug>/   baked bundles
```

URL state: `?target=` or `?ra=&dec=`, plus `&fov=&det=&mode=`. That makes every view linkable and embeddable.

## 4. Roles (proposal, to confirm)

| | Daniel (team leader) | Maor |
|---|---|---|
| Owns | `pipeline/`, `notebooks/`, `docs/DATA.md` | `web/` incl. VR, `docs/BUNDLE_FORMAT.md` (agreed jointly) |
| Also | emails, coordinator, 16:00 summary | deck, demo script |
| Together | Phase 0 walkthrough, pitch rehearsal, submission | |

Swap if Maor is the stronger Python person. The point is that each of us owns separate folders,
so we (and our Claudes) never edit the same files.

## 5. Milestones

| By | Milestone | Done when |
|---|---|---|
| Sat ~18:30 | **M0 data understood** | `DATA.md` answered, bundle format agreed, environment works on both laptops |
| Sat night | **M1 first blink** | `bake.py` produces a real bundle for one target, and the viewer plays it in the browser. All five targets baked on both laptops. |
| Sun 11:00 | **M2 core app** | All five targets play. Frames aligned and dated, detector selector, URL state. Barnard's Star visibly moves. |
| Sun 15:30 | **M3 extras** | As many of the list below as fit, in this order |
| Sun 16:30 | **Feature freeze** | Bug fixes only after this |

**M3 extras, by priority** (revisit at the 11:00 checkpoint):
1. Difference mode (each frame minus a reference epoch). Movers show up as black/white pairs.
2. Light curve for RW Aur and R Dra, comparing at matched wavelengths
3. Spectrum on the fly at the target position (the 102-band showpiece)
4. Aladin Lite panel with a Gaia DR3 overlay and the proper-motion track
5. Metadata and flags panel / overlay
6. Field-of-view slider plus a live query for any RA/Dec (needs the backend running)
7. **VR mode** (below)
8. CSA angle: NEOSSat or CADC data cross-match, for the CSA-data prize

## 6. VR on the Quest 3 (after M2; keep the path open now)

**Idea:** a "VR" button (three.js `VRButton`, WebXR) in the same web app. Inside, the blink frames hang
on a large panel in front of you, or wrap onto the sky around you. A controller trigger steps epochs,
and the light curve or spectrum floats beside the panel. It runs in the Quest Browser, so there's no app to install.

**What this means now:**
- Frames are plain PNGs and the manifest is plain JSON, so three.js can use them directly. ✔ (bundle design)
- `player.js` holds the blink state with no DOM code, so 2D and VR share it. ✔ (architecture)
- three.js loads from a CDN with an import map, so no build step. ✔
- **WebXR needs HTTPS** (or `localhost`). For testing on the Quest, either:
  - host the static site on **Firebase Hosting** (free via the Google Cloud Global Offer, HTTPS by default;
    see §8), or
  - USB + `adb reverse tcp:8000 tcp:8000` with the Quest in developer mode, then open `http://localhost:8000`.
- **De-risk tonight with 15 minutes on the Quest:** open a three.js WebXR example page in the Quest Browser,
  check that "Enter VR" works, then try our own hosting path with a hello-world page.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Venue Wi-Fi / IRSA slow during judging | Pre-baked bundles on both laptops; Ethernet cable |
| Frames rotated relative to each other → stars "dance" | Reproject onto a common grid (`reproject`) |
| Brightness changes caused by wavelength, not variability | Compare at matched wavelengths; say so in the pitch (a Validity point) |
| Few epochs for some targets | Show what exists honestly; R Dra near the ecliptic pole has many |
| Epsilon Indi B lost in the glare of Epsilon Indi A | Show it honestly; difference images help |
| Hosting not ready | The local demo is the default; hosting is a bonus |
| Cutout downloads slow (3.9 MB each, ~11 s, mostly the PSF table) | **Solved:** read cutouts straight from NASA's public S3 bucket (§9): 8 in 4 s, no PSF table, no rate limit. IRSA cutouts stay as the fallback. |
| Sub-pixel motion hard to see | Blink the first vs. last epoch, difference images, mark the predicted track |

## 8. Hosting and free tools (Space Apps Global Offers, see `docs/RESOURCES.md` §5)
**DECIDED 14.11: GitHub Pages at https://spherex-blink.github.io/** (org `spherex-blink`, public repo `spherex-blink.github.io` holding only
the deploy workflow). It checks out this private repo with a read-only deploy key, copies `web/` + the sky index (`/index/`), and deploys:
hourly (app), daily 02:41 UTC (index refresh from NASA), or by hand. The first run is seeded from the release `seed`. Chosen over Firebase
(360 MB/day cap) and Cloudflare (new account): no new account, 100 GB/month, HTTPS for WebXR, github.io rarely blocked. Firebase notes below kept for reference.

- **Firebase Hosting (free Spark plan, no card)** for the static site (`web/` + baked bundles), with HTTPS so VR works on the Quest.
  Limits: 10 GB stored, **360 MB/day transferred**. A bundle is ~1-3 MB, so that's 100+ target views a day, plenty for judging.
- **Cloud Run** (Google Cloud; needs the card-verified $300 trial) only for the live "any RA/Dec" backend. Same Google project as Firebase.
- **GoDaddy offer → a free domain** pointed at Firebase, for a memorable URL in the pitch. Optional, late Sunday morning.
- Azure is the fallback if Google's offer stalls. Miro is optional, for the pitch storyboard.
- Credits for the README and deck: the SPHEREx acknowledgement sentence from the IRSA page, plus Gaia DR3 and CDS (Aladin, Sesame).

## 9. Data freshness: supporting new NASA data (decided 14.11, measured numbers)
NASA's nice-to-have #1: "new data arrives fast, so make updating to new releases easy".

**Can we mirror all SPHEREx data on our own hosting? No.** Measured from IRSA's own tables on 14.11:

| Collection | Files | Size | Observed |
|---|---|---|---|
| spherex_dr1 | 945,725 | 61.4 TB | May 2025 → 14 May 2026 |
| spherex_dr1_deep (ecliptic-pole deep fields) | 233,681 | 15.4 TB | same |
| spherex_qr3 | 362,124 | 23.5 TB | 14 May 2026 → 5 Oct 2026 |
| spherex_qr3_deep | 86,700 | 5.7 TB | same |
| **Total** | **~1.63 M** | **~106 TB** | each file ~65 MB (one detector, one exposure) |

Growth: **one ingestion per week** (Thursdays: 15, 22, 29 Oct), ~43,000 files ≈ **2.8 TB/week**, published 3-4 weeks after
observation. Storing 106 TB would cost ~$2,000/month even in cheap cloud storage (free tiers are 5-10 GB), and downloading it would take weeks.
QR2 is no longer in the tables: TAP returns only DR1 + QR3, so we don't need to de-duplicate releases ourselves.

**We don't need to mirror it, because NASA already hosts it in the cloud.** The full archive is in the public AWS bucket
`s3://nasa-irsa-spherex/` (`dr1/`, `qr2/`, `qr3/`), with no login. astropy reads **only the pixels we need** from a 65 MB file
(`fits.open(url, use_fsspec=True, fsspec_kwargs={"anon": True})` + `.section[...]`). Measured: **8 cutouts in 4 s** with 8 threads,
identical to IRSA's cutout, without the 3.8 MB PSF table and without the "server busy" rate limit.
So "running from storage" is already possible; that storage is NASA's.

**Architecture: store what we make, not what NASA has**
1. **Raw data stays at NASA** (S3 bucket, with the IRSA cutout service as fallback). We cache raw cutouts only temporarily on the machine that builds.
2. **We store processed bundles** (aligned PNG frames + manifest + light-curve/spectrum JSON, ~1-3 MB per target) on **Firebase Hosting**.
   That's what users load, so it's fast, free and independent of IRSA's load during the demo.
3. **Every bundle's manifest records its provenance:** the list of exposure IDs used, their collection (`spherex_dr1`, `spherex_qr3`...),
   the pipeline file version (`l2b-v27-...`), and "data as of" = the newest observation date. The viewer shows that line.
4. **Daily updater** (GitHub Actions cron: free, no card, runs our Python):
   for each featured target, one TAP query (~20 s) → compare exposure IDs with the manifest → if new ones exist, fetch **only the new**
   cutouts from S3, rebuild that bundle, `firebase deploy`. Daily is cheap and catches the weekly ingestion within a day.
   **A new release (DR2) is handled by the same path:** the query is release-agnostic, newer collections replace older copies
   of the same observation ID, and the manifest records which release each frame came from.
5. **Any RA/Dec on demand:** the same `bake` code runs behind one endpoint (Cloud Run, or our laptop for the demo).
   It reads from S3 in ~1 min for a few hundred frames, then caches the bundle so the next visitor gets it instantly.

**The four layers, from biggest to smallest, and who hosts each** (sizes in `docs/DATA.md`)
| Layer | What | Hosted by | Size for us |
|---|---|---|---|
| Sky picker | SPHEREx all-sky HiPS (102 colours) shown in Aladin Lite; the user zooms and clicks a point | NASA/IRSA | 0 |
| Index | Our table of all 1.63 M exposures, split by HEALPix cell → instant "which images cover this point" | Firebase (static files) | ~50 MB |
| Pixels | Cutouts read on demand from S3, aligned, stacked per visit → a bundle; cached after the first request | NASA S3 → our backend | 0 raw; ~1-3 MB per bundle |
| Featured | Pre-baked bundles for the five test targets + a few showpieces, so the demo never waits | Firebase | ~10-30 MB |
The daily updater appends new exposures to the index and rebuilds featured bundles that gained frames.
Future (pitch): pre-computed all-sky blink maps per visit (~5 GB as WebP HiPS), built in the cloud next to NASA's data.

## 10b. UPDATE 14.11 afternoon: the browser can do it all, no backend needed (measured)
- **NASA's S3 bucket sends `Access-Control-Allow-Origin: *` and allows `Range`**, so the web page itself can read SPHEREx pixels.
  (IRSA's TAP and cutout services send no CORS headers, so a browser can't call them directly.)
- **Our sky index replaces TAP:** `pipeline/index/` (harvest → S3 keys → HEALPix order-5 cell files + `meta.json`).
  Test on 43k exposures: **10/10 points identical to IRSA's TAP `CONTAINS`** (centres, just inside and just outside footprint corners,
  empty sky), in **~20 ms instead of 11-37 s**. Full archive: ~415 MB static JSON (~100 MB gzipped), ~24 small cell files (~200 KB) per lookup.
- **Per-file WCS can't be pre-stored cheaply:** the SIP distortion differs per file (1.8 KB of header facts per file → 2.9 GB for all).
  So at click time the browser reads each chosen file's first 40 KB (headers, ~0.5 s) and then the rows (~0.4 s). Measured in Python:
  32 headers + 32 cutouts in **2.0 s** wall time with 16 in parallel.
- **Position accuracy:** distortion must be applied (`all_world2pix`): Barnard's Star lands within **0.1-0.45 px** of prediction in 6 frames;
  without SIP (`wcs_world2pix`) it's **1-3.9 px off**, which would fake motion. The JS library must match all_world2pix.
- **Result:** a fully static site (Firebase free tier) can blink **any point in the sky** from live NASA data. A backend (Cloud Run)
  becomes optional (heavy stacking or spectra). New NASA data needs only an index refresh, no re-hosting of pixels.

## 10. Speed plan: from click to blink in ~2 s (measured building blocks, 14.11)
Today, naively: TAP query 14-108 s + IRSA cutouts ~5 s each with rate limiting → **minutes**. Target: **first blink in ~2 s, full bundle in ~5-10 s.**

**Prepared in advance (offline):**
1. **Exposure index** (all ~1.63 M files, ~50 MB): exposure ID, time, detector, collection, S3 key, footprint, **visit ID**, split by HEALPix sky cell.
   Replaces the TAP query: ~0.1 s instead of 14-108 s. Bulk-harvested from TAP once, then appended daily.
2. **Per-file header facts** in the same index: the sky mapping (WCS + distortion, ~40 numbers) and the **byte offset of the IMAGE data**.
   Measured: offsets differ between files (25,920 or 28,800 bytes), so they must be stored. With them, a cutout is **one ~240 KB
   S3 range request, ~1 s, identical to IRSA's cutout**. Harvesting needs the first 40 KB of every file (0.7 s each, ~65 GB for the whole sky):
   do it now for the featured regions, lazily (first visit fills it in) for the rest, and for the whole sky as a cloud job later.
3. **The 6 per-detector calibration tables** (wavelength map, PSF), identical in every file → stored once. Then we can compute
   **the wavelength each frame sees at the clicked point before downloading anything**, and pick wavelength-matched frames up front.
4. **Featured bundles, pre-baked:** the five test targets + a "tour" of famous movers and variables (nearby brown dwarfs, high
   proper-motion stars, Miras) drawn as markers on the sky. Most clicks in a demo land on these: **instant**.
5. **Background map:** NASA's SPHEREx all-sky HiPS (zero work for us).
6. Future: per-visit all-sky blink HiPS (~5 GB) → every point instant, like scrolling a map.

**At click time:**
- **Pick few frames, smartly:** per visit and detector, the 1-3 best exposures (wavelength-matched, target well inside the detector,
  no saturation), not all ~600. Usually 10-40 range reads.
- **Progressive:** fetch the first and last visit first → **first blink at ~1.5-2 s**, then the remaining frames, difference image and spectrum stream in.
- **Parallel range reads** (16-32 at once; S3 doesn't push back like IRSA's cutout service).
- **Ship small float16 arrays, not PNGs, and draw in the browser** (WebGL canvas): stretch, blink speed and difference are then instant
  with no server round-trip, and the VR view reuses the same arrays.
- **Cache by HEALPix cell:** snap clicks to a cell and fetch a slightly larger field, so neighbouring clicks and repeat visitors hit the cache.
- **Server close to the data:** Cloud Run in **us-east4** (Virginia, next to AWS us-east-1 where the bucket is), min-instances 1 (no cold start).
- **Prefetch:** when the user zooms in below ~1°, start loading that area's index cell and first/last-visit frames before the click.

**Firebase or Google Cloud?** Both: Firebase *is* a front door to Google Cloud, the same project. Firebase Hosting (free, no card)
serves the site and bundles. Google Cloud Run is only for step 5 and needs billing (the $300 trial). For step 4, GitHub Actions is
simpler and free; Cloud Scheduler + a Cloud Run job is the all-Google alternative if we enable billing anyway.

**For the pitch:** "New SPHEREx data lands every Thursday. Our site checks NASA daily and rebuilds only what changed;
a new data release needs no code change, and every frame says which release it came from."
