"""DropAlert web app: upload a student table, score dropout risk with the project's three models, explain with SHAP.

    python app.py            (then open http://127.0.0.1:8000)
"""
from __future__ import annotations

import io
import json
import math
import shutil
import tempfile
import threading
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from scipy.stats import spearmanr

import core  # noqa: F401  (needed so joblib can unpickle core.Platt / core.signed_log1p)
import build as build_mod
import engine
from core import MODEL_NAMES, SEED
from engine import Session
from schema import SPEC, SPECS, parse_column, profile_columns, suggest_mapping, suggest_optional

HERE = Path(__file__).parent
ART = HERE / "artifacts"
MAX_BYTES = 200 * 1024 * 1024

if not (ART / "bundle.joblib").exists():
    raise SystemExit("artifacts/bundle.joblib is missing. Run:  python train.py")
BUNDLE = joblib.load(ART / "bundle.joblib")
RESEARCH = json.load(open(ART / "research.json"))
SESSIONS: dict[str, Session] = {}
_EXPLAINER = {}

app = FastAPI(title="DropAlert", docs_url="/api/docs", openapi_url="/api/openapi.json")


# ----------------------------------------------------------------------------- json helpers
def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        f = float(o)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, pd.Timestamp):
        return str(o)
    return o


def jr(obj, status=200):
    return JSONResponse(clean(obj), status_code=status)


def get_sess(sid: str) -> Session:
    s = SESSIONS.get(sid)
    if s is None:
        raise HTTPException(404, "This session has expired (the server was restarted). Upload the file again.")
    return s


def need_scored(s: Session):
    if s.X is None:
        raise HTTPException(409, "Confirm the column mapping and run the prediction first.")


def model_arg(model: str) -> str:
    if model not in MODEL_NAMES:
        raise HTTPException(400, f"model must be one of {MODEL_NAMES}")
    return model


def explainer():
    if "e" not in _EXPLAINER:
        import shap
        _EXPLAINER["e"] = shap.TreeExplainer(BUNDLE["models"]["LightGBM"])
    return _EXPLAINER["e"]


# ----------------------------------------------------------------------------- static information
@app.get("/api/info")
def info():
    return jr(dict(
        specs=[{k: v for k, v in s.items() if k != "syn"} for s in SPECS],
        models=MODEL_NAMES,
        thresholds=BUNDLE["thr"],
        variables=BUNDLE["VARIABLES"],
        features=BUNDLE["FEATURES"],
        nan_allowed=BUNDLE["nan_ok"],
        demo_available=(ART / "demo_cohort.csv").exists(),
        n_train=BUNDLE["n_train"],
        test_metrics=RESEARCH["key"]["test_metrics"],
    ))


@app.get("/api/research")
def research():
    return jr(RESEARCH)


# ----------------------------------------------------------------------------- upload
def read_table(name: str, data: bytes) -> pd.DataFrame:
    low = name.lower()
    if low.endswith((".xlsx", ".xlsm", ".xls")):
        try:
            return pd.read_excel(io.BytesIO(data), sheet_name=0)
        except Exception as e:
            raise HTTPException(400, f"Could not read the Excel file: {e}")
    if low.endswith((".csv", ".tsv", ".txt")):
        last = None
        for enc in ("utf-8-sig", "latin-1"):
            try:
                df = pd.read_csv(io.BytesIO(data), encoding=enc, sep="\t" if low.endswith(".tsv") else ",", low_memory=False)
                if df.shape[1] == 1:   # probably a semicolon or other delimiter
                    df = pd.read_csv(io.BytesIO(data), encoding=enc, sep=None, engine="python")
                return df
            except Exception as e:
                last = e
        raise HTTPException(400, f"Could not read the file as CSV: {last}")
    raise HTTPException(400, "Unsupported file type. Use .csv, .tsv, .xlsx or .xls.")


def session_payload(filename: str, df: pd.DataFrame) -> dict:
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    if df.shape[0] == 0 or df.shape[1] == 0:
        raise HTTPException(400, "The file has no rows or no columns.")
    if df.columns.duplicated().any():
        raise HTTPException(400, "Two columns share the same name: " + ", ".join(df.columns[df.columns.duplicated()]))
    sid = engine.new_sid()
    SESSIONS[sid] = Session(sid=sid, filename=filename, raw=df.reset_index(drop=True))
    mapping = suggest_mapping(df)
    opt = suggest_optional(df, {m["column"] for m in mapping.values()})
    return dict(sid=sid, filename=filename, rows=int(len(df)), cols=int(df.shape[1]), columns=profile_columns(df),
                mapping=mapping, optional=opt, preview=json.loads(df.head(8).to_json(orient="records")))


