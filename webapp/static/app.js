/* DropAlert front end: no build step, no external libraries. */
const S = {
  info: null, research: null, sid: null, filename: '', scored: false, hasOutcome: false, report: null,
  model: 'LightGBM', high: null, med: null, up: null, auditCols: [],
  f: { band: '', module: '', q: '', sort: 'risk', desc: true, page: 1, size: 25 },
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = () => $('#view');
const E = C.esc;

/* ------------------------------------------------------------------ helpers */
async function api(path, opt = {}) {
  const r = await fetch(path, opt);
  let j = null; try { j = await r.json(); } catch (e) { /* not json */ }
  if (!r.ok) { const e = new Error((j && (j.detail || j.message)) || r.statusText); e.data = j; e.status = r.status; throw e; }
  return j;
}
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', err ? 6000 : 2800); }
const qs = o => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const sess = p => `/api/session/${S.sid}/${p}`;
const label = v => (S.info.specs.find(s => s.name === v) || {}).label || v;
const short = v => ({ code_module: 'Course module', clicks_total: 'Total clicks', active_days: 'Active days', clicks_prestart: 'Pre-start clicks', first_access_day: 'First access day', days_since_last_access: 'Days since last access', click_trend: 'Click trend', clicks_forum: 'Forum clicks', n_submitted: 'Submissions', date_registration: 'Registration day', num_of_prev_attempts: 'Previous attempts', studied_credits: 'Credits', edu_ord: 'Education', imd_ord: 'Deprivation (IMD)', disability_bin: 'Disability' }[v] || v);
const EDU = ['No formal quals', 'Below A level', 'A level', 'HE qualification', 'Postgraduate'];
function fmtVal(v, x) {
  if (x == null || (typeof x === 'number' && isNaN(x))) return 'missing';
  if (typeof x === 'string') return x;
  if (v === 'edu_ord') return EDU[x] ?? x;
  if (v === 'imd_ord') return `${x * 10}–${x * 10 + 10}%`;
  if (v === 'disability_bin') return x ? 'Yes' : 'No';
  return Number.isInteger(x) ? x.toLocaleString() : x.toFixed(1);
}
const riskCol = b => b === 'High' ? 'var(--high)' : b === 'Medium' ? 'var(--med)' : 'var(--low)';
const bandPill = b => `<span class="pill ${b}">${b}</span>`;
function table(rows, cols, o = {}) {
  return `<div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${E(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.f ? c.f(r) : E(r[c.k] ?? '–')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function head(title, sub, right = '') { return `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="row">${right}</div></div>`; }
function noData(what = 'this page') {
  return `<div class="card empty"><h2>No dataset loaded yet</h2><p>${E(what)} needs scored students. Load the project's held-out students or upload your own file.</p>
  <div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" data-act="demo">Try the project's held-out students</button><a class="btn" href="#/upload">Upload a file</a></div></div>`;
}
function wireActs(root = view()) {
  $$('[data-act="demo"]', root).forEach(b => b.onclick = loadDemo);
}
function setCrumb(t, s) { $('#crumb').innerHTML = `${E(t)}${s ? `<small>${E(s)}</small>` : ''}`; }
const modelThr = () => S.info.thresholds[S.model];
function resetCuts() { S.high = modelThr(); S.med = modelThr() / 2; }
function cutQ() { return qs({ model: S.model, high: S.high, med: S.med }); }

/* ------------------------------------------------------------------ navigation and routing */
const NAV = [
  ['Workspace'],
  ['#/', '◎', 'Overview'], ['#/upload', '⇪', 'Upload & schema'],
  ['Your students'],
  ['#/ranking', '≣', 'Risk ranking', 1], ['#/importance', '▤', 'Why: single factors', 1], ['#/combos', '⬡', 'Why: factor pairs', 1],
  ['Evidence'],
  ['#/performance', '◔', 'Model performance'], ['#/fairness', '⚖', 'Fairness check', 1], ['#/study', '❖', 'Study results'], ['#/about', 'ⓘ', 'Limits & method'],
];
function drawNav() {
  const cur = location.hash.split('/')[1] || '';
  $('#nav').innerHTML = NAV.map(n => n.length === 1 ? `<div class="grp">${n[0]}</div>` :
    `<a href="${n[0]}" class="${('#/' + cur) === n[0] || (cur === 'student' && n[0] === '#/ranking') ? 'on' : ''} ${n[3] && !S.scored ? 'lock' : ''}"><span class="ic">${n[1]}</span>${n[2]}</a>`).join('');
  $('#sideFoot').innerHTML = S.scored ? `<b>${E(S.filename)}</b><br>${S.report.rows_scored.toLocaleString()} students scored` : 'No dataset loaded';
  $('#side').classList.remove('open');
}
const ROUTES = { '': pgOverview, upload: pgUpload, ranking: pgRanking, student: pgStudent, importance: pgImportance, combos: pgCombos, performance: pgPerformance, fairness: pgFairness, study: pgStudy, about: pgAbout };
async function route() {
  drawNav();
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const fn = ROUTES[parts[0]] || pgOverview;
  window.__poll && clearTimeout(window.__poll);
  view().innerHTML = '<div class="empty"><span class="spin"></span></div>';
  try { await fn(parts.slice(1)); } catch (e) {
    if (e.status === 404 && /expired/.test(e.message)) { S.scored = false; S.sid = null; drawNav(); }
    view().innerHTML = `<div class="note-box bad"><b>Something went wrong.</b> ${E(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* ------------------------------------------------------------------ OVERVIEW */
async function pgOverview() {
  setCrumb('Overview');
  const K = S.research.key, tm = K.test_metrics.LightGBM;
  if (!S.scored) {
    view().innerHTML = `
    <section class="card hero" style="padding:28px">
      <div>
        <span class="pill neutral">MSc Applied Statistics · OULAD</span>
        <h1 style="margin-top:10px">See who may drop out, and why, within the first 28 days.</h1>
        <p class="muted" style="font-size:15px;margin:10px 0 18px">Upload one row per student. DropAlert ranks them by calibrated dropout risk with the study's three models, then explains each score with SHAP: single factors and factor pairs.</p>
        <div class="row"><button class="btn primary big" data-act="demo">Try the project's held-out students</button><a class="btn big" href="#/upload">Upload your file</a></div>
        <p class="muted" style="margin-top:12px;font-size:12.5px">The demo loads the ${S.research.test_n.toLocaleString()} students the models never saw in training. Your file stays on this computer.</p>
      </div>
      <ol class="steps">
        <li><div><b>Upload or load</b><br><span class="muted">CSV or Excel. Columns are matched by name and by their values; you confirm the match.</span></div></li>
        <li><div><b>Validate</b><br><span class="muted">Prediction is blocked if an input is missing. Unreadable rows are excluded and counted, never filled in.</span></div></li>
        <li><div><b>Rank and explain</b><br><span class="muted">High, Medium, Low by risk percentage, with the factors and factor pairs behind each score.</span></div></li>
      </ol>
    </section>
    <div class="grid g4" style="margin-top:16px">
      <div class="card kpi"><div class="lab">Risk set (still registered at day 28)</div><div class="val">${K.risk_set.toLocaleString()}</div><div class="note">of ${K.n_all.toLocaleString()} enrolments; ${K.n_left_by_28.toLocaleString()} had already left</div></div>
      <div class="card kpi"><div class="lab">Dropout rate</div><div class="val">${C.pct(K.dropout_rate)}</div><div class="note">Withdrawn vs Pass, Distinction and Fail</div></div>
      <div class="card kpi"><div class="lab">LightGBM ROC-AUC (held-out)</div><div class="val">${C.num(tm['ROC-AUC'])}</div><div class="note">moderate; a prioritisation aid, not a verdict</div></div>
      <div class="card kpi"><div class="lab">Recall at the study threshold</div><div class="val">${C.pct(tm.Recall, 0)}</div><div class="note">precision ${C.pct(tm.Precision, 0)}, so most flags are not dropouts</div></div>
    </div>
    <div class="note-box warn" style="margin-top:16px"><b>Read this first.</b> At day 28 students who are still registered look alike, so discrimination is modest (AUC ≈ 0.70). Treat the ranking as a way to decide whom to contact first, not as a prediction about any one person. The Fairness and Limits pages show where it is weaker.</div>`;
    wireActs(); return;
  }
  const s = await api(sess('summary?' + cutQ()));
  const n = s.n;
  setCrumb('Overview', s.filename);
  const top = await api(sess('ranking?' + qs({ model: S.model, high: S.high, med: S.med, size: 8 })));
  const bt = s.bands;
  view().innerHTML = `
  ${head('Overview', `${E(s.filename)}: ${n.toLocaleString()} students scored with <b>${S.model}</b>.`, `<a class="btn primary" href="#/ranking">Open risk ranking</a><a class="btn" href="/api/session/${S.sid}/download?${cutQ()}">Download ranked CSV</a>`)}
  <div class="grid g4">
    <div class="card kpi"><div class="lab">Students scored</div><div class="val">${n.toLocaleString()}</div><div class="note">${s.report.rows_excluded ? `${s.report.rows_excluded.toLocaleString()} excluded (see Upload page)` : 'no rows excluded'}</div></div>
    <div class="card kpi"><div class="lab">High risk</div><div class="val" style="color:var(--high)">${s.counts.High.toLocaleString()}</div><div class="note">${C.pct(s.counts.High / n)} of students, risk ≥ ${C.pct(s.high_cut)}</div></div>
    <div class="card kpi"><div class="lab">Medium risk</div><div class="val" style="color:var(--med)">${s.counts.Medium.toLocaleString()}</div><div class="note">${C.pct(s.counts.Medium / n)}, risk ${C.pct(s.med_cut)}–${C.pct(s.high_cut)}</div></div>
    <div class="card kpi"><div class="lab">Average predicted risk</div><div class="val">${C.pct(s.mean_risk)}</div><div class="note">${s.has_outcome ? `observed dropout ${C.pct(bt.reduce((a, b) => a + (b.dropouts || 0), 0) / n)}` : 'no outcome column supplied'}</div></div>
  </div>
  <div class="grid g21" style="margin-top:16px">
    <div class="card"><h2>How risk is spread</h2><div class="sub">Each bar is a slice of predicted risk. Colours follow the High / Medium / Low cut-offs.</div>${C.hist(s.hist.counts, s.hist.edges, [s.high_cut, s.med_cut])}</div>
    <div class="card"><h2>Risk bands</h2><div class="sub">${s.has_outcome ? 'Predicted versus what actually happened.' : 'Add an outcome column to compare with what happened.'}</div>
      ${table(bt, [{ h: 'Band', f: r => bandPill(r.band) }, { h: 'Students', num: 1, f: r => r.n.toLocaleString() }, { h: 'Predicted', num: 1, f: r => C.pct(r.mean_risk) }].concat(s.has_outcome ? [{ h: 'Observed', num: 1, f: r => C.pct(r.observed_rate) }] : []))}
      ${s.has_outcome ? '<p class="muted" style="margin-top:8px;font-size:12.5px">If Predicted and Observed are close, the risk percentages can be read as real frequencies.</p>' : ''}</div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Highest-risk students</h2><div class="sub">Click a row to see why.</div>
      <div id="topTbl">${table(top.rows, [{ h: 'Rank', num: 1, k: 'rank' }, { h: 'Student', k: 'id' }, { h: 'Risk', num: 1, f: r => `<b>${C.pct(r.risk, 0)}</b>` }, { h: 'Band', f: r => bandPill(r.band) }, { h: 'Main reason', f: r => r.reasons[0] ? E(short(r.reasons[0].variable)) : '–' }])}</div>
    </div>
    <div class="card"><h2>Average risk by course module</h2><div class="sub">Module is the strongest single factor in the study.</div>
      ${C.barsH(s.by_module.sort((a, b) => b.mean_risk - a.mean_risk).map(m => ({ label: `${m.module} (${m.n.toLocaleString()})`, value: m.mean_risk, color: 'var(--accent)' })), { w: 560, labelW: 130, fmt: v => C.pct(v), axisFmt: v => (v * 100).toFixed(0) + '%' })}</div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Do the three models agree?</h2><div class="sub">Spearman rank correlation of the risk scores on your students.</div>
    <div class="tbl-wrap">${table(S.info.models.map(a => ({ a })), [{ h: '' , f: r => `<b>${r.a}</b>` }].concat(S.info.models.map(b => ({ h: b, num: 1, f: r => s.agreement[r.a][b].toFixed(2) }))))}</div></div>`;
  $$('#topTbl tbody tr').forEach((tr, i) => { tr.classList.add('click'); tr.onclick = () => location.hash = '#/student/' + top.rows[i].pos; });
}

async function loadDemo() {
  try {
    toast('Loading the held-out students…');
    const u = await api('/api/demo', { method: 'POST' });
    S.up = initUp(u);
    await runPredict();
    if (location.hash === '#/' || location.hash === '') route(); else location.hash = '#/';
  } catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------------------ UPLOAD & SCHEMA */
function initUp(u) {
  const m = {}; S.info.specs.forEach(s => m[s.name] = (u.mapping[s.name] || {}).column || '');
  return { ...u, map: m, conf: Object.fromEntries(Object.entries(u.mapping).map(([k, v]) => [k, v.confident])), opt: { id: u.optional.id || '', outcome: u.optional.outcome || '', positive: u.optional.positive || [], group: u.optional.group || '', audit: u.optional.audit || [] }, outVals: null, done: false };
}
async function runPredict() {
  const u = S.up;
  const body = { mapping: u.map, id_col: u.opt.id, outcome_col: u.opt.outcome, positive: u.opt.positive, group_col: u.opt.group, audit_cols: u.opt.audit };
  let r;
  try { r = await api(`/api/session/${u.sid}/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { u.blocked = e.data || { message: e.message }; throw new Error(u.blocked.message || e.message); }
  u.blocked = null; u.done = true; u.report = r.report;
  S.sid = u.sid; S.scored = true; S.filename = u.filename; S.report = r.report; S.hasOutcome = r.has_outcome; S.auditCols = r.audit_cols;
  resetCuts(); drawNav();
}
async function pgUpload() {
  setCrumb('Upload & schema');
  const draw = () => {
    const u = S.up;
    let h = head('Upload & schema', 'One row per student (or student-course) with the 28-day features below. Column names do not have to match: pick the right column for each input.',
      `<button class="btn" id="tpl">Download blank template</button><button class="btn" data-act="demo">Load held-out demo</button>`);
    h += `<div class="dz" id="dz"><b>Drop a CSV or Excel file here</b><span class="muted">or</span> <label class="btn primary" style="margin-left:6px">Choose file<input type="file" id="file" accept=".csv,.tsv,.txt,.xlsx,.xls" hidden></label><div class="muted" style="margin-top:8px;font-size:12.5px">.csv, .tsv, .xlsx, .xls · up to 200 MB · stays on this computer</div></div>`;
    h += buildPanel();
    if (u) h += mappingHtml(u);
    h += `<details style="margin-top:16px"><summary>What the 15 inputs mean, and how to build them from the raw OULAD tables</summary>
      <div class="tbl-wrap" style="margin-top:10px">${table(S.info.specs, [{ h: 'Input', f: r => `<b>${E(r.label)}</b><br><small>${r.name}</small>` }, { h: 'Group', k: 'group' }, { h: 'Meaning', k: 'help' }])}</div>
      <p class="muted" style="margin-top:10px">The browser cannot read the 450 MB click table, so the 28-day features are built once outside the app. The project notebook does this (section 1) and caches the result in <code>outputs/cache/features_by_cutoff.csv</code>. Two columns are allowed to be blank because the models were trained with blanks there: ${S.info.nan_allowed.map(x => `<code>${x}</code>`).join(', ')}.</p></details>`;
    view().innerHTML = h; wireUpload(); wireActs();
  };
  draw();
  S._drawUp = draw;
}
/* ---- build the 28-day table from the six raw OULAD tables ---- */
const TABLES = ['studentInfo', 'studentRegistration', 'assessments', 'studentAssessment', 'vle', 'studentVle'];
function buildPanel() {
  const b = S.bld;
  const busy = b && b.status === 'running';
  return `<div class="card" style="margin-top:16px"><h2>Have the raw OULAD tables instead? <span class="pill" style="background:var(--med-soft);color:var(--med);font-size:11px;padding:2px 8px;border-radius:99px;vertical-align:middle">Experimental</span></h2>
    <div class="sub"><b>Experimental:</b> this builder is checked against the notebook's logic and on synthetic clicks, but has not been run on the full 450 MB <code>studentVle.csv</code>. Compare a few students with the notebook's cache before relying on it. DropAlert builds the day-28 features itself, the same way the notebook does, and keeps only students still registered on day 28. Needs all six: ${TABLES.map(t => `<code>${t}</code>`).join(', ')} (.csv, or compressed .bz2/.gz).</div>
    <div class="grid g2">
      <div><b>Pick the folder on this computer</b><p class="muted" style="font-size:12.5px;margin:2px 0 8px">Best for the 450 MB click table: it is read in place, nothing is copied.</p>
        <div class="row"><input type="text" id="bpath" placeholder="D:\\data\\oulad" style="flex:1" value="${E(S.bpath || '')}" ${busy ? 'disabled' : ''}><button class="btn primary" id="bgo" ${busy ? 'disabled' : ''}>Build</button></div></div>
      <div><b>Or choose the six files</b><p class="muted" style="font-size:12.5px;margin:2px 0 8px">Uploaded to the local server, used once, then deleted. The click table can take a few minutes to upload.</p>
        <label class="btn" style="${busy ? 'opacity:.5;pointer-events:none' : ''}">Choose files<input type="file" id="bfiles" multiple accept=".csv,.bz2,.gz,.txt" hidden></label></div>
    </div>
    <div id="bstat">${buildStatHtml()}</div></div>`;
}
function buildStatHtml() {
  const b = S.bld; if (!b) return '';
  if (b.status === 'running') return `<div class="note-box"><span class="spin"></span> ${E(b.phase || 'Working')}${b.rows_read ? ` · ${b.rows_read.toLocaleString()} click rows read` : ''}</div>`;
  if (b.status === 'error') return `<div class="note-box bad"><b>Could not build.</b> ${E(b.error)}</div>`;
  return '';
}
function wireBuild() {
  const go = $('#bgo'); if (!go) return;
  const start = async (call) => {
    try { S.bld = { status: 'running', phase: 'Starting' }; $('#bstat').innerHTML = buildStatHtml(); const r = await call(); pollBuild(r.id, r.ignored); }
    catch (e) { S.bld = { status: 'error', error: e.message }; $('#bstat').innerHTML = buildStatHtml(); }
  };
  go.onclick = () => { S.bpath = $('#bpath').value; start(() => api('/api/build/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: S.bpath }) })); };
  $('#bfiles').onchange = e => {
    const fd = new FormData(); [...e.target.files].forEach(f => fd.append('files', f));
    start(() => { $('#bstat').innerHTML = '<div class="note-box"><span class="spin"></span> Uploading… large files take a while</div>'; return api('/api/build/upload', { method: 'POST', body: fd }); });
  };
}
async function pollBuild(id, ignored) {
  const j = await api('/api/build/' + id);
  S.bld = j;
  if (j.status === 'running') { const el = $('#bstat'); if (el) el.innerHTML = buildStatHtml(); setTimeout(() => pollBuild(id, ignored), 1000); return; }
  if (j.status === 'done') {
    S.up = initUp(j.result); S.up.build = j.stats; S.up.ignored = ignored || []; S.bld = null;
    if (location.hash.startsWith('#/upload') && S._drawUp) { S._drawUp(); toast('Features built. Check the matches and predict.'); }
  } else if ($('#bstat')) $('#bstat').innerHTML = buildStatHtml();
}

function mappingHtml(u) {
  const cols = u.columns.map(c => c.name);
  const colInfo = n => u.columns.find(c => c.name === n);
  const opts = sel => `<option value="">— not mapped —</option>` + cols.map(c => `<option ${c === sel ? 'selected' : ''}>${E(c)}</option>`).join('');
  const groups = [...new Set(S.info.specs.map(s => s.group))];
  const missing = S.info.specs.filter(s => !u.map[s.name]).length;
  const bs = u.build;
  let h = `<div class="card" style="margin-top:16px">${bs ? `<div class="note-box good"><b>Built from the raw tables.</b> ${bs.enrolments.toLocaleString()} enrolments → ${bs.left_by_cutoff.toLocaleString()} had already left by day 28 and ${bs.registered_after_cutoff.toLocaleString()} registered after it, so <b>${bs.risk_set.toLocaleString()}</b> are scored. ${bs.no_clicks.toLocaleString()} of them have no clicks in days 0-28. ${bs.click_rows_read.toLocaleString()} click rows read.${u.ignored && u.ignored.length ? ` Ignored files: ${u.ignored.map(E).join(', ')}.` : ''}</div>${bs.warning ? `<div class="note-box warn">${E(bs.warning)}</div>` : ''}` : ''}<div class="row"><div><h2>${E(u.filename)}</h2><div class="sub">${u.rows.toLocaleString()} rows × ${u.cols} columns</div></div><div class="spacer"></div>
    ${missing ? `<span class="pill High">${missing} input${missing > 1 ? 's' : ''} not mapped</span>` : '<span class="pill Low">all inputs mapped</span>'}</div>`;
  groups.forEach(g => {
    h += `<h3 style="margin:14px 0 2px;color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em">${g}</h3>`;
    S.info.specs.filter(s => s.group === g).forEach(s => {
      const cur = u.map[s.name], ci = cur && colInfo(cur);
      const st = !cur ? '<span class="st bad">✕ required</span>' : (u.conf[s.name] ? '<span class="st ok">✓ matched</span>' : '<span class="st warn">! please check</span>');
      h += `<div class="map-row"><div class="nm"><b>${E(s.label)}</b><small>${E(s.help)}</small></div>
        <div><select data-spec="${s.name}" style="width:100%">${opts(cur)}</select>${ci ? `<small>e.g. ${ci.sample.map(x => E(String(x))).join(', ')}${ci.missing ? ` · ${ci.missing} blank` : ''}</small>` : ''}</div><div>${st}</div></div>`;
    });
  });
  const o = u.opt;
  h += `<h3 style="margin:18px 0 8px">Optional columns</h3><div class="grid g3">
    <label class="field">Student ID<select id="o_id">${opts(o.id)}</select></label>
    <label class="field">Known outcome (to measure performance)<select id="o_out">${opts(o.outcome)}</select></label>
    <label class="field">Presentation / cohort (for stability by group)<select id="o_grp">${opts(o.group)}</select></label></div>
    <div id="posbox" style="margin-top:10px"></div>
    <div style="margin-top:10px"><span class="field">Columns to audit for fairness (not used as model inputs)</span><div>${cols.filter(c => { const ci = colInfo(c); return ci.unique >= 2 && ci.unique <= 15; }).map(c => `<span class="chip btnchip ${o.audit.includes(c) ? 'on' : ''}" data-aud="${E(c)}">${E(c)}</span>`).join('') || '<small>No column with 2–15 distinct values.</small>'}</div></div>
    <div class="row" style="margin-top:18px"><button class="btn primary big" id="go" ${missing ? 'disabled' : ''}>Confirm mapping and predict risk</button>${missing ? '<span class="muted">Map every required input to continue. A missing input is never filled in.</span>' : ''}</div>
    <div id="blocked"></div></div>`;
  if (u.done && u.report) h += reportHtml(u.report);
  return h;
}
function reportHtml(r) {
  return `<div class="card" style="margin-top:16px"><div class="row"><div><h2>Validation report</h2><div class="sub">${r.rows_scored.toLocaleString()} of ${r.rows_uploaded.toLocaleString()} rows scored${r.rows_excluded ? `, ${r.rows_excluded.toLocaleString()} excluded` : ''}.</div></div><div class="spacer"></div><a class="btn primary" href="#/">Open results</a></div>
    ${r.rows_excluded ? '<div class="note-box warn">Excluded rows had a blank or unreadable value in an input that cannot be blank. They were not filled in or guessed.</div>' : '<div class="note-box good">Every row passed validation.</div>'}
    ${r.warnings.map(w => `<div class="note-box warn">${E(w)}</div>`).join('')}
    ${r.outcome_unknown ? `<div class="note-box">${r.outcome_unknown} scored rows have no outcome and are left out of the performance checks.</div>` : ''}
    ${table(r.per_input.filter(i => i.missing || i.invalid || i.outside_training_range), [{ h: 'Input', f: i => E(i.label) }, { h: 'Column', f: i => E(i.column) }, { h: 'Blank', num: 1, k: 'missing' }, { h: 'Unreadable', num: 1, k: 'invalid' }, { h: 'Excluded rows', num: 1, k: 'excluded' }, { h: 'Outside training range', num: 1, f: i => i.outside_training_range ?? '–' }]) || ''}</div>`;
}
function wireUpload() {
  const dz = $('#dz'), file = $('#file');
  if (!dz) return;
  file.onchange = () => file.files[0] && up(file.files[0]);
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => e.dataTransfer.files[0] && up(e.dataTransfer.files[0]));
  $('#tpl').onclick = () => { const names = S.info.specs.map(s => s.name); const blob = new Blob([['id_student', ...names, 'final_result'].join(',') + '\n'], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dropalert_template.csv'; a.click(); };
  wireBuild();
  const u = S.up; if (!u) return;
  $$('select[data-spec]').forEach(s => s.onchange = () => { u.map[s.dataset.spec] = s.value; u.conf[s.dataset.spec] = true; S._drawUp(); });
  $('#o_id').onchange = e => u.opt.id = e.target.value;
  $('#o_grp').onchange = e => u.opt.group = e.target.value;
  $('#o_out').onchange = e => { u.opt.outcome = e.target.value; u.opt.positive = []; loadOutVals(); };
  $$('[data-aud]').forEach(c => c.onclick = () => { const k = c.dataset.aud; u.opt.audit = u.opt.audit.includes(k) ? u.opt.audit.filter(x => x !== k) : [...u.opt.audit, k]; c.classList.toggle('on'); });
  $('#go').onclick = async () => {
    const b = $('#go'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Predicting…';
    try { await runPredict(); toast('Prediction complete'); S._drawUp(); $('#view').lastElementChild.scrollIntoView({ behavior: 'smooth' }); }
    catch (e) { b.disabled = false; b.textContent = 'Confirm mapping and predict risk'; $('#blocked').innerHTML = `<div class="note-box bad"><b>Prediction is blocked.</b> ${E(e.message)}</div>${u.blocked && u.blocked.report ? reportHtml(u.blocked.report) : ''}`; }
  };
  loadOutVals();
}
async function loadOutVals() {
  const u = S.up, box = $('#posbox'); if (!box) return;
  if (!u.opt.outcome) { box.innerHTML = ''; return; }
  const v = await api(sess2(u.sid, 'values?col=' + encodeURIComponent(u.opt.outcome)));
  box.innerHTML = `<span class="field">Which values mean “dropped out”?${v.total_unique > 25 ? ' (first 25 shown)' : ''}</span><div>${v.values.map(x => `<span class="chip btnchip ${u.opt.positive.includes(x.value) ? 'on' : ''}" data-pos="${E(x.value)}">${E(x.value)} · ${x.n.toLocaleString()}</span>`).join('')}</div>`;
  $$('[data-pos]', box).forEach(c => c.onclick = () => { const k = c.dataset.pos; u.opt.positive = u.opt.positive.includes(k) ? u.opt.positive.filter(x => x !== k) : [...u.opt.positive, k]; c.classList.toggle('on'); });
}
const sess2 = (sid, p) => `/api/session/${sid}/${p}`;
async function up(f) {
  try {
    toast('Reading ' + f.name + '…');
    const fd = new FormData(); fd.append('file', f);
    const u = await api('/api/upload', { method: 'POST', body: fd });
    S.up = initUp(u); S._drawUp(); toast('File read. Check the column matches.');
  } catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------------------ RISK RANKING */
async function pgRanking() {
  setCrumb('Risk ranking', S.model);
  if (!S.scored) { view().innerHTML = head('Risk ranking') + noData('The ranking'); wireActs(); return; }
  const mods = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG'];
  view().innerHTML = head('Risk ranking', `Students ordered by calibrated dropout risk from <b>${S.model}</b>. Click a student to see why.`,
    `<a class="btn" id="dl" href="#">Download ranked CSV</a>`) + `
  <div class="card"><div class="row" style="align-items:flex-end">
    <label class="field">Search student ID<input type="search" id="q" placeholder="e.g. 577401" value="${E(S.f.q)}"></label>
    <label class="field">Band<select id="fb"><option value="">All</option>${['High', 'Medium', 'Low'].map(b => `<option ${S.f.band === b ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
    <label class="field">Module<select id="fm"><option value="">All</option>${mods.map(b => `<option ${S.f.module === b ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
    <label class="field">Sort by<select id="fs"><option value="risk">Risk</option><option value="id">Student ID</option><option value="module">Module</option></select></label>
    <label class="field">Rows<select id="fz">${[10, 25, 50, 100].map(n => `<option ${S.f.size === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <div class="spacer"></div>
    <label class="field" style="min-width:210px">High risk from <b id="hv"></b><input type="range" id="hc" min="0.05" max="0.8" step="0.005"></label>
    <label class="field" style="min-width:210px">Medium risk from <b id="mv"></b><input type="range" id="mc" min="0.02" max="0.6" step="0.005"></label>
    <button class="btn" id="rc" title="Back to the study's thresholds">Reset</button></div>
    <p class="muted" style="font-size:12.5px;margin:10px 0 0">Defaults: High = the study's F1-optimal threshold for ${S.model} (${C.pct(modelThr())}); Medium = half of that. The cut-offs are a choice, not a model output; the Overview page shows how often each band actually dropped out when outcomes are known.</p>
  </div>
  <div class="card" style="margin-top:16px"><div id="rk"></div></div>`;
  $('#fs').value = S.f.sort;
  const sync = () => { $('#hc').value = S.high; $('#mc').value = S.med; $('#hv').textContent = C.pct(S.high); $('#mv').textContent = C.pct(S.med); };
  sync();
  let t; const reload = (reset = true) => { if (reset) S.f.page = 1; clearTimeout(t); t = setTimeout(loadRank, 160); };
  $('#q').oninput = e => { S.f.q = e.target.value; reload(); };
  $('#fb').onchange = e => { S.f.band = e.target.value; reload(); };
  $('#fm').onchange = e => { S.f.module = e.target.value; reload(); };
  $('#fs').onchange = e => { S.f.sort = e.target.value; S.f.desc = e.target.value === 'risk'; reload(); };
  $('#fz').onchange = e => { S.f.size = +e.target.value; reload(); };
  $('#hc').oninput = e => { S.high = +e.target.value; if (S.med > S.high) S.med = S.high; sync(); reload(); };
  $('#mc').oninput = e => { S.med = Math.min(+e.target.value, S.high); sync(); reload(); };
  $('#rc').onclick = () => { resetCuts(); sync(); reload(); };
  $('#dl').onclick = e => { e.preventDefault(); location.href = sess('download?' + cutQ()); };
  loadRank();
}
async function loadRank() {
  const f = S.f, box = $('#rk'); if (!box) return;
  const r = await api(sess('ranking?' + qs({ model: S.model, high: S.high, med: S.med, band: f.band, module: f.module, q: f.q, sort: f.sort, desc: f.desc, page: f.page, size: f.size })));
  const pages = Math.max(1, Math.ceil(r.total / f.size));
  box.innerHTML = `<div class="row" style="margin-bottom:6px"><b>${r.total.toLocaleString()}</b> students match</div>
  <div class="tbl-wrap"><table><thead><tr><th class="num">Rank</th><th>Student</th><th>Risk</th><th>Band</th><th>Module</th><th>Main risk factors (SHAP)</th><th class="num" title="Logistic Regression / Random Forest / LightGBM">3 models</th>${S.hasOutcome ? '<th>Outcome</th>' : ''}</tr></thead><tbody>
  ${r.rows.map(x => `<tr class="click" data-pos="${x.pos}"><td class="num">${x.rank.toLocaleString()}</td><td><b>${E(x.id)}</b></td>
    <td><div class="riskcell"><b>${C.pct(x.risk, 0)}</b><div class="bar" style="flex:1"><i style="width:${Math.min(100, x.risk * 100 / 0.8)}%;background:${riskCol(x.band)}"></i></div></div></td>
    <td>${bandPill(x.band)}</td><td>${x.module}</td>
    <td>${x.reasons.map(q => `<span class="chip" title="pushes risk up by ${q.shap.toFixed(2)} (log-odds)">${E(short(q.variable))}</span>`).join('') || '<small>none pushes risk up</small>'}</td>
    <td class="num"><small>${S.info.models.map(m => (x.others[m] * 100).toFixed(0)).join(' / ')}</small></td>
    ${S.hasOutcome ? `<td>${x.outcome === 1 ? '<span class="pill High">dropped out</span>' : x.outcome === 0 ? '<small>stayed</small>' : '–'}</td>` : ''}</tr>`).join('') || `<tr><td colspan="8" class="empty">No students match.</td></tr>`}
  </tbody></table></div>
  <div class="pager"><button class="btn" id="pp" ${f.page <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">Page ${f.page} of ${pages.toLocaleString()}</span><button class="btn" id="pn" ${f.page >= pages ? 'disabled' : ''}>Next ›</button></div>`;
  $$('tr.click', box).forEach(tr => tr.onclick = () => location.hash = '#/student/' + tr.dataset.pos);
  $('#pp').onclick = () => { S.f.page--; loadRank(); }; $('#pn').onclick = () => { S.f.page++; loadRank(); };
}

/* ------------------------------------------------------------------ ONE STUDENT */
async function pgStudent([pos]) {
  if (!S.scored) { view().innerHTML = head('Student') + noData('A student page'); wireActs(); return; }
  const s = await api(sess(`student/${pos}?` + cutQ()));
  setCrumb('Student ' + s.id, s.band + ' risk');
  const fac = s.factors.slice(0, 8);
  const rest = s.factors.slice(8).reduce((a, f) => a + f.points, 0);
  const items = fac.map(f => ({ label: E(`${short(f.variable)} = ${fmtVal(f.variable, f.value)}`), points: f.points, title: `${short(f.variable)}: ${f.shap.toFixed(3)} log-odds` }));
  if (s.factors.length > 8) items.push({ label: `${s.factors.length - 8} other factors`, points: rest, title: 'All remaining factors together' });
  view().innerHTML = head(`Student ${E(s.id)}`, `Explained by LightGBM (the study's primary model). Contributions are SHAP values: they describe what the model uses, not what causes dropout.`,
    `<a class="btn" href="#/ranking">‹ Back to ranking</a>`) + `
  <div class="grid g3">
    <div class="card kpi"><div class="lab">Dropout risk (${S.model})</div><div class="val" style="color:${riskCol(s.band)}">${C.pct(s.risk, 1)}</div><div class="note">${bandPill(s.band)} · the average student scores ${C.pct(s.base_risk, 0)}</div></div>
    <div class="card kpi"><div class="lab">All three models</div>${S.info.models.map(m => `<div class="row" style="justify-content:space-between"><span>${m}</span><b>${C.pct(s.models[m].risk, 0)} ${s.models[m].flagged ? '<span class="pill High">flagged</span>' : ''}</b></div>`).join('')}</div>
    <div class="card kpi"><div class="lab">${s.outcome != null ? 'What actually happened' : 'Outcome'}</div><div class="val" style="font-size:22px">${s.outcome === 1 ? 'Dropped out' : s.outcome === 0 ? 'Stayed' : 'not supplied'}</div><div class="note">${s.outcome != null ? 'from your outcome column' : 'add an outcome column to compare'}</div></div>
  </div>
  <div class="grid g21" style="margin-top:16px">
    <div class="card"><h2>Why this score</h2><div class="sub">Each bar moves risk from the average student (top) to this student (bottom). Red raises risk, blue lowers it. Units are percentage points, split in proportion to each factor's SHAP value.</div>${C.waterfall(items, s.base_risk, s.lgbm_risk)}
      ${Math.abs(s.lgbm_risk - s.risk) > 0.005 ? `<p class="muted" style="font-size:12.5px">The waterfall shows LightGBM (${C.pct(s.lgbm_risk)}); the headline number uses ${S.model}.</p>` : ''}</div>
    <div class="card"><h2>Factor pairs that matter here</h2><div class="sub">Exact SHAP interaction values for this student. The badge is how reliably the pair ranks near the top across your data (see Factor pairs).</div>
      ${table(s.pairs.slice(0, 6), [{ h: 'Pair', f: p => `${E(short(p.a))} × ${E(short(p.b))}` }, { h: 'Effect', num: 1, f: p => `<b style="color:${p.value >= 0 ? 'var(--up)' : 'var(--down)'}">${p.points >= 0 ? '+' : ''}${(p.points * 100).toFixed(1)} pts</b>` }, { h: '', f: p => p.badge ? `<span class="pill ${p.badge}">${p.badge}</span>` : '' }])}
      ${s.pairs[0] && !s.pairs[0].badge ? '<p class="muted" style="font-size:12.5px;margin-top:8px">Open <a href="#/combos">Factor pairs</a> once to add stability badges here.</p>' : ''}</div>
  </div>
  <div class="card" style="margin-top:16px"><h2>The student's data</h2><div class="sub">As uploaded.</div><div class="kv" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr));display:grid">${Object.entries(s.row).map(([k, v]) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:4px 0"><span class="muted">${E(k)}</span><b>${E(v ?? 'blank')}</b></div>`).join('')}</div></div>`;
}

/* ------------------------------------------------------------------ SINGLE FACTORS */
async function pgImportance() {
  setCrumb('Why: single factors');
  if (!S.scored) { view().innerHTML = head('Why: single factors') + noData('Feature importance'); wireActs(); return; }
  const d = await api(sess('importance'));
  const nb = Object.fromEntries(S.research.tables.table4_shap_importance.map(r => [r.name, r.Rank]));
  const swarmRows = d.rows.filter(r => d.swarm[r.variable]).slice(0, 8).map(r => ({ label: short(r.variable), ...d.swarm[r.variable] }));
  const ms = Object.entries(d.module_shap).sort((a, b) => b[1] - a[1]);
  const top3 = d.rows.slice(0, 3);
  view().innerHTML = head('Why: single factors', `Which inputs move the risk score most across your ${d.n.toLocaleString()} students. SHAP values from LightGBM; the whiskers are 95% bootstrap intervals over students.`) + `
  <div class="note-box">Top three on your data: <b>${top3.map(r => short(r.variable)).join(', ')}</b>, carrying ${C.pct(top3.reduce((a, r) => a + r.share, 0), 0)} of all single-factor influence. SHAP shows what the model relies on, not why students leave. Course module partly reflects how each course is designed and assessed.</div>
  <div class="grid g2">
    <div class="card"><h2>Global importance</h2><div class="sub">Mean |SHAP| in log-odds</div>${C.barsH(d.rows.map(r => ({ label: short(r.variable), value: r.mean_abs, lo: r.lo, hi: r.hi, color: 'var(--accent)' })), { w: 620, labelW: 150, fmt: v => v.toFixed(3) })}</div>
    <div class="card"><h2>Direction</h2><div class="sub">How the model reads each input. Rank in the study is the project's held-out test ranking.</div>
      ${table(d.rows, [{ h: '#', num: 1, k: 'rank' }, { h: 'Input', f: r => `<b>${E(short(r.variable))}</b>` }, { h: 'Effect', f: r => r.direction === 'categorical' ? 'depends on module' : r.direction === 'mixed' ? 'mixed' : r.direction.includes('higher risk') ? '<span style="color:var(--up)">higher value → more risk</span>' : '<span style="color:var(--down)">higher value → less risk</span>' }, { h: 'Study #', num: 1, f: r => nb[r.variable] ?? '–' }])}</div>
  </div>
  <div class="grid g21" style="margin-top:16px">
    <div class="card"><h2>SHAP beeswarm</h2><div class="sub">Each dot is a student (700 sampled). Position = push on risk; colour = the student's value for that input.</div>${C.swarm(swarmRows)}</div>
    <div class="card"><h2>Course module effect</h2><div class="sub">Average SHAP of the module input, by module (log-odds). Right = pushes risk up.</div>
      ${C.barsH(ms.map(([m, v]) => ({ label: `${m}  ${v >= 0 ? '↑ risk' : '↓ risk'}`, value: Math.abs(v), color: v >= 0 ? 'var(--up)' : 'var(--down)', title: `${m}: ${v >= 0 ? '+' : ''}${v.toFixed(3)} log-odds` })), { w: 440, labelW: 110, fmt: v => v.toFixed(2) })}</div>
  </div>`;
}

/* ------------------------------------------------------------------ FACTOR PAIRS (interaction reliability) */
async function pgCombos() {
  setCrumb('Why: factor pairs', 'interaction reliability');
  if (!S.scored) { view().innerHTML = head('Why: factor pairs') + noData('Interaction analysis'); wireActs(); return; }
  const st = await api(sess('explain/start'), { method: 'POST' });
  const step = async () => {
    const s = await api(sess('explain/status'));
    if (s.status === 'error') { view().innerHTML = `<div class="note-box bad">${E(s.error)}</div>`; return; }
    if (s.status !== 'done') {
      view().innerHTML = head('Why: factor pairs') + `<div class="card empty"><h2>Computing SHAP interaction values…</h2><p>Exact pair effects for up to 1,500 students, then 200 resamples to test how stable the ranking is.</p><div class="prog" style="max-width:420px;margin:14px auto"><i style="width:${Math.round(s.progress * 100)}%"></i></div></div>`;
      window.__poll = setTimeout(step, 1200); return;
    }
    renderCombos(await api(sess('interactions?top=15')));
  };
  step();
}
function renderCombos(d) {
  const nb9 = S.research.tables.table9_stability_summary;
  const seeds = nb9.find(r => r.Axis === 'Seeds'), pres = nb9.find(r => r.Axis === 'Presentations');
  const J = k => k['Interaction Jaccard@10'];
  const t0 = d.rows[0];
  const ad = S.research.tables.table8_added_value;
  const vars = d.heat.vars;
  const lab = pr => { const [a, b] = pr.split(' x '); return `${short(a)} × ${short(b)}`; };
  view().innerHTML = head('Why: factor pairs', `Which two factors act <i>together</i>, and whether that finding holds up. This is the study's contribution: interactions are measured with SHAP, then checked for stability.`) + `
  <div class="grid g3">
    <div class="card claim"><div class="big" style="color:var(--accent)">${C.pct(d.pair_share, 0)}</div><div><b>of the model's attribution is pair effects</b><br><span class="muted">on your data; single factors carry the rest. In the study: ${C.pct(S.research.key.pair_share, 0)}.</span></div></div>
    <div class="card claim"><div class="big" style="color:var(--accent)">${t0.badge}</div><div><b>${E(lab(t0.pair))}</b> is the strongest pair<br><span class="muted">top-${d.top_k} in ${C.pct(t0.freq, 0)} of ${d.boot.B} resamples of your students.</span></div></div>
    <div class="card claim"><div class="big" style="color:var(--accent)">+${(ad[1]['Gain from interactions'] * 100).toFixed(1)}</div><div><b>PR-AUC points from allowing pairs</b><br><span class="muted">${ad[1]['CI excludes 0?'] === 'Yes' ? 'Real but small' : 'Not reliable'}: ROC-AUC gain ${ad[0]['Gain from interactions'].toFixed(4)} ${ad[0]['95% CI (student bootstrap)']} (study).</span></div></div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Strongest factor pairs</h2><div class="sub">Strength = mean |SHAP interaction| on ${d.n.toLocaleString()} students. <b>Resampling</b> = how often the pair stays in the top ${d.top_k} when students are resampled. <b>Retraining</b> = the same check in the study, where models were retrained on other seeds, courses, windows and years (core pair = in the top ${d.top_k} in at least ${C.pct(d.core_share, 0)} of 38 runs).</div>
    ${table(d.rows, [{ h: '#', num: 1, k: 'rank' }, { h: 'Pair', f: r => `<b>${E(short(r.a))}</b> × <b>${E(short(r.b))}</b>` },
      { h: 'Strength', f: r => `<div class="riskcell"><div class="bar" style="flex:1"><i style="width:${r.strength / d.rows[0].strength * 100}%;background:var(--accent)"></i></div><span>${r.strength.toFixed(3)}</span></div>` },
      { h: '95% interval', num: 1, f: r => `${r.lo.toFixed(3)}–${r.hi.toFixed(3)}` }, { h: 'Resampling', f: r => `<span class="pill ${r.badge}">${r.badge}</span> <small>${C.pct(r.freq, 0)}</small>` },
      { h: 'Retraining (study)', f: r => r.notebook_all_runs == null ? '<small>not in study top-10</small>' : `<span class="pill ${r.notebook_core ? 'Stable' : 'Moderate'}">${r.notebook_core ? 'Core' : 'Not core'}</span> <small>${C.pct(r.notebook_all_runs, 0)}</small>` }])}</div>
  <div class="note-box warn"><b>Two kinds of stability, kept apart.</b> Resampling re-ranks pairs after drawing the same explained students again, so it is naturally high (mean overlap ${d.boot.jaccard_mean.toFixed(2)} vs ${d.boot.chance_p95.toFixed(2)} by chance). It shows the ranking is not a fluke of which students were sampled. It cannot show the model would give the same pairs if it were retrained. The study did that: overlap of the top-10 pairs was <b>${J(seeds).toFixed(2)}</b> across 10 seeds but only <b>${J(pres).toFixed(2)}</b> across 22 course presentations (chance 0.05). Pairs involving course module are the most reproducible; the exact order is not.</div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Pair strength map</h2><div class="sub">Top 8 inputs. Darker = stronger interaction.</div>${C.heat(vars, d.heat.matrix, short)}</div>
    <div class="card"><h2>See one pair</h2><div class="sub">Dependence plot: the x input against its SHAP value, coloured by the partner input. If dots at the same x differ in height by colour, the two interact.</div>
      <div class="row"><label class="field">X input<select id="da">${vars.map(v => `<option value="${v}">${E(short(v))}</option>`).join('')}</select></label><label class="field">Colour by<select id="db">${vars.map((v, i) => `<option value="${v}" ${i === 1 ? 'selected' : ''}>${E(short(v))}</option>`).join('')}</select></label></div><div id="dep" style="margin-top:8px"></div></div>
  </div>
  ${d.groups.length ? `<div class="card" style="margin-top:16px"><h2>Is the ranking the same inside each group?</h2><div class="sub">Overlap (Jaccard, top ${d.top_k}) between a group's pair ranking and the overall ranking. Groups under 150 sampled students are skipped.</div>
    ${C.barsH(d.groups.map(g => ({ label: `${g.attribute === 'code_module' ? 'module ' : ''}${g.group} (n=${g.n})`, value: g.jaccard, color: g.jaccard >= 0.5 ? 'var(--accent)' : 'var(--med)' })), { w: 640, labelW: 190, max: 1, fmt: v => v.toFixed(2), axisFmt: v => v.toFixed(1) })}</div>` : ''}`;
  const dep = async () => {
    const a = $('#da').value, b = $('#db').value;
    if (a === b) { $('#dep').innerHTML = '<p class="muted">Pick two different inputs.</p>'; return; }
    const r = await api(sess(`dependence?a=${a}&b=${b}`));
    const numB = r.color.filter(x => typeof x === 'number'), mn = Math.min(...numB), mx = Math.max(...numB);
    const catCols = ['#3b5bdb', '#e8890c', '#2b9a4a', '#d6336c', '#7048e8', '#0c8599', '#868e96'];
    const cats = [...new Set(r.color)].sort();
    const colFor = c => r.b_is_cat ? catCols[cats.indexOf(c) % 7] : (() => { const t = mx > mn ? (c - mn) / (mx - mn) : .5, A = [47, 111, 219], B = [224, 49, 49]; return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`; })();
    let xs = r.x; if (r.a_is_cat) { const ca = [...new Set(r.x)].sort(); xs = r.x.map(v => ca.indexOf(v)); }
    const pts = xs.map((x, i) => ({ x, y: r.shap[i], c: colFor(r.color[i]), jx: r.a_is_cat ? ((i * 37) % 17 - 8) : 0 }));
    $('#dep').innerHTML = C.scatter(pts, { xl: short(a) + (r.a_is_cat ? ' (A=0, B=1, …)' : ''), yl: `SHAP of ${short(a)}` }) + `<div class="legend">${r.b_is_cat ? cats.map(c => `<span><i style="background:${colFor(c)}"></i>${c}</span>`).join('') : `<span><i style="background:rgb(47,111,219)"></i>low ${short(b)}</span><span><i style="background:rgb(224,49,49)"></i>high ${short(b)}</span>`}</div>`;
  };
  $('#da').onchange = dep; $('#db').onchange = dep;
  const pa = d.rows[0].a, pb = d.rows[0].b; $('#da').value = vars.includes(pa) ? pa : vars[0]; $('#db').value = vars.includes(pb) && pb !== $('#da').value ? pb : vars.find(v => v !== $('#da').value);
  dep();
}

/* ------------------------------------------------------------------ PERFORMANCE */
const MCOL = { 'Logistic Regression': 'var(--accent)', 'Random Forest': 'var(--low)', 'LightGBM': 'var(--high)' };
async function pgPerformance() {
  setCrumb('Model performance');
  const R = S.research, T1 = R.tables.table1_test_metrics_ci;
  const M = ['Accuracy', 'Precision', 'Recall', 'F1', 'ROC-AUC', 'PR-AUC'];
  const curve = k => S.info.models.map(m => ({ name: m, color: MCOL[m], pts: R.curves[m][k] }));
  let h = head('Model performance', `How well the three models rank students who dropped out between day 28 and the end of the course. Metrics use the threshold chosen on training data only.`) + `
  <div class="card"><h2>Study test set <small>(${R.test_n.toLocaleString()} held-out students, ${C.pct(R.test_prevalence)} dropout)</small></h2><div class="sub">Accuracy, precision, recall, F1, ROC-AUC and PR-AUC with 95% intervals from resampling students.</div>
    ${table(T1, [{ h: 'Model', f: r => `<b>${E(r.Model)}</b>` }].concat(M.map(m => ({ h: m, num: 1, f: r => E(r[m]) }))))}
    <div class="note-box" style="margin-top:12px">The three models differ by about 0.01 AUC. With these features and an honest day-28 risk set, LightGBM is only slightly better than a plain logistic regression. See the paired comparison on <a href="#/study">Study results</a>.</div></div>
  <div class="grid g3" style="margin-top:16px">
    <div class="card"><h2>ROC curves</h2>${C.lines(curve('roc'), { xl: 'False-positive rate', yl: 'True-positive rate', diag: true })}</div>
    <div class="card"><h2>Precision–recall</h2>${C.lines(curve('pr'), { xl: 'Recall', yl: 'Precision', hline: R.test_prevalence })}</div>
    <div class="card"><h2>Calibration</h2>${C.lines(curve('calib').map(s => ({ ...s, dots: true })), { xl: 'Predicted risk', yl: 'Observed dropout rate', diag: true, xmax: 0.7, ymax: 0.7 })}</div>
  </div>`;
  if (!S.scored) { view().innerHTML = h + `<div style="margin-top:16px">${noData('Performance on your own data')}</div>`; wireActs(); return; }
  const p = await api(sess('performance?' + cutQ() + '&thr=' + (S._thr ?? modelThr())));
  h += `<h2 style="margin:26px 0 10px">Your dataset: ${E(S.filename)}</h2>`;
  if (!p.has_outcome) {
    h += `<div class="note-box warn">${E(p.note || 'No outcome column was supplied, so accuracy, recall and the other metrics cannot be computed on your data. Add an outcome column on the Upload page to see them.')} Risk scores themselves are still valid.</div>`;
    view().innerHTML = h; return;
  }
  const m = p.metrics, cf = p.confusion;
  h += `<div class="grid g4"><div class="card kpi"><div class="lab">ROC-AUC</div><div class="val">${C.num(m['ROC-AUC'])}</div><div class="note">${p.n.toLocaleString()} students with outcome, ${C.pct(p.prevalence)} dropped out</div></div>
    <div class="card kpi"><div class="lab">Recall</div><div class="val">${C.pct(m.Recall, 0)}</div><div class="note">${cf.tp.toLocaleString()} of ${(cf.tp + cf.fn).toLocaleString()} dropouts flagged</div></div>
    <div class="card kpi"><div class="lab">Precision</div><div class="val">${C.pct(m.Precision, 0)}</div><div class="note">${cf.tp.toLocaleString()} of ${(cf.tp + cf.fp).toLocaleString()} flagged did drop out</div></div>
    <div class="card kpi"><div class="lab">F1 · Accuracy</div><div class="val">${C.num(m.F1, 2)} · ${C.num(m.Accuracy, 2)}</div><div class="note">at threshold ${C.pct(p.threshold)}</div></div></div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Threshold</h2><div class="sub">Flag a student when risk ≥ threshold. Lower catches more dropouts and flags more people.</div>
      <label class="field">Threshold <b id="tv">${C.pct(p.threshold)}</b><input type="range" id="thr" min="0.05" max="0.6" step="0.005" value="${p.threshold}"></label><button class="btn" id="tr" style="margin-top:8px">Study threshold (${C.pct(modelThr())})</button>
      <div style="margin-top:12px">${table(p.grid.filter((g, i) => i % 3 === 0), [{ h: 'Threshold', num: 1, f: g => C.pct(g.threshold) }, { h: 'Flagged', num: 1, f: g => `${g.flagged.toLocaleString()} (${C.pct(g.flagged_share, 0)})` }, { h: 'Precision', num: 1, f: g => C.pct(g.precision, 0) }, { h: 'Recall', num: 1, f: g => C.pct(g.recall, 0) }, { h: 'F1', num: 1, f: g => g.f1.toFixed(2) }])}</div></div>
    <div class="card"><h2>Confusion matrix</h2><div class="sub">${S.model} at the threshold.</div>
      <div class="grid g2" style="gap:8px;margin-top:6px"><div class="card kpi" style="background:var(--low-soft)"><div class="lab">Correctly not flagged</div><div class="val">${cf.tn.toLocaleString()}</div></div><div class="card kpi" style="background:var(--med-soft)"><div class="lab">Flagged, stayed</div><div class="val">${cf.fp.toLocaleString()}</div></div><div class="card kpi" style="background:var(--high-soft)"><div class="lab">Missed dropouts</div><div class="val">${cf.fn.toLocaleString()}</div></div><div class="card kpi" style="background:var(--low-soft)"><div class="lab">Correctly flagged</div><div class="val">${cf.tp.toLocaleString()}</div></div></div>
      <h3 style="margin:14px 0 6px">All three models on your data</h3>${table(S.info.models, [{ h: 'Model', f: x => `<b>${x}</b>` }, { h: 'ROC-AUC', num: 1, f: x => C.num(p.models[x].roc_auc) }, { h: 'PR-AUC', num: 1, f: x => C.num(p.models[x].pr_auc) }])}</div>
  </div>
  <div class="grid g2" style="margin-top:16px"><div class="card"><h2>Calibration on your data</h2><div class="sub">Close to the diagonal means a 30% risk really is about 30%.</div>${C.lines([{ name: S.model, color: MCOL[S.model], pts: p.calibration, dots: true }], { xl: 'Predicted risk', yl: 'Observed dropout rate', diag: true, xmax: 0.7, ymax: 0.7 })}</div>
    <div class="card"><h2>Do the bands mean something?</h2><div class="sub">Observed dropout rate inside each band.</div>${C.barsH(p.bands.map(b => ({ label: `${b.band} (${b.n.toLocaleString()})`, value: b.observed_rate ?? 0, color: riskCol(b.band) })), { w: 520, labelW: 130, fmt: v => C.pct(v), axisFmt: v => (v * 100).toFixed(0) + '%' })}</div></div>`;
  view().innerHTML = h;
  let t; $('#thr').oninput = e => { $('#tv').textContent = C.pct(+e.target.value); clearTimeout(t); t = setTimeout(() => { S._thr = +e.target.value; pgPerformance(); }, 250); };
  $('#tr').onclick = () => { S._thr = null; pgPerformance(); };
}

/* ------------------------------------------------------------------ FAIRNESS */
async function pgFairness() {
  setCrumb('Fairness check');
  if (!S.scored) { view().innerHTML = head('Fairness check') + noData('A fairness check'); wireActs(); return; }
  const f = await api(sess('fairness?' + qs({ model: S.model })));
  const nbg = S.research.tables.table13_fairness_gaps;
  let h = head('Fairness check', `Who gets flagged, and who gets missed, for each group in your data. Gender and age were not model inputs in the study; they are used only to audit. ${S.model} at threshold ${C.pct(f.threshold || modelThr())}.`);
  if (!f.available) { view().innerHTML = h + `<div class="note-box warn">${E(f.message)}</div><a class="btn" href="#/upload">Go to Upload page</a>`; return; }
  f.attributes.forEach(a => {
    h += `<div class="card" style="margin-top:16px"><h2>${E(a.attribute)}</h2>
      ${a.eo_gap != null ? `<div class="sub">Equalised-odds gap (largest difference in recall or false-alarm rate between reliable groups): <b>${a.eo_gap.toFixed(2)}</b>, permutation p = ${a.perm_p.toFixed(3)} → ${a.perm_p < 0.05 ? '<b style="color:var(--high)">larger than chance</b>' : 'could be chance'}. Groups compared: ${a.compared.map(E).join(', ')}.</div>` : `<div class="sub">${f.has_outcome ? 'Fewer than two groups have enough dropouts to compare.' : 'No outcome column, so only selection rates are shown.'}</div>`}
      ${table(a.groups, [{ h: 'Group', f: g => `<b>${E(g.group)}</b>${g.reliable === false ? ' <span class="pill Medium" title="fewer than 30 dropouts">small</span>' : ''}` }, { h: 'Students', num: 1, f: g => g.n.toLocaleString() }, { h: 'Avg risk', num: 1, f: g => C.pct(g.mean_risk) }, { h: 'Flagged', num: 1, f: g => C.pct(g.selection_rate) }].concat(f.has_outcome ? [{ h: 'Dropout rate', num: 1, f: g => C.pct(g.dropout_rate) }, { h: 'Recall', num: 1, f: g => C.pct(g.recall, 0) }, { h: 'False-alarm rate', num: 1, f: g => C.pct(g.fpr, 0) }, { h: 'Precision', num: 1, f: g => C.pct(g.precision, 0) }] : []))}</div>`;
  });
  h += `<div class="card" style="margin-top:16px"><h2>For comparison: the study's gaps</h2><div class="sub">LightGBM on the held-out test students.</div>${table(nbg, [{ h: 'Attribute', f: r => `<b>${E(r.Attribute)}</b>` }, { h: 'Recall gap', num: 1, f: r => r['TPR gap'].toFixed(2) }, { h: 'False-alarm gap', num: 1, f: r => r['FPR gap'].toFixed(2) }, { h: 'Equalised-odds gap', num: 1, f: r => r['Equalised-odds gap'].toFixed(2) }, { h: '95% interval', k: 'Gap 95% CI (bootstrap)' }, { h: 'Larger than chance?', k: 'Gap larger than chance?' }])}
    <p class="muted" style="margin-top:8px">A gap is a difference in how the model treats groups, not proof of unfairness. Part of the gender gap is a module effect (men and women enrol in different modules); removing deprivation (IMD) as an input narrowed the IMD gap in the study. Check the Study results page before acting on any group difference.</p></div>`;
  view().innerHTML = h;
}

/* ------------------------------------------------------------------ STUDY RESULTS */
async function pgStudy() {
  setCrumb('Study results', 'from the notebook');
  const R = S.research, T = R.tables, K = R.key;
  const ck = T.table17_objective_checklist;
  const add = T.table8_added_value, st = T.table9_stability_summary;
  const figs = [['fig2_roc_pr', 'ROC and precision-recall curves'], ['fig3_calibration', 'Calibration'], ['fig4_shap_bar_beeswarm', 'SHAP importance and beeswarm'], ['fig5_interactions', 'Interaction heat map and dependence'], ['fig6_stability', 'Stability of the top pairs'], ['fig7_fairness', 'Recall and false-alarm rate by group']];
  view().innerHTML = head('Study results', 'The numbers from the project notebook, shown beside what the app computes on your data. Nothing on this page is recomputed.') + `
  <div class="grid g2">${ck.map(r => `<div class="card"><div class="row"><span class="pill neutral">${r.Objective}</span><b>${E(r['What was delivered'])}</b></div><p style="margin:10px 0 4px"><b>Result:</b> ${E(r['Key result'])}</p><p class="muted" style="margin:0"><b>Caveat:</b> ${E(r['Main caveat'])}</p></div>`).join('')}</div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>O3 · Do pairs add predictive value?</h2><div class="sub">Full LightGBM versus an additive one (no interactions), 5-fold grouped cross-validation.</div>
      ${table(add, [{ h: '', f: r => `<b>${E(r.name)}</b>` }, { h: 'Additive', num: 1, f: r => r.Additive.toFixed(4) }, { h: 'Full', num: 1, f: r => r.Full.toFixed(4) }, { h: 'Gain', num: 1, f: r => '+' + r['Gain from interactions'].toFixed(4) }, { h: '95% interval', k: '95% CI (student bootstrap)' }])}
      <div class="note-box">Interactions are real and measurable, and they help a little. Pair effects are ${C.pct(K.pair_share, 0)} of attribution but the predictive gain is under one AUC point. Reported as modest, not hidden.</div></div>
    <div class="card"><h2>O4 · How stable are the pairs?</h2><div class="sub">Overlap of the top-10 pairs between retrained models (Jaccard). Chance level is 0.05; its 95th percentile is 0.18.</div>
      ${C.barsH(st.map(r => ({ label: `${r.Axis} (${r.Runs} runs)`, value: r['Interaction Jaccard@10'], color: 'var(--accent)' })), { w: 560, labelW: 170, max: 1, fmt: v => v.toFixed(2), axisFmt: v => v.toFixed(1) })}
      <div class="note-box">Every axis beats chance. Seeds are most stable; across 22 course presentations only about a third of the top-10 pairs repeat. Single-variable rankings are more stable than pair rankings.</div></div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Which pairs are "core"?</h2><div class="sub">Share of retraining runs in which each of the main top-10 pairs stays in the top 10. Core = at least 80%.</div>
    ${table(T.table10_core_pairs, [{ h: 'Pair', f: r => `<b>${E(r.name.split(' x ').map(short).join(' × '))}</b>` }, { h: 'Seeds', num: 1, f: r => C.pct(r.Seeds, 0) }, { h: 'Presentations', num: 1, f: r => C.pct(r.Presentations, 0) }, { h: 'Cut-off day', num: 1, f: r => C.pct(r['Cut-off day'], 0) }, { h: 'Time', num: 1, f: r => C.pct(r.Time, 0) }, { h: 'All runs', num: 1, f: r => `<b>${C.pct(r['All runs'], 0)}</b>` }, { h: '', f: r => r['Core pair?'] ? '<span class="pill Stable">Core</span>' : '' }])}</div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>O1 · Are the models really different?</h2><div class="sub">Paired bootstrap of ROC-AUC differences on the test students.</div>${table(T.table3b_paired_auc, [{ h: 'Comparison', f: r => `<b>${E(r.Comparison)}</b>` }, { h: 'ΔAUC', num: 1, f: r => r['Delta ROC-AUC'].toFixed(3) }, { h: '95% interval', k: '95% CI' }, { h: 'Clear?', k: 'Clear difference?' }])}</div>
    <div class="card"><h2>Why the AUC is lower than in many papers</h2><div class="sub">The same LightGBM under different set-ups (grouped CV ROC-AUC).</div>${table(T.table16_sensitivity, [{ h: 'Cohort', f: r => E(r.Cohort.startsWith('All') ? 'Includes students who already left' : 'Still registered at day 28 (this study)') }, { h: 'Fail', f: r => E(r.Fail === 'removed' ? 'removed' : 'counted') }, { h: 'Features', f: r => E(r.Features.startsWith('Original') ? '8 original' : 'final') }, { h: 'AUC', num: 1, f: r => `<b>${r['Grouped-CV ROC-AUC'].toFixed(3)}</b>` }])}
      <p class="muted" style="margin-top:8px">The high AUC mostly measures "is the student still registered?", not early warning.</p></div>
  </div>
  <h2 style="margin:26px 0 10px">Figures from the notebook</h2>
  <div class="grid g2">${figs.map(([f, t]) => `<div class="card"><h3 style="margin-bottom:8px">${t}</h3><img class="fig" src="/static/figures/${f}.png" alt="${t}" loading="lazy"></div>`).join('')}</div>`;
}

/* ------------------------------------------------------------------ ABOUT */
async function pgAbout() {
  setCrumb('Limits & method');
  const K = S.research.key;
  view().innerHTML = head('Limits & method', 'What this tool is, how it was built, and where not to trust it.') + `
  <div class="grid g2">
    <div class="card"><h2>Method in one page</h2><ul style="padding-left:18px;margin:8px 0">
      <li><b>Data:</b> OULAD, ${K.n_all.toLocaleString()} student-course enrolments. Only the ${K.risk_set.toLocaleString()} still registered on day 28 are scored; students who had already left would make the task a registration lookup.</li>
      <li><b>Target:</b> Withdrawn = 1; Pass, Distinction and Fail = 0 (${C.pct(K.dropout_rate)}).</li>
      <li><b>Inputs:</b> ${K.variables.length} variables (${K.features.length} columns after one-hot module) built from days 0-28. Gender and age are audit-only.</li>
      <li><b>Models:</b> Logistic Regression, Random Forest, LightGBM; class weights, no resampling; Platt calibration; threshold chosen from out-of-fold training predictions.</li>
      <li><b>Split:</b> 80/20 by student, so nobody appears on both sides; ${K.train_rows.toLocaleString()} training rows, ${K.test_rows.toLocaleString()} test rows.</li>
      <li><b>Explanation:</b> exact TreeSHAP for LightGBM: single factors and pair interactions. Logistic Regression and Random Forest risks are shown, but the explanations always come from LightGBM.</li></ul></div>
    <div class="card"><h2>Where not to trust it</h2><ul style="padding-left:18px;margin:8px 0">
      <li><b>Modest discrimination.</b> ROC-AUC ≈ ${K.test_metrics.LightGBM['ROC-AUC'].toFixed(2)}. At the study threshold about two in three flags are students who did not drop out.</li>
      <li><b>One university, 2013-2014.</b> The models learned OULAD. They do not transfer to another institution's data without retraining; the app will score such data only if it has the same 15 inputs, and it will say little about whether the scores are meaningful.</li>
      <li><b>SHAP is not cause.</b> A factor that raises the score is not necessarily a reason the student leaves. Module effects partly reflect course design.</li>
      <li><b>Group gaps exist</b> (gender, age, deprivation). See Fairness before using scores to allocate support.</li>
      <li><b>Pair rankings are fragile</b> across course presentations (overlap about a third). Read pairs as "these interact", not as a fixed top-10.</li>
      <li><b>Not a decision-maker.</b> Use the ranking to decide whom to contact first, with a human in the loop.</li></ul></div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Run it yourself</h2><pre style="background:var(--panel2);padding:12px;border-radius:10px;overflow:auto">cd webapp
python -m venv .venv &amp;&amp; .venv\\Scripts\\pip install -r requirements.txt
.venv\\Scripts\\python train.py     # rebuilds models; matches the notebook's numbers
.venv\\Scripts\\python app.py       # http://127.0.0.1:8000</pre><p class="muted">Uploaded files are held in memory by the local server and are not written to disk or sent anywhere. Restarting the server clears them.</p></div>`;
}

/* ------------------------------------------------------------------ boot */
(async function boot() {
  const th = (() => { try { return localStorage.getItem('da-theme'); } catch (e) { return null; } })();
  if (th) document.documentElement.dataset.theme = th;
  $('#themeBtn').onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const n = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; try { localStorage.setItem('da-theme', n); } catch (e) { /* ignore */ } route(); };
  $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
  try {
    [S.info, S.research] = await Promise.all([api('/api/info'), api('/api/research')]);
  } catch (e) { view().innerHTML = `<div class="note-box bad">Could not reach the server: ${E(e.message)}</div>`; return; }
  $('#modelSel').innerHTML = S.info.models.map(m => `<option ${m === S.model ? 'selected' : ''}>${m}</option>`).join('');
  $('#modelSel').onchange = e => { S.model = e.target.value; resetCuts(); S._thr = null; S.f.page = 1; route(); };
  resetCuts();
  route();
})();
