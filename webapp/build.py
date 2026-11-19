"""Build the 28-day feature table straight from the raw OULAD tables.

The logic is the notebook's (section 1, build_cutoff / build_features) for the main cut-off day only, followed by
the same risk-set rule: only enrolments still registered on day 28 are kept.
"""
from __future__ import annotations

import bz2
import gzip
import re
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from core import EDU_ORDER, IMD_GROUPS, IMD_LEVELS, KEYS, MAIN_CUTOFF, NUMERIC

REQUIRED = ["studentInfo", "studentRegistration", "assessments", "studentAssessment", "vle", "studentVle"]
CLICK_COLS = ["code_module", "code_presentation", "id_student", "id_site", "date", "sum_click"]


def table_key(filename: str) -> str | None:
    """'studentVle2.csv.bz2' -> 'studentVle'. Matches on the table name only, case-insensitively."""
    base = re.sub(r"\.(csv|tsv|txt|bz2|gz|zip)+$", "", Path(filename).name, flags=re.I)
    base = re.sub(r"[\s_\-]*\(?\d+\)?$", "", base)           # 'studentVle2', 'studentInfo (1)'
    for k in REQUIRED:
        if base.lower() == k.lower():
            return k
    return None


def _compression(path: Path) -> str | None:
    """Detect by content, not name: a bzip2 file called .csv is common (the earlier studentVle2.csv was one)."""
    with open(path, "rb") as f:
        head = f.read(3)
    if head[:3] == b"BZh":
        return "bz2"
    if head[:2] == b"\x1f\x8b":
        return "gzip"
    return None


def _read(path: Path, **kw) -> pd.DataFrame:
    return pd.read_csv(path, compression=_compression(path), **kw)


def _need(df: pd.DataFrame, cols: list[str], table: str):
    miss = [c for c in cols if c not in df.columns]
    if miss:
        raise ValueError(f"{table} is missing the column(s): {', '.join(miss)}. Is this the original OULAD {table} table?")


def read_clicks(path: Path, max_day: int, progress: Callable[[int], None] | None = None) -> tuple[pd.DataFrame, int]:
    parts, n_rows = [], 0
    comp = _compression(path)
    head = pd.read_csv(path, compression=comp, nrows=2)
    _need(head, CLICK_COLS, "studentVle")
    for chunk in pd.read_csv(path, compression=comp, usecols=CLICK_COLS, chunksize=2_000_000, na_values=["?"]):
        n_rows += len(chunk)
        parts.append(chunk[chunk["date"] <= max_day])
        if progress:
            progress(n_rows)
    clicks = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=CLICK_COLS)
    return clicks, n_rows