def open_session(filename: str, df: pd.DataFrame):
    return jr(session_payload(filename, df))


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "File is larger than 200 MB. Build the one-row-per-student table first (see the Upload page).")
    return open_session(file.filename or "upload", read_table(file.filename or "x.csv", data))


@app.post("/api/demo")
def demo():
    path = ART / "demo_cohort.csv"
    if not path.exists():
        raise HTTPException(404, "No demo cohort. Run train.py first.")
    return open_session("OULAD held-out test students (demo).csv", pd.read_csv(path))


# ----------------------------------------------------------------------------- build from raw OULAD tables
BUILDS: dict[str, dict] = {}


def _run_build(bid: str, files: dict, tmpdir: Path | None, label: str):
    job = BUILDS[bid]

    def progress(phase, rows=0):
        job.update(phase=phase, rows_read=int(rows))
    try:
        cohort, stats = build_mod.build_from_folder(files, progress)
        payload = session_payload(label, cohort)
        job.update(status="done", phase="Done", stats=stats, result=payload)
    except Exception as e:
        job.update(status="error", error=str(e) if isinstance(e, ValueError) else f"{type(e).__name__}: {e}")
    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)


def _start_build(files: dict, tmpdir, label, ignored):
    missing = [k for k in build_mod.REQUIRED if k not in files]
    if missing:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)
        raise HTTPException(400, "These OULAD tables are missing: " + ", ".join(missing) + ". All six are needed: " +
                            ", ".join(build_mod.REQUIRED) + (f". Ignored files: {', '.join(ignored)}." if ignored else "."))
    bid = engine.new_sid()
    BUILDS[bid] = dict(status="running", phase="Starting", rows_read=0, error=None, ignored=ignored, tables=sorted(files))
    threading.Thread(target=_run_build, args=(bid, files, tmpdir, label), daemon=True).start()
    return jr(dict(id=bid, tables=sorted(files), ignored=ignored))


@app.post("/api/build/upload")
def build_upload(files: list[UploadFile] = File(...)):
    tmp = Path(tempfile.mkdtemp(prefix="dropalert_"))
    found, ignored = {}, []
    try:
        for f in files:
            key = build_mod.table_key(f.filename or "")
            if key is None:
                ignored.append(f.filename or "?")
                continue
            dest = tmp / f"{key}.dat"
            with open(dest, "wb") as out:
                shutil.copyfileobj(f.file, out, 1024 * 1024)
            found[key] = dest
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return _start_build(found, tmp, "OULAD raw tables (built from upload).csv", ignored)


@app.post("/api/build/folder")
def build_folder(body: dict = Body(...)):
    folder = Path(str(body.get("path", "")).strip().strip('"'))
    if not folder.is_dir():
        raise HTTPException(400, f"'{folder}' is not a folder on this computer.")
    found, ignored = {}, []
    for p in sorted(folder.iterdir()):
        if not p.is_file():
            continue
        key = build_mod.table_key(p.name)
        if key is None:
            if p.suffix.lower() in (".csv", ".bz2", ".gz", ".txt"):
                ignored.append(p.name)
            continue
        found[key] = p                       # read in place; never copied or deleted
    return _start_build(found, None, "OULAD raw tables (built from folder).csv", ignored)


@app.get("/api/build/{bid}")
def build_status(bid: str):
    job = BUILDS.get(bid)
    if job is None:
        raise HTTPException(404, "Unknown build.")
    return jr({k: v for k, v in job.items()})


@app.get("/api/session/{sid}/values")
def column_values(sid: str, col: str):
    s = get_sess(sid)
    if col not in s.raw.columns:
        raise HTTPException(404, "No such column.")
    vc = s.raw[col].dropna().astype(str).str.strip().value_counts()
    return jr(dict(column=col, total_unique=int(len(vc)), values=[dict(value=k, n=int(v)) for k, v in vc.head(25).items()]))


