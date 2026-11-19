"""Shared pipeline pieces for DropAlert.

Everything here mirrors the project notebook (SDP_Early_Warning_Pipeline.ipynb) so the web app scores
students with exactly the same features, models, calibration and thresholds as the study.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, average_precision_score, f1_score, precision_recall_curve,
                             precision_score, recall_score, roc_auc_score)
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import FunctionTransformer, StandardScaler

# ----------------------------------------------------------------------------- settings (same as notebook)
KEYS = ["id_student", "code_module", "code_presentation"]
MAIN_CUTOFF = 28
SEED = 42
TEST_SIZE = 0.20
N_FOLDS = 5
CORR_LIMIT = 0.90
TOP_K = 10
CORE_SHARE = 0.80

EDU_ORDER = ["No Formal quals", "Lower Than A Level", "A Level or Equivalent", "HE Qualification",
             "Post Graduate Qualification"]
IMD_LEVELS = ["0-10%", "10-20%", "20-30%", "30-40%", "40-50%", "50-60%", "60-70%", "70-80%", "80-90%", "90-100%"]
IMD_GROUPS = {"Most deprived (0-30%)": ["0-10%", "10-20%", "20-30%"],
              "Middle (30-70%)": ["30-40%", "40-50%", "50-60%", "60-70%"],
              "Least deprived (70-100%)": ["70-80%", "80-90%", "90-100%"]}
NUMERIC = ["clicks_total", "active_days", "clicks_prestart", "first_access_day", "days_since_last_access",
           "click_trend", "clicks_forum", "n_submitted", "date_registration", "num_of_prev_attempts",
           "studied_credits", "edu_ord", "imd_ord", "disability_bin"]
MODULES = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"]
MODEL_NAMES = ["Logistic Regression", "Random Forest", "LightGBM"]
METRICS = ["Accuracy", "Precision", "Recall", "F1", "ROC-AUC", "PR-AUC"]

LGB_PARAMS = dict(n_estimators=300, learning_rate=0.03, num_leaves=15, max_depth=4, min_child_samples=40,
                  subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=5.0)
RF_PARAMS = dict(n_estimators=300, max_depth=8, min_samples_leaf=20, class_weight="balanced_subsample")


# ----------------------------------------------------------------------------- cohort and design matrix
def make_cohort(frame: pd.DataFrame, cutoff: int = MAIN_CUTOFF) -> pd.DataFrame:
    """Risk set: students still registered at the cut-off day (as in the notebook)."""
    d = frame[frame["cutoff"] == cutoff].copy()
    keep = (d["date_unregistration"].isna() | (d["date_unregistration"] > cutoff)) & \
           (d["date_registration"].isna() | (d["date_registration"] <= cutoff))
    d = d[keep]
    d["y"] = (d["final_result"] == "Withdrawn").astype(int)
    d["pres"] = d["code_module"] + "-" + d["code_presentation"]
    d["year"] = d["code_presentation"].str[:4]
    imd_group = {b: g for g, bands in IMD_GROUPS.items() for b in bands}
    d["imd_group"] = d["imd_band"].map(imd_group).fillna("Unknown")
    return d.reset_index(drop=True)


def make_X(frame: pd.DataFrame, cols: list[str] | None = None) -> pd.DataFrame:
    X = frame[NUMERIC].astype(float).copy()
    for m in MODULES:
        X["module_" + m] = (frame["code_module"] == m).astype(int)
    return X if cols is None else X[cols]


def var_of(col: str) -> str:
    return "code_module" if col.startswith("module_") else col


# ----------------------------------------------------------------------------- models
def signed_log1p(x):
    return np.sign(x) * np.log1p(np.abs(x))


def make_model(name: str, seed: int, spw: float, **over):
    if name == "Logistic Regression":
        return make_pipeline(SimpleImputer(strategy="median"), FunctionTransformer(signed_log1p), StandardScaler(),
                             LogisticRegression(max_iter=2000, class_weight="balanced"))
    if name == "Random Forest":
        return make_pipeline(SimpleImputer(strategy="median"),
                             RandomForestClassifier(**{**RF_PARAMS, **over}, n_jobs=-1, random_state=seed))
    params = {**LGB_PARAMS, **over}
    return LGBMClassifier(**params, scale_pos_weight=spw, random_state=seed, verbose=-1, n_jobs=-1)


def spw_of(y) -> float:
    y = np.asarray(y)
    return (y == 0).sum() / max((y == 1).sum(), 1)


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p)).reshape(-1, 1)


class Platt:
    """Monotone probability calibration (does not change ROC-AUC)."""

    def fit(self, p, y):
        self.m = LogisticRegression(C=1e6).fit(logit(p), y)
        return self

    def transform(self, p):
        return self.m.predict_proba(logit(p))[:, 1]


def best_f1_threshold(y, p) -> float:
    pr, rc, th = precision_recall_curve(y, p)
    return float(th[np.argmax((2 * pr * rc / (pr + rc + 1e-12))[:-1])])


def six_metrics(y, p, thr) -> dict:
    pred = (p >= thr).astype(int)
    return {"Accuracy": accuracy_score(y, pred), "Precision": precision_score(y, pred, zero_division=0),
            "Recall": recall_score(y, pred, zero_division=0), "F1": f1_score(y, pred, zero_division=0),
            "ROC-AUC": roc_auc_score(y, p), "PR-AUC": average_precision_score(y, p)}


# ----------------------------------------------------------------------------- SHAP helpers
def shap_pos(values):
    """Different SHAP versions return different shapes; keep the 'dropout = 1' values (rows, features)."""
    if isinstance(values, list):
        values = values[1]
    values = np.asarray(values)
    return values[..., 1] if values.ndim == 3 else values


def interaction_pos(values):
    v = np.asarray(values[1] if isinstance(values, list) else values)
    return v[..., 1] if v.ndim == 4 else v
