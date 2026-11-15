# Setup (Windows, tested 14.11 on Daniel's laptop)

We use **Python 3.12** in a repo-local `.venv`. The system Python may be 3.14, and some astro packages lag behind.

```powershell
# 1. uv (fast Python/package manager), installed once into the system Python
python -m pip install --user uv

# 2. Python 3.12 + venv in the repo root
python -m uv python install 3.12
python -m uv venv --python 3.12 .venv
#   If uv fails with "Missing expected target directory for Python minor version link"
#   (happened on Daniel's laptop), create the venv from the downloaded interpreter directly:
#   & "$env:APPDATA\uv\python\cpython-3.12.16-windows-x86_64-none\python.exe" -m venv .venv

# 3. Packages (pinned)
python -m uv pip install --python .venv\Scripts\python.exe -r requirements.txt

# 4. Notebook
.venv\Scripts\jupyter lab      # open notebooks/01_data_walkthrough.ipynb
```

Notes:
- Downloaded cutouts go to `cache/` (git-ignored). Each cutout is ~4 MB.
- SIMBAD's TAP endpoint was down (404) on 14.11. Use CDS Sesame for names and proper motions (see the notebook).
- `www.spaceappschallenge.org` fails TLS verification from command-line tools on Daniel's laptop. Read it in the browser.