# ----------------------------------------------------------------------------- predict
@app.post("/api/session/{sid}/predict")
def predict(sid: str, body: dict = Body(...)):
    s = get_sess(sid)
    mapping = {k: v for k, v in (body.get("mapping") or {}).items() if v}
    try:
        ok, parsed, report = engine.validate(s.raw, mapping, BUNDLE)
    except ValueError as e:
        return jr(dict(blocked=True, message=str(e)), 422)
    if ok.sum() < 20:
        return jr(dict(blocked=True, message=f"Only {int(ok.sum())} rows can be scored after validation; at least 20 are needed. "
                       "See the per-input counts of missing or unreadable values.", report=report), 422)

    s.mapping, s.parsed, s.valid_pos, s.report = mapping, parsed, ok, report
    s.explain = dict(status="idle", progress=0.0, error=None)
    s.ex = {}
    s.probs = {}
    opts = dict(id_col=body.get("id_col") or None, outcome_col=body.get("outcome_col") or None,
                positive=[str(x) for x in (body.get("positive") or [])], group_col=body.get("group_col") or None,
                audit_cols=[c for c in (body.get("audit_cols") or []) if c in s.raw.columns])
    pos = np.where(ok)[0]
    # outcome
    s.y = None
    if opts["outcome_col"] and opts["outcome_col"] in s.raw.columns and opts["positive"]:
        col = s.raw[opts["outcome_col"]].iloc[pos]
        known = ~col.isna()
        y = np.where(col.astype(str).str.strip().isin(opts["positive"]), 1.0, 0.0)
        y[~known.values] = np.nan
        s.y = y
        report["outcome_unknown"] = int((~known).sum())
    # grouping column for stability by presentation
    opts["group_values"] = (s.raw[opts["group_col"]].iloc[pos].astype(str).values
                            if opts["group_col"] and opts["group_col"] in s.raw.columns else None)
    s.opts = opts
    engine.score(s, BUNDLE)
    report["models"] = MODEL_NAMES
    return jr(dict(blocked=False, report=report, has_outcome=s.y is not None, id_col=opts["id_col"],
                   audit_cols=opts["audit_cols"], group_col=opts["group_col"]))


# ----------------------------------------------------------------------------- summary and ranking
def cuts(model: str, high, med):
    h, m = engine.default_cuts(BUNDLE, model)
    h = float(high) if high not in (None, "") else h
    m = float(med) if med not in (None, "") else min(m, h)
    return h, min(m, h)


def id_series(s: Session) -> pd.Series:
    pos = np.where(s.valid_pos)[0]
    col = s.opts.get("id_col")
    if col and col in s.raw.columns:
        return s.raw[col].iloc[pos].reset_index(drop=True).astype(str)
    return pd.Series([f"row {i + 1}" for i in pos])


@app.get("/api/session/{sid}/summary")
def summary(sid: str, model: str = "LightGBM", high: float | None = None, med: float | None = None):
    s = get_sess(sid); need_scored(s); model_arg(model)
    h, m = cuts(model, high, med)
    p = s.probs[model]
    b = engine.bands(p, h, m)
    vals = engine.var_values(s, BUNDLE)
    by_mod = []
    for g, idx in vals.groupby("code_module").groups.items():
        by_mod.append(dict(module=g, n=int(len(idx)), mean_risk=float(p[list(idx)].mean()), high=int((b[list(idx)] == "High").sum())))
    hist, edges = np.histogram(p, bins=20, range=(0, max(0.6, float(np.quantile(p, 0.995)))))
    return jr(dict(filename=s.filename, model=model, n=int(len(p)), high_cut=h, med_cut=m, threshold=BUNDLE["thr"][model],
                   counts={k: int((b == k).sum()) for k in ["High", "Medium", "Low"]}, mean_risk=float(p.mean()),
                   has_outcome=s.y is not None, report=s.report, bands=engine.band_table(s, model, h, m), by_module=by_mod,
                   hist=dict(counts=hist.tolist(), edges=edges.tolist()),
                   agreement={m1: {m2: float(spearmanr(s.probs[m1], s.probs[m2])[0]) for m2 in MODEL_NAMES} for m1 in MODEL_NAMES}))


def top_reasons(s: Session, rows: np.ndarray, k: int = 3):
    V = BUNDLE["VARIABLES"]
    out = []
    for r in rows:
        c = s.contrib[r]
        order = np.argsort(-c)[:k]
        out.append([dict(variable=V[j], shap=float(c[j])) for j in order if c[j] > 0])
    return out


