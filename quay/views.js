/* Quay 1 — secondary tab views (All Staff, Compare, Work Time, Daily, Manager, Lead Sources) */

window.VIEWS = (function () {
  const Q = window.QUAY, I = window.ICON, C = window.CHART;
  const fmt = n => n.toLocaleString('en-ZA');
  const initials = name => name.split(' ').map(w => w[0]).slice(0, 2).join('');
  const effClass = e => e >= 70 ? 'ok' : e >= 60 ? 'warn' : 'bad';
  const sucClass = s => s >= 15 ? 'ok' : s >= 11 ? 'warn' : 'bad';

  function agentRow(a, rank) {
    const sc = sucClass(a.success);
    const bar = Math.min(100, (a.calls / 720) * 100);
    return `<tr>
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
      <td class="num"><div class="cell-bar"><div class="track"><span style="width:${bar}%"></span></div></div></td>
    </tr>`;
  }

  // ---------------------------------------------------- ALL STAFF
  function allStaff(period) {
    const agents = Q.agentsFor(period).slice().sort((a, b) => b.calls - a.calls);
    const rows = agents.map((a, i) => agentRow(a, i + 1)).join('');
    const tCalls = agents.reduce((s, a) => s + a.calls, 0);
    const tLeads = agents.reduce((s, a) => s + a.leads, 0);
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
            <button class="active">Overall Report</button>
            <button>Per Caller</button>
          </div>
        </div>
      </div>

      <div class="row g-3 mt">
        ${miniStat('Roster size', agents.length + ' agents', 'RM + Fancy combined', I.users)}
        ${miniStat('Total calls', fmt(tCalls), 'across selected range', I.phone)}
        ${miniStat('Total leads', fmt(tLeads), 'seller · rental · email', I.target)}
      </div>

      <div class="card mt">
        <div class="card-head">
          <div><h3>Agent-level performance</h3><div class="sub">Ranked by call volume · click a row to drill in</div></div>
          <button class="btn">${I.download} Export CSV</button>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th class="num">#</th><th>Agent</th><th>Team</th>
              <th class="num">Calls</th><th class="num">Leads</th>
              <th class="num">Success</th><th class="num">Connect</th><th class="num">Volume</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
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

  // ---------------------------------------------------- WORK TIME
  function workTime(period) {
    const agents = Q.agentsFor(period).slice().sort((a, b) => b.eff - a.eff);
    const avgEff = Math.round(agents.reduce((s, a) => s + a.eff, 0) / agents.length);
    const totDf = agents.reduce((s, a) => s + a.df, 0);
    const totCt = agents.reduce((s, a) => s + a.ct, 0);
    const onTrack = agents.filter(a => a.eff >= 70).length;
    const rows = agents.map(a => {
      const ec = effClass(a.eff);
      const col = a.eff >= 70 ? 'var(--green)' : a.eff >= 60 ? 'var(--amber)' : 'var(--red)';
      return `<tr>
        <td><div class="agent-cell"><div class="avatar">${initials(a.name)}</div>
          <div><div class="agent-name">${a.name}</div><div class="agent-sub">${a.team}</div></div></div></td>
        <td class="num tnum">${a.df.toFixed(1)}h</td>
        <td class="num tnum">${a.ct.toFixed(1)}h</td>
        <td style="width:240px"><div class="eff-track">
          <span style="width:${Math.min(100, a.eff)}%;background:${col}"></span>
          <div class="eff-target" style="left:70%"></div>
        </div></td>
        <td class="num"><span class="pill ${ec}">${a.eff}%</span></td>
      </tr>`;
    }).join('');
    return `
    <div class="tab-view">
      <div class="row g-3">
        ${miniStat('Avg efficiency', avgEff + '%', 'DialFire ÷ ConnectTeams · target ≥70%', I.bolt)}
        ${miniStat('On-target agents', onTrack + ' / ' + agents.length, 'meeting the 70% threshold', I.check)}
        ${miniStat('Dialler vs clocked', totDf.toFixed(0) + 'h / ' + totCt.toFixed(0) + 'h', 'active dialling vs total clocked-in', I.clock)}
      </div>

      <div class="row g-2-1 mt">
        <div class="card">
          <div class="card-head"><div><h3>DialFire vs ConnectTeams</h3><div class="sub">Active dialler time against total clocked-in time</div></div>
            <button class="btn">${I.download} Export</button></div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Agent</th><th class="num">DialFire</th><th class="num">ConnectTeams</th><th>Efficiency</th><th class="num">%</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </div>

        <div style="display:flex;flex-direction:column;gap:20px">
          <div class="card">
            <div class="card-head"><div><h3>Upload export</h3></div></div>
            <div class="card-pad">
              <div class="upload">
                ${I.upload}
                <div style="font-weight:700;color:var(--ink);margin-top:8px">Drop ConnectTeams CSV</div>
                <div style="font-size:12px;margin-top:4px">ConnectTeams → Reports → Time Tracking → Export</div>
                <button class="btn" style="margin-top:14px;background:#fff">Choose file</button>
              </div>
              <div style="font-size:11.5px;color:var(--muted);margin-top:14px;line-height:1.6">
                Expected columns: <b style="color:var(--slate)">Name, Total Hours</b>.
                Uploads are kept in your browser session.
              </div>
            </div>
          </div>
          <div class="card card-pad">
            <div class="eyebrow">How efficiency works</div>
            <ul style="margin:12px 0 0;padding-left:18px;font-size:12.5px;color:var(--slate);line-height:1.9">
              <li><b style="color:var(--blue)">DialFire</b> = actual dialler time</li>
              <li><b style="color:var(--amber)">ConnectTeams</b> = clocked-in time</li>
              <li><b style="color:var(--ink)">Efficiency</b> = DF ÷ CT (target ≥70%)</li>
            </ul>
          </div>
        </div>
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
          <thead><tr><th class="num">#</th><th>Agent</th><th>Team</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Success</th><th class="num">Connect</th><th class="num">Volume</th></tr></thead>
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

  // ---------------------------------------------------- LEAD SOURCES
  function leadSources() {
    const src = Q.SOURCES.slice().sort((a, b) => b.conv - a.conv);
    const maxConv = Math.max(...src.map(s => s.conv));
    const rows = src.map((s, i) => `<tr>
      <td class="num" style="font-weight:700;color:var(--muted);width:40px">${i + 1}</td>
      <td><div class="agent-cell"><span style="width:11px;height:11px;border-radius:3px;background:${s.color};display:inline-block"></span>
        <span class="agent-name">${s.name}</span></div></td>
      <td class="num tnum">${fmt(s.calls)}</td>
      <td class="num tnum">${fmt(s.leads)}</td>
      <td class="num"><span class="pill ${s.conv >= 10 ? 'ok' : s.conv >= 7 ? 'warn' : 'bad'}">${s.conv}%</span></td>
      <td class="num"><div class="cell-bar"><div class="track"><span style="width:${(s.conv/maxConv)*100}%;background:${s.color}"></span></div></div></td>
    </tr>`).join('');
    const best = src[0];
    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel">
          <div class="field"><label>From</label><input type="date" value="2026-05-01"></div>
          <div class="field"><label>To</label><input type="date" value="2026-06-05"></div>
          <button class="btn btn-primary">${I.target} Run</button>
          <button class="btn">${I.download} Export CSV</button>
        </div>
      </div>
      <div class="row g-3 mt">
        ${miniStat('Best converter', best.name, best.conv + '% lead conversion', I.star)}
        ${miniStat('Lowest yield', src[src.length-1].name, src[src.length-1].conv + '% — review spend', I.alert)}
        ${miniStat('Sources tracked', src.length + '', 'portals · web · referral · social', I.layers)}
      </div>
      <div class="card mt">
        <div class="card-head"><div><h3>Lead source efficacy</h3><div class="sub">Which source converts best — ranked by conversion</div></div></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th class="num">#</th><th>Source</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Conv.</th><th class="num">Rate</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
    </div>`;
  }

  return { allStaff, compare, workTime, daily, manager, leadSources };
})();
