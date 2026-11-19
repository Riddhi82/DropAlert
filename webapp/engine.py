"""Scoring, SHAP, interaction stability, performance and fairness for an uploaded dataset."""
from __future__ import annotations

import itertools
import threading
import uuid
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.metrics import (average_precision_score, confusion_matrix, precision_recall_curve, roc_auc_score,
                             roc_curve)

import core
from core import CORE_SHARE, MODEL_NAMES, NUMERIC, SEED, TOP_K, make_X, six_metrics
from schema import SPEC, SPECS, parse_column

MIN_POS = 30


# ----------------------------------------------------------------------------- session
@dataclass
class Session:
    sid: str
    filename: str
    raw: pd.DataFrame
    mapping: dict = field(default_factory=dict)
    opts: dict = field(default_factory=dict)
    # filled by predict
    valid_pos: np.ndarray | None = None         # positions in raw of rows that were scored
    X: pd.DataFrame | None = None
    parsed: pd.DataFrame | None = None
    report: dict = field(default_factory=dict)
    probs: dict = field(default_factory=dict)   # model -> calibrated risk
    y: np.ndarray | None = None
    contrib: np.ndarray | None = None           # variable-level SHAP (log-odds), LightGBM
    base_margin: float = 0.0
    explain: dict = field(default_factory=lambda: dict(status="idle", progress=0.0, error=None))
    ex: dict = field(default_factory=dict)      # interaction results
    lock: threading.Lock = field(default_factory=threading.Lock)


def new_sid() -> str:
    return uuid.uuid4().hex[:12]


# ----------------------------------------------------------------------------- validation and scoring
def validate(raw: pd.DataFrame, mapping: dict, bundle: dict) -> tuple[np.ndarray, pd.DataFrame, dict]:
    """Parse the mapped columns. Returns (valid mask, parsed frame, report). Nothing is imputed or guessed."""
    missing_specs = [s["name"] for s in SPECS if not mapping.get(s["name"])]
    if missing_specs:
        raise ValueError("Prediction is blocked. These model inputs are not mapped to a column: " + ", ".join(missing_specs))
    cols = [mapping[s["name"]] for s in SPECS]
    if len(set(cols)) != len(cols):
        dup = sorted({c for c in cols if cols.count(c) > 1})
        raise ValueError("The same column is mapped to more than one input: " + ", ".join(dup))
    for c in cols:
        if c not in raw.columns:
            raise ValueError(f"Column '{c}' is not in the file.")

    parsed = pd.DataFrame(index=raw.index)
    ok = pd.Series(True, index=raw.index)
    per_input, warnings = [], []
    for s in SPECS:
        name = s["name"]
        v, miss, bad = parse_column(raw[mapping[name]], s["kind"], name)
        parsed[name] = v
        allow_missing = name in bundle["nan_ok"]
        excl = bad | (miss & (not allow_missing))
        ok &= ~excl
        info = dict(input=name, label=s["label"], column=mapping[name], missing=int(miss.sum()), invalid=int(bad.sum()),
                    excluded=int(excl.sum()), missing_allowed=bool(allow_missing))
        if s["kind"] != "category":
            lo, hi = bundle["ranges"][name][2], bundle["ranges"][name][3]
            vv = pd.to_numeric(v, errors="coerce")
            out = int(((vv < lo) | (vv > hi)).sum())
            info["outside_training_range"] = out
            if out > 0.05 * max(1, len(raw)):
                warnings.append(f"{s['label']}: {out:,} values ({out / len(raw):.0%}) fall outside the range seen in training ({lo:g} to {hi:g}).")
        per_input.append(info)

    if "active_days" in parsed and parsed["active_days"].max() > 29:
        warnings.append("Active days goes above 29, so these features may not use the first-28-day window the models were trained on.")
    if "first_access_day" in parsed and parsed["first_access_day"].max() > 40:
        warnings.append("First access day goes well beyond day 29; check that the features cover days 0-28 only.")

    report = dict(rows_uploaded=int(len(raw)), rows_scored=int(ok.sum()), rows_excluded=int((~ok).sum()),
                  per_input=per_input, warnings=warnings)
    return ok.values, parsed, report


