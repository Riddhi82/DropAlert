"""Rebuild the trained models and the research summary for DropAlert from the project's cached features.

    python train.py

Reads  ../outputs/cache/features_by_cutoff.csv and ../outputs/tables/*.csv
Writes artifacts/bundle.joblib, artifacts/demo_cohort.csv, artifacts/research.json

The split, features, model settings, Platt calibration and F1 thresholds are the notebook's, so the
numbers printed at the end should match outputs/tables/key_numbers.json.
"""
import itertools
import json
import time
import warnings
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from scipy.stats import spearmanr  # noqa: F401  (kept for parity with the notebook)
from sklearn.metrics import brier_score_loss, confusion_matrix, precision_recall_curve, roc_auc_score, roc_curve
from sklearn.model_selection import GroupShuffleSplit, StratifiedGroupKFold

import core
from core import (CORR_LIMIT, MAIN_CUTOFF, MODEL_NAMES, MODULES, NUMERIC, N_FOLDS, SEED, TEST_SIZE, Platt,
                  best_f1_threshold, make_cohort, make_model, make_X, six_metrics, spw_of)

warnings.filterwarnings("ignore")
HERE = Path(__file__).parent
PROJECT = HERE.parent
ART = HERE / "artifacts"
ART.mkdir(exist_ok=True)

t0 = time.time()
feat = pd.read_csv(PROJECT / "outputs" / "cache" / "features_by_cutoff.csv")
df = make_cohort(feat, MAIN_CUTOFF)
print("Risk set:", df.shape, f"dropout rate {df['y'].mean():.3%}")

tr_pos, te_pos = next(GroupShuffleSplit(1, test_size=TEST_SIZE, random_state=SEED).split(df, df["y"], groups=df["id_student"]))
train, test = df.iloc[tr_pos].reset_index(drop=True), df.iloc[te_pos].reset_index(drop=True)

# ---- feature pruning on training students only (same rule as the notebook) ----
X_all_train = make_X(train)
eng = ["clicks_total", "active_days", "clicks_prestart", "first_access_day", "days_since_last_access", "click_trend",
       "clicks_forum", "n_submitted"]
rho = X_all_train[eng].corr(method="spearman").abs()
dropped = []
for a, b in itertools.combinations(eng, 2):
    if a in dropped or b in dropped:
        continue
    if rho.loc[a, b] > CORR_LIMIT:
        auc_a = abs(roc_auc_score(train["y"], X_all_train[a]) - 0.5)
        auc_b = abs(roc_auc_score(train["y"], X_all_train[b]) - 0.5)
        dropped.append(b if auc_a >= auc_b else a)
FEATURES = [c for c in X_all_train.columns if c not in dropped]
VARIABLES = list(dict.fromkeys(core.var_of(c) for c in FEATURES))
X_train, X_test = make_X(train, FEATURES), make_X(test, FEATURES)
y_train, y_test = train["y"], test["y"]
g_train = train["id_student"]
print(f"{len(FEATURES)} model inputs, dropped for correlation: {dropped or 'none'}")

cv = StratifiedGroupKFold(n_splits=N_FOLDS, shuffle=True, random_state=SEED)
FOLDS = list(cv.split(X_train, y_train, groups=g_train))

models, platts, thrs, p_test, p_test_raw = {}, {}, {}, {}, {}
for name in MODEL_NAMES:
    t1 = time.time()
    oof = np.zeros(len(X_train))
    for tr, va in FOLDS:
        m = make_model(name, SEED, spw_of(y_train.iloc[tr])).fit(X_train.iloc[tr], y_train.iloc[tr])
        oof[va] = m.predict_proba(X_train.iloc[va])[:, 1]
    platt = Platt().fit(oof, y_train.values)
    thr = best_f1_threshold(y_train.values, platt.transform(oof))
    final = make_model(name, SEED, spw_of(y_train)).fit(X_train, y_train)
    p_raw = final.predict_proba(X_test)[:, 1]
    models[name], platts[name], thrs[name] = final, platt, thr
    p_test_raw[name], p_test[name] = p_raw, platt.transform(p_raw)
    print(f"  {name}: threshold {thr:.3f}, test ROC-AUC {roc_auc_score(y_test, p_test[name]):.4f} ({time.time() - t1:.0f}s)")