@app.get("/api/session/{sid}/ranking")
def ranking(sid: str, model: str = "LightGBM", high: float | None = None, med: float | None = None, band: str = "",
            module: str = "", q: str = "", sort: str = "risk", desc: bool = True, page: int = 1, size: int = 50):
    s = get_sess(sid); need_scored(s); model_arg(model)
    h, m = cuts(model, high, med)
    p = s.probs[model]
    b = engine.bands(p, h, m)
    vals = engine.var_values(s, BUNDLE)
    ids = id_series(s)
    mask = np.ones(len(p), bool)
    if band in ("High", "Medium", "Low"):
        mask &= b == band
    if module:
        mask &= (vals["code_module"] == module).values
    if q:
        mask &= ids.str.contains(q, case=False, regex=False).values
    sel = np.where(mask)[0]
    key = {"risk": p, "id": ids.values, "module": vals["code_module"].values}.get(sort, p)
    order = sel[np.argsort(key[sel], kind="stable")]
    if desc:
        order = order[::-1]
    total = len(order)
    size = max(5, min(200, size))
    page = max(1, page)
    page_rows = order[(page - 1) * size: page * size]
    reasons = top_reasons(s, page_rows)
    rank_all = np.empty(len(p), int)                      # overall rank, 1 = highest risk
    rank_all[np.argsort(-p, kind="stable")] = np.arange(1, len(p) + 1)
    rows = []
    for i, r in enumerate(page_rows):
        row = dict(pos=int(r), rank=int(rank_all[r]), id=ids.iloc[r], risk=float(p[r]), band=str(b[r]),
                   module=str(vals["code_module"].iloc[r]), reasons=reasons[i],
                   others={n: float(s.probs[n][r]) for n in MODEL_NAMES})
        if s.y is not None and not np.isnan(s.y[r]):
            row["outcome"] = int(s.y[r])
        rows.append(row)
    return jr(dict(total=int(total), page=page, size=size, rows=rows, high_cut=h, med_cut=m,
                   modules=sorted(vals["code_module"].unique().tolist())))


# ----------------------------------------------------------------------------- one student
@app.get("/api/session/{sid}/student/{pos}")
def student(sid: str, pos: int, model: str = "LightGBM", high: float | None = None, med: float | None = None):
    s = get_sess(sid); need_scored(s); model_arg(model)
    if pos < 0 or pos >= len(s.X):
        raise HTTPException(404, "No such student.")
    h, m = cuts(model, high, med)
    V = BUNDLE["VARIABLES"]
    vals = engine.var_values(s, BUNDLE)
    c = s.contrib[pos]
    margin = s.base_margin + float(c.sum())
    platt = BUNDLE["platts"]["LightGBM"]
    p_base = engine.margin_to_p(s.base_margin, platt)
    p_lgb = engine.margin_to_p(margin, platt)
    tot = float(np.abs(c).sum()) or 1.0
    scale = (p_lgb - p_base) / float(c.sum()) if abs(c.sum()) > 1e-9 else 0.0
    factors = []
    for j in np.argsort(-np.abs(c)):
        v = vals.iloc[pos][V[j]]
        factors.append(dict(variable=V[j], value=v if isinstance(v, str) else float(v), shap=float(c[j]), points=float(c[j] * scale),
                            share=float(abs(c[j]) / tot)))
    # pairs for this student only (exact SHAP interaction values for one row)
    iv = core.interaction_pos(explainer().shap_interaction_values(s.X.iloc[[pos]]))[0]
    feats = BUNDLE["FEATURES"]
    col_idx = {v: [i for i, f in enumerate(feats) if core.var_of(f) == v] for v in V}
    pairs = []
    import itertools
    for a, b2 in itertools.combinations(V, 2):
        val = 2 * float(iv[np.ix_(col_idx[a], col_idx[b2])].sum())
        pairs.append(dict(pair=f"{a} x {b2}", a=a, b=b2, value=val, points=val * scale))
    pairs.sort(key=lambda d: -abs(d["value"]))
    pm = {n: float(s.probs[n][pos]) for n in MODEL_NAMES}
    pair_stab = None
    if s.ex:
        fr = {n: float(f) for n, f in zip(s.ex["pair_names"], s.ex["freq"])}
        for pr in pairs[:8]:
            pr["stability"] = fr.get(pr["pair"]); pr["badge"] = engine.badge(fr.get(pr["pair"], 0.0))
    out = dict(pos=pos, id=id_series(s).iloc[pos], risk=pm[model], model=model, band=str(engine.bands(np.array([pm[model]]), h, m)[0]),
               models={n: dict(risk=pm[n], band=str(engine.bands(np.array([pm[n]]), *engine.default_cuts(BUNDLE, n))[0]),
                               flagged=bool(pm[n] >= BUNDLE["thr"][n])) for n in MODEL_NAMES},
               base_risk=p_base, lgbm_risk=p_lgb, base_margin=s.base_margin, margin=margin, factors=factors, pairs=pairs[:10],
               explained_by="LightGBM", high_cut=h, med_cut=m)
    if s.y is not None and not np.isnan(s.y[pos]):
        out["outcome"] = int(s.y[pos])
    raw_row = s.raw.iloc[np.where(s.valid_pos)[0][pos]]
    out["row"] = {str(k): (None if pd.isna(v) else (v if isinstance(v, (int, float, str)) else str(v))) for k, v in raw_row.items()}
    return jr(out)