def score(sess: Session, bundle: dict) -> None:
    ok = sess.valid_pos
    frame = sess.parsed.iloc[np.where(ok)[0]].copy()
    frame["code_module"] = frame["code_module"].astype(str)
    X = make_X(frame, bundle["FEATURES"])
    X.index = np.arange(len(X))
    sess.X = X
    for name in MODEL_NAMES:
        raw_p = bundle["models"][name].predict_proba(X)[:, 1]
        sess.probs[name] = bundle["platts"][name].transform(raw_p)
    # first-order SHAP from LightGBM's native TreeSHAP (log-odds), merged to one value per variable
    contrib = bundle["models"]["LightGBM"].predict(X, pred_contrib=True)
    sess.base_margin = float(contrib[0, -1])
    feats = bundle["FEATURES"]
    var_names = bundle["VARIABLES"]
    cm = np.zeros((len(X), len(var_names)))
    for j, c in enumerate(feats):
        cm[:, var_names.index(core.var_of(c))] += contrib[:, j]
    sess.contrib = cm


# ----------------------------------------------------------------------------- helpers
def bands(p: np.ndarray, high: float, med: float) -> np.ndarray:
    return np.where(p >= high, "High", np.where(p >= med, "Medium", "Low"))


def default_cuts(bundle: dict, model: str) -> tuple[float, float]:
    t = float(bundle["thr"][model])
    return t, t / 2


def var_values(sess: Session, bundle: dict) -> pd.DataFrame:
    """One raw value per original variable (module as text) for the scored rows."""
    p = sess.parsed.iloc[np.where(sess.valid_pos)[0]].reset_index(drop=True)
    return p[bundle["VARIABLES"]]


def margin_to_p(margin, platt) -> float:
    raw = 1 / (1 + np.exp(-margin))
    return float(platt.transform(np.array([raw]))[0])


# ----------------------------------------------------------------------------- global explanation job
def run_explain(sess: Session, bundle: dict, max_rows: int = 1500, n_boot: int = 200) -> None:
    import shap
    try:
        with sess.lock:
            sess.explain.update(status="running", progress=0.05, error=None)
        n = len(sess.X)
        rng = np.random.default_rng(SEED)
        idx = np.sort(rng.choice(n, size=min(max_rows, n), replace=False))
        Xs = sess.X.iloc[idx]
        model = bundle["models"]["LightGBM"]
        expl = shap.TreeExplainer(model)
        chunks = np.array_split(np.arange(len(Xs)), 6)
        parts = []
        for k, ch in enumerate(chunks):
            if len(ch):
                parts.append(core.interaction_pos(expl.shap_interaction_values(Xs.iloc[ch])))
            with sess.lock:
                sess.explain["progress"] = 0.1 + 0.7 * (k + 1) / len(chunks)
        iv = np.concatenate(parts, axis=0)

        feats, V = bundle["FEATURES"], bundle["VARIABLES"]
        col_idx = {v: [i for i, c in enumerate(feats) if core.var_of(c) == v] for v in V}
        pairs = list(itertools.combinations(V, 2))
        P = np.zeros((len(Xs), len(pairs)))              # signed pair effect per student
        for k, (a, b) in enumerate(pairs):
            P[:, k] = 2 * iv[:, col_idx[a]][:, :, col_idx[b]].sum(axis=(1, 2))
        main = np.stack([iv[:, col_idx[v]][:, :, col_idx[v]].sum(axis=(1, 2)) for v in V], axis=1)
        absP = np.abs(P)
        S = absP.mean(0)
        pair_names = [f"{a} x {b}" for a, b in pairs]

        # resampling stability: how often does each pair stay in the top-K when the explained students are resampled?
        B = n_boot
        boot_idx = rng.integers(0, len(Xs), size=(B, len(Xs)))
        boot_S = np.stack([absP[bi].mean(0) for bi in boot_idx])           # B x pairs
        top_sets = [set(np.argsort(-row)[:TOP_K]) for row in boot_S]
        freq = np.zeros(len(pairs))
        for ts in top_sets:
            for j in ts:
                freq[j] += 1
        freq /= B
        jac = [len(a & b) / len(a | b) for a, b in itertools.combinations(top_sets[:60], 2)]
        # chance level for two random top-K sets
        cr = np.random.default_rng(0)
        chance = []
        for _ in range(3000):
            a = set(cr.choice(len(pairs), TOP_K, replace=False)); b = set(cr.choice(len(pairs), TOP_K, replace=False))
            chance.append(len(a & b) / len(a | b))

        # same ranking inside each course module / presentation
        vals = var_values(sess, bundle).iloc[idx].reset_index(drop=True)
        top_overall = set(np.argsort(-S)[:TOP_K])
        groups = []
        group_sources = {"code_module": vals["code_module"].values}
        if sess.opts.get("group_values") is not None:
            gv = np.asarray(sess.opts["group_values"])[idx]
            group_sources["presentation"] = gv
        for gname, arr in group_sources.items():
            for g in sorted(set(arr)):
                m = arr == g
                if m.sum() < 150:
                    continue
                Sg = absP[m].mean(0)
                tg = set(np.argsort(-Sg)[:TOP_K])
                groups.append(dict(attribute=gname, group=str(g), n=int(m.sum()), jaccard=len(tg & top_overall) / len(tg | top_overall)))

        order = np.argsort(-S)
        pair_total, main_total = float(S.sum()), float(np.abs(main).mean(0).sum())
        res = dict(
            n=int(len(Xs)), pair_names=pair_names, pairs=pairs, S=S, freq=freq, order=order, P=P, idx=idx,
            main={v: float(np.abs(main[:, i]).mean()) for i, v in enumerate(V)},
            pair_share=pair_total / (pair_total + main_total),
            boot=dict(B=B, jaccard_mean=float(np.mean(jac)), jaccard_min=float(np.min(jac)), chance_mean=float(np.mean(chance)),
                      chance_p95=float(np.percentile(chance, 95))),
            groups=groups, boot_S=boot_S, vals=vals,
        )
        with sess.lock:
            sess.ex = res
            sess.explain.update(status="done", progress=1.0)
    except Exception as e:  # report to the UI instead of dying silently
        with sess.lock:
            sess.explain.update(status="error", error=f"{type(e).__name__}: {e}")


