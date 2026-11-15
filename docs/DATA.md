# What we know about the SPHEREx data

Answers to the questions in `docs/PLAN.md` §2. Source: `notebooks/01_data_walkthrough.ipynb`, first run 14.11.
✅ = verified by running code, ❓ = still open.

## Access
- ✅ IRSA TAP (`Irsa.query_tap`) works. A position query takes **14-18 s, up to 108 s when IRSA is busy**.
- ✅ **Best access path: NASA's public S3 bucket** `s3://nasa-irsa-spherex/` (dr1/, qr2/, qr3/; anonymous; HTTP range requests).
  The S3 key = the part of the TAP `uri` after `spherex/`. `fits.open(key, use_fsspec=True, fsspec_kwargs={"anon": True})` +
  `h["IMAGE"].section[y0:y1, x0:x1]` gives a cutout **identical to IRSA's**, in ~3.8 s per file; **8 files in parallel took 4 s** wall time.
  No PSF table, no rate limit. Needs `fsspec` + `s3fs` (in requirements.txt). Full files are 65 MB each.
- ✅ **Fastest cutout: one raw HTTP range request** to `https://nasa-irsa-spherex.s3.amazonaws.com/<key>`. IMAGE is big-endian float32,
  2040 wide, no BZERO/BSCALE; rows y0..y1 sit at `datLoc + y*2040*4`. Rows 767-795 of the R Dra D2 file (237 KB) came back in **1.1 s**,
  and columns 1115-1143 are **identical to IRSA's cutout**. `datLoc` varies per file (25,920 or 28,800 seen), so read the first
  40 KB (0.7 s, all headers) once per file and store `datLoc` + WCS in our index. Note: `(x, y)` from `WCS.world_to_pixel` are 0-based centres; slice `[y-14:y+15, x-14:x+15]`.
- ✅ **S3 file list** (`pipeline/index/s3_keys.py`, 263 s): **1,628,230 files, 106.07 TB**. That equals IRSA's TAP total
  including the deep fields, so deep files live in the same folders. Weeks can have a `l2b_retry-…` folder next to `l2b-…`;
  retry files only fill gaps, with **0 duplicate (obs_id, detector)** pairs.
- ✅ **SIP distortion differs per file** (18-42 distinct sets per detector; A_0_0 varies ~0.5 px). Store or read it per file.
- ✅ **Use `all_world2pix` (or `world_to_pixel`)**; it matches Barnard's Star's true position to 0.1-0.45 px in 6 frames.
  The JS port (`pipeline/js/spherex.mjs`) matches astropy's all_world2pix to 6e-7 px.
- ✅ **Bug found and fixed (14.11): re-anchoring a SIP WCS on a cutout.** Editing `w.wcs.crpix` leaves `w.sip`'s own CRPIX behind,
  and frames end up misaligned by up to 1.6 px (0.68 px rms), enough to fake motion. Use `w.slice(...)`. After the fix: **0.01 px rms**
  common shift across 8 frames. In JS, compute raw detector pixels and subtract the cutout corner; never shift CRPIX.
- ✅ **Click → aligned frames: 1.7 s (2 frames), 2.1 s (8 frames)** from S3 with our index (`pipeline/quickblink.py`).
- ✅ **FULL SKY INDEX BUILT AND VALIDATED (14.11):** 1,628,230 exposures (= S3 files; every science collection's count = TAP's),
  all with S3 keys, data as of 2026-10-05; 12,288 cell files, 409 MB (median 27 KB). **15/15 lookups identical to TAP CONTAINS over
  the whole archive** (5 test targets + 10 random points; R Dra 2,493 exposures). Lookup **15-200 ms** vs TAP 11-108 s. Max footprint
  radius 2.583°, FOOT_R = 2.70. Rebuild: `harvest_obscore --all` (28 min, 8 threads) + `s3_keys --all` (4 min) + `build_index` (30 s) + `validate`.
- ✅ **Barnard's Star motion reproduced from raw NASA data** (9 frames, 3 visits, D2): visit-averaged position within **0.09-0.21 px** of the
  catalogue prediction; visit 1 → 3 motion **1.64 px measured vs 1.71 px predicted (96%), direction within 4°**. Background stars fixed to 0.03 px.