# ----------------------------------------------------------------------------- global importance (first order)
@app.get("/api/session/{sid}/importance")
def importance(sid: str):
    s = get_sess(sid); need_scored(s)
    V = BUNDLE["VARIABLES"]
    S = s.contrib
    n = len(S)
    rng = np.random.default_rng(SEED)
    sub = rng.choice(n, size=min(n, 6000), replace=False)
    absS = np.abs(S[sub])
    boots = np.stack([absS[rng.integers(0, len(sub), len(sub))].mean(0) for _ in range(200)])
    mean = np.abs(S).mean(0)
    vals = engine.var_values(s, BUNDLE)
    rows = []
    for j, v in enumerate(V):
        if v == "code_module":
            direction = "categorical"; rho = None
        else:
            x = vals[v].values.astype(float)
            ok = ~np.isnan(x)
            r = spearmanr(x[ok][:8000], S[ok, j][:8000])[0] if ok.sum() > 10 and np.nanstd(x[ok]) > 0 else np.nan
            rho = None if np.isnan(r) else float(r)
            direction = "mixed" if rho is None else ("higher value -> higher risk" if rho > 0.1 else ("higher value -> lower risk" if rho < -0.1 else "mixed"))
        rows.append(dict(variable=v, mean_abs=float(mean[j]), lo=float(np.percentile(boots[:, j], 2.5)), hi=float(np.percentile(boots[:, j], 97.5)),
                         direction=direction, rho=rho))
    rows.sort(key=lambda d: -d["mean_abs"])
    tot = sum(r["mean_abs"] for r in rows) or 1
    for i, r in enumerate(rows):
        r["rank"] = i + 1; r["share"] = r["mean_abs"] / tot
    # beeswarm sample
    bs = rng.choice(n, size=min(n, 700), replace=False)
    swarm = {}
    for j, v in enumerate(V):
        if v == "code_module":
            continue
        x = vals[v].values[bs].astype(float)
        ok = ~np.isnan(x)
        rk = np.zeros(len(x)); rk[ok] = pd.Series(x[ok]).rank(pct=True).values
        swarm[v] = dict(shap=S[bs, j].tolist(), rank=rk.tolist(), value=x.tolist())
    modsh = {g: float(S[list(idx), V.index("code_module")].mean()) for g, idx in vals.groupby("code_module").groups.items()}
    return jr(dict(rows=rows, swarm=swarm, module_shap=modsh, n=int(n)))


# ----------------------------------------------------------------------------- interactions
@app.post("/api/session/{sid}/explain/start")
def explain_start(sid: str):
    s = get_sess(sid); need_scored(s)
    engine.start_explain(s, BUNDLE)
    return jr(s.explain)


@app.get("/api/session/{sid}/explain/status")
def explain_status(sid: str):
    s = get_sess(sid)
    return jr(s.explain)


@app.get("/api/session/{sid}/interactions")
def interactions(sid: str, top: int = 15):
    s = get_sess(sid); need_scored(s)
    if s.explain["status"] != "done":
        return jr(dict(ready=False, status=s.explain))
    ex = s.ex
    nb_core = {r["name"]: r for r in RESEARCH["tables"]["table10_core_pairs"]}
    order = ex["order"][:top]
    tot = float(ex["S"].sum())
    rows = []
    for rk, j in enumerate(order):
        name = ex["pair_names"][j]
        nb = nb_core.get(name)
        rows.append(dict(rank=rk + 1, pair=name, a=ex["pairs"][j][0], b=ex["pairs"][j][1], strength=float(ex["S"][j]), share=float(ex["S"][j] / tot),
                         freq=float(ex["freq"][j]), badge=engine.badge(float(ex["freq"][j])),
                         lo=float(np.percentile(ex["boot_S"][:, j], 2.5)), hi=float(np.percentile(ex["boot_S"][:, j], 97.5)),
                         notebook_all_runs=None if nb is None else nb.get("All runs"), notebook_core=None if nb is None else (nb.get("Core pair?") == "Core")))
    V = BUNDLE["VARIABLES"]
    imp = sorted(ex["main"].items(), key=lambda kv: -kv[1])[:8]
    vars_top = [v for v, _ in imp]
    mat = [[0.0] * len(vars_top) for _ in vars_top]
    pname = {f"{a} x {b}": k for k, (a, b) in enumerate(ex["pairs"])}
    for i, a in enumerate(vars_top):
        for j2, b in enumerate(vars_top):
            if i == j2:
                continue
            k = pname.get(f"{a} x {b}", pname.get(f"{b} x {a}"))
            mat[i][j2] = float(ex["S"][k]) if k is not None else 0.0
    return jr(dict(ready=True, n=ex["n"], rows=rows, heat=dict(vars=vars_top, matrix=mat), main=ex["main"], pair_share=ex["pair_share"],
                   boot=ex["boot"], groups=ex["groups"], top_k=core.TOP_K, core_share=core.CORE_SHARE))


