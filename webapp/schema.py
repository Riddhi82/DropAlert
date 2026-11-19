"""Column detection, mapping and validation for uploaded datasets.

Nothing here assumes column names: every model input is matched by name and by what the values look like,
and the user can correct each match. A value that cannot be read is never guessed; the row is excluded and counted.
"""
from __future__ import annotations

import difflib
import re

import numpy as np
import pandas as pd

from core import EDU_ORDER, MODULES


def norm(s) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


# kind: count | number | ordinal | binary | category
SPECS = [
    dict(name="clicks_total", label="Total clicks (first 28 days)", kind="count", group="Engagement",
         help="Sum of all learning-platform clicks from day 0 to day 28.",
         syn=["total_clicks", "sum_click", "clicks", "n_clicks", "click_count", "vle_clicks"]),
    dict(name="active_days", label="Active days", kind="count", group="Engagement",
         help="Number of distinct days with at least one click (day 0-28).",
         syn=["days_active", "n_active_days", "active_day", "days_with_activity", "login_days"]),
    dict(name="clicks_prestart", label="Clicks before course start", kind="count", group="Engagement",
         help="Clicks recorded before day 0.", syn=["prestart_clicks", "pre_start_clicks", "clicks_before_start", "early_clicks"]),
    dict(name="first_access_day", label="First access day", kind="number", group="Engagement",
         help="Day of the first click in the window; 29 if no click.", syn=["first_access", "first_day", "first_login_day"]),
    dict(name="days_since_last_access", label="Days since last access", kind="number", group="Engagement",
         help="Window end (day 28) minus the last active day; 29 if no click.",
         syn=["days_since_last", "recency", "days_inactive", "last_access_gap", "days_since_last_login"]),
    dict(name="click_trend", label="Click trend", kind="number", group="Engagement",
         help="Clicks in the second half of the window minus the first half.", syn=["trend", "click_change", "clicks_trend"]),
    dict(name="clicks_forum", label="Forum clicks", kind="count", group="Engagement",
         help="Clicks on the discussion forum.", syn=["forum_clicks", "forumng", "forum_activity", "discussion_clicks"]),
    dict(name="n_submitted", label="Assessments submitted", kind="count", group="Engagement",
         help="Assessments handed in by day 28.", syn=["submissions", "n_submissions", "num_submitted", "assessments_submitted", "submitted"]),
    dict(name="date_registration", label="Registration day", kind="number", group="Enrolment",
         help="Day of registration relative to course start (negative = before start).",
         syn=["registration_date", "reg_date", "registered_day", "days_registered", "registration_day"]),
    dict(name="num_of_prev_attempts", label="Previous attempts", kind="count", group="Enrolment",
         help="Earlier attempts at this module.", syn=["prev_attempts", "previous_attempts", "attempts", "num_prev_attempts"]),
    dict(name="studied_credits", label="Studied credits", kind="count", group="Enrolment",
         help="Credits the student is studying in total.", syn=["credits", "credit", "total_credits", "studied_credit"]),
    dict(name="edu_ord", label="Highest education", kind="ordinal", group="Background",
         help="Accepts the text levels (No Formal quals ... Post Graduate Qualification) or codes 0-4.",
         syn=["highest_education", "education", "education_level", "edu", "qualification"]),
    dict(name="imd_ord", label="Deprivation band (IMD)", kind="ordinal", group="Background",
         help="Accepts bands like '0-10%' ... '90-100%' or codes 0-9. Blank is allowed.",
         syn=["imd_band", "imd", "deprivation", "deprivation_band", "imd_decile"]),
    dict(name="disability_bin", label="Disability", kind="binary", group="Background",
         help="Y/N, Yes/No, 1/0.", syn=["disability", "disabled", "has_disability"]),
    dict(name="code_module", label="Course module", kind="category", group="Course",
         help="One of the seven OULAD modules (AAA-GGG). The model has not seen any other module.",
         syn=["module", "course", "course_module", "course_code", "module_code"]),
]
SPEC = {s["name"]: s for s in SPECS}

ID_NAMES = ["id_student", "student_id", "studentid", "id", "student", "learner_id", "userid"]
OUTCOME_NAMES = ["final_result", "outcome", "dropout", "withdrawn", "target", "label", "y", "result", "status"]
GROUP_NAMES = ["code_presentation", "presentation", "cohort", "term", "intake", "semester"]
AUDIT_NAMES = ["gender", "sex", "age_band", "age", "imd_group", "imd_band", "region", "disability", "highest_education", "ethnicity"]

_EDU = {norm(e): i for i, e in enumerate(EDU_ORDER)}
_EDU.update({"postgraduate": 4, "postgrad": 4, "he": 3, "alevel": 2, "belowalevel": 1, "lowerthanalevel": 1,
             "noformalqualifications": 0, "none": 0, "noformalqual": 0})
_YES = {"y", "yes", "true", "t", "1", "1.0"}
_NO = {"n", "no", "false", "f", "0", "0.0"}
_MISSING = {"", "nan", "none", "null", "na", "n/a", "?", "-"}


def _is_missing(s: pd.Series) -> pd.Series:
    return s.isna() | s.astype(str).str.strip().str.lower().isin(_MISSING)