def start_explain(sess: Session, bundle: dict) -> None:
    with sess.lock:
        if sess.explain["status"] in ("running", "done"):
            return
        sess.explain.update(status="running", progress=0.02)
    threading.Thread(target=run_explain, args=(sess, bundle), daemon=True).start()


def badge(freq: float) -> str:
    return "Stable" if freq >= CORE_SHARE else ("Moderate" if freq >= 0.5 else "Unstable")


# ----------------------------------------------------------------------------- performance
def thin(a, b, n=120):
    idx = np.unique(np.linspace(0, len(a) - 1, n).astype(int))
    return [[round(float(a[i]), 4), round(float(b[i]), 4)] for i in idx]


def performance(sess: Session, model: str, thr: float) -> dict:
    if sess.y is None:
        return dict(has_outcome=False)
    k = ~np.isnan(sess.y)
    y = sess.y[k].astype(int)
    if len(set(y)) < 2:
        return dict(has_outcome=False, note="The outcome column has only one class, so performance cannot be computed.")
    PR = {m: sess.probs[m][k] for m in MODEL_NAMES}
    out = dict(has_outcome=True, n=int(len(y)), positives=int(y.sum()), prevalence=float(y.mean()), models={})
    for name in MODEL_NAMES:
        p = PR[name]
        t = thr if name == model else None
        m = six_metrics(y, p, t if t is not None else 0.5) if t is not None else None
        out["models"][name] = dict(roc_auc=float(roc_auc_score(y, p)), pr_auc=float(average_precision_score(y, p)))
        if m:
            out["models"][name]["at_threshold"] = m
    p = PR[model]
    fpr, tpr, _ = roc_curve(y, p)
    pr, rc, _ = precision_recall_curve(y, p)
    edges = np.quantile(p, np.linspace(0, 1, 11))
    bi = np.clip(np.digitize(p, edges[1:-1]), 0, 9)
    tn, fp, fn, tp = confusion_matrix(y, (p >= thr).astype(int), labels=[0, 1]).ravel()
    grid = []
    for t in np.round(np.arange(0.05, 0.61, 0.025), 3):
        pred = p >= t
        tpp = int((pred & (y == 1)).sum()); fpp = int((pred & (y == 0)).sum())
        grid.append(dict(threshold=float(t), flagged=int(pred.sum()), flagged_share=float(pred.mean()),
                         precision=float(tpp / max(1, pred.sum())), recall=float(tpp / max(1, (y == 1).sum())),
                         f1=float(2 * tpp / max(1, pred.sum() + (y == 1).sum()))))
    out.update(model=model, threshold=float(thr), roc=thin(fpr, tpr), pr=thin(rc, pr),
               calibration=[[round(float(p[bi == b].mean()), 4), round(float(y[bi == b].mean()), 4)] for b in range(10)],
               confusion=dict(tn=int(tn), fp=int(fp), fn=int(fn), tp=int(tp)), grid=grid,
               metrics=six_metrics(y, p, thr))
    return out