- ✅ **First blink (2 frames) for every test target: 1.4-1.65 s.** eps Ind B 458 exposures / 5 visits, WISE 0855 258 / 3, RW Aur 335 / 3, R Dra 2,493 / 16.
- ✅ **Visits near the ecliptic poles:** coverage is nearly continuous, so "gap > 30 d" never splits. Rule now: split at gaps > 30 d
  or after 30 d of length, then fold small tail stubs back in. R Dra → 16 monthly visits (good for its light curve).
- ❓ Detector choice is automatic (most common in both visits); WISE 0855 got D3, but it's brightest in D5/D6. The viewer should let the user pick.
- ✅ **IRSA's IRSA cutout corner** = `(1 - CRPIX1A, 1 - CRPIX2A)` (0-based) in a cutout header; its window isn't exactly centred on the target.
- ✅ **Archive size (14.11):** ~1.63 M files, **~106 TB** (DR1 61 TB + DR1 deep 15 TB + QR3 23 TB + QR3 deep 6 TB). DR1 covers observations
  up to 14 May 2026, QR3 after that. **QR2 is not in TAP any more**, so no release duplicates. New data: **weekly** (Thursdays), ~43k files ≈ 2.8 TB,
  3-4 weeks after observation; latest observation 5 Oct 2026, last ingestion 29 Oct. Columns for tracking: `observation.collection`,
  `plane.ipac_pub_date`, `artifact.lastmodified`, `artifact.contentchecksum`. See `docs/PLAN.md` §9.
- ✅ **IRSA rate-limits cutouts.** At 6 parallel requests most came back as the 25-byte text `Server busy, retry later.`
  (our naive code saved it as a .fits). With 3 threads + validation (`content[:6] == b"SIMPLE"`) + back-off:
  12 cutouts in 60 s with 16 retries. **Rule: validate every download, 2-3 threads, retry with back-off.**
  Working code: `notebooks/walkthrough_figures.py` → `fetch()`.
- ✅ The files are already **DR1**: URIs look like `ibe/data/spherex/dr1/level2/2025W23_2B/l2b-v27-2026-201/2/level2_..._1D2_spx_l2b-v27-2026-201.fits`.
  ❓ Are QR2/QR3 copies of the same exposure also returned (duplicates)? Check the `spherex.artifact` / `plane`
  columns (the notebook prints the schema).
- ✅ **SIMBAD TAP returned 404** on 14.11. CDS **Sesame** works and gives positions plus proper motion
  (`https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S?<name>`, follows a redirect). Use Sesame; SIMBAD is optional.
- ✅ Cutouts: one 0.05° cutout (29×29 px) = **3.9 MB, ~11 s**. Almost all of that is the **EPSF table**
  (441 rows × 1089 doubles), not the image. ❓ Can the cutout skip extensions? Not documented. Options:
  ask IRSA or test URL parameters, take bigger fields per file, parallel downloads, the AWS S3 copy. **This is the speed bottleneck.**

## Test targets (Sesame, J2000 + proper motion)
| Target | RA | Dec | PM (mas/yr) | Motion | Since J2000 |
|---|---|---|---|---|---|
| Barnard's Star | 269.45208 | +4.69336 | -801.6, +10362.4 | 10.39"/yr = 0.84 px / 6 mo | 4.5' |
| eps Ind B | 331.04415 | -56.78284 | +3982.0, -2466.8 | 4.68"/yr = 0.38 px / 6 mo | 2.0' |
| WISE 0855 | 133.81891 | -7.24705 | -8123.7, +673.2 | 8.15"/yr = 0.66 px / 6 mo | 3.5' |
| RW Aur | 76.95653 | +30.40144 | ~0 | none (variability test) | |
| R Dra | 248.16761 | +66.75498 | ~0 | none (variability test) | |

