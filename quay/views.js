/* Quay 1 — secondary tab views (All Staff, Compare, Daily, Manager, Lead Sources) */

window.VIEWS = (function () {
  const Q = window.QUAY, I = window.ICON, C = window.CHART;
  const fmt = n => n.toLocaleString('en-ZA');
  const initials = name => name.split(' ').map(w => w[0]).slice(0, 2).join('');
  // Shared performance-pill thresholds. Centralised here so every tab
  // (Overview, All Staff, Daily, Monthly, drill-downs) reads the same
  // green/amber/red boundary instead of drifting per-view literals.
  // Anchored on CFG.QUAY_CONFIG.BENCHMARKS so changing the floor target
  // ripples everywhere.
  const _CFG = (window.QUAY_CONFIG && window.QUAY_CONFIG.BENCHMARKS) || {};
  const _SR_TARGET = _CFG.rm_success_rate ?? 17;          // RM floor (Fancy is +3pts above, pill stays usable for both)
  const _SR_WARN_BUFFER = 3;                              // pts below target → amber
  const _EFF_TARGET = _CFG.efficiency ?? 70;
  const _CPH_TARGET = _CFG.cph ?? 45;
  // success-rate pill: ok at/above target, amber within 3pts below, red further below
  const sucClass = s => s >= _SR_TARGET ? 'ok'
                       : s >= (_SR_TARGET - _SR_WARN_BUFFER) ? 'warn' : 'bad';
  // efficiency pill: ok ≥ 70, amber ≥ 60, red below
  const effClass = e => e >= _EFF_TARGET ? 'ok'
                       : e >= (_EFF_TARGET - 10) ? 'warn' : 'bad';
  // CPH pill: ok ≥ 45, amber ≥ 35, red below
  const cphClass = c => c >= _CPH_TARGET ? 'ok'
                       : c >= (_CPH_TARGET - 10) ? 'warn' : 'bad';

  function agentRow(a, rank, scaleMax) {
    const sc = sucClass(a.success);
    const ec = effClass(a.eff);
    // Volume bar scales to the busiest agent in the current list so the
    // bar still reads as a proportion when periods change (was hardcoded /720).
    const maxC = scaleMax && scaleMax > 0 ? scaleMax : (a.calls || 1);
    const bar = Math.min(100, (a.calls / maxC) * 100);
    const df = a.df != null ? a.df : 0;
    const ct = a.ct != null ? a.ct : 0;
    const eff = a.eff != null ? a.eff : 0;
    const ctSrc = a.ctSource === 'clock'
      ? '<span class="pill" style="background:var(--green-tint);color:var(--green);font-size:9.5px;font-weight:700;margin-left:5px;padding:1px 6px">real</span>'
      : '<span class="pill" style="background:#EEF0F6;color:var(--muted);font-size:9.5px;font-weight:700;margin-left:5px;padding:1px 6px" title="estimated DF / 0.85 — agent not in the clock data yet">est</span>';
    return `<tr data-agent="${a.name}" data-rank="${rank}" data-name="${a.name}" data-team="${a.team}" data-calls="${a.calls}" data-leads="${a.leads}" data-success="${a.success}" data-connect="${a.connect}" data-df="${df}" data-ct="${ct}" data-eff="${eff}" style="cursor:pointer">
      <td class="num" style="color:var(--muted);font-weight:700;width:40px">${rank}</td>
      <td><div class="agent-cell">
        <div class="avatar">${initials(a.name)}</div>
        <div><div class="agent-name">${a.name}</div></div>
      </div></td>
      <td><span class="pill ${a.team === 'RM' ? 'rm' : 'fancy'}">${a.team}</span></td>
      <td class="num tnum">${fmt(a.calls)}</td>
      <td class="num tnum">${fmt(a.leads)}</td>
      <td class="num"><span class="pill ${sc}">${a.success}%</span></td>
      <td class="num tnum">${a.connect}%</td>
      <td class="num tnum">${df.toFixed(1)}h</td>
      <td class="num tnum">${ct.toFixed(1)}h${ctSrc}</td>
      <td class="num"><span class="pill ${ec}">${eff}%</span></td>
      <td class="num"><div class="cell-bar"><div class="track"><span style="width:${bar}%"></span></div></div></td>
    </tr>`;
  }

  // ---------------------------------------------------- ALL STAFF
  //   `range` (optional) = { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }.
  // When both from/to are set, the tab pulls from Q.agentsForRange instead
  // of Q.agentsFor and shows a "covers X → Y · N complete weeks" caption.
  function allStaff(period, teamFilter, range) {
    teamFilter = teamFilter || 'all';
    const usingRange = !!(range && range.from && range.to);
    let source;
    if (usingRange) {
      source = Q.agentsForRange(range.from, range.to);
    } else {
      source = Q.agentsFor(period);
    }
    let agents = source.slice().sort((a, b) => b.calls - a.calls);
    const rangeMeta = usingRange ? source._range : null;
    if (teamFilter === 'RM' || teamFilter === 'Fancy') {
      agents = agents.filter(a => a.team === teamFilter);
    }
    const scaleMax = agents.length ? agents[0].calls : 1;
    const rows = agents.map((a, i) => agentRow(a, i + 1, scaleMax)).join('');
    const cards = agents.map(a => perCallerCard(a)).join('');
    const tCalls = agents.reduce((s, a) => s + a.calls, 0);
    const tLeads = agents.reduce((s, a) => s + a.leads, 0);
    const totDf  = agents.reduce((s, a) => s + (a.df || 0), 0);
    const totCt  = agents.reduce((s, a) => s + (a.ct || 0), 0);
    const haveClock = agents.some(a => a.ctSource === 'clock');
    const avgEff = agents.length ? Math.round(agents.reduce((s, a) => s + (a.eff || 0), 0) / agents.length) : 0;
    const rosterSub = teamFilter === 'all'
      ? 'RM + Fancy combined'
      : teamFilter + ' only';
    const selOpt = (v, label) =>
      `<option value="${v}" ${teamFilter === v ? 'selected' : ''}>${label}</option>`;
    // Effective-range caption when custom From/To is active. Same phrasing
    // as the Teams Reporting tab so directors read one consistent label.
    let rangeCaption = '';
    if (usingRange) {
      if (rangeMeta && rangeMeta.granularity === 'daily') {
        // Sub-week span served from per-day snapshots (e.g. yesterday).
        const n = rangeMeta.daysIncluded || 0;
        rangeCaption = `<div class="sub" style="margin-top:6px">
          Custom range · covers <b>${rangeMeta.effectiveFrom}</b> → <b>${rangeMeta.effectiveTo}</b>
          · ${n} day${n === 1 ? '' : 's'} <span class="muted">· per-day data (clocked hours estimated)</span>
          <span class="muted">(quick-period chips ignored while this is set)</span>
        </div>`;
      } else if (rangeMeta && rangeMeta.weeksIncluded > 0) {
        const snapNote = rangeMeta.autoSnappedTo
          ? ` <span class="muted">· auto-extended to ${rangeMeta.autoSnappedTo} so the last Mon–Sun week is included</span>`
          : '';
        rangeCaption = `<div class="sub" style="margin-top:6px">
          Custom range · covers <b>${rangeMeta.effectiveFrom}</b> → <b>${rangeMeta.effectiveTo}</b>
          · ${rangeMeta.weeksIncluded} complete week${rangeMeta.weeksIncluded === 1 ? '' : 's'}${snapNote}
          <span class="muted">(quick-period chips ignored while this is set)</span>
        </div>`;
      } else {
        rangeCaption = `<div class="sub" style="margin-top:6px;color:#D20A03">
          Custom range · ${range.from} → ${range.to}
          · no data for this range
        </div>`;
      }
    }
    // Coaching signal: active agents under the CPH/success benchmark.
    const belowTarget = agents.filter(a => (a.calls || 0) > 0 && !a.meetsTarget).length;

    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel" style="justify-content:space-between">
          <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label for="staffTeamFilter">Team</label><select id="staffTeamFilter">
              ${selOpt('all', 'All teams')}
              ${selOpt('RM', 'RM')}
              ${selOpt('Fancy', 'Fancy')}
            </select></div>
          </div>
          <div class="seg" id="staffSeg" role="group" aria-label="Staff view">
            <button class="active" data-view="overall" aria-pressed="true">Callers · Overall</button>
            <button data-view="per" aria-pressed="false">Callers · Per agent</button>
            <button data-view="ln" aria-pressed="false">LN &amp; Assistants</button>
          </div>
        </div>
        ${rangeCaption}
      </div>

      <div class="row mt" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
        ${miniStat('Roster size', agents.length + ' agents', rosterSub, I.users)}
        ${miniStat('Total calls', fmt(tCalls), 'across selected range', I.phone)}
        ${miniStat('Total leads', fmt(tLeads), 'seller · rental · email', I.target)}
        ${miniStat('Avg efficiency', avgEff + '%', 'DialFire ÷ clocked time · target ≥70%', I.bolt)}
        ${miniStat('Below target', belowTarget + '', 'active agents under CPH / success benchmark', I.alert)}
        ${miniStat('Dialler vs clocked', totDf.toFixed(0) + ' / ' + totCt.toFixed(0) + 'h', haveClock ? 'real data from quay-clock' : 'estimated — no clock data yet', I.clock)}
      </div>

      <div class="card mt" id="staffOverall">
        <div class="card-head">
          <div><h3>Agent-level performance</h3><div class="sub">Calls · leads · dialler vs clocked hours · efficiency · click any column to sort</div></div>
          <button class="btn js-export">${I.download} Export CSV</button>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th class="num">#</th>
              <th data-sort="name|str">Agent<span class="sort-ind"></span></th>
              <th data-sort="team|str">Team<span class="sort-ind"></span></th>
              <th class="num" data-sort="calls|num">Calls<span class="sort-ind"></span></th>
              <th class="num" data-sort="leads|num">Leads<span class="sort-ind"></span></th>
              <th class="num" data-sort="success|num">Success<span class="sort-ind"></span></th>
              <th class="num" data-sort="connect|num">Connect<span class="sort-ind"></span></th>
              <th class="num" data-sort="df|num">Dialler<span class="sort-ind"></span></th>
              <th class="num" data-sort="ct|num">Clocked<span class="sort-ind"></span></th>
              <th class="num" data-sort="eff|num">Eff %<span class="sort-ind"></span></th>
              <th class="num">Volume</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>

      <div class="mt staff-cards" id="staffPerCaller" style="display:none">${cards}</div>

      <!-- LN & Assistants — Supabase-fed, hydrated by app.js lnReportsLoad() -->
      <div class="mt" id="staffLnReports" style="display:none">
        <div class="card card-pad" style="color:var(--muted);text-align:center;padding:40px">
          Click <b>LN &amp; Assistants</b> above to load this period's end-of-day reports.
        </div>
      </div>
    </div>`;
  }

  // ---- LN & Assistants — end-of-day report submissions ---------------
  // Renders a summary table (one row per staff member) + a chronological
  // detail list. Data comes from public.clock_out_reports via Supabase;
  // app.js owns the fetch + caches per-period.
  function lnReports(reports) {
    if (!Array.isArray(reports) || reports.length === 0) {
      return `<div class="card card-pad" style="color:var(--muted);text-align:center;padding:40px">
        No end-of-day reports submitted in this period.
      </div>`;
    }
    // Aggregate per staff_id.
    const byStaff = new Map();
    reports.forEach(r => {
      const k = r.staff_id;
      if (!byStaff.has(k)) {
        byStaff.set(k, {
          staff_id: k,
          name: (r.staff && r.staff.name) || r.staff_id,
          designation: r.designation || '',
          divisions: new Set(),
          reports: 0,
          hs_tasks: 0, hs_calls: 0, hs_emails: 0, hs_was: 0, hs_answered: 0, hs_leads: 0, hs_recon: 0,
          df_calls: 0, df_emails: 0, df_leads: 0, df_hours: 0,
          wa_sent: 0, wa_resp: 0, wa_leads: 0,
        });
      }
      const t = byStaff.get(k);
      if (r.division) t.divisions.add(r.division);
      t.reports     += 1;
      t.hs_tasks    += r.hs_tasks_completed   || 0;
      t.hs_calls    += r.hs_calls_made        || 0;
      t.hs_emails   += r.hs_emails_sent       || 0;
      t.hs_was      += r.hs_whatsapps_sent    || 0;
      t.hs_answered += r.hs_answered_contacts || 0;
      t.hs_leads    += r.hs_leads_vals        || 0;
      t.hs_recon    += r.hs_reconverted_leads || 0;
      t.df_calls    += r.df_calls             || 0;
      t.df_emails   += r.df_email_successes   || 0;
      t.df_leads    += r.df_leads_vals        || 0;
      t.df_hours    += Number(r.df_hours      || 0);
      t.wa_sent     += r.wa_sent              || 0;
      t.wa_resp     += r.wa_responses         || 0;
      t.wa_leads    += r.wa_leads_vals        || 0;
    });
    const summary = Array.from(byStaff.values()).sort((a, b) => b.reports - a.reports || a.name.localeCompare(b.name));

    const designationPill = (d) => {
      const lc = (d || '').toLowerCase();
      const cls = lc === 'ln' ? 'rm' : (lc === 'assistant' ? 'fancy' : '');
      const NICE = { ln: 'LN', assistant: 'Assistant', broker: 'Broker', senior_broker: 'Senior Broker' };
      const label = NICE[lc] || (d || '—');
      return `<span class="pill ${cls}" style="font-size:10.5px;padding:2px 8px">${label}</span>`;
    };

    const summaryRows = summary.map(t => {
      const calls  = t.hs_calls + t.df_calls;
      const emails = t.hs_emails + t.df_emails;
      const was    = t.hs_was + t.wa_sent;
      const leads  = t.hs_leads + t.df_leads + t.wa_leads;
      return `<tr
        data-name="${escapeHtml(t.name)}"
        data-reports="${t.reports}"
        data-tasks="${t.hs_tasks}"
        data-calls="${calls}"
        data-emails="${emails}"
        data-was="${was}"
        data-leads="${leads}">
        <td><b>${escapeHtml(t.name)}</b></td>
        <td>${designationPill(t.designation)}</td>
        <td class="muted" style="font-size:12px">${escapeHtml(Array.from(t.divisions).join(', ') || '—')}</td>
        <td class="num tnum">${t.reports}</td>
        <td class="num tnum">${fmt(t.hs_tasks)}</td>
        <td class="num tnum">${fmt(calls)}</td>
        <td class="num tnum">${fmt(emails)}</td>
        <td class="num tnum">${fmt(was)}</td>
        <td class="num tnum">${fmt(leads)}</td>
        <td class="num tnum">${t.df_hours ? t.df_hours.toFixed(1) + 'h' : '—'}</td>
      </tr>`;
    }).join('');

    // Recent submissions detail — newest first, all fields, notes
    // truncated with click-to-expand (mirrors the requests reason cell).
    const fmtDate = iso => {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Africa/Johannesburg' })
           + ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' });
    };
    const recent = reports.slice(0, 80);  // already ordered desc by app.js
    const detailRows = recent.map(r => {
      const name = (r.staff && r.staff.name) || r.staff_id;
      const hsTotal = (r.hs_tasks_completed||0) + (r.hs_calls_made||0) + (r.hs_emails_sent||0) + (r.hs_whatsapps_sent||0);
      const dfTotal = (r.df_calls||0) + (r.df_email_successes||0);
      const waTotal = (r.wa_sent||0);
      return `<tr>
        <td class="tnum" style="font-size:12px">${fmtDate(r.clocked_out_at)}</td>
        <td>${name}</td>
        <td>${designationPill(r.designation)}</td>
        <td class="muted" style="font-size:12px">${escapeHtml(r.division || '—')}</td>
        <td class="num tnum">${fmt(hsTotal)}</td>
        <td class="num tnum">${fmt(dfTotal)}</td>
        <td class="num tnum">${fmt(waTotal)}</td>
        <td class="num tnum">${fmt((r.hs_leads_vals||0)+(r.df_leads_vals||0)+(r.wa_leads_vals||0))}</td>
        <td class="muted reason-cell" title="${escapeHtml(r.notes || '')}" style="max-width:280px;font-size:12px">
          <div class="reason-text">${escapeHtml(r.notes || '—')}</div>
        </td>
      </tr>`;
    }).join('');

    return `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>LN &amp; Assistants — summary</h3>
            <div class="sub">${summary.length} staff · ${reports.length} report${reports.length === 1 ? '' : 's'} this period · totals aggregate HubSpot + DialFire + WhatsApp where overlap</div>
          </div>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th data-sort="name|str">Staff<span class="sort-ind"></span></th>
            <th>Role</th>
            <th>Divisions</th>
            <th class="num" data-sort="reports|num">#<span class="sort-ind"></span></th>
            <th class="num" data-sort="tasks|num">Tasks<span class="sort-ind"></span></th>
            <th class="num" data-sort="calls|num">Calls<span class="sort-ind"></span></th>
            <th class="num" data-sort="emails|num">Emails<span class="sort-ind"></span></th>
            <th class="num" data-sort="was|num">WhatsApps<span class="sort-ind"></span></th>
            <th class="num" data-sort="leads|num">Leads<span class="sort-ind"></span></th>
            <th class="num">DF hrs</th>
          </tr></thead>
          <tbody>${summaryRows}</tbody>
        </table></div>
      </div>

      <div class="card mt">
        <div class="card-head">
          <div>
            <h3>Recent submissions</h3>
            <div class="sub">Newest first · click a notes cell to expand · showing ${recent.length} of ${reports.length}</div>
          </div>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>When (SAST)</th>
            <th>Staff</th>
            <th>Role</th>
            <th>Division</th>
            <th class="num">HubSpot Σ</th>
            <th class="num">DialFire Σ</th>
            <th class="num">WhatsApp Σ</th>
            <th class="num">Leads</th>
            <th>Notes</th>
          </tr></thead>
          <tbody>${detailRows}</tbody>
        </table></div>
      </div>
    `;
  }

  // ---- Per-caller card (richer per-agent view from real fields) ----
  function perCallerCard(a) {
    const sc = sucClass(a.success);
    const onTarget = !!a.meetsTarget;
    const camps = (a.campaigns || []).map(c =>
      `<span class="pill" style="font-size:10.5px;padding:3px 9px;background:#EDF1F8;border-color:#D8E0EC;color:#3D5BA6">${c}</span>`
    ).join('');
    const stat = (label, value) =>
      `<div><div class="kpi-label" style="margin:0;font-size:10.5px">${label}</div>
       <div class="tnum" style="font-family:var(--serif);font-weight:700;font-size:17px;color:var(--ink);margin-top:2px">${value}</div></div>`;
    return `<div class="card card-pad pc-card" data-agent="${a.name}" style="cursor:pointer">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
        <div class="avatar" style="width:42px;height:42px;font-size:14px">${initials(a.name)}</div>
        <div style="flex:1;min-width:0">
          <div class="agent-name" style="font-size:15.5px;line-height:1.2">${a.name}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">
            <span class="pill ${a.team === 'RM' ? 'rm' : 'fancy'}" style="font-size:10px;padding:2px 8px">${a.team}</span>
            ${onTarget ? '<span class="pill ok" style="font-size:10px;padding:2px 8px">on target</span>' : ''}
            <span class="pill ${sc}" style="font-size:10px;padding:2px 8px">${a.success}% success</span>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px 16px">
        ${stat('Calls', fmt(a.calls))}
        ${stat('Leads',     fmt(a.leads))}
        ${stat('CPH',       a.cph || '—')}
        ${stat('Dialler hrs', a.df.toFixed(1) + 'h')}
        ${stat('Work %',  (a.workPct != null ? a.workPct : 0) + '%')}
        ${stat('Talk %',  (a.talkPct != null ? a.talkPct : a.connect) + '%')}
      </div>
      ${(a.seller || a.rental || a.email) ? `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line);display:flex;gap:18px;font-size:12px">
        <div><b style="color:var(--ink)">${fmt(a.seller)}</b> <span style="color:var(--muted)">seller</span></div>
        <div><b style="color:var(--ink)">${fmt(a.rental)}</b> <span style="color:var(--muted)">rental</span></div>
        <div><b style="color:var(--ink)">${fmt(a.email)}</b> <span style="color:var(--muted)">email</span></div>
      </div>` : ''}
      ${camps ? `<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:5px">${camps}</div>` : ''}
    </div>`;
  }

  function miniStat(label, value, sub, icon) {
    // Allow the value to wrap (around a slash, for ratios like "1344 / 1581h")
    // when the 5-card row gets tight. Single-word values still fit on one line.
    return `<div class="card card-pad">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        <div class="kpi-ic">${icon}</div>
        <div style="min-width:0;flex:1 1 auto"><div class="kpi-label" style="margin:0;white-space:nowrap">${label}</div>
        <div style="font-family:var(--serif);font-size:24px;font-weight:600;color:var(--ink);line-height:1.15;overflow-wrap:break-word">${value}</div></div>
      </div>
      <div class="kpi-foot" style="margin-top:12px">${sub}</div>
    </div>`;
  }

  // ---------------------------------------------------- COMPARE
  // Both Week-vs-Week and Month-vs-Month are data-driven from
  // weeksBreakdown() / monthlyBreakdown(). The pickers default to
  // (latest, latest-1); on change the inner body re-renders in place
  // (no full route shell rebuild — handled in app.js segWire).
  function compare(period, agRange) {
    const months = (Q.monthlyBreakdown && Q.monthlyBreakdown()) || [];
    const weeksB = (Q.weeksBreakdown && Q.weeksBreakdown()) || [];
    // Agent-vs-Agent is self-contained: Compare has no period control, so the
    // roster + numbers default to the latest COMPLETE week rather than
    // inheriting whatever period leaked in from another tab — UNLESS a custom
    // date range is set via the picker on this panel (agRange), which scopes both.
    // last-week = weeks[1] (last completed); this-week is now the in-progress week.
    const activePeriod = 'last-week';
    const agRangeActive = !!(agRange && agRange.from && agRange.to);
    const agentsList = agRangeActive
      ? ((Q.agentsForRange && Q.agentsForRange(agRange.from, agRange.to)) || [])
      : ((Q.agentsFor && Q.agentsFor(activePeriod)) || []);
    const sortedAgents = agentsList.slice().sort((a, b) => b.calls - a.calls);
    const agToday = (new Date()).toISOString().slice(0, 10);
    const agFromV = agRangeActive ? agRange.from : '';
    const agToV   = agRangeActive ? agRange.to   : '';
    const agNoteTxt = agRangeActive
      ? `Custom range · ${agFromV} → ${agToV}`
      : 'Roster & numbers use the latest complete week — pick a custom date range below to change the window.';
    const defAgA = sortedAgents[0] ? sortedAgents[0].name : '';
    const defAgB = sortedAgents[1] ? sortedAgents[1].name : (sortedAgents[0] ? sortedAgents[0].name : '');
    const agentOpts = (selected) => sortedAgents.map(a =>
      `<option value="${escapeHtml(a.name)}" ${a.name === selected ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');

    // Default selection: most recent vs the one before.
    const defMA = months[0] ? months[0].key : '';
    const defMB = months[1] ? months[1].key : (months[0] ? months[0].key : '');
    const defWA = weeksB[0] ? weeksB[0].key : '';
    const defWB = weeksB[1] ? weeksB[1].key : (weeksB[0] ? weeksB[0].key : '');

    const monthOpts = (selected) => months.map(m =>
      `<option value="${m.key}" ${m.key === selected ? 'selected' : ''}>${m.label}</option>`).join('');
    const weekOpts = (selected) => weeksB.map(w =>
      `<option value="${w.key}" ${w.key === selected ? 'selected' : ''}>${w.label}</option>`).join('');

    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel" style="gap:18px;flex-wrap:wrap">
          <div class="seg" id="cmpSeg" role="group" aria-label="Comparison mode">
            <button data-cmp-mode="week" class="active" aria-pressed="true">${I.calendar} Week vs Week</button>
            <button data-cmp-mode="month" aria-pressed="false">${I.cal2} Month vs Month</button>
            <button data-cmp-mode="agent" aria-pressed="false">${I.users} Agent vs Agent</button>
          </div>
        </div>
      </div>

      <!-- WEEK vs WEEK panel -->
      <div id="cmpWeekPanel">
        <div class="card mt">
          <div class="panel" style="gap:18px;flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label for="cmpWeekA">Week A</label>
              <select id="cmpWeekA">${weekOpts(defWA)}</select>
            </div>
            <div class="field"><label for="cmpWeekB">Week B</label>
              <select id="cmpWeekB">${weekOpts(defWB)}</select>
            </div>
          </div>
          <div id="cmpWeekBody">${renderWeekCompare(weeksB, defWA, defWB)}</div>
        </div>
      </div>

      <!-- MONTH vs MONTH panel -->
      <div id="cmpMonthPanel" style="display:none">
        <div class="card mt">
          <div class="panel" style="gap:18px;flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label for="cmpMonthA">Month A</label>
              <select id="cmpMonthA">${monthOpts(defMA)}</select>
            </div>
            <div class="field"><label for="cmpMonthB">Month B</label>
              <select id="cmpMonthB">${monthOpts(defMB)}</select>
            </div>
          </div>
          <div id="cmpMonthBody">${renderMonthCompare(months, defMA, defMB)}</div>
        </div>
      </div>

      <!-- AGENT vs AGENT panel -->
      <div id="cmpAgentPanel" style="display:none">
        <div class="card mt">
          <div class="panel" style="gap:18px;flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label for="cmpAgentA">Agent A</label>
              <select id="cmpAgentA">${agentOpts(defAgA)}</select>
            </div>
            <div class="field"><label for="cmpAgentB">Agent B</label>
              <select id="cmpAgentB">${agentOpts(defAgB)}</select>
            </div>
            <div class="field" style="margin-left:auto">
              <label>Date range</label>
              <div class="ln-date-picker" aria-label="Custom date range">
                <label class="muted" for="cmpAgDateFrom">From</label>
                <input id="cmpAgDateFrom" type="date" value="${agFromV}" max="${agToday}">
                <span class="muted" aria-hidden="true">→</span>
                <label class="muted" for="cmpAgDateTo">To</label>
                <input id="cmpAgDateTo" type="date" value="${agToV}" max="${agToday}">
                <button class="btn" id="cmpAgDateClear" type="button">Clear</button>
              </div>
            </div>
          </div>
          <div class="muted" id="cmpAgNote" style="font-size:12px;padding:6px 0 10px;text-align:center">${agNoteTxt}</div>
          <div id="cmpAgentBody">${renderAgentCompare(sortedAgents, defAgA, defAgB)}</div>
        </div>
      </div>
    </div>`;
  }

  // Agent-vs-agent comparison. Rebuilt 2026-07-06 based on the
  // compare-audit + compare-redesign swarm findings:
  //   1. Hero KPI band for the three metrics managers actually look at first
  //      (Total calls, Success rate, Calls / hour) with paired big numbers
  //      + a proportional brass bar + winner name pinned underneath.
  //   2. Winner-tinted cells in the detail table (green-tint for the winner,
  //      red-tint for the loser, muted for tie / same-agent / no data).
  //   3. Brass-gold delta chip - drop the previous up/down "delta" chip in
  //      the compare context.
  //   4. Per-metric direction map so future higher-is-worse metrics
  //      (Wait %, Pause %) land the winner shading the right way.
  //   5. Empty states: same agent selected, agent has no data in period,
  //      neither picked.
  //   6. Responsive stack below 720px handled by CSS.
  function renderAgentCompare(agents, nameA, nameB) {
    const lookup = new Map(agents.map(a => [a.name, a]));
    const a = lookup.get(nameA);
    const b = lookup.get(nameB);
    if (!a || !b) {
      return `<div class="cmp-empty">
        <div class="cmp-empty-t">Pick two agents to compare.</div>
        <div class="cmp-empty-s">Set a custom date range on this panel if the dropdowns look thin.</div>
      </div>`;
    }
    const sameAgent = a.name === b.name;
    const noDataA = (a.calls || 0) === 0;
    const noDataB = (b.calls || 0) === 0;
    const rows = [
      ['Total calls',      a.calls,       b.calls,       { kind: 'count',                       dir:  1, hero: 1 }],
      ['Answered',         a.rawSuccess,  b.rawSuccess,  { kind: 'count',                       dir:  1 }],
      ['Success rate',     a.success,     b.success,     { kind: 'pct',   suffix: '%',          dir:  1, hero: 2 }],
      ['Calls per hour',   a.cph,         b.cph,         { kind: 'rate',  decimals: 1,          dir:  1, hero: 3 }],
      ['Seller leads',     a.seller,      b.seller,      { kind: 'count',                       dir:  1 }],
      ['Rental leads',     a.rental,      b.rental,      { kind: 'count',                       dir:  1 }],
      ['Emails collected', a.email,       b.email,       { kind: 'count',                       dir:  1 }],
      ['Dialler hours',    a.df,          b.df,          { kind: 'hours',                       dir:  1 }],
      ['Clocked hours',    a.ct,          b.ct,          { kind: 'hours',                       dir:  0 }],
      ['Efficiency',       a.eff,         b.eff,         { kind: 'pct',   suffix: '%',          dir:  1 }],
      ['Talk %',           a.talkPct,     b.talkPct,     { kind: 'pct',   suffix: '%',          dir:  1 }],
    ];
    const heroRows = rows.filter(r => r[3].hero).sort((r1, r2) => r1[3].hero - r2[3].hero);
    // Score the head-to-head: how many rows each agent wins outright.
    let aWins = 0, bWins = 0;
    rows.forEach(([, av, bv, opts]) => {
      if (sameAgent || noDataA || noDataB || !opts.dir) return;
      const diff = Number(av) - Number(bv);
      if (diff === 0) return;
      const aBetter = opts.dir > 0 ? diff > 0 : diff < 0;
      if (aBetter) aWins++; else bWins++;
    });
    let scoreLine = '';
    if (!sameAgent && !noDataA && !noDataB) {
      const leadTxt = aWins > bWins ? `<b>${escapeHtml(a.name)} leads</b> ${aWins} to ${bWins}`
                    : bWins > aWins ? `<b>${escapeHtml(b.name)} leads</b> ${bWins} to ${aWins}`
                    : `Tied ${aWins} to ${bWins}`;
      scoreLine = `<div class="cmp-score">${leadTxt} across ${aWins + bWins} scoring metrics</div>`;
    }
    const notices = [];
    if (sameAgent)  notices.push(`<div class="cmp-warn">Same agent picked on both sides. Pick a different Agent B to see a real comparison.</div>`);
    if (noDataA && !noDataB) notices.push(`<div class="cmp-warn"><b>${escapeHtml(a.name)}</b> had no dialling activity in this period.</div>`);
    if (noDataB && !noDataA) notices.push(`<div class="cmp-warn"><b>${escapeHtml(b.name)}</b> had no dialling activity in this period.</div>`);
    return `${notices.join('')}${scoreLine}${cmpHero(heroRows, a, b, { sameAgent, noDataA, noDataB })}<div class="mt">${cmpTableN(rows, a.name, b.name, { sameAgent, noDataA, noDataB })}</div>`;
  }

  // Compute which side wins a given row. Returns 1 = A wins, -1 = B wins,
  // 0 = tie (or the row is directionless / one side has no data / both
  // sides are the same agent). Isolated helper so the hero band + the
  // detail table share the exact same rule.
  function _cmpWinner(av, bv, opts, ctx) {
    if (!ctx || ctx.sameAgent || ctx.noDataA || ctx.noDataB) return 0;
    const dir = opts.dir || 0;
    if (dir === 0) return 0;
    const diff = Number(av) - Number(bv);
    if (diff === 0) return 0;
    return (dir > 0) ? (diff > 0 ? 1 : -1) : (diff > 0 ? -1 : 1);
  }

  // Hero KPI band: three side-by-side cards, one per hero metric.
  function cmpHero(rows, a, b, ctx) {
    const cards = rows.map(([label, av, bv, opts]) => {
      const winner = _cmpWinner(av, bv, opts, ctx);
      const cA = winner ===  1 ? 'cmp-cell--win'
              : winner === -1 ? 'cmp-cell--loss'
              : 'cmp-cell--same';
      const cB = winner === -1 ? 'cmp-cell--win'
              : winner ===  1 ? 'cmp-cell--loss'
              : 'cmp-cell--same';
      const max = Math.max(Number(av) || 0, Number(bv) || 0, 0.0001);
      const wA = Math.round(((Number(av) || 0) / max) * 100);
      const wB = Math.round(((Number(bv) || 0) / max) * 100);
      let footer = '';
      if (ctx.sameAgent) footer = 'Same agent selected';
      else if (ctx.noDataA) footer = `${escapeHtml(a.name)} has no data`;
      else if (ctx.noDataB) footer = `${escapeHtml(b.name)} has no data`;
      else if (winner === 0) footer = 'Tied';
      else {
        const winnerName = winner === 1 ? a.name : b.name;
        footer = `<b>${escapeHtml(winnerName)}</b> wins <span class="cmp-delta">${fmtCmpDelta(av, bv, opts)}</span>`;
      }
      return `<div class="cmp-hero-card">
        <div class="cmp-hero-label">${escapeHtml(label)}</div>
        <div class="cmp-hero-pair">
          <div class="cmp-hero-side ${cA}">
            <div class="cmp-hero-name">${escapeHtml(a.name)}</div>
            <div class="cmp-hero-metric tnum">${fmtCmpVal(av, opts)}</div>
            <div class="cmp-hero-bar"><span style="width:${wA}%"></span></div>
          </div>
          <div class="cmp-hero-side ${cB}">
            <div class="cmp-hero-name">${escapeHtml(b.name)}</div>
            <div class="cmp-hero-metric tnum">${fmtCmpVal(bv, opts)}</div>
            <div class="cmp-hero-bar"><span style="width:${wB}%"></span></div>
          </div>
        </div>
        <div class="cmp-hero-winner">${footer}</div>
      </div>`;
    }).join('');
    return `<div class="cmp-hero">${cards}</div>`;
  }

  // N-column comparison table with per-row winner shading. Used by the
  // agent mode; the older cmpTable is retained for Week / Month callers.
  function cmpTableN(rows, labelA, labelB, ctx) {
    const body = rows.map(([label, av, bv, opts]) => {
      const winner = _cmpWinner(av, bv, opts, ctx);
      const cA = winner ===  1 ? 'cmp-cell--win'
              : winner === -1 ? 'cmp-cell--loss'
              : 'cmp-cell--same';
      const cB = winner === -1 ? 'cmp-cell--win'
              : winner ===  1 ? 'cmp-cell--loss'
              : 'cmp-cell--same';
      const deltaTxt = ctx.sameAgent ? 'same agent'
                     : (ctx.noDataA || ctx.noDataB) ? 'no data'
                     : fmtCmpDelta(av, bv, opts);
      const deltaCls = winner === 1 ? 'up' : winner === -1 ? 'down' : 'flat';
      return `<tr>
        <td data-label="Metric" class="cmp-metric">${escapeHtml(label)}</td>
        <td data-label="${escapeHtml(labelA)}" class="num tnum ${cA}">${fmtCmpVal(av, opts)}</td>
        <td data-label="${escapeHtml(labelB)}" class="num tnum ${cB}">${fmtCmpVal(bv, opts)}</td>
        <td data-label="Delta" class="num"><span class="cmp-delta ${deltaCls}">${deltaTxt}</span></td>
      </tr>`;
    }).join('');
    return `<div class="tbl-wrap"><table class="tbl cmp-table">
      <thead><tr><th>Metric</th><th class="num">${escapeHtml(labelA)}</th><th class="num">${escapeHtml(labelB)}</th><th class="num">Delta</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  // Shared value + delta formatters. Split out from cmpTable so cmpHero
  // and cmpTableN can call them without going through the older path.
  function fmtCmpVal(v, opts) {
    if (opts.kind === 'pct')   return Number(v || 0).toFixed(1) + (opts.suffix || '%');
    if (opts.kind === 'hours') return Number(v || 0).toFixed(2) + 'h';
    if (opts.kind === 'rate')  return Number(v || 0).toFixed(opts.decimals != null ? opts.decimals : 1);
    return fmt(Math.round(Number(v) || 0));
  }
  function fmtCmpDelta(av, bv, opts) {
    const diff = Number(av || 0) - Number(bv || 0);
    const sign = diff > 0 ? '+' : '';
    if (opts.kind === 'pct')   return sign + diff.toFixed(1) + ' pts';
    if (opts.kind === 'hours') return sign + diff.toFixed(2) + 'h';
    if (opts.kind === 'rate')  return sign + diff.toFixed(opts.decimals != null ? opts.decimals : 1);
    return sign + fmt(Math.round(diff));
  }

  // Renders just the inner week-comparison body — used both on initial
  // mount and when the week dropdowns change (wired in app.js segWire).
  // Same metric set as the Month view minus 'Weeks of data' (always 1).
  function renderWeekCompare(weeks, keyA, keyB) {
    const lookup = new Map(weeks.map(w => [w.key, w]));
    const a = lookup.get(keyA);
    const b = lookup.get(keyB);
    if (!a || !b) {
      return `<div class="muted" style="padding:24px;text-align:center;font-size:13.5px">
        Pick two weeks to compare.
      </div>`;
    }
    // Uses cmpTableN (the Agent-vs-Agent renderer) so Week-vs-Week gets the
    // same direction-aware winner shading on the value cells. Each row carries
    // a `dir` (1 = higher is better); ctx is {} so no same-agent/no-data guard.
    return cmpTableN([
      ['Active callers',   a.activeCount, b.activeCount, { kind: 'count',                 dir: 1 }],
      ['Total calls',  a.calls,       b.calls,       { kind: 'count',                 dir: 1 }],
      ['Avg success rate', a.successRate, b.successRate, { kind: 'pct',  suffix: '%',    dir: 1 }],
      ['Avg calls/hr', a.cph,         b.cph,         { kind: 'rate', decimals: 1,     dir: 1 }],
      ['Seller leads',     a.seller,      b.seller,      { kind: 'count',                 dir: 1 }],
      ['Rental leads',     a.rental,      b.rental,      { kind: 'count',                 dir: 1 }],
      ['Emails collected', a.email,       b.email,       { kind: 'count',                 dir: 1 }],
      ['Dialler hours',    a.dfHours,     b.dfHours,     { kind: 'hours',                 dir: 1 }],
    ], a.label, b.label, {});
  }

  // Renders just the inner month-comparison body — used both on initial
  // mount and when the month dropdowns change (wired in app.js segWire).
  function renderMonthCompare(months, keyA, keyB) {
    const lookup = new Map(months.map(m => [m.key, m]));
    const a = lookup.get(keyA);
    const b = lookup.get(keyB);
    if (!a || !b) {
      return `<div class="muted" style="padding:24px;text-align:center;font-size:13.5px">
        Pick two months to compare.
      </div>`;
    }
    // Same cmpTableN path as Week-vs-Week for matching winner shading.
    // 'Weeks of data' is structural, not a performance metric, so dir:0
    // (no colour) — mirrors how Agent mode treats 'Clocked hours'.
    return cmpTableN([
      ['Weeks of data',    a.weeks,       b.weeks,       { kind: 'count',                 dir: 0 }],
      ['Active callers',   a.activeCount, b.activeCount, { kind: 'count',                 dir: 1 }],
      ['Total calls',  a.calls,       b.calls,       { kind: 'count',                 dir: 1 }],
      ['Avg success rate', a.successRate, b.successRate, { kind: 'pct',  suffix: '%',    dir: 1 }],
      ['Avg calls/hr', a.cph,         b.cph,         { kind: 'rate', decimals: 1,     dir: 1 }],
      ['Seller leads',     a.seller,      b.seller,      { kind: 'count',                 dir: 1 }],
      ['Rental leads',     a.rental,      b.rental,      { kind: 'count',                 dir: 1 }],
      ['Emails collected', a.email,       b.email,       { kind: 'count',                 dir: 1 }],
      ['Dialler hours',    a.dfHours,     b.dfHours,     { kind: 'hours',                 dir: 1 }],
    ], a.label, b.label, {});
  }

  // One reusable table renderer for both Week and Month comparisons.
  // The Change column shows absolute delta with a unit-appropriate
  // suffix — never a misleading % on raw hours.
  function cmpTable(rows, labelA, labelB) {
    const fmtVal = (v, opts) => {
      if (opts.kind === 'pct')   return Number(v).toFixed(1) + (opts.suffix || '%');
      if (opts.kind === 'hours') return Number(v).toFixed(2) + 'h';
      if (opts.kind === 'rate')  return Number(v).toFixed(opts.decimals ?? 1);
      return fmt(Math.round(Number(v) || 0));
    };
    const fmtDelta = (av, bv, opts) => {
      const diff = Number(av) - Number(bv);
      const sign = diff > 0 ? '+' : '';
      if (opts.kind === 'pct')   return sign + diff.toFixed(1) + ' pts';
      if (opts.kind === 'hours') return sign + diff.toFixed(2) + 'h';
      if (opts.kind === 'rate')  return sign + diff.toFixed(opts.decimals ?? 1);
      return sign + fmt(Math.round(diff));
    };
    const body = rows.map(([label, av, bv, opts]) => {
      const diff = Number(av) - Number(bv);
      const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
      const ic  = diff > 0 ? I.up : diff < 0 ? I.down : '';
      return `<tr>
        <td style="font-weight:600;color:var(--ink)">${label}</td>
        <td class="num tnum">${fmtVal(av, opts)}</td>
        <td class="num tnum">${fmtVal(bv, opts)}</td>
        <td class="num"><span class="delta ${cls}">${ic}${fmtDelta(av, bv, opts)}</span></td>
      </tr>`;
    }).join('');
    return `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Metric</th><th class="num">${labelA}</th><th class="num">${labelB}</th><th class="num">Change</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  // ---------------------------------------------------- DAILY
  // Picks a specific date and renders per-caller stats. Backed by
  // data/daily_data.json (written by the update-daily.yml workflow);
  // shows an empty-state with backfill instructions if no entry exists.
  function daily(period, selectedDate) {
    const available = (Q.dailyDates || []).slice();
    const date = selectedDate || (available[0] || null);
    const agents = (Q.dailyFor && date) ? (Q.dailyFor(date) || []) : [];
    const scaleMax = agents.length ? agents[0].calls : 1;
    const rows = agents.map((a, i) => agentRow(a, i + 1, scaleMax)).join('');
    const totCalls = agents.reduce((s, a) => s + a.calls, 0);
    const totLeads = agents.reduce((s, a) => s + a.leads, 0);

    // Friendly label "Thursday · 5 June 2026"
    const labelFor = (ymd) => {
      if (!ymd) return '—';
      const d = new Date(ymd + 'T00:00:00Z');
      const weekday = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      const day = d.getUTCDate();
      const month = d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
      const year = d.getUTCFullYear();
      return `${weekday} · ${day} ${month} ${year}`;
    };
    const prettyDate = labelFor(date);

    // The empty-state message when no data exists for the picked date
    // OR when the daily fetcher has never run.
    const emptyMsg = !available.length
      ? `No per-day data yet — the <code>update-daily.yml</code> workflow needs to populate <code>data/daily_data.json</code>. ` +
        `Trigger it manually with a start_date / end_date in GitHub Actions, or wait for the daily 06:00 SAST cron.`
      : `No data captured for <b>${escapeHtml(prettyDate)}</b>. ` +
        `The most recent date with stats is <b>${available[0]}</b>.`;

    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel" style="justify-content:space-between">
          <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
            <div class="field">
              <label for="dailyDate">Date</label>
              <input id="dailyDate" type="date" value="${date || ''}" ${available.length ? `min="${available[available.length - 1]}" max="${available[0]}"` : ''}>
            </div>
            <button class="btn" data-daily-jump="today">Today</button>
            <button class="btn" data-daily-jump="yesterday">Yesterday</button>
            <button class="btn" data-daily-step="-1">${'◀'} Prev day</button>
            <button class="btn" data-daily-step="1">Next day ${'▶'}</button>
          </div>
          <button class="btn js-export">${I.download} Export CSV</button>
        </div>
      </div>
      <div class="row g-3 mt">
        ${miniStat('Calls', fmt(totCalls), prettyDate, I.phone)}
        ${miniStat('Leads', fmt(totLeads), 'seller · rental · email', I.target)}
        ${miniStat('Active callers', agents.length + '', 'logged dialling time', I.users)}
      </div>
      <div class="card mt">
        <div class="card-head"><div><h3>Per-caller performance — ${escapeHtml(prettyDate)}</h3><div class="sub">${available.length} day${available.length === 1 ? '' : 's'} of history available</div></div></div>
        ${agents.length ? `
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th class="num">#</th><th>Agent</th><th>Team</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Success</th><th class="num">Connect</th><th class="num">Dialler</th><th class="num">Clocked</th><th class="num">Eff %</th><th class="num">Volume</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        ` : `<div class="muted" style="padding:24px;text-align:center;font-size:13.5px;line-height:1.6">${emptyMsg}</div>`}
      </div>
      <!-- End-of-day reports submitted on this date (populated by app.js after mount) -->
      <div class="mt" id="dailyReportsHost" data-daily-date="${date || ''}"></div>
    </div>`;
  }

  // Shared escapeHtml — owned by app.js, exposed as window.QUAY_ESC.
  // Fallback wraps it locally in case views.js loads before app.js
  // (shouldn't happen with the current order, but defensive).
  const escapeHtml = (s) => (window.QUAY_ESC
    ? window.QUAY_ESC(s)
    : String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;'));

  // ---------------------------------------------------- MANAGER
  function manager(period) {
    period = period || 'this-week';

    // ---- Monthly graphs --------------------------------------------------
    // Re-uses the Operational Overview's miniCard painter (.mc el is wired
    // by managerWire() in app.js after this view mounts).
    const monthCard = (label, icon, series, color, unit) => {
      const last = series[series.length - 1], prev = series[series.length - 2] || 1;
      const pct = (((last - prev) / prev) * 100).toFixed(1);
      const up  = last >= prev;
      return `<div class="card mini">
        <div class="mini-head">${icon} ${label} by month</div>
        <div class="mini-sub">last 8 months</div>
        <div class="mini-val tnum">${fmt(last)}${unit || ''}<span style="color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span></div>
        <div style="margin-top:10px" class="mc" data-series='${JSON.stringify(series)}' data-color="${color}"></div>
      </div>`;
    };
    const monthlyGraphs = `
      <div class="card mt card-pad">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
          <div><h3 style="margin:0">Monthly trends</h3><div class="sub">Last 8 months across the engine room · ${Q.MONTHS[0]} → ${Q.MONTHS[Q.MONTHS.length - 1]}</div></div>
        </div>
        <div class="row mini-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
          ${monthCard('Calls', I.phone, Q.MONTH_CALLS, '#3D5BA6')}
          ${monthCard('Leads',   I.target, Q.MONTH_LEADS,   '#B98A02')}
          ${monthCard('Rentals', I.home,   Q.MONTH_RENTALS, '#4C6BB8')}
          ${monthCard('Emails',  I.mail,   Q.MONTH_EMAILS,  '#2E6FB0')}
        </div>
      </div>`;
    // Tab is "Red Flags" — show the flags card first (the actionable bit)
    // and the monthly trend strip below as context. Campaign breakdown table
    // was retired (lives in the Operational Overview's campaign drill-downs).
    return `
    <div class="tab-view">
      <div id="managerFlagsHost"></div>
      ${monthlyGraphs}
    </div>`;
  }

  // ---------------------------------------------------- LEAD SOURCES (now: Campaigns)
  function leadSources(period) {
    const pk = period || 'this-week';
    // Combined Dialfire dialling + Engine Room (ClientHub) calling, one row per
    // team, each expandable into its CM / NA / New sources.
    const teams = Q.leadSourceRows(pk);
    if (!teams.length) {
      return `<div class="tab-view"><div class="card card-pad">
        <h3 style="font-family:var(--serif);margin:0 0 8px">No lead-source data</h3>
        <div class="sub">No teams found for this period.</div></div></div>`;
    }
    const totalCalls = teams.reduce((s, c) => s + c.calls, 0);
    const totalLeads = teams.reduce((s, c) => s + c.leads, 0);
    const totalEmails = teams.reduce((s, c) => s + c.email, 0);
    const totalSeller = teams.reduce((s, c) => s + c.seller, 0);
    const totalRental = teams.reduce((s, c) => s + c.rental, 0);
    const totalER = teams.reduce((s, c) => s + (c.engineRoom ? c.engineRoom.calls : 0), 0);
    // Floor-wide Connect% = total answered ÷ the Dialfire attempts those
    // answered figures cover (null when no team has answered data this period).
    const totalAnswered = teams.reduce((s, c) => s + (c.answered || 0), 0);
    const totalAnsCalls = teams.reduce((s, c) => s + (c.answeredCalls || 0), 0);
    const anyAnswered   = teams.some(c => c.answered != null);
    const floorConnect  = anyAnswered && totalAnsCalls
      ? +((totalAnswered / totalAnsCalls) * 100).toFixed(1) : null;
    const maxCalls = teams[0].calls || 1;
    const best = teams.slice().sort((a, b) => b.conv - a.conv)[0];

    // A team's drill-down: its Dialfire CM/NA/New + Engine Room CM/NA/New.
    const sourceRows = (t) => {
      if (!t.sources || !t.sources.length) {
        return `<tr><td colspan="7" class="muted" style="padding:12px 16px;font-size:12.5px">
          No per-source breakdown for this period yet.</td></tr>`;
      }
      return t.sources.map((s) => {
        const dot = s.group === 'Engine Room' ? '#B98A02' : '#3D5BA6';
        return `<tr>
          <td style="padding-left:20px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${dot};margin-right:8px"></span>
            <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">${s.group}</span>
            <b style="margin-left:6px">${s.label}</b></td>
          <td class="num tnum">${fmt(s.calls)}</td>
          <td class="num tnum">${fmt(s.leads)}</td>
          <td class="num tnum">${fmt(s.seller)}</td>
          <td class="num tnum">${fmt(s.rental)}</td>
          <td class="num tnum">${fmt(s.email)}</td>
          <td class="num muted tnum">${s.conv}%</td>
        </tr>`;
      }).join('');
    };

    const rows = teams.map((c, i) => {
      const conv = c.conv;
      const pill = conv >= 12 ? 'ok' : conv >= 7 ? 'warn' : 'bad';
      const bar = (c.calls / maxCalls) * 100;
      // Answered/Connect are measured on Dialfire auto-dials only. When a team
      // also has manual Engine Room calls, `calls` (total attempts) exceeds the
      // measured base — surface that so e.g. "4,300 attempts / 15 answered /
      // 75%" reads as "75% of the 20 auto-dials", not a broken number.
      const dialAtt = c.answeredCalls != null ? c.answeredCalls : (c.answered != null ? c.calls : 0);
      const manualCalls = (c.answered != null && dialAtt) ? Math.max(c.calls - dialAtt, 0) : 0;
      // When Answered/Connect are blank, explain *why* so a team with real
      // leads (e.g. Mozzies) doesn't read as "never connects". Two causes:
      // Engine-Room-only teams (ClientHub has no pick-up signal), or Dialfire
      // calls that pre-date answered tracking (20 Aug 2026) / have aged out of
      // Dialfire's ~60-day call-log retention. Leads are unaffected either way.
      const erCalls = c.engineRoom ? (c.engineRoom.calls || 0) : 0;
      const dfCalls = c.dialfire ? (c.dialfire.calls || 0) : 0;
      const noAnsWhy = (erCalls && !dfCalls)
        ? 'No answered data: this team calls through the Engine Room (ClientHub), which has no pick-up / answered signal. Leads still count.'
        : 'No answered data for these calls: they pre-date Dialfire answered tracking (from 20 Aug 2026) or have aged out of its ~60-day call-log retention. Leads still count.';
      const overlap = c.exact === false;
      const nameSuffix = overlap
        ? '<span title="Over-counted: a legacy week where an agent worked multiple campaigns and this row sums their total across all of them" style="margin-left:6px;color:var(--amber);font-weight:700;cursor:help" aria-label="Over-counted row">⚠</span>'
        : '';
      const erBadge = c.engineRoom && c.engineRoom.calls
        ? `<span class="pill" style="font-size:10px;padding:2px 7px;margin-left:8px;background:rgba(185,138,2,.12);color:#8a6a02" title="Includes Engine Room (ClientHub) calling">+ Engine Room</span>`
        : '';
      const head = `<tr class="ls-row"${overlap ? ' style="background:rgba(185,138,2,.04)"' : ''}`
        + ` data-ls-key="${i}" data-name="${String(c.name).replace(/"/g, '&quot;')}"`
        + ` data-agents="${c.agentsCount}" data-calls="${c.calls}" data-leads="${c.leads}"`
        + ` data-seller="${c.seller}" data-rental="${c.rental}" data-email="${c.email}" data-conv="${conv}">
        <td class="num" style="font-weight:700;color:var(--muted);width:40px">${i + 1}</td>
        <td><a href="#" class="ls-link" data-ls-key="${i}" style="text-decoration:none;color:inherit">
          <span class="ls-caret" aria-hidden="true" style="display:inline-block;width:12px;color:var(--muted)">▸</span>
          <span style="width:11px;height:11px;border-radius:3px;background:${c.color};display:inline-block;vertical-align:middle;margin:0 6px"></span>
          <span class="agent-name">${c.name}${nameSuffix}</span>${erBadge}</a></td>
        <td class="num tnum">${c.agentsCount}</td>
        <td class="num tnum"${manualCalls ? ` title="${fmt(dialAtt)} auto-dial attempts + ${fmt(manualCalls)} manual Engine Room calls"` : ''}>${fmt(c.calls)}${manualCalls ? '<span class="muted" style="font-size:10px"> †</span>' : ''}</td>
        <td class="num tnum">${c.answered != null
            ? fmt(c.answered) + (manualCalls ? `<span class="muted" style="font-size:10px" title="Answered is measured on the ${fmt(dialAtt)} auto-dial attempts only. The ${fmt(manualCalls)} manual Engine Room calls have no pick-up signal.">/${fmt(dialAtt)}</span>` : '')
            : `<span class="muted" style="cursor:help;border-bottom:1px dotted var(--muted)" title="${noAnsWhy}">—</span>`}</td>
        <td class="num tnum">${c.connect != null
            ? `<span title="Connect = ${fmt(c.answered)} answered ÷ ${fmt(dialAtt)} auto-dial attempts${manualCalls ? ` (excludes ${fmt(manualCalls)} manual Engine Room calls with no pick-up data)` : ''}">${c.connect}%${manualCalls ? ' †' : ''}</span>`
            : `<span class="muted" style="cursor:help;border-bottom:1px dotted var(--muted)" title="Connect rate — ${noAnsWhy}">—</span>`}</td>
        <td class="num tnum">${fmt(c.leads)}</td>
        <td class="num tnum">${fmt(c.seller)}</td>
        <td class="num tnum">${fmt(c.rental)}</td>
        <td class="num tnum">${fmt(c.email)}</td>
        <td class="num"><span class="pill ${pill}${overlap ? '" style="opacity:.65' : ''}" title="${overlap ? 'Approximate — overlap-based aggregation' : ''}">${conv}%</span></td>
        <td class="num"><div class="cell-bar"><div class="track"><span style="width:${bar}%;background:${c.color}"></span></div></div></td>
      </tr>`;
      const detail = `<tr class="ls-detail" data-ls-detail="${i}" style="display:none;background:#FAFBFC">
        <td></td>
        <td colspan="11" style="padding:0 10px 10px">
          <table class="tbl" style="margin:0;width:100%;box-shadow:none">
            <thead><tr>
              <th style="padding-left:20px">Source</th>
              <th class="num">Calls</th><th class="num">Leads</th><th class="num">Seller</th>
              <th class="num">Rental</th><th class="num">Email</th><th class="num">Conv.</th>
            </tr></thead>
            <tbody>${sourceRows(c)}</tbody>
          </table>
        </td>
      </tr>`;
      return head + detail;
    }).join('');

    return `
    <div class="tab-view">
      <div class="row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
        ${miniStat('Best converter', best.name, best.conv + '% (' + fmt(best.leads) + ' / ' + fmt(best.calls) + ' calls)', I.star)}
        ${miniStat('Connect rate', floorConnect != null ? floorConnect + '%' : '—',
          floorConnect != null ? fmt(totalAnswered) + ' answered / ' + fmt(totalAnsCalls) + ' attempts' : 'awaiting per-team answered data', I.phone || I.medal)}
        ${miniStat('Seller leads', fmt(totalSeller), 'Dialfire + Engine Room', I.medal)}
        ${miniStat('Rental leads', fmt(totalRental), 'Dialfire + Engine Room', I.home)}
        ${miniStat('Engine Room calls', fmt(totalER), 'of ' + fmt(totalCalls) + ' total', I.phone || I.layers)}
        ${miniStat('Teams', teams.length + '', best.agentsCount + ' agents on top team', I.layers)}
      </div>

      <div class="mt">
        <div class="card">
          <div class="card-head"><div><h3 id="lead-sources-tbl-h">Lead sources by team</h3>
            <div class="sub">Combined Dialfire + Engine Room · ${(Q.PERIODS[pk] || {}).label || pk} · click a team to see its CM / NA / New sources</div></div>
            <button class="btn js-export">${I.download} Export CSV</button></div>
          <div class="tbl-wrap"><table class="tbl" id="lead-sources-tbl" aria-labelledby="lead-sources-tbl-h">
            <thead><tr>
              <th class="num">#</th>
              <th>Team</th>
              <th class="num">Agents</th>
              <th class="num" title="Call attempts — every dial the team completed (Dialfire + Engine Room)">Attempts</th>
              <th class="num" title="Answered — calls where the line was picked up (completed dials minus No Answer / not-in-service / busy). Dialfire only; includes wrong numbers &amp; voicemail.">Answered</th>
              <th class="num" title="Connect rate = Answered ÷ Dialfire attempts">Connect</th>
              <th class="num">Leads</th>
              <th class="num">Seller</th>
              <th class="num">Rental</th>
              <th class="num">Email</th>
              <th class="num">Conv.</th>
              <th class="num">Volume</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          <details class="card-explainer">
            <summary>${I.check} About these numbers · period totals: ${fmt(totalCalls)} calls · ${fmt(totalLeads)} leads · ${fmt(totalEmails)} emails</summary>
            <p>Each team row combines <b>Dialfire</b> dialling with the team's <b>Engine Room</b> (ClientHub) calling
              for the period. Expand a team to see where its calls come from: the Dialfire
              <code>CM</code>/<code>NA</code>/<code>New</code> variants and the Engine Room
              <code>CM</code>/<code>NA</code>/<code>New</code> campaigns.</p>
            <p><b>Attempts</b> = every completed dial. <b>Answered</b> = calls where the line was
              picked up (completed dials minus <code>No Answer</code>, <code>Not in service</code> and
              <code>Busy</code>); <b>Connect</b> = Answered ÷ Dialfire attempts. This is the telephony
              Connect rate, so it counts wrong numbers and voicemail as answered. Answered/Connect are
              Dialfire-only (Engine Room has no pick-up signal) and show <b>—</b> when there is no
              answered signal for a team's calls in the period: either the calls run through the Engine
              Room, or they pre-date Dialfire's answered tracking (from 2026-08-20) and have aged out of
              its ~60-day call-log retention, so that history can no longer be recovered. Leads for those
              calls are unaffected — hover a <b>—</b> for the specific reason.</p>
            <p class="muted">A <b>†</b> marks teams that also do manual Engine Room (ClientHub)
              calling. Those manual calls count in <b>Attempts</b> but have no pick-up signal, so
              <b>Answered</b> and <b>Connect</b> are measured only on the team's Dialfire auto-dials
              (shown as <code>answered/dials</code> and in the Connect tooltip).</p>
            <p>Engine Room's per-source (CM/NA/New) split populates on the next scheduled
              data refresh after this change ships; until then a team's Engine Room calls show as a single line.</p>
            <p class="muted">Rows marked <span style="color:var(--amber)">⚠</span> are legacy weeks that
              pre-date exact per-campaign attribution and may over-count on the Dialfire side.</p>
          </details>
        </div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------- MONTHLY BREAKDOWN
  // One row per calendar month — newest-first. Matches the
  // "Monthly Breakdown — All Time" pattern from the management dashboard
  // so the two surfaces line up.
  function monthly() {
    const rows = Q.monthlyBreakdown ? Q.monthlyBreakdown() : [];
    // Use the shared success-rate threshold (see sucClass at top of module)
    // so Monthly Breakdown agrees with Overview / Leadership / All Staff.
    const srPill = sucClass;

    const body = rows.length ? rows.map(r => `
      <tr data-month-row="${r.key}" class="month-row">
        <td><a href="#" class="month-link" data-month-key="${r.key}">
          <span class="month-caret" aria-hidden="true">▸</span> ${r.label}
        </a></td>
        <td class="muted">${r.weeks} week${r.weeks === 1 ? '' : 's'}</td>
        <td>
          <span class="pill rm" style="font-size:11px;padding:3px 9px">${r.rmCount} RMs</span>
          <span class="pill fancy" style="font-size:11px;padding:3px 9px;margin-left:6px">${r.fancyCount} Fancy</span>
        </td>
        <td class="num tnum" style="font-weight:700">${fmt(r.calls)}</td>
        <td class="num"><span class="pill ${srPill(r.successRate)}">${r.successRate}%</span></td>
        <td class="num tnum">${fmt(r.seller)}</td>
        <td class="num tnum">${fmt(r.rental)}</td>
        <td class="num tnum">${fmt(r.email)}</td>
      </tr>
      <tr data-month-detail="${r.key}" style="display:none;background:#FAFBFC">
        <td colspan="8" style="padding:0">
          <div class="month-weeks-host" data-month-key="${r.key}"></div>
        </td>
      </tr>`).join('') : `
      <tr><td colspan="8" class="muted" style="text-align:center;padding:34px">
        No monthly data yet — backfill needs to land first.
      </td></tr>`;

    return `
    <div class="tab-view">
      <div class="card">
        <div class="card-head">
          <div><h3>Monthly Breakdown · All Time</h3>
            <div class="sub">Aggregated from every week of DialFire history we have</div>
          </div>
          <button class="btn js-export">${I.download} Export CSV</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Month</th>
            <th>Weeks</th>
            <th>Callers</th>
            <th class="num">Total Calls</th>
            <th class="num">Success Rate</th>
            <th class="num">Seller Leads</th>
            <th class="num">Rental Leads</th>
            <th class="num">Emails</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </div>
    </div>`;
  }

  // Per-week breakdown table for the Monthly tab's drill-down.
  function monthWeeksTable(monthKey) {
    const weeks = (Q.weeksInMonth && Q.weeksInMonth(monthKey)) || [];
    if (!weeks.length) {
      return `<div class="muted" style="padding:18px;text-align:center;font-size:13px">
        No weekly data for this month.
      </div>`;
    }
    const srPill = sucClass;
    const body = weeks.map(w => `
      <tr>
        <td style="font-weight:600;color:var(--ink)">${w.label}</td>
        <td class="num tnum">${w.activeCount}</td>
        <td class="num tnum" style="font-weight:700">${fmt(w.calls)}</td>
        <td class="num"><span class="pill ${srPill(w.successRate)}">${w.successRate}%</span></td>
        <td class="num tnum">${w.cph}</td>
        <td class="num tnum">${fmt(w.seller)}</td>
        <td class="num tnum">${fmt(w.rental)}</td>
        <td class="num tnum">${fmt(w.email)}</td>
        <td class="num tnum">${w.dfHours.toFixed(2)}h</td>
      </tr>`).join('');
    return `<div style="padding:14px 18px">
      <div class="sub" style="font-size:12px;margin-bottom:8px">Per-week breakdown</div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th>Week of</th>
          <th class="num">Callers</th>
          <th class="num">Calls</th>
          <th class="num">Success</th>
          <th class="num">CPH</th>
          <th class="num">Seller</th>
          <th class="num">Rental</th>
          <th class="num">Emails</th>
          <th class="num">Dialler hrs</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
  }

  // Expose the pill helpers so app.js + other tab code can stop hand-rolling
  // ad-hoc thresholds. Single source of truth = sucClass/effClass/cphClass.
  window.QUAY_PILLS = { sucClass, effClass, cphClass };

  return { allStaff, lnReports, compare, daily, manager, leadSources, monthly, renderMonthCompare, renderWeekCompare, renderAgentCompare, monthWeeksTable };
})();
