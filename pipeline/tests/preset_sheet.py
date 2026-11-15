"""Visual check of the demo presets: first/last frame + difference for each target, as the demo shows them.
Usage: .venv/Scripts/python -m pipeline.tests.preset_sheet out.png [detector overrides like wise0855=5]
Written with Claude Code.
"""
import sys
import warnings
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pipeline.quickblink import quick_blink
from pipeline.index.lookup import SkyIndex

warnings.simplefilter("ignore")
T = {  # same coordinates / proper motions Sesame returns for the demo's preset names
    "barnard": ("Barnard's Star", 269.4520769586, 4.6933649666, (-801.551, 10362.394)),
    "epsindB": ("Epsilon Indi B", 331.04415, -56.78284, (3982.0, -2466.8)),
    "wise0855": ("WISE 0855", 133.81891, -7.24705, (-8123.7, 673.2)),
    "rwaur": ("RW Aurigae", 76.95653, 30.40144, (7.2, -20.3)),
    "rdra": ("R Draconis", 248.16761, 66.75498, (-20.643, 6.149)),
}


def stretch_all(frames):
    imgs = [f["image"] - np.nanmedian(f["image"]) for f in frames]
    allv = np.concatenate([i[np.isfinite(i)] for i in imgs])
    lo, hi = np.percentile(allv, [1, 99.5])
    return [np.arcsinh(np.clip((i - lo) / (hi - lo), 0, 1) * 10) / np.arcsinh(10) for i in imgs], imgs


def stack_by_visit(r, how):
    """Combine the frames of each visit into one (median, or mean after 3-sigma clipping per pixel)."""
    out = []
    for a, b, _ in r["visits"]:
        fs = [f for f in r["frames"] if a <= f["t"] <= b + 1e-6]
        if not fs:
            continue
        cube = np.array([f["image"] - np.nanmedian(f["image"]) for f in fs])
        if how == "median":
            img = np.nanmedian(cube, axis=0)
        else:
            med = np.nanmedian(cube, axis=0); mad = np.nanmedian(np.abs(cube - med), axis=0) * 1.4826 + 1e-6
            img = np.nanmean(np.where(np.abs(cube - med) < 3 * mad, cube, np.nan), axis=0)
        out.append(dict(fs[0], image=img.astype(np.float32), date=f"{fs[0]['date']} (x{len(fs)})",
                        target_px=tuple(np.mean([f["target_px"] for f in fs], axis=0))))
    return dict(r, frames=out)


def main(out, overrides, stack=0, how="median"):
    idx = SkyIndex()
    rows = []
    for slug, (name, ra, dec, pm) in T.items():
        det = overrides.get(slug, None)
        r = quick_blink(ra, dec, pm=pm, half=30, which="ends", detector=det, index=idx, per_visit=max(1, stack))
        if stack:
            r = stack_by_visit(r, how)
        rows.append((slug, name, r))
    fig, ax = plt.subplots(len(rows), 3, figsize=(9, 3.1 * len(rows)))
    cmap = matplotlib.colormaps["gray"].copy(); cmap.set_bad((1, 0, 0.78))
    for k, (slug, name, r) in enumerate(rows):
        fr = r["frames"]
        st, raw = stretch_all(fr)
        for j in range(2):
            a = ax[k, j]; a.imshow(np.ma.masked_invalid(st[j]), origin="lower", cmap=cmap, vmin=0, vmax=1, interpolation="nearest")
            tx, ty = fr[j]["target_px"]; a.plot(tx, ty, "+", color="#4fc3f7", ms=14, mew=1.2)
            a.set_title(f"{name} D{fr[j]['det']} {fr[j]['date']}", fontsize=8); a.set_xticks([]); a.set_yticks([])
        d = raw[1] - raw[0]; s = np.nanpercentile(np.abs(d), 99.5)
        cm2 = matplotlib.colormaps["RdBu_r"].copy(); cm2.set_bad((0.22, 1, 0.08))
        a = ax[k, 2]; a.imshow(np.ma.masked_invalid(d), origin="lower", cmap=cm2, vmin=-s, vmax=s, interpolation="nearest")
        for j in range(2):
            tx, ty = fr[j]["target_px"]; a.plot(tx, ty, "+", color=["#2ca02c", "#ff7f0e"][j], ms=14, mew=1.2)
        a.set_title("last − first", fontsize=8); a.set_xticks([]); a.set_yticks([])
        # numbers: target brightness above background in a 3x3 box, per frame
        vals = []
        for j in range(2):
            tx, ty = (int(round(v)) for v in fr[j]["target_px"])
            box = raw[j][ty - 1:ty + 2, tx - 1:tx + 2]
            noise = np.nanmedian(np.abs(raw[j] - np.nanmedian(raw[j]))) * 1.4826 * 3   # robust: noise in a 3x3 sum
            vals.append((float(np.nansum(box)), float(np.isnan(box).sum()), float(noise)))
        print(f"{name:15s} D{r['detector']}: target 3x3 sum {vals[0][0]:9.1f} / {vals[1][0]:9.1f} MJy/sr, NaN px {vals[0][1]:.0f}/{vals[1][1]:.0f}, "
              f"frame noise {vals[0][2]:.1f}; shift {np.hypot(*np.subtract(fr[1]['target_px'], fr[0]['target_px'])):.2f} px")
    plt.tight_layout(); plt.savefig(out, dpi=70)


if __name__ == "__main__":
    args = sys.argv[2:]
    stack = int(next((a.split("=")[1] for a in args if a.startswith("stack=")), 0))
    how = next((a.split("=")[1] for a in args if a.startswith("how=")), "median")
    ov = dict(a.split("=") for a in args if not a.startswith(("stack=", "how=")))
    main(sys.argv[1], {k: int(v) for k, v in ov.items()}, stack, how)
