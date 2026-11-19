# DropAlert: early and fair student dropout prediction (first 28 days)

A research project and a web app in one repository.

- **Research:** predicts who will withdraw from an Open University (OULAD) course using only the first 28 days, with
  Logistic Regression, Random Forest and LightGBM, SHAP explanations, SHAP factor-pair interactions, stability checks and a
  fairness audit. Everything is in `SDP_Early_Warning_Pipeline.ipynb`.
- **Web app (`webapp/`):** upload a student table, get students ranked High / Medium / Low by calibrated dropout risk, and see
  why (single factors and factor pairs). It runs the project's own three models. Nothing is simulated.

Study test results (held-out students, 95% intervals in `outputs/tables/table1_test_metrics_ci.csv`):

| Model | Accuracy | Precision | Recall | F1 | ROC-AUC |
|---|---|---|---|---|---|
| Logistic Regression | 0.669 | 0.313 | 0.608 | 0.414 | 0.694 |
| Random Forest | 0.636 | 0.298 | 0.662 | 0.411 | 0.698 |
| LightGBM | 0.686 | 0.323 | 0.580 | 0.415 | 0.705 |

## Quick start

Needs Python 3.11 or newer (tested on 3.11).

Windows: double-click `run.bat`, or in a terminal from this folder:

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
cd webapp
python app.py
```

macOS / Linux: `./run.sh`. Then open **http://127.0.0.1:8000**. The first start takes about 20 seconds.
On the Overview page click **Try the project's held-out students** to see it work without a file.

## What is in this folder

| Path | What it is |
|---|---|
| `webapp/` | The app. `app.py` (FastAPI backend), `engine.py` (scoring and SHAP), `schema.py` (column matching and validation), `core.py` (the notebook's features and models), `train.py`, `build.py`, `static/` (dashboard front end), `artifacts/bundle.joblib` (the three trained models), `artifacts/research.json`. Details in `webapp/README.md`. |
| `SDP_Early_Warning_Pipeline.ipynb` | The research notebook, raw tables to every table and figure. |
| `SDP_Early_Warning_Pipeline_executed.ipynb` | The same notebook with saved outputs. |
| `outputs/tables/`, `outputs/figures/` | Every result table (CSV) and figure (PNG). `key_numbers.json` holds the headline numbers. |
| `outputs/cache/features_by_cutoff.csv` | Day 7, 14 and 28 features built from the 454 MB click file. With it, that file is not needed. |
| `data/` | The small OULAD tables. `studentVle.csv` (454 MB) is not included. |
| `Project_Report.docx` | The written report. |
| `requirements.txt` | App dependencies, pinned to the versions the models were built with. |
| `requirements-notebook.txt` | Extra packages only for re-running the notebook (`pip install -r requirements-notebook.txt`). |

## How the app stays honest

- The three models are the project's. `python train.py` (in `webapp/`) rebuilds them from the cached features with the
  notebook's split, class weights, Platt calibration and thresholds, and reproduces the study's test ROC-AUCs exactly
  (0.6938, 0.6980, 0.7051).
- Risks, rankings, SHAP values and metrics all come from model output on the uploaded rows. If your file has the outcome
  column, live metrics are computed on it; if not, the app says so and shows only the study's results.
- An upload must contain the 15 model inputs (the Upload page lists them). Column names need not match; you confirm the
  mapping. An unmapped input blocks prediction. Rows with a blank or unreadable value, or a module outside AAA-GGG, are
  excluded and counted. The app never fills in values.
- Compatibility is not assumed. A table from another institution can be scored, but the models were trained on OULAD
  and the scores are not validated for it.
- Explanations always come from LightGBM (exact TreeSHAP). The other two models' risks are shown but not explained.

## Limits

Runs locally only. The "raw OULAD tables" panel on the Upload page is experimental (not run on the full click file).
The risk bands are a choice: High is the study's F1-optimal threshold for the selected model, Medium is half of it.
This is a research tool, not a basis for decisions about individual students.