def build_from_tables(info, reg, asm, sa, vle, clicks, cutoff: int = MAIN_CUTOFF) -> tuple[pd.DataFrame, dict]:
    for df, cols, name in [(info, KEYS + ["gender", "highest_education", "imd_band", "num_of_prev_attempts", "studied_credits", "disability", "final_result", "age_band"], "studentInfo"),
                           (reg, KEYS + ["date_registration", "date_unregistration"], "studentRegistration"),
                           (asm, ["id_assessment", "code_module", "code_presentation"], "assessments"),
                           (sa, ["id_assessment", "id_student", "date_submitted"], "studentAssessment"),
                           (vle, ["id_site", "activity_type"], "vle")]:
        _need(df, cols, name)
    subs = sa.merge(asm[["id_assessment", "code_module", "code_presentation"]], on="id_assessment")
    base = info.merge(reg[KEYS + ["date_registration", "date_unregistration"]], on=KEYS, how="left")
    base["imd_band"] = base["imd_band"].replace({"?": np.nan, "10-20": "10-20%"})
    base["imd_ord"] = base["imd_band"].map({b: i for i, b in enumerate(IMD_LEVELS)})
    base["edu_ord"] = base["highest_education"].map({e: i for i, e in enumerate(EDU_ORDER)})
    base["disability_bin"] = (base["disability"] == "Y").astype(int)

    clicks = clicks.copy()
    site_type = vle.drop_duplicates("id_site").set_index("id_site")["activity_type"]
    clicks["activity_type"] = clicks["id_site"].map(site_type)

    # NOTE (kept on purpose): as in the notebook, clicks_prestart, click_trend, clicks_forum and n_submitted are attached to
    # the table of students who have at least one click in days 0..cutoff. A student with no click in the window therefore
    # gets 0 for all of them, even if they submitted work or clicked before day 0. The trained models learned this
    # definition, so it is reproduced exactly rather than "fixed" here.
    inwin = clicks[(clicks["date"] >= 0) & (clicks["date"] <= cutoff)]
    f = inwin.groupby(KEYS).agg(clicks_total=("sum_click", "sum"), active_days=("date", "nunique"),
                                first_day=("date", "min"), last_day=("date", "max"))
    f["clicks_prestart"] = clicks[clicks["date"] < 0].groupby(KEYS)["sum_click"].sum()
    late = inwin["date"] > cutoff / 2
    half = inwin.assign(late=late).groupby(KEYS + ["late"])["sum_click"].sum().unstack(fill_value=0)
    f["click_trend"] = half.get(True, 0) - half.get(False, 0)
    f["clicks_forum"] = inwin[inwin["activity_type"] == "forumng"].groupby(KEYS)["sum_click"].sum()
    f["n_submitted"] = subs[subs["date_submitted"] <= cutoff].groupby(KEYS).size()
    f = f.reset_index()
    out = base.merge(f, on=KEYS, how="left")
    for c in ["clicks_total", "active_days", "clicks_prestart", "click_trend", "clicks_forum", "n_submitted"]:
        out[c] = out[c].fillna(0)
    out["first_access_day"] = out["first_day"].fillna(cutoff + 1)
    out["days_since_last_access"] = (cutoff - out["last_day"]).fillna(cutoff + 1)

    n_all = len(out)
    left = out["date_unregistration"].notna() & (out["date_unregistration"] <= cutoff)
    late_reg = out["date_registration"].notna() & (out["date_registration"] > cutoff)
    keep = ~left & ~late_reg                                  # the notebook's risk set
    cohort = out[keep].copy()
    grp = {b: g for g, bands in IMD_GROUPS.items() for b in bands}
    cohort["imd_group"] = cohort["imd_band"].map(grp).fillna("Unknown")
    cols = KEYS + NUMERIC + ["gender", "age_band", "imd_band", "imd_group", "final_result"]
    cohort = cohort[cols].reset_index(drop=True)
    stats = dict(enrolments=int(n_all), left_by_cutoff=int(left.sum()), registered_after_cutoff=int((late_reg & ~left).sum()),
                 risk_set=int(len(cohort)), no_clicks=int((cohort["clicks_total"] == 0).sum()),
                 students_with_clicks_rows=int(len(clicks)))
    return cohort, stats


def build_from_folder(files: dict[str, Path], progress: Callable[[str, int], None] | None = None) -> tuple[pd.DataFrame, dict]:
    missing = [k for k in REQUIRED if k not in files]
    if missing:
        raise ValueError("These OULAD tables are missing: " + ", ".join(missing) + ". All six are needed: " + ", ".join(REQUIRED) + ".")
    say = progress or (lambda p, n=0: None)
    say("Reading the small tables", 0)
    info = _read(files["studentInfo"])
    reg = _read(files["studentRegistration"], na_values=["?"])
    asm = _read(files["assessments"], na_values=["?"])
    sa = _read(files["studentAssessment"], na_values=["?"])
    vle = _read(files["vle"], na_values=["?"])
    say("Reading the click table (days up to 28 are kept)", 0)
    clicks, n_click_rows = read_clicks(files["studentVle"], MAIN_CUTOFF, lambda n: say("Reading the click table (days up to 28 are kept)", n))
    say("Building features", n_click_rows)
    cohort, stats = build_from_tables(info, reg, asm, sa, vle, clicks)
    stats["click_rows_read"] = int(n_click_rows)
    if n_click_rows < 5_000_000:
        stats["warning"] = (f"The click table has only {n_click_rows:,} rows. The full OULAD studentVle has about 10.6 million; "
                            "a shorter file (for example one cut at Excel's 1,048,575-row limit) leaves most course presentations "
                            "without clicks, and their students would look inactive.")
    return cohort, stats
