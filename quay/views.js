/* Quay 1 — secondary tab views (All Staff, Compare, Daily, Manager, Lead Sources) */

window.VIEWS = (function () {
  const Q = window.QUAY, I = window.ICON, C = window.CHART;
  const fmt = n => n.toLocaleString('en-ZA');
  const initials = name => name.split(' ').map(w => w[0]).slice(0, 2).join('');
  const effClass = e => e >= 70 ? 'ok' : e >= 60 ? 'warn' : 'bad';
  const sucClass = s => s >= 15 ? 'ok' : s >= 11 ? 'warn' : 'bad';

  function agentRow(a, rank) {
    const sc = sucClass(a.success);
    const ec = effClass(a.eff);
    const bar = Math.min(100, (a.calls / 720) * 100);
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
        <div><div class="agent-name">${a.name}</div>
        <div class="agent-sub">ID ${a.id.toUpperCase()}</div></div>
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
  function allStaff(period) {
    const agents = Q.agentsFor(period).slice().sort((a, b) => b.calls - a.calls);
    const rows = agents.map((a, i) => agentRow(a, i + 1)).join('');
    const cards = agents.map(a => perCallerCard(a)).join('');
    const tCalls = agents.reduce((s, a) => s + a.calls, 0);
    const tLeads = agents.reduce((s, a) => s + a.leads, 0);
    const totDf  = agents.reduce((s, a) => s + (a.df || 0), 0);
    const totCt  = agents.reduce((s, a) => s + (a.ct || 0), 0);
    const haveClock = agents.some(a => a.ctSource === 'clock');
    const avgEff = agents.length ? Math.round(agents.reduce((s, a) => s + (a.eff || 0), 0) / agents.length) : 0;
    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel" style="justify-content:space-between">
          <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label>From</label><input type="date" value="2026-06-01"></div>
            <div class="field"><label>To</label><input type="date" value="2026-06-05"></div>
            <div class="field"><label>Team</label><select><option>All teams</option><option>RM</option><option>Fancy</option></select></div>
            <button class="btn btn-primary">${I.filter} Apply</button>
          </div>
          <div class="seg" id="staffSeg">
            <button class="active" data-view="overall">Overall Report</button>
            <button data-view="per">Per Caller</button>
          </div>
        </div>
      </div>

      <div class="row mt" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
        ${miniStat('Roster size', agents.length + ' agents', 'RM + Fancy combined', I.users)}
        ${miniStat('Total calls', fmt(tCalls), 'across selected range', I.phone)}
        ${miniStat('Total leads', fmt(tLeads), 'seller · rental · email', I.target)}
        ${miniStat('Avg efficiency', avgEff + '%', 'DialFire ÷ clocked time · target ≥70%', I.bolt)}
        ${miniStat('Dialler vs clocked', totDf.toFixed(0) + 'h / ' + totCt.toFixed(0) + 'h', haveClock ? 'real data from quay-clock' : 'estimated — no clock data yet', I.clock)}
      </div>

      <div class="card mt" id="staffOverall">
        <div class="card-head">
          <div><h3>Agent-level performance</h3><div class="sub">Calls · leads · dialler vs clocked hours · efficiency · click any column to sort</div></div>
          <button class="btn">${I.download} Export CSV</button>
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
    </div>`;
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
            ${onTarget ? '<span class="pill ok" style="font-size:10px;padding:2px 8px">✓ on target</span>' : ''}
            <span class="pill ${sc}" style="font-size:10px;padding:2px 8px">${a.success}% success</span>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px 16px">
        ${stat('Calls', fmt(a.calls))}
        ${stat('Leads', fmt(a.leads))}
        ${stat('CPH', a.cph || '—')}
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
    return `<div class="card card-pad">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="kpi-ic">${icon}</div>
        <div><div class="kpi-label" style="margin:0;white-space:nowrap">${label}</div>
        <div style="font-family:var(--serif);font-size:24px;font-weight:600;color:var(--ink);line-height:1.15;white-space:nowrap">${value}</div></div>
      </div>
      <div class="kpi-foot" style="margin-top:12px">${sub}</div>
    </div>`;
  }

  // ---------------------------------------------------- COMPARE
  function compare() {
    const A = { calls: 7396, leads: 498, success: 17.1, leadsE: 196, leadsR: 142 };
    const B = { calls: 6810, leads: 461, success: 15.9, leadsE: 178, leadsR: 131 };
    const metric = (label, a, b, suffix = '') => {
      const diff = a - b, pct = ((diff / b) * 100).toFixed(1);
      const up = diff >= 0;
      return `<tr>
        <td style="font-weight:600;color:var(--ink)">${label}</td>
        <td class="num tnum">${fmt(a)}${suffix}</td>
        <td class="num tnum">${fmt(b)}${suffix}</td>
        <td class="num"><span class="delta ${up ? 'up' : 'down'}">${up ? I.up : I.down}${Math.abs(pct)}%</span></td>
      </tr>`;
    };
    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel">
          <div class="seg" id="cmpSeg">
            <button class="active">${I.calendar} Week vs Week</button>
            <button>${I.cal2} Month vs Month</button>
          </div>
          <div class="field"><label>Period A</label><select><option>W23 · This week</option><option>W22</option></select></div>
          <div class="field"><label>Period B</label><select><option>W21 · Week before</option><option>W22</option></select></div>
          <button class="btn btn-primary">${I.scale} Compare</button>
        </div>
      </div>

      <div class="row g-2 mt">
        ${cmpHero('Week A', 'W23 · 1–5 Jun', A, 'win')}
        ${cmpHero('Week B', 'W21 · 18–22 May', B, '')}
      </div>

      <div class="card mt">
        <div class="card-head"><div><h3>Side-by-side breakdown</h3><div class="sub">Week A vs Week B · variance</div></div></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Metric</th><th class="num">Week A</th><th class="num">Week B</th><th class="num">Change</th></tr></thead>
          <tbody>
            ${metric('Total calls', A.calls, B.calls)}
            ${metric('Total leads', A.leads, B.leads)}
            ${metric('Avg success rate', A.success, B.success, '%')}
            ${metric('Email leads', A.leadsE, B.leadsE)}
            ${metric('Rental leads', A.leadsR, B.leadsR)}
          </tbody>
        </table></div>
      </div>
    </div>`;
  }
  function cmpHero(tag, sub, d, cls) {
    return `<div class="card spot ${cls}">
      <div class="eyebrow">${tag} · ${sub}</div>
      <div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:14px">
        <div><div class="kpi-label" style="margin:0">Calls</div><div class="spot-name" style="margin-top:2px">${fmt(d.calls)}</div></div>
        <div><div class="kpi-label" style="margin:0">Leads</div><div class="spot-name" style="margin-top:2px">${fmt(d.leads)}</div></div>
        <div><div class="kpi-label" style="margin:0">Success</div><div class="spot-name" style="margin-top:2px">${d.success}%</div></div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------- DAILY
  function daily(period) {
    const agents = Q.agentsFor('this-week').map(a => ({ ...a, calls: Math.round(a.calls / 5), leads: Math.round(a.leads / 5) }))
      .sort((a, b) => b.calls - a.calls);
    const rows = agents.map((a, i) => agentRow(a, i + 1)).join('');
    const tot = agents.reduce((s, a) => s + a.calls, 0);
    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel" style="justify-content:space-between">
          <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">
            <div class="field"><label>Date</label><input type="date" value="2026-06-05"></div>
            <button class="btn">Today</button><button class="btn">Yesterday</button>
            <button class="btn">◀ Prev</button><button class="btn">Next ▶</button>
            <button class="btn btn-primary">${I.calendar} Load</button>
          </div>
          <button class="btn">${I.download} Export CSV</button>
        </div>
      </div>
      <div class="row g-3 mt">
        ${miniStat('Calls today', fmt(tot), 'Thursday · 5 June 2026', I.phone)}
        ${miniStat('Leads today', fmt(agents.reduce((s,a)=>s+a.leads,0)), 'seller · rental · email', I.target)}
        ${miniStat('Active callers', agents.length + '', 'logged dialling time today', I.users)}
      </div>
      <div class="card mt">
        <div class="card-head"><div><h3>Per-caller performance — 5 June</h3><div class="sub">Today's dialling by agent</div></div></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th class="num">#</th><th>Agent</th><th>Team</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Success</th><th class="num">Connect</th><th class="num">Dialler</th><th class="num">Clocked</th><th class="num">Eff %</th><th class="num">Volume</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------- MANAGER
  function manager() {
    const camps = ['Seller Mandates', 'Rental Drive', 'Email Capture', 'Database Reactivation', 'Show-day Follow-up'];
    const chips = camps.map((c, i) => `<label class="pill ${i < 2 ? 'fancy' : 'rm'}" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 12px">
      <input type="checkbox" ${i < 2 ? 'checked' : ''} style="accent-color:var(--brass)"> ${c}</label>`).join('');
    const data = [
      ['Seller Mandates', 9840, 612, 6.2, 31.5],
      ['Rental Drive', 7120, 488, 6.9, 24.0],
      ['Email Capture', 5460, 742, 13.6, 18.5],
      ['Database Reactivation', 3180, 196, 6.2, 12.8],
      ['Show-day Follow-up', 2210, 174, 7.9, 9.4],
    ];
    const rows = data.map(d => `<tr>
      <td style="font-weight:600;color:var(--ink)">${d[0]}</td>
      <td class="num tnum">${fmt(d[1])}</td>
      <td class="num tnum">${fmt(d[2])}</td>
      <td class="num"><span class="pill ${d[3] >= 10 ? 'ok' : d[3] >= 6.5 ? 'warn' : 'bad'}">${d[3]}%</span></td>
      <td class="num tnum">${d[4]}h</td>
    </tr>`).join('');
    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel" style="flex-direction:column;align-items:stretch;gap:18px">
          <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">
            <div class="field"><label>From</label><input type="date" value="2026-05-01"></div>
            <div class="field"><label>To</label><input type="date" value="2026-06-05"></div>
            <button class="btn btn-primary" style="margin-left:auto">${I.chart} Run report</button>
            <button class="btn">${I.download} Export CSV</button>
          </div>
          <div>
            <label style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">Campaigns</label>
            <div style="display:flex;flex-wrap:wrap;gap:9px;margin-top:9px">${chips}</div>
          </div>
        </div>
      </div>
      <div class="card mt">
        <div class="card-head"><div><h3>Campaign performance — May 1 to Jun 5</h3><div class="sub">Filtered by selected campaigns</div></div></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Campaign</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Conv.</th><th class="num">Dialler hrs</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------- LEAD SOURCES (now: Campaigns)
  function leadSources(period) {
    const camps = Q.campaignsFor(period || 'this-week');
    if (!camps.length) {
      return `<div class="tab-view"><div class="card card-pad">
        <h3 style="font-family:var(--serif);margin:0 0 8px">No campaign data</h3>
        <div class="sub">No campaigns found for this period.</div></div></div>`;
    }
    const totalCalls = camps.reduce((s, c) => s + c.calls, 0);
    const totalLeads = camps.reduce((s, c) => s + c.leads, 0);
    const totalEmails = camps.reduce((s, c) => s + c.email, 0);
    const totalSeller = camps.reduce((s, c) => s + c.seller, 0);
    const totalRental = camps.reduce((s, c) => s + c.rental, 0);
    const maxCalls = camps[0].calls || 1;
    const best = camps.slice().sort((a, b) => b.conv - a.conv)[0];

    const rows = camps.map((c, i) => {
      const conv = c.conv;
      const pill = conv >= 12 ? 'ok' : conv >= 7 ? 'warn' : 'bad';
      const bar = (c.calls / maxCalls) * 100;
      return `<tr>
        <td class="num" style="font-weight:700;color:var(--muted);width:40px">${i + 1}</td>
        <td><div class="agent-cell">
          <span style="width:11px;height:11px;border-radius:3px;background:${c.color};display:inline-block"></span>
          <span class="agent-name">${c.name}</span></div></td>
        <td class="num tnum">${c.agentsCount}</td>
        <td class="num tnum">${fmt(c.calls)}</td>
        <td class="num tnum">${fmt(c.leads)}</td>
        <td class="num tnum">${fmt(c.seller)}</td>
        <td class="num tnum">${fmt(c.rental)}</td>
        <td class="num tnum">${fmt(c.email)}</td>
        <td class="num"><span class="pill ${pill}">${conv}%</span></td>
        <td class="num"><div class="cell-bar"><div class="track"><span style="width:${bar}%;background:${c.color}"></span></div></div></td>
      </tr>`;
    }).join('');

    return `
    <div class="tab-view">
      <div class="row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
        ${miniStat('Best converter', best.name, best.conv + '% (' + fmt(best.leads) + ' / ' + fmt(best.calls) + ')', I.star)}
        ${miniStat('Seller leads', fmt(totalSeller), 'across all campaigns', I.medal)}
        ${miniStat('Rental leads', fmt(totalRental), 'across all campaigns', I.home)}
        ${miniStat('Email leads',  fmt(totalEmails), 'across all campaigns', I.mail)}
        ${miniStat('Campaigns running', camps.length + '', best.agentsCount + ' agents on top campaign', I.layers)}
      </div>

      <div class="row g-2-1 mt">
        <div class="card">
          <div class="card-head"><div><h3>Campaign performance</h3>
            <div class="sub">Ranked by call volume · ${Q.PERIODS[period || 'this-week'].label} · variants like SURFERS_NA + SURFERS_CM are grouped</div></div>
            <button class="btn">${I.download} Export CSV</button></div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th class="num">#</th><th>Campaign</th>
              <th class="num">Agents</th><th class="num">Calls</th>
              <th class="num">Leads</th><th class="num">Seller</th>
              <th class="num">Rental</th><th class="num">Email</th>
              <th class="num">Conv.</th><th class="num">Volume</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </div>

        <div class="card card-pad">
          <div class="eyebrow">${camps[0].exact ? I.check : I.alert} About these numbers</div>
          ${camps[0].exact ? `
            <p style="font-size:12.5px;color:var(--slate);line-height:1.7;margin-top:10px">
              <b style="color:var(--green)">Exact attribution.</b>
              The Dialfire fetcher now stores per-agent stats per campaign, so
              when an agent works multiple campaigns each row reflects only
              the calls/leads they made on that specific campaign.
            </p>` : `
            <p style="font-size:12.5px;color:var(--slate);line-height:1.7;margin-top:10px">
              Each agent's call/lead/email totals appear under <b>every campaign they're tagged on</b>.
              When agents work multiple campaigns, the per-campaign rows
              <b>over-count</b>. (Historical week — pre-dates the per-campaign breakdown.)
            </p>`}
          <p style="font-size:12.5px;color:var(--slate);line-height:1.7;margin-top:10px">
            Variants like <code>SURFERS_NA</code>, <code>SURFERS_CM</code> and <code>SURFERS</code> are merged into one <b>SURFERS</b> row.
          </p>
          <div style="font-size:12.5px;color:var(--slate);line-height:1.7;margin-top:14px">
            <b style="color:var(--ink)">Period totals:</b><br>
            ${fmt(totalCalls)} calls · ${fmt(totalLeads)} leads · ${fmt(totalEmails)} emails
          </div>
        </div>
      </div>
    </div>`;
  }

  return { allStaff, compare, daily, manager, leadSources };
})();