The movers shift less than 1 px per 6 months, so the blink must span the **whole baseline** (~1.4 yr ≈ 1-1.2 px for Barnard's Star).
Sub-pixel motion shows best as a centroid shift and a difference image, not as a jump. **Design the demo around that.**

## Exposures and epochs
- ✅ R Dra (near the north ecliptic pole) has ~2,500 exposures: D1 584, D2 89, D3 574, D4 584, D5 89, D6 573,
  spanning MJD 60790-61310 (**May 2025 → Oct 2026**).
- ✅ **Detectors come in pairs with identical counts** (D1/D4, D2/D5, D3/D6). SPHEREx images the same field with a
  short-wave (D1-3) and a long-wave (D4-6) array at once, so each pointing yields a D1-3 and a D4-6 frame.
- ✅ R Dra D2 exposure times cluster into **3 visits**, separated by gaps of 139 and 188 days (smaller gaps of 7-10 days inside).
  So "epoch" = a cluster of exposures, and we co-add within each epoch.

## The cutout files
- ✅ HDUs: PRIMARY, IMAGE (float32, **MJy/sr**), FLAGS (int32), VARIANCE, ZODI, EPSF (table), WCS-WAVE (table).
- ✅ DETECTOR keyword: 1-3 = SWIR, 4-6 = MWIR. Pixel ≈ 0.00170° = **6.1"**.
- ✅ **Frames are rotated relative to each other.** Two R Dra D2 exposures have CD matrices with opposite signs
  (~180° apart). So **reprojecting onto a common grid is mandatory** before blinking.
- ✅ Wavelength at the target is readable: one D2 exposure saw R Dra at **λ = 1.405 µm, Δλ = 0.034 µm**.
  ❓ How much does λ vary between exposures of the same detector? (Expected: a lot, across the whole D2 range.)
  This sets how we build light curves (match λ) and spectra (λ from every exposure).
- ⚠ astropy warns "SIP coefficients detected but CTYPE lacks -SIP". The IRSA tutorial sets `.sip = None` for the
  wavelength WCS. ❓ Check whether the *spatial* WCS should keep SIP (probably yes; just silence the warning).

## What's inside the 106 TB, and how small it can get (measured 14.11)
**One file = one ~2-minute exposure on one detector.** Each exposure makes 6 files at once (D1-D6); D1/D4, D2/D5 and D3/D6
see the same patch of sky through a beam splitter. Each detector covers ~3.5° × 3.5° (2040 px × 6.15").

| Layer in a full 65.3 MB file | Size | Unique per file? | Can shrink to |
|---|---|---|---|
| IMAGE (float32 2040²) | 16.65 MB | yes | 6.3 MB float16+zlib (science) · 2.3 MB 8-bit PNG · **0.38 MB 8-bit WebP** (viewing) |
| VARIANCE (float32) | 16.65 MB | yes | not needed for viewing; approximate from IMAGE if needed |
| ZODI (float32) | 16.65 MB | yes, but a smooth model | a 64×64 thumbnail (~16 KB) is enough |
| FLAGS (int32, already tile-compressed) | ~11 MB on disk | yes | 0.79 MB zlib (mostly zeros) |
| EPSF (PSF table) | 3.86 MB | **no: identical in every file of a detector** (one calibration file, `epsf_2_20260507`) | 6 tables total (~23 MB) instead of 6.3 TB |
| WCS-WAVE | ~1 KB | **no: identical per detector** | 6 tiny tables |

Verified by hashing the tables in 15 D2 files from June 2025 to September 2026: EPSF and WCS-WAVE identical, ZODI different every time.

**Whole archive (1.63 M files):** as delivered ~106 TB · IMAGE layers only ~27 TB · dedup + science-grade compression ~11.6 TB ·
8-bit viewing copy ~0.6 TB · **one all-sky "blink frame" per visit** at full 6.15" resolution as 8-bit WebP:
1.4×10¹⁰ sky pixels ≈ **1.3 GB per visit** (~5 GB for 3 visits including the zoom pyramid; ×6 per detector ≈ 30 GB).
Building those maps means reading ~45 TB from S3. That's realistic only on a cloud machine next to the data (AWS us-east-1),
not this weekend: a "future work" line for the pitch.

**Sky location is already indexed by NASA:** every file has its WCS and a footprint polygon (`plane.poly`) that TAP searches with `CONTAINS`.
Our own index only makes that search faster: a table of 1.63 M rows (exposure ID, time, detector, footprint centre and corners,
S3 key) is roughly **50 MB compressed** (estimate). Split it by HEALPix sky cell, and "which images cover this point" becomes a
~16 KB static-file lookup instead of a 14-108 s TAP query.

**SPHEREx all-sky HiPS (for the interface):** `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube`.
SPHEREx DR1, **all 102 colours as a cube**, PNG tiles (asinh stretch), built with Aladin's HipsGen, order 5 = **12.9" per pixel**
(half the native resolution). It's a co-add over all of DR1 (MJD 60790-61174), so it has **no time dimension**: perfect as the
"pick a point" background map, while the blink comes from our per-exposure cutouts. FITS cube tiles (512×512×102, 320 MB each)
exist for science. ❓ Maor: check that Aladin Lite v3 shows this HiPS and can switch cube frames (Firefly can).

## Anatomy of one image: everything in the headers (R Dra, D2, 2025-06-08)
Read from `cache/rdra_D2_0.fits`. Every cutout carries the same set.

**Where in the sky:** a full WCS: `RA---TAN-SIP` / `DEC--TAN-SIP` (tangent projection + 3rd-order SIP distortion),
`CRVAL` = 247.08°, +66.89°, and a PC matrix encoding a pixel of ~6.1" and the rotation. `ASTRONETSOLVED = True`,
matched against **1,678 stars** (`MATCH_NSTARS`). The planned boresight is also given in ecliptic coordinates (`SPS_ELON/ELAT`, `SPS_EPA`).
A second WCS ("A") maps back to raw detector pixels, which tells us where on the 2040×2040 detector our cutout came from.

**When:** `DATE-BEG/AVG/END` + `MJD-*` (UTC). Integration time `XPOSURE` = 113.6 s, wall time `TELAPSE` = 118.2 s.
Use `MJD-AVG` (the midpoint) as the frame time.

**From where:** the spacecraft's position and velocity, geocentric, in km and km/s, at the start, middle and end of the exposure
(`X_SC, Y_SC, Z_SC, VX_SC...`). |r| ≈ 7,000 km → ~620 km altitude, low Earth orbit at ~7.5 km/s. Plus the
ground-track lat/lon (74.4°N, 15.6°E: polar orbit) and the distance to the South Atlantic Anomaly.

**Camera / detector:** `DETECTOR` 1-6 (1-3 short-wave "SWIR", 4-6 mid-wave "MWIR"; MWIR images are flipped in X to match, `DETCOORD = sky`).
H2RG arrays, 2040×2040 active pixels, 32 readout channels, read every 1.53 s (`TSAMP`), and the slope fitted on board ("SUR").
Units **MJy/sr** (surface brightness). Pixel solid angle `OMEGA_MEDIAN` = 37.7 arcsec² (= 6.14" square).
PSF width `PSF_FWHM` = 7.5" (a star covers ~1.2 px FWHM, so it's slightly bigger than one pixel).

**Wavelength:** per-pixel wavelength + bandwidth from a lookup table (`WCS-WAVE` extension, `CTYPE*W = WAVE-TAB`).
At R Dra in this frame: 1.405 µm ± 0.034 µm.

**Quality / what went wrong in this exposure:** pass/fail checks (`L1DQAFLG`, `L2DQAFLG` = Pass), counts of flagged pixels per
problem type (persistence 10k, transients 20k, outliers 84k...), 1 satellite streak, 10 "snowballs" (cosmic-ray hits),
119 saturated bloomed sources, and whether the frame was taken during radio transmission (`OBS_IN_SBAND`).

**Backgrounds the pipeline modelled:** zodiacal light (the `ZODI` image, Kelsall 1998 model with wavelength scaling),
He-I airglow from the upper atmosphere (fitted only for D1-D2; amplitude + polynomial in the header), aurora and "shuttle glow"
correlations (0 here).

**FLAGS bits** (from `MSKN/MSKM/MSKD` in the FLAGS header, bit = 1<<n):
0 TRANSIENT · 1 OVERFLOW (saturated) · 2 SUR_ERROR · 6 NONFUNC (dead) · 7 DICHROIC (low efficiency) · 9 MISSING_DATA ·
10 HOT · 11 COLD · 12 FULLSAMPLE (info only) · 14 PHANMISS · 15 NONLINEAR · 17 PERSIST (afterglow of an earlier bright source) ·
19 OUTLIER · 20 CROSSTALK · **21 SOURCE (just "a known star is here": NOT bad; 40% of pixels!)** · 22 GHOST · 23 GHOST_FPA ·
24 GHOST_EXT · 25 STREAK (satellite) · 26 BLOOM · 27 SNOWBALL · 28 HALO.

**The other extensions:** `VARIANCE` (MJy²/sr², the noise per pixel) · `ZODI` (MJy/sr) · `EPSF`: the PSF table, see below.

### The PSF table (`EPSF`) and why each cutout is 3.9 MB
The **PSF (point spread function)** is the shape a perfect point of light, a star, takes on the detector: a small blur,
here ~7.5" wide. It changes across the detector and with wavelength, so the pipeline measures it from real stars in each exposure
and stores **a 21×21 grid of PSF models** (441 rows), each a 33×33 image oversampled ×5, with its centre, wavelength and star count.
It's needed for precise photometry (fitting the PSF to a star). It's **not needed for blinking**. Cutouts include it anyway,
which is why a 29×29-pixel cutout weighs 3.9 MB.

### What we must correct for (pipeline checklist)
| # | Effect | What we do |
|---|---|---|
| 1 | Each frame has its own rotation, flip and distortion | Reproject every frame onto one common north-up grid centred on the target (WCS with SIP) |
| 2 | Target moves (proper motion) | Predicted position at each frame's `MJD-AVG` from Sesame proper motion. Draw the predicted track; centre the field on it if the user wants to "ride along" |
| 3 | Annual parallax (Barnard's Star 0.55") | < 0.1 px, so ignore it, but say so. The spacecraft's offset from Earth's centre is negligible for stars. |
| 4 | Wavelength differs per frame (LVF) | Read λ at the target from WCS-WAVE. Blink and light-curve at **matched λ**; spectra use λ from every frame |
| 5 | Zodiacal light (+ He-I airglow in D1-D2) | Subtract `ZODI`; then subtract a local background median |
| 6 | Bad pixels | Mask by FLAGS (all bad bits; **keep SOURCE and FULLSAMPLE**) |
| 7 | Different noise per frame | Inverse-variance weights from `VARIANCE` when co-adding; SNR for display |
| 8 | Units are surface brightness | Flux = Σ pixels × `OMEGA` (sr) → Jy, for light curves and spectra |
| 9 | Display | One shared brightness stretch for all frames (otherwise the blink flickers from the stretch, not the sky) |
| 10 | **Saturation** of bright targets | ✅ Confirmed: see below. Flag frames where the target overflowed; never use them as brightness measurements |

## Findings from the walkthrough figures (14.11, `notebooks/walkthrough_figures.py`)
- ✅ **Wavelength trap is real:** 12 D2 exposures of R Dra saw it at **1.10-1.40 µm** (each ±~0.015 µm). Same detector, very different colour.
- ✅ **R Dra is saturated in D2:** in all 12 sampled exposures the pixels at the star carry OVERFLOW, and the IMAGE core is **NaN**
  (a ~5-9 px blob with BLOOM/HALO around it). With all bad pixels masked, its flux = 0. Barnard's Star is also saturated in D2
  (4-7 overflow px, NaN core). **Light curves for R Dra / RW Aur need unsaturated pixels, bands or epochs.** ❓ Check D4-D6 and minimum-light epochs.
- ✅ **Display masking ≠ photometry masking.** For pictures, mask only NONFUNC/MISSING/HOT/COLD and use an asinh stretch;
  for flux, mask everything bad. Strict masking turns bright stars into black holes.
- ✅ **Barnard's Star blink works.** 61 D2 exposures. First (2025-08-21, λ 1.10 µm) vs last (2026-09-22, λ 1.51 µm), reprojected
  onto one grid: predicted shift **11.3" ≈ 1.8 px north**. The difference image shows the halo red to the north and blue to the south,
  matching the proper motion. Caveat: different λ, so part of the difference is colour.

## Still open
- ❓ Does Barnard's Star visibly shift across the baseline after reprojecting?
- ❓ Can a browser call IRSA directly (CORS)? Is there a SPHEREx HiPS URL for Aladin Lite?
- ❓ NEOSSat coverage of any target (see `RESOURCES.md` §1)

## Solar System objects (14.11)
- ✅ JPL Horizons knows SPHEREx as observer **−163182** (`CENTER='500@-163182'`). Numbered asteroids: `COMMAND='DES=2000001;'` (bare '1' = Mercury).
  TLIST fails above ~50 times per request; send ≤ 40. Horizons sends no CORS headers (browser can't call it).
- ✅ Cadence at one spot: bursts of ~4 exposures 2.4 min apart (paired detectors simultaneous), then hours/days. Longest burst ≤ 10 frames.
- ✅ SPHEREx-centred vs geocentric: main belt < 1 px; NEOs 3-29 px. Ceres/Vesta measured 0.02-0.5 px from SPHEREx-centred prediction.
- ✅ Exposure mid-time = t_min + ~56.5 s (MJD-AVG); using exact MJD-AVG changes positions by ≤ 0.13 px even for a fast NEO.
- ✅ 2001 FD58 trails ~10 px per 113 s exposure; centroid offsets of 2-5 px are the streak, not a position error.
- Search: `pipeline/movers/find_movers.py` (11 objects ranked, `data/movers/summary.md`), `refine.py`, `mover_video.py`, `burst_sheet.py`.

## Canadian data (CSA / NEOSSat) (14.11, work Claude; code `pipeline/neossat/`, brief `docs/tasks/canada-neossat.md`)
- ✅ **SSOIS** (CADC) finds **3,699 NEOSSat images of 3I/ATLAS** (3,090 `_cord` = with celestial WCS) on 72 nights, Jul 2025 → Feb 2026
  (per month: Jul 261, Aug 483, Sep 1,024, Oct 120 (near the Sun), Nov 1,160, Dec 330, Jan 292, Feb 29). Exposures 15-120 s. Query takes 1-4 s.
  Vesta: 1 NEOSSat image (a 3I field, 2025-09-01); 2001 FD58: 1 (no WCS, 2025-06).
- ✅ **Only `MODE = '16 - FINE_POINT'` frames are usable.** `06 - ST_ACQUIRE`, `10 - ST_REACQUIRE`, slews and settles show no stars, only
  scattered-light arcs and streaks (checked visually). Of 1,072 screened candidates **690 (64%) were FINE_POINT**. SSOIS doesn't give the mode,
  but CADC honours **HTTP range requests**: the first 8.6 KB (MODE + EXPOSURE) in ~3.5 s, 457 headers in 183 s with 12 threads (`modes.py`).
- ✅ Files: 4.3 MB, ~4-12 s each; 106 files in 256 s with 6 threads, 6 retries, 0 failures. Calibrated (dark-subtracted, Jason Rowe's
  `neossat` pipeline), 1024×1020 float32, `GAIN` 1.10, **no photometric zero point** in the header. `A_EXP_S`/`DATE-OBS` = shutter open; mid = + EXPOSURE/2.
- ✅ **The header WCS is the commanded pointing, not a star fit**: CRVAL = CMDRA/CMDDEC, and it is off by **14.5 px (44″) median** (max 29 px).
  Re-fitted per image on **Gaia DR3** (ESA archive TAP `gea.esac.esa.int`, 2 s per cone; VizieR TAP timed out, IRSA's Gaia gave 502):
  affine fit on median 202 matched stars → **0.24 px rms**, scale 2.995-3.00″/px, 60/62 images solved.
- ✅ **JPL Horizons knows NEOSSat: ID −139089** (TLE trajectory since 2013). NEOSSat-centred vs geocentric positions of 3I differ by **1.2 px (3.6″) median**.
  Measured centroid vs prediction in 40 clean detections: **NEOSSat-centred 0.40 px (1.2″) median (rms 0.61 px) vs geocentric 1.24 px**;
  NEOSSat-centred closer in 31/40. 39/45 detections within 2 px.
- ✅ **Photometric zero point from Gaia:** G = ZP − 2.5 log10(counts/s), ZP **21.25 median** (20.0-21.6, from 7-340 stars per image).
  Quality rule: |ZP − median| > 0.4 or centroid > 2.5 px from prediction → frame invalid (6/60 rejected: 4 with a bright star 9 px away, 2 bad fits).
- ✅ **3I/ATLAS visible light curve (10″ aperture, G scale):** 15.96 median in Aug 2025 → **11.12 on 2025-11-10** (12 days after perihelion,
  just after solar conjunction) → 16.1 in Feb 2026: **86× brighter at peak**. 49 valid points. Measured magnitudes are **2.7 mag brighter (median)
  than Horizons' T-mag prediction** (range 1.0-3.5): Horizons' comet magnitude model is only a rough prediction for this comet.
- ✅ **NEOSSat vs SPHEREx, same 20″ aperture:** Aug 2025 NEOSSat 1.75 mJy (G → mJy with 3229 Jy) vs SPHEREx 0.7-1.0 µm 2.13 mJy; Dec 2025 59.7 vs 83.5 mJy.
  Ratio **1.21 / 1.40**; reflected sunlight predicts ≈ 1.3 (Sun's V−I = 0.7). Two independent calibrations agree.
- ✅ **SPHEREx CO₂ band:** Aug 2025, 4.15-4.45 µm **2.57 mJy (15 exposures, median)** vs 0.27 (3.9-4.15) and 0.25 (4.45-4.8): **~10× the neighbouring continuum**.
  Dec 2025: 28.3 vs 9.0 mJy on the short side (×3.1), but the long side rises too (30.6 mJy at 4.45-4.8: dust heat or CO 4.67 µm), so ×1.4 two-sided.
  Mar 2026: comet faint, CO₂ not detected. Stray high values (84th percentile up to 470 mJy) = field stars in the aperture → always use medians.
- ✅ Published: `web/lib/spherex/neossat/3i-atlas.json` (1.67 MB: 60 NEOSSat cutouts 61×61 at 3″, 28 SPHEREx frames 31×31 at 6.15″, 6 pairs ≤ 5 h apart
  on the 6.15″ grid, light curves, validation). Demo: `web/lib/spherex/demo-canada.html`.
- ✅ **Tier 2: every asteroid/comet seen by both telescopes** (`pipeline/neossat/tier2.py`, `tier2_build.py`). 277 candidates (our 11 movers,
  asteroids 1-20, 242 NEAs from JPL `cad.api` (< 0.05 AU & H < 24, or < 0.2 AU & H < 19), 10 comets of 2025-26). SSOIS (114 s, 0 errors):
  **30 have NEOSSat images** in MJD 60790-61320; sky index + Horizons (SPHEREx-centred): **all 30 are also in SPHEREx images** (18-639 each).
  NEOSSat **detects 6, all comets**: 3I/ATLAS, C/2025 A6 (Lemmon) 22/26 frames (0.52 px median offset), C/2024 E1 (Wierzchos) 16/19 (0.55 px, 3 pairs),
  C/2025 K1 (ATLAS) 9/9 (0.90 px), 210P/Christensen 7/9 (0.42 px), C/2025 R2 (SWAN) 1/4. The NEAs/asteroids fail: 4 are in usable frames but
  far too faint (predicted V 17.5-29, 0 detections, not published); 20 have no usable frame (only slews/acquisition, or raw frames without WCS:
  Vesta, Juno, Hebe, Astraea, 2001 FD58 (a raw `02 - EKF_SETTLE` frame), 2007 DB61 (33 raw)).
  Horizons needs `CAP;` for periodic comets and `CAP;NOFRAG;` for C/2025 K1 (it broke up: several records). Total published **3.8 MB** (budget 150 MB).
  Gaia (ESA TAP) timed out (HTTP 408) on 6 of ~120 tier-2 images, which were then skipped.
- ✅ **Fly-by videos (stars fixed, comet moves)** (`pipeline/neossat/flyby.py`): NEOSSat 27 Nov 2025, one 70-frame FINE_POINT sequence (all 70 usable),
  comet detected in 70/70, **0.26 px median from the NEOSSat-centred prediction vs 1.39 px geocentric**; 40 frames over 58 min on one 4.5′ grid,
  comet moves 2.1′, stars aligned to 0.25 px (Gaia). SPHEREx 14 Dec 2025, D3, 17 frames over 13 h, comet moves 38′, 3×3-binned to 18.45″ (2.6 MB).
- ❌ CADC TAP (position search) not retried for 3I: SSOIS + direct file URLs were enough.

## Exoplanet transits (feasibility, 15.11 ~16:30, not in the app)
- Doppler/RV: impossible (SPHEREx R ~40-130).
- Transits: only near the ecliptic poles, where SPHEREx observes every orbit. getLightCurve on known hot Jupiters, folded on the
  NASA Exoplanet Archive ephemeris, with a 5-sigma clip around the out-of-transit median:
  - Qatar-10 b: 1.30 +/- 0.23% (5.7 sigma; catalogue 1.93%)
  - WASP-62 b: 1.1 +/- 0.3% (3.5 sigma; catalogue 1.2%)
  - Control at a shifted phase: no signal.
- Per-exposure scatter is ~2%, and the binned folds look noisy (not a clean box). Treat it as a tentative recovery of known transits,
  good for Q&A, NOT a demo item. Scripts and plots were in the session scratchpad (exo/), not committed.
