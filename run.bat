@echo off
rem DropAlert launcher (Windows). Run from the project root. Opens http://127.0.0.1:8000
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Creating virtual environment...
  python -m venv .venv || (echo Python 3.11 or newer is required. & pause & exit /b 1)
  .venv\Scripts\python -m pip install -r requirements.txt || (echo Install failed. & pause & exit /b 1)
)
cd webapp
if not exist artifacts\bundle.joblib ..\.venv\Scripts\python train.py
start "" http://127.0.0.1:8000
..\.venv\Scripts\python app.py
