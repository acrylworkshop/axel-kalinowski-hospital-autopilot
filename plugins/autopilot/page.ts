/**
 * The page shell of Hospital Autopilot: the header, the layout and the styles. The client script (`client.js`) fills the
 * views from the orchestrator's snapshot, so the page itself only needs the hospital identity and the initial numbers.
 */
import { HOSPITAL } from './catalog.ts'
import { formatWall } from './engine.ts'

export interface PageNumbers {
  clock: number
  running: boolean
  cases: number
  openTasks: number
  alerts: number
  decisions: number
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderPage(numbers: PageNumbers): string {
  const initial = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hospital Autopilot &middot; ${escapeHtml(HOSPITAL.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<div id="root">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true">HA</span>
      <div>
        <p class="eyebrow">${escapeHtml(HOSPITAL.trust)} &middot; ${escapeHtml(HOSPITAL.site)}</p>
        <h1>Hospital Autopilot <span class="sub">operational coordination</span></h1>
      </div>
    </div>
    <dl class="topstats">
      <div><dt>Simulated clock</dt><dd id="top-clock">${formatWall(numbers.clock)}</dd></div>
      <div><dt>Simulation</dt><dd id="top-sim">${numbers.running ? 'running' : 'paused'}</dd></div>
      <div><dt>Active cases</dt><dd id="top-cases">${numbers.cases}</dd></div>
      <div><dt>Open tasks</dt><dd id="top-tasks">${numbers.openTasks}</dd></div>
      <div><dt>Alerts</dt><dd id="top-alerts">${numbers.alerts}</dd></div>
      <div><dt>Decisions</dt><dd id="top-decisions">${numbers.decisions}</dd></div>
    </dl>
  </header>
  <main id="app">
    <section class="boot">
      <h2>${escapeHtml(HOSPITAL.name)}</h2>
      <p>${escapeHtml(HOSPITAL.majorTraumaCentre)}. ${escapeHtml(HOSPITAL.simulated)}</p>
      <p class="muted">Loading the live command centre&hellip;</p>
    </section>
  </main>
</div>
<script type="module">
  const base = location.pathname.replace(/\\/+$/, '')
  const script = document.createElement('script')
  script.type = 'module'
  script.src = base + '/app.js?v=' + Date.now()
  document.head.appendChild(script)
</script>
</body>
</html>`
  return initial
}

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #060b14;
  --bg-2: #0a1220;
  --panel: #0d1728;
  --panel-2: #111f34;
  --panel-3: #16263f;
  --line: #1d2f4a;
  --line-soft: #16243a;
  --text: #e2eaf6;
  --muted: #8497b1;
  --dim: #5d6f88;
  --teal: #2ed3bd;
  --teal-dim: #17655f;
  --amber: #f2b23e;
  --amber-dim: #6b4c12;
  --red: #ff5d66;
  --red-dim: #6d2027;
  --blue: #4f9dff;
  --violet: #a07cff;
  --green: #3ddc84;
  --radius: 12px;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, monospace;
  --sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
body {
  background:
    radial-gradient(1100px 620px at 8% -10%, rgba(79,157,255,.10), transparent 60%),
    radial-gradient(900px 520px at 100% 0%, rgba(46,211,189,.07), transparent 55%),
    var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { margin: 0; font-weight: 640; letter-spacing: -.01em; }
h1 { font-size: 1.24rem; }
h2 { font-size: 1.02rem; }
h3 { font-size: .92rem; }
p { margin: .2rem 0; }
button, select { font: inherit; color: inherit; }
button { cursor: pointer; }
a { color: var(--blue); }
.muted { color: var(--muted); }
.dim { color: var(--dim); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.eyebrow { font-size: .68rem; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.sub { font-size: .74rem; font-weight: 500; color: var(--dim); letter-spacing: .04em; text-transform: uppercase; margin-left: .5rem; }

.topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 1.5rem;
  padding: .85rem 1.4rem;
  background: linear-gradient(180deg, rgba(13,23,40,.96), rgba(8,15,26,.92));
  border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 30;
  backdrop-filter: blur(8px);
  flex-wrap: wrap;
}
.brand { display: flex; align-items: center; gap: .85rem; }
.mark {
  display: grid; place-items: center; width: 40px; height: 40px; border-radius: 11px;
  background: linear-gradient(150deg, var(--teal), #1b7f8c 60%, #1d4f9e);
  color: #04121a; font-weight: 800; font-size: .85rem; letter-spacing: .04em;
  box-shadow: 0 0 0 1px rgba(46,211,189,.35), 0 10px 30px -12px rgba(46,211,189,.65);
}
.topstats { display: flex; gap: 1.35rem; margin: 0; flex-wrap: wrap; }
.topstats div { display: flex; flex-direction: column; }
.topstats dt { font-size: .62rem; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); }
.topstats dd { margin: 0; font-family: var(--mono); font-size: .95rem; color: var(--text); }

#app { padding: 1rem 1.4rem 3rem; max-width: 1720px; margin: 0 auto; }
.boot { padding: 3rem 0; }
.layout { display: grid; grid-template-columns: 268px minmax(0, 1fr); gap: 1.1rem; align-items: start; }
@media (max-width: 1080px) { .layout { grid-template-columns: 1fr; } }

.panel {
  background: linear-gradient(180deg, rgba(17,31,52,.72), rgba(10,18,32,.86));
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: .9rem 1rem;
}
.panel + .panel { margin-top: .9rem; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: .6rem; margin-bottom: .6rem; }
.panel-head h2, .panel-head h3 { display: flex; align-items: center; gap: .45rem; }
.count { font-family: var(--mono); font-size: .72rem; color: var(--muted); background: var(--panel-3); border: 1px solid var(--line); padding: .05rem .4rem; border-radius: 999px; }

.side { position: sticky; top: 84px; }
.stack { display: grid; gap: .5rem; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
  padding: .48rem .72rem; border-radius: 9px; border: 1px solid var(--line);
  background: var(--panel-2); color: var(--text); font-weight: 560; font-size: .82rem;
  transition: background .12s ease, border-color .12s ease, transform .06s ease;
}
.btn:hover { background: var(--panel-3); border-color: #2a4266; }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.primary { background: linear-gradient(140deg, #1d6f8d, #175a7a); border-color: #2c86a8; color: #eafcff; }
.btn.primary:hover { background: linear-gradient(140deg, #26809f, #1b6a8c); }
.btn.teal { background: rgba(46,211,189,.12); border-color: #215e5c; color: #b7f5ed; }
.btn.amber { background: rgba(242,178,62,.12); border-color: #6b4c12; color: #ffd89a; }
.btn.red { background: rgba(255,93,102,.13); border-color: #6d2027; color: #ffc2c6; }
.btn.ghost { background: transparent; }
.btn.sm { padding: .28rem .5rem; font-size: .74rem; border-radius: 7px; }
.btn.wide { width: 100%; }

.tabs { display: flex; gap: .25rem; flex-wrap: wrap; margin-bottom: .9rem; border-bottom: 1px solid var(--line-soft); padding-bottom: .5rem; }
.tab {
  padding: .42rem .7rem; border-radius: 8px; border: 1px solid transparent; background: transparent;
  color: var(--muted); font-size: .82rem; font-weight: 560;
}
.tab:hover { color: var(--text); background: rgba(255,255,255,.03); }
.tab[aria-selected="true"] { color: #d9fbff; background: rgba(46,211,189,.10); border-color: #215e5c; }
.tab .badge { font-family: var(--mono); font-size: .68rem; margin-left: .35rem; color: var(--amber); }

.grid { display: grid; gap: .9rem; }
.grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.grid.auto { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
@media (max-width: 1280px) { .grid.three { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 900px) { .grid.two, .grid.three { grid-template-columns: 1fr; } }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .7rem; }
.kpi { border: 1px solid var(--line); border-radius: 10px; padding: .6rem .7rem; background: rgba(13,23,40,.6); }
.kpi .label { font-size: .66rem; letter-spacing: .09em; text-transform: uppercase; color: var(--dim); }
.kpi .value { font-family: var(--mono); font-size: 1.45rem; line-height: 1.15; margin-top: .15rem; }
.kpi .note { font-size: .72rem; color: var(--muted); }
.kpi.urgent .value { color: var(--red); }
.kpi.watch .value { color: var(--amber); }
.kpi.good .value { color: var(--teal); }

.pill {
  display: inline-flex; align-items: center; gap: .32rem;
  font-size: .68rem; font-weight: 620; letter-spacing: .04em; text-transform: uppercase;
  padding: .13rem .45rem; border-radius: 999px; border: 1px solid var(--line);
  color: var(--muted); background: rgba(255,255,255,.02); white-space: nowrap;
}
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .9; }
.pill.ready, .pill.available, .pill.completed { color: var(--teal); border-color: #215e5c; background: rgba(46,211,189,.09); }
.pill.preparing, .pill.in_progress, .pill.acknowledged, .pill.reserved { color: var(--blue); border-color: #234a7a; background: rgba(79,157,255,.09); }
.pill.notified, .pill.pending { color: var(--muted); }
.pill.blocked, .pill.urgent, .pill.escalated { color: var(--red); border-color: #6d2027; background: rgba(255,93,102,.1); }
.pill.unavailable, .pill.cancelled { color: var(--dim); border-color: #2a3547; }
.pill.occupied, .pill.watch { color: var(--amber); border-color: #6b4c12; background: rgba(242,178,62,.1); }
.pill.awaiting_release { color: var(--amber); border-color: #5a431a; }

.row { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; }
.spread { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
.card {
  border: 1px solid var(--line); border-radius: 10px; padding: .7rem .8rem;
  background: rgba(13,23,40,.66);
}
.card + .card { margin-top: .55rem; }
.card.urgent { border-color: #6d2027; background: linear-gradient(180deg, rgba(255,93,102,.08), rgba(13,23,40,.7)); }
.card.watch { border-color: #5a431a; }
.card.blocked { border-color: #6d2027; }
.card h4 { margin: 0 0 .1rem; font-size: .86rem; }
.card .meta { font-size: .74rem; color: var(--muted); }
.card .detail { font-size: .8rem; color: #b9c8dc; margin-top: .3rem; }
.card .why { font-size: .74rem; color: var(--dim); margin-top: .3rem; font-style: italic; }

table { width: 100%; border-collapse: collapse; font-size: .8rem; }
th, td { text-align: left; padding: .38rem .4rem; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
th { font-size: .66rem; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
tr:last-child td { border-bottom: none; }
td.mono { font-family: var(--mono); }

.list { display: grid; gap: .35rem; margin: 0; padding: 0; list-style: none; }
.list li { display: flex; gap: .5rem; align-items: flex-start; font-size: .8rem; color: #c4d2e4; }
.list li .dot { flex: none; width: 6px; height: 6px; margin-top: .45rem; border-radius: 50%; background: var(--teal); }
.list li.urgent .dot { background: var(--red); }
.list li.watch .dot { background: var(--amber); }
.list li.done .dot { background: var(--blue); }

.timeline { display: flex; flex-wrap: wrap; gap: .3rem; padding-bottom: .35rem; }
.stage {
  flex: 1 1 92px; min-width: 92px; max-width: 132px; border-radius: 9px; padding: .45rem .5rem;
  border: 1px solid var(--line); background: rgba(10,18,32,.7);
  display: flex; flex-direction: column; gap: .15rem; position: relative;
}
.stage .idx { font-family: var(--mono); font-size: .62rem; color: var(--dim); }
.stage .name { font-size: .72rem; font-weight: 600; line-height: 1.25; }
.stage .state { font-size: .64rem; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
.stage.done { border-color: #215e5c; background: rgba(46,211,189,.08); }
.stage.done .state { color: var(--teal); }
.stage.now { border-color: #2b6ea8; background: rgba(79,157,255,.12); box-shadow: 0 0 0 1px rgba(79,157,255,.25) inset; }
.stage.now .state { color: var(--blue); }
.stage.blocked { border-color: #6d2027; background: rgba(255,93,102,.08); }
.stage.blocked .state { color: var(--red); }

.map { display: flex; flex-wrap: wrap; gap: .45rem; }
.chip {
  display: inline-flex; align-items: center; gap: .4rem; padding: .3rem .55rem; border-radius: 8px;
  border: 1px solid var(--line); background: rgba(17,31,52,.7); font-size: .76rem;
}
.chip .dept { font-weight: 600; }
.chip .state { font-family: var(--mono); font-size: .68rem; color: var(--muted); }
.chip.ready { border-color: #215e5c; background: rgba(46,211,189,.08); }
.chip.preparing { border-color: #234a7a; background: rgba(79,157,255,.08); }
.chip.blocked { border-color: #6d2027; background: rgba(255,93,102,.09); }
.chip.arrownote { font-size: .7rem; color: var(--dim); background: transparent; border-style: dashed; }

.bar { height: 6px; border-radius: 999px; background: #142238; overflow: hidden; }
.bar > span { display: block; height: 100%; background: linear-gradient(90deg, var(--teal), #2b8fd8); }
.bar.red > span { background: linear-gradient(90deg, #ff5d66, #a52a34); }
.bar.amber > span { background: linear-gradient(90deg, #f2b23e, #a67718); }

.flash {
  border: 1px solid #234a7a; background: rgba(79,157,255,.1); color: #cfe6ff;
  border-radius: 9px; padding: .45rem .65rem; font-size: .8rem; margin-bottom: .7rem;
}
.flash.error { border-color: #6d2027; background: rgba(255,93,102,.1); color: #ffd2d5; }
.flash.ok { border-color: #215e5c; background: rgba(46,211,189,.1); color: #c6fff6; }

.empty { color: var(--dim); font-size: .8rem; padding: .5rem 0; }

.rolecard { display: grid; gap: .3rem; }
.rolecard select { width: 100%; padding: .42rem .5rem; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2); }
.perms { display: flex; flex-wrap: wrap; gap: .25rem; }
.perm { font-family: var(--mono); font-size: .62rem; color: var(--muted); border: 1px solid var(--line-soft); border-radius: 5px; padding: .05rem .3rem; }
.gate { font-size: .72rem; color: var(--amber); }

.audit { display: grid; gap: .3rem; max-height: 460px; overflow: auto; }
.audit-row { display: grid; grid-template-columns: 74px 130px minmax(0,1fr); gap: .5rem; font-size: .76rem; padding: .22rem 0; border-bottom: 1px solid rgba(29,47,74,.5); }
.audit-row .t { font-family: var(--mono); color: var(--dim); }
.audit-row .a { color: var(--teal); font-weight: 600; }
.audit-row .s { color: #c4d2e4; }
.audit-row .d { grid-column: 1 / -1; color: var(--dim); font-size: .72rem; }

.split { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: .9rem; }
@media (max-width: 1200px) { .split { grid-template-columns: 1fr; } }

.fault-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: .5rem; }
.fault {
  border: 1px solid var(--line); border-radius: 10px; padding: .6rem .7rem; background: rgba(13,23,40,.6);
  display: flex; flex-direction: column; gap: .35rem;
}
.fault .name { font-weight: 600; font-size: .82rem; }
.fault .note { font-size: .72rem; color: var(--muted); }

.checklist { list-style: none; margin: .3rem 0 0; padding: 0; display: grid; gap: .18rem; }
.checklist li { font-size: .76rem; color: var(--muted); display: flex; gap: .4rem; }
.checklist li.on { color: var(--teal); }
.checklist li .box { font-family: var(--mono); }

.decide { border: 1px solid #6b4c12; background: linear-gradient(180deg, rgba(242,178,62,.09), rgba(13,23,40,.75)); }
.decide .question { font-size: .86rem; color: #ffe3b0; }
.option { display: grid; gap: .15rem; margin-top: .4rem; }
.option .cons { font-size: .72rem; color: var(--dim); }
.footer-note { margin-top: 1.6rem; font-size: .72rem; color: var(--dim); border-top: 1px solid var(--line-soft); padding-top: .7rem; }
.legend { display: flex; gap: .8rem; flex-wrap: wrap; font-size: .7rem; color: var(--dim); }
.legend span { display: inline-flex; align-items: center; gap: .3rem; }
.legend i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
`