def band_table(sess: Session, model: str, high: float, med: float) -> list[dict]:
    p = sess.probs[model]
    b = bands(p, high, med)
    rows = []
    for name in ["High", "Medium", "Low"]:
        m = b == name
        r = dict(band=name, n=int(m.sum()), share=float(m.mean()) if len(m) else 0.0, mean_risk=float(p[m].mean()) if m.any() else None)
        if sess.y is not None:
            mk = m & ~np.isnan(sess.y)
            r["observed_rate"] = float(sess.y[mk].mean()) if mk.any() else None
            r["dropouts"] = int(sess.y[mk].sum())
        rows.append(r)
    return rows


# ----------------------------------------------------------------------------- fairness
def _rates(y, pred):
    tpr = pred[y == 1].mean() if (y == 1).any() else np.nan
    fpr = pred[y == 0].mean() if (y == 0).any() else np.nan
    return tpr, fpr


def fairness(sess: Session, model: str, thr: float, audit_cols: list[str], n_perm: int = 300) -> list[dict]:
    raw = sess.raw.iloc[np.where(sess.valid_pos)[0]].reset_index(drop=True)
    p = sess.probs[model]
    y = sess.y
    if y is not None:                      # rows without a known outcome are left out of this view
        k = ~np.isnan(y)
        raw, p, y = raw[k].reset_index(drop=True), p[k], y[k].astype(int)
    pred = (p >= thr).astype(int)
    rng = np.random.default_rng(SEED)
    out = []
    for col in audit_cols:
        if col not in raw.columns:
            continue
        labels = raw[col].astype(str).where(raw[col].notna(), "Unknown").values
        groups = sorted(set(labels))
        if len(groups) < 2 or len(groups) > 15:
            continue
        rows, eligible = [], []
        for g in groups:
            m = labels == g
            r = dict(group=str(g), n=int(m.sum()), mean_risk=float(p[m].mean()), selection_rate=float(pred[m].mean()))
            if y is not None:
                npos = int(y[m].sum())
                tpr, fpr = _rates(y[m], pred[m])
                r.update(dropouts=npos, dropout_rate=float(y[m].mean()), recall=None if np.isnan(tpr) else float(tpr),
                         fpr=None if np.isnan(fpr) else float(fpr),
                         precision=float(y[m][pred[m] == 1].mean()) if (pred[m] == 1).any() else None,
                         reliable=bool(npos >= MIN_POS))
                if npos >= MIN_POS and (y[m] == 0).any():
                    eligible.append(g)
            rows.append(r)
        entry = dict(attribute=col, groups=rows)
        if y is not None and len(eligible) >= 2:
            def gap(lab):
                t, f = [], []
                for g in eligible:
                    m = lab == g
                    a, b = _rates(y[m], pred[m]); t.append(a); f.append(b)
                return np.nanmax(t) - np.nanmin(t), np.nanmax(f) - np.nanmin(f)
            tg, fg = gap(labels)
            obs = max(tg, fg)
            perm = np.array([max(gap(rng.permutation(labels))) for _ in range(n_perm)])
            entry.update(tpr_gap=float(tg), fpr_gap=float(fg), eo_gap=float(obs), perm_p=float((perm >= obs).mean()),
                         compared=eligible)
        out.append(entry)
    return out