def parse_column(series: pd.Series, kind: str, name: str) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Return (parsed values, missing mask, invalid mask). Parsed is float, except code_module (str)."""
    miss = _is_missing(series)
    s = series.where(~miss)
    if kind == "category":  # course module
        v = s.astype(str).str.strip().str.upper().where(~miss)
        bad = (~miss) & (~v.isin(MODULES))
        return v.where(~bad), miss, bad
    if kind == "binary":
        t = s.astype(str).str.strip().str.lower()
        v = pd.Series(np.nan, index=series.index)
        v[t.isin(_YES) & ~miss] = 1.0
        v[t.isin(_NO) & ~miss] = 0.0
        bad = (~miss) & v.isna()
        return v, miss, bad
    num = pd.to_numeric(s, errors="coerce")
    if kind in ("count", "number"):
        bad = (~miss) & num.isna()
        return num, miss, bad
    # ordinal: either numeric codes or text levels
    if name == "edu_ord":
        if num.notna().sum() >= 0.8 * (~miss).sum() and num.dropna().between(0, 4).all():
            return num, miss, (~miss) & num.isna()
        v = s.astype(str).map(lambda x: _EDU.get(norm(x), np.nan)).astype(float).where(~miss)
        return v, miss, (~miss) & v.isna()
    if name == "imd_ord":
        if num.notna().sum() >= 0.8 * (~miss).sum() and num.dropna().between(0, 9).all():
            return num, miss, (~miss) & num.isna()

        def one(x):
            m = re.search(r"(\d+)\s*-\s*(\d+)", str(x))
            if not m:
                return np.nan
            lo = int(m.group(1))
            return float(lo // 10) if lo % 10 == 0 else np.nan
        v = s.map(one).astype(float).where(~miss)
        return v, miss, (~miss) & v.isna()
    return num, miss, (~miss) & num.isna()


def _name_score(col: str, spec: dict) -> float:
    n = norm(col)
    primary = norm(spec["name"])
    if n == primary:
        return 1.0
    syn = [norm(x) for x in spec["syn"]]
    if n in syn:
        return 0.95
    best = max(difflib.SequenceMatcher(None, n, t).ratio() for t in [primary] + syn)
    return best * 0.9 if best >= 0.7 else best * 0.5


def suggest_mapping(df: pd.DataFrame) -> dict:
    sample = df.head(3000)
    cands = []
    for spec in SPECS:
        for col in df.columns:
            ns = _name_score(col, spec)
            if ns < 0.45:
                continue
            try:
                _, miss, bad = parse_column(sample[col], spec["kind"], spec["name"])
                nn = int((~miss).sum())
                compat = 0.0 if nn == 0 else 1.0 - float(bad.sum()) / nn
            except Exception:
                compat = 0.0
            cands.append((ns * (0.35 + 0.65 * compat), spec["name"], col, ns, compat))
    cands.sort(reverse=True)
    used_cols, used_specs, out = set(), set(), {}
    for score, sname, col, ns, compat in cands:
        if sname in used_specs or col in used_cols or score < 0.5:
            continue
        used_cols.add(col); used_specs.add(sname)
        out[sname] = dict(column=col, score=round(score, 3), confident=bool(score >= 0.8 and compat >= 0.95))
    return out


def _find(cols: list[str], names: list[str]) -> str | None:
    lookup = {norm(c): c for c in cols}
    for n in names:
        if norm(n) in lookup:
            return lookup[norm(n)]
    return None


def suggest_optional(df: pd.DataFrame, mapped_cols: set) -> dict:
    cols = list(df.columns)
    id_col = _find(cols, ID_NAMES)
    outcome = _find(cols, OUTCOME_NAMES)
    group = _find(cols, GROUP_NAMES)
    audit = []
    for n in AUDIT_NAMES:
        c = _find(cols, [n])
        if c and c not in audit and 2 <= df[c].nunique(dropna=True) <= 15:
            audit.append(c)
    # prefer the grouped IMD column over the ten raw bands (ten small groups are too noisy to audit)
    if "imdgroup" in [norm(a) for a in audit]:
        audit = [a for a in audit if norm(a) != "imdband"]
    pos = []
    if outcome is not None:
        vals = df[outcome].dropna().astype(str).str.strip()
        uniq = sorted(vals.unique())
        low = {u.lower(): u for u in uniq}
        if "withdrawn" in low:
            pos = [low["withdrawn"]]
        elif set(uniq) <= {"0", "1", "0.0", "1.0"}:
            pos = ["1"] if "1" in uniq else ["1.0"]
        elif "dropout" in low:
            pos = [low["dropout"]]
    return dict(id=id_col, outcome=outcome, positive=pos, group=group, audit=audit[:4])


def profile_columns(df: pd.DataFrame) -> list[dict]:
    rows = []
    for c in df.columns:
        s = df[c]
        miss = int(_is_missing(s).sum())
        num = pd.to_numeric(s, errors="coerce")
        numeric = bool(num.notna().sum() >= 0.9 * max(1, (~_is_missing(s)).sum()))
        uniq = int(s.nunique(dropna=True))
        rows.append(dict(name=str(c), type="number" if numeric else "text", missing=miss, unique=uniq,
                         sample=[None if pd.isna(x) else (x if isinstance(x, (int, float, str)) else str(x)) for x in s.dropna().head(4).tolist()]))
    return rows
