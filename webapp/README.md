# DropAlert: web app for the SDP early-warning project

Upload a table of students, get them ranked High, Medium, Low by calibrated dropout risk, and see why:
single factors, factor pairs (SHAP interactions) and how reliable those pairs are.

It runs the project's own pipeline, not demo models. `train.py` rebuilds the three models from
`../outputs/cache/features_by_cutoff.csv` with the notebook's split, features, class weights, Platt calibration and
thresholds. The test ROC-AUCs it reproduces match `key_numbers.json` exactly (0.6938, 0.6980, 0.7051).

## Run

From the project root (one level up from this folder): `run.bat` on Windows, `./run.sh` on macOS/Linux. Or by hand:

```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python
cd webapp
..\.venv\Scripts\python app.py                              # then open http://127.0.0.1:8000
```
The first start takes about 20 s (SHAP loads). `artifacts/bundle.joblib` (the three trained models) ships with the project.
`python train.py` rebuilds it from the notebook's cached features in about 20 s and should print the same test ROC-AUCs.

## Pages

| Page | What it does |
|---|---|
| Overview | KPIs, risk distribution, band table (predicted vs observed), highest-risk students, risk by module, model agreement |
| Upload & schema | CSV/Excel upload, automatic column matching (by name and by values) with dropdown corrections, validation report |
| Risk ranking | Search, filter, sort, adjustable High/Medium cut-offs, three-model comparison per student, CSV download |
| Student | SHAP waterfall (percentage points), the student's strongest factor pairs, all three models, actual outcome if known |
| Why: single factors | Mean absolute SHAP with 95% intervals, direction, beeswarm, module effect |
| Why: factor pairs | The novelty page: ranked pairs, resampling stability and the study's retraining stability side by side, heat map, dependence plot, same-ranking-inside-each-module check |
| Model performance | Study test-set metrics with intervals and curves; live metrics, threshold slider, confusion matrix and calibration on your data if it has an outcome |
| Fairness check | Selection rate, recall, false-alarm rate by group, equalised-odds gap with permutation p-value |
| Study results | Every notebook result (objectives O1-O5, added value of interactions, stability, sensitivity, figures) |
| Limits & method | What the tool is, and where not to trust it |

## What the upload must contain

One row per student (or student-course) with the 15 inputs, built over days 0-28 as in the notebook (see the Upload page for
each input's meaning). Names do not have to match. The app never fills in or guesses:

- an unmapped input blocks prediction;
- a blank or unreadable value in an input excludes that row, and the count is shown (blank is allowed only for
  `date_registration` and `imd_ord`, the two inputs that had blanks in training);
- a course module other than AAA-GGG is excluded (the models have never seen it);
- values far outside the training range, or a window longer than 28 days, produce a warning.

The 450 MB click table is not uploaded through the browser; the notebook builds the 28-day features from it once
(`outputs/cache/features_by_cutoff.csv`).

## Design decisions worth knowing

- Explanations always come from LightGBM (exact TreeSHAP). Logistic Regression and Random Forest risks are shown and can drive
  the ranking, but they are not explained separately.
- Risk bands are a choice: High = the study's F1-optimal threshold for the selected model, Medium = half of it. Sliders change them,
  and the Overview shows how often each band really dropped out when outcomes are known.
- Two kinds of pair stability are shown and kept apart. Resampling the explained students is high by construction. The study's
  retraining check (seeds 0.69, course presentations 0.36 top-10 overlap, chance 0.05) is the stronger and more cautious evidence.
- Uploaded files stay in the server's memory only. Nothing is written to disk or sent anywhere.

## Known limits

- **Raw OULAD panel is experimental.** Its feature logic was checked against the notebook (non-click columns identical; click
  features matched an independent calculation on synthetic clicks) but it has not been run on the real 450 MB `studentVle.csv`.
  It copies a notebook quirk: students with no click in days 0-28 get 0 for n_submitted, clicks_forum, click_trend and
  clicks_prestart. The models learned that; changing it needs retraining.
- **Only OULAD-style inputs work.** The models were trained on these 15 inputs from days 0-28 of an OULAD course. A table from
  another institution can be uploaded and mapped, but its scores are not validated for that population.
- Runs locally only; not deployed. Uploads are held in memory and never written to disk.