@app.get("/api/session/{sid}/dependence")
def dependence(sid: str, a: str, b: str):
    s = get_sess(sid); need_scored(s)
    if s.explain["status"] != "done":
        return jr(dict(ready=False))
    V = BUNDLE["VARIABLES"]
    if a not in V or b not in V:
        raise HTTPException(400, "unknown variable")
    ex = s.ex
    idx = ex["idx"]
    vals = ex["vals"]
    ja = V.index(a)
    pname = {f"{x} x {y}": k for k, (x, y) in enumerate(ex["pairs"])}
    k = pname.get(f"{a} x {b}", pname.get(f"{b} x {a}"))
    xa = vals[a].tolist(); cb = vals[b].tolist()
    return jr(dict(ready=True, a=a, b=b, x=xa, color=cb, shap=s.contrib[idx, ja].tolist(),
                   interaction=ex["P"][:, k].tolist() if k is not None else None,
                   a_is_cat=a == "code_module", b_is_cat=b == "code_module"))


# ----------------------------------------------------------------------------- performance and fairness
@app.get("/api/session/{sid}/performance")
def performance(sid: str, model: str = "LightGBM", thr: float | None = None, high: float | None = None, med: float | None = None):
    s = get_sess(sid); need_scored(s); model_arg(model)
    t = float(thr) if thr is not None else BUNDLE["thr"][model]
    h, m = cuts(model, high, med)
    out = engine.performance(s, model, t)
    out["bands"] = engine.band_table(s, model, h, m)
    return jr(out)


@app.get("/api/session/{sid}/fairness")
def fairness(sid: str, model: str = "LightGBM", thr: float | None = None):
    s = get_sess(sid); need_scored(s); model_arg(model)
    t = float(thr) if thr is not None else BUNDLE["thr"][model]
    cols = s.opts.get("audit_cols") or []
    if not cols:
        return jr(dict(available=False, message="No audit columns were chosen. Pick columns such as gender, age band or deprivation group on the Upload page."))
    return jr(dict(available=True, has_outcome=s.y is not None, threshold=t, model=model, attributes=engine.fairness(s, model, t, cols)))


# ----------------------------------------------------------------------------- download
@app.get("/api/session/{sid}/download")
def download(sid: str, model: str = "LightGBM", high: float | None = None, med: float | None = None):
    s = get_sess(sid); need_scored(s); model_arg(model)
    h, m = cuts(model, high, med)
    p = s.probs[model]
    out = s.raw.iloc[np.where(s.valid_pos)[0]].reset_index(drop=True).copy()
    V = BUNDLE["VARIABLES"]
    rs = []
    for r in range(len(out)):
        c = s.contrib[r]
        top = [f"{V[j]} ({c[j]:+.2f})" for j in np.argsort(-c)[:3] if c[j] > 0]
        rs.append("; ".join(top))
    out.insert(0, "top_risk_factors_shap_logodds", rs)
    out.insert(0, "risk_band", engine.bands(p, h, m))
    out.insert(0, f"risk_percent_{model.replace(' ', '_')}", np.round(p * 100, 2))
    out.insert(0, "risk_rank", pd.Series(p).rank(ascending=False, method="first").astype(int).values)
    out = out.sort_values("risk_rank")
    buf = io.StringIO()
    out.to_csv(buf, index=False)
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="dropalert_ranked_students.csv"'})


# ----------------------------------------------------------------------------- front end
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(HERE / "static" / "index.html", headers={"Cache-Control": "no-store"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