# ---- compare with the notebook's saved numbers ----
key = json.load(open(PROJECT / "outputs" / "tables" / "key_numbers.json"))
assert FEATURES == key["features"], "feature list differs from the notebook"
print("\nReproduction check (this run vs notebook key_numbers.json):")
ok = True
for name in MODEL_NAMES:
    mine = six_metrics(y_test.values, p_test[name], thrs[name])["ROC-AUC"]
    ref = key["test_metrics"][name]["ROC-AUC"]
    diff = abs(mine - ref)
    ok &= diff < 0.01
    print(f"  {name:20s} ROC-AUC {mine:.4f} vs {ref:.4f}  (diff {diff:.4f})   threshold {thrs[name]:.3f} vs {key['thresholds'][name]:.3f}")
if not ok:
    print("  WARNING: differs from the notebook by more than 0.01 AUC (library versions can cause small shifts).")

# ---- what the app needs to validate uploads ----
train_nan = X_train.isna().any()
nan_ok = [c for c in NUMERIC if bool(train_nan.get(c, False))]
ranges = {c: [float(X_train[c].quantile(0.001)), float(X_train[c].quantile(0.999)), float(X_train[c].min()), float(X_train[c].max())]
          for c in NUMERIC}
joblib.dump(dict(models=models, platts=platts, thr=thrs, FEATURES=FEATURES, VARIABLES=VARIABLES, NUMERIC=NUMERIC,
                 MODULES=MODULES, nan_ok=nan_ok, ranges=ranges, base_rate=float(y_train.mean()),
                 n_train=int(len(train))), ART / "bundle.joblib", compress=3)
print("nan allowed (missing in training):", nan_ok)

# ---- demo cohort: the held-out test students, in a plain 'user-style' layout ----
demo = test[["id_student", "code_module", "code_presentation"] + NUMERIC +
            ["gender", "age_band", "imd_band", "imd_group", "final_result"]].copy()
demo.to_csv(ART / "demo_cohort.csv", index=False)

# ---- curves and tables for the research pages ----
def thin(a, b, n=140):
    idx = np.unique(np.linspace(0, len(a) - 1, n).astype(int))
    return [[round(float(a[i]), 4), round(float(b[i]), 4)] for i in idx]

curves = {}
yv = y_test.values
for name in MODEL_NAMES:
    p = p_test[name]
    fpr, tpr, _ = roc_curve(yv, p)
    pr, rc, _ = precision_recall_curve(yv, p)
    edges = np.quantile(p, np.linspace(0, 1, 11))
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, 9)
    tn, fp, fn, tp = confusion_matrix(yv, (p >= thrs[name]).astype(int)).ravel()
    curves[name] = dict(roc=thin(fpr, tpr), pr=thin(rc, pr), calib=[[round(float(p[idx == b].mean()), 4), round(float(yv[idx == b].mean()), 4)] for b in range(10)],
                        confusion=dict(tn=int(tn), fp=int(fp), fn=int(fn), tp=int(tp)),
                        brier=float(brier_score_loss(yv, p)), threshold=float(thrs[name]))

def read_table(name):
    t = pd.read_csv(PROJECT / "outputs" / "tables" / f"{name}.csv")
    if t.columns[0].startswith("Unnamed"):
        t = t.rename(columns={t.columns[0]: "name"})
    return json.loads(t.to_json(orient="records"))

tables = {n: read_table(n) for n in [
    "table1_test_metrics_ci", "table2_confusion", "table3_ranking", "table3b_paired_auc", "table4_shap_importance",
    "table5_local_explanations", "table6_top_interactions", "table7_main_vs_interaction", "table8_added_value",
    "table9_stability_summary", "table10_core_pairs", "table11_auc_by_setting", "table12_fairness_groups",
    "table13_fairness_gaps", "table13b_gender_gap_within_modules", "table14_interaction_by_group",
    "table15_ranking_by_group", "table16_sensitivity", "table17_objective_checklist"]}

research = dict(key=key, curves=curves, tables=tables, test_n=int(len(test)), test_prevalence=float(yv.mean()),
                train_n=int(len(train)))
json.dump(research, open(ART / "research.json", "w"), default=float)
print(f"\nDone in {time.time() - t0:.0f}s. Artifacts in {ART}")
