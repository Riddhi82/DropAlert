#!/usr/bin/env bash
# DropAlert launcher (macOS / Linux). Run from the project root. Open http://127.0.0.1:8000
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install -r requirements.txt
fi
cd webapp
[ -f artifacts/bundle.joblib ] || ../.venv/bin/python train.py
../.venv/bin/python app.py
