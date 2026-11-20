/**
 * The Hospital Autopilot interface: rendered from the orchestrator's snapshot, refreshed while the clock runs.
 *
 * It is served as a plain module from the plugin's own route (`/autopilot/app.js`, under the frame's prefix in the canvas). Every
 * URL it builds starts at the page's own path, so it works on the app's own server and inside the frame without naming the prefix.
 */

const BASE = location.pathname.replace(/\/+$/, '')
let DATA = null
let CATALOG = null
let TAB = 'command'
let FLASH = null
let LAST_KEY = ''
const OPEN = new Set()

const TABS = [
  ['command', 'Command centre'],
  ['department', 'My department'],
  ['journey', 'Patient journey'],
  ['coordination', 'Coordination'],
  ['resources', 'Resources'],
  ['alerts', 'Alerts'],
  ['decisions', 'Decisions'],
  ['intelligence', 'Intelligence'],
  ['faults', 'Fault injection'],
  ['audit', 'Audit'],
]

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))

const openTasks = (state) => state.tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled')
const openAlerts = (state) => state.escalations.filter((entry) => entry.status !== 'resolved')
const pendingDecisions = (state) => state.decisions.filter((entry) => entry.status === 'pending')

function clockText(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600) % 24
  const m = Math.floor(total / 60) % 60
  const sec = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function wallText(seconds) {
  return clockText((DATA?.shiftStart ?? 27720) + Math.max(0, seconds))
}

function relative(seconds) {
  const minutes = Math.round(Math.abs(seconds) / 60)
  if (minutes < 1) return 'now'
  return seconds >= 0 ? `in ${minutes} min` : `${minutes} min ago`
}

function deptName(id) {
  return CATALOG?.departments.find((entry) => entry.id === id)?.name ?? id ?? 'Hospital'
}

function deptShort(id) {
  return CATALOG?.departments.find((entry) => entry.id === id)?.short ?? String(id ?? '')
}

function roleName(id) {
  return CATALOG?.roles.find((entry) => entry.id === id)?.name ?? id ?? ''
}

function stageName(id) {
  return DATA?.stageDefinitions.find((entry) => entry.id === id)?.name ?? id
}

function pill(state, label) {
  return `<span class="pill ${esc(state)}">${esc(label ?? String(state).replace(/_/gu, ' '))}</span>`
}

function priorityPill(priority) {
  return `<span class="pill ${priority === 'P1' ? 'urgent' : priority === 'P2' ? 'watch' : 'pending'}">${esc(priority)}</span>`
}

function list(items, className = '') {
  if (!items || items.length === 0) return ''
  return `<ul class="list">${items.map((entry) => `<li class="${className}">${entry}</li>`).join('')}</ul>`
}

function bullets(items, className = '') {
  if (!items || items.length === 0) return ''
  return `<ul class="list">${items.map((entry) => `<li class="${className}"><span class="dot"></span><span>${entry}</span></li>`).join('')}</ul>`
}

async function request(path, body) {
  const response = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}

async function refresh(force = false) {
  try {
    const next = await request('/api/state')
    const key = JSON.stringify(next)
    if (force || key !== LAST_KEY) {
      DATA = next
      LAST_KEY = key
      render()
    }
  } catch (error) {
    FLASH = { kind: 'error', text: String(error.message ?? error) }
    render()
  }
}

let busy = false
async function act(name, data) {
  if (busy) return
  busy = true
  try {
    let result = null
    if (name === 'tab') {
      TAB = data.tab
      if (location.hash !== `#${TAB}`) {
        try {
          history.replaceState(null, '', `#${TAB}`)
        } catch {
          /* a host page that forbids the change still switches the view */
        }
      }
      render()
      return
    }
    if (name === 'toggle') {
      if (OPEN.has(data.id)) OPEN.delete(data.id)
      else OPEN.add(data.id)
      render()
      return
    }
    if (name === 'run') result = await request('/api/scenario', { kind: 'primary' })
    else if (name === 'run-second') result = await request('/api/scenario', { kind: 'second' })
    else if (name === 'play') result = await request('/api/sim', { action: 'play' })
    else if (name === 'pause') result = await request('/api/sim', { action: 'pause' })
    else if (name === 'step') result = await request('/api/sim', { action: 'step' })
    else if (name === 'reset') result = await request('/api/sim', { action: 'reset' })
    else if (name === 'speed') result = await request('/api/sim', { action: 'speed', speed: Number(data.value) })
    else if (name === 'automation') result = await request('/api/sim', { action: 'automation', enabled: data.enabled !== 'false' })
    else if (name === 'role') result = await request('/api/role', { role: data.value })
    else if (name === 'task') result = await request(`/api/task/${encodeURIComponent(data.id)}`, { action: data.op })
    else if (name === 'decide') result = await request(`/api/decision/${encodeURIComponent(data.id)}`, { option: data.option })
    else if (name === 'decide-all') result = await request('/api/decisions/approve-pending', {})
    else if (name === 'esc-ack') result = await request(`/api/escalation/${encodeURIComponent(data.id)}`, { action: 'acknowledge' })
    else if (name === 'esc-resolve') result = await request(`/api/escalation/${encodeURIComponent(data.id)}`, { action: 'resolve', option: data.option })
    else if (name === 'handover') result = await request(`/api/handover/${encodeURIComponent(data.id)}`, {})
    else if (name === 'fault') result = await request('/api/fault', { kind: data.kind })
    if (result) {
      FLASH = { kind: 'ok', text: result.message ?? 'Done' }
      if (result.snapshot) {
        DATA = result.snapshot
        LAST_KEY = JSON.stringify(result.snapshot)
      } else {
        await refresh(true)
      }
    }
  } catch (error) {
    FLASH = { kind: 'error', text: String(error.message ?? error) }
  } finally {
    busy = false
    render()
  }
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-act]')
  if (!element) return
  event.preventDefault()
  void act(element.dataset.act, element.dataset)
})

document.addEventListener('change', (event) => {
  const element = event.target.closest('[data-change]')
  if (!element) return
  void act(element.dataset.change, element.dataset)
})

function render() {
  const root = document.getElementById('root')
  if (!root || !DATA) return
  const flash = FLASH
    ? `<div class="flash ${FLASH.kind === 'error' ? 'error' : 'ok'}">${esc(FLASH.text)}</div>`
    : ''
  const view = VIEWS[TAB] ? VIEWS[TAB](DATA) : VIEWS.command(DATA)
  root.innerHTML = `
    ${topbar(DATA)}
    <main id="app">
      <div class="layout">
        <aside class="side">${sidebar(DATA)}</aside>
        <section>
          <nav class="tabs" role="tablist">
            ${TABS.map(([id, label]) => {
              const badge = id === 'alerts' && openAlerts(DATA.state).length > 0
                ? `<span class="badge">${openAlerts(DATA.state).length}</span>`
                : id === 'decisions' && pendingDecisions(DATA.state).length > 0
                  ? `<span class="badge">${pendingDecisions(DATA.state).length}</span>`
                  : ''
              return `<button class="tab" role="tab" aria-selected="${TAB === id}" data-act="tab" data-tab="${id}">${esc(label)}${badge}</button>`
            }).join('')}
          </nav>
          ${flash}
          <div id="view">${view}</div>
          ${footer(DATA)}
        </section>
      </div>
    </main>`
}

function topbar(data) {
  const state = data.state
  return `<header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true">HA</span>
      <div>
        <p class="eyebrow">${esc(CATALOG?.hospital.trust ?? '')} &middot; ${esc(CATALOG?.hospital.site ?? '')}</p>
        <h1>Hospital Autopilot <span class="sub">operational coordination</span></h1>
      </div>
    </div>
    <dl class="topstats">
      <div><dt>Simulated clock</dt><dd class="mono">${esc(data.clock)}</dd></div>
      <div><dt>Simulation</dt><dd>${state.running ? pill('ready', 'running') : pill('pending', 'paused')}</dd></div>
      <div><dt>Active cases</dt><dd class="mono">${state.cases.filter((entry) => entry.status !== 'closed').length}</dd></div>
      <div><dt>Open tasks</dt><dd class="mono">${openTasks(state).length}</dd></div>
      <div><dt>Alerts</dt><dd class="mono" style="color:${openAlerts(state).length ? 'var(--red)' : 'inherit'}">${openAlerts(state).length}</dd></div>
      <div><dt>Decisions</dt><dd class="mono" style="color:${pendingDecisions(state).length ? 'var(--amber)' : 'inherit'}">${pendingDecisions(state).length}</dd></div>
    </dl>
  </header>`
}

function sidebar(data) {
  const state = data.state
  const roles = CATALOG?.roles ?? []
  const byDepartment = new Map()
  for (const role of roles) {
    const group = byDepartment.get(role.department) ?? []
    group.push(role)
    byDepartment.set(role.department, group)
  }
  const options = [...byDepartment.entries()]
    .map(([department, group]) => `<optgroup label="${esc(deptName(department))}">${group
      .map((role) => `<option value="${esc(role.id)}" ${role.id === data.role.id ? 'selected' : ''}>${esc(role.name)}${role.clinical ? '' : ' (non-clinical)'}</option>`)
      .join('')}</optgroup>`)
    .join('')
  return `
    <div class="panel">
      <div class="panel-head"><h3>Demonstration</h3></div>
      <div class="stack">
        <button class="btn primary wide" data-act="run">Run major trauma scenario</button>
        <button class="btn wide" data-act="run-second">Add second casualty</button>
        <p class="muted" style="font-size:.74rem">Road traffic collision: emergency call, ambulance, pre-alert, A&amp;E, emergency surgery, intensive care. Five clinical gates need a person.</p>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Simulation</h3>${state.running ? pill('ready', 'running') : pill('pending', 'paused')}</div>
      <div class="stack">
        <div class="row">
          ${state.running
            ? '<button class="btn wide" data-act="pause">Pause</button>'
            : '<button class="btn teal wide" data-act="play">Resume</button>'}
          <button class="btn" data-act="step">Step</button>
          <button class="btn ghost" data-act="reset">Reset</button>
        </div>
        <label class="row" style="font-size:.78rem;justify-content:space-between">
          <span class="muted">Speed</span>
          <select data-change="speed" data-value="${state.speed}" style="padding:.25rem .4rem;border-radius:7px;border:1px solid var(--line);background:var(--panel-2)">
            ${[1, 2, 3, 4, 5].map((speed) => `<option value="${speed}" ${speed === state.speed ? 'selected' : ''}>${speed}x (${state.tickSeconds * speed}s / tick)</option>`).join('')}
          </select>
        </label>
        <label class="row" style="font-size:.78rem;gap:.4rem">
          <input type="checkbox" ${state.departmentAutomation ? 'checked' : ''} data-change="automation" data-enabled="${state.departmentAutomation ? 'false' : 'true'}" />
          <span class="muted">Departments act automatically</span>
        </label>
        <p class="dim" style="font-size:.7rem">Pausing stops the simulated clock. Clinical gates never resolve on time alone.</p>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Acting role</h3></div>
      <div class="rolecard">
        <select data-change="role" data-value="${esc(data.role.id)}">${options}</select>
        <p class="muted" style="font-size:.74rem">${esc(data.role.name)} &middot; ${esc(deptName(data.role.department))}</p>
        <div class="perms">${data.permissions.map((permission) => `<span class="perm">${esc(permission)}</span>`).join('')}</div>
        <p class="dim" style="font-size:.7rem">The server checks this role on every action; the interface only shows what the role holds.</p>
      </div>
    </div>
    <div class="panel">
      <div class="legend">
        <span><i style="background:var(--teal)"></i>ready</span>
        <span><i style="background:var(--blue)"></i>preparing</span>
        <span><i style="background:var(--amber)"></i>occupied</span>
        <span><i style="background:var(--red)"></i>blocked</span>
        <span><i style="background:var(--dim)"></i>idle</span>
      </div>
    </div>`
}

function footer(data) {
  return `<p class="footer-note">${esc(CATALOG?.hospital.name ?? '')} &middot; ${esc(CATALOG?.hospital.simulated ?? '')} Operational coordination only: diagnoses, treatment, prioritisation and interventions stay with authorised clinicians. Every decision and override is written to the audit trail. State persists in the app's home folder.</p>`
}

// ------------------------------------------------------------------ command centre

const VIEWS = {}

VIEWS.command = (data) => {
  const state = data.state
  const tasks = openTasks(state)
  const blocked = tasks.filter((task) => task.status === 'blocked')
  const overdue = tasks.filter((task) => task.status !== 'blocked' && task.dueAt < state.clock)
  const alerts = openAlerts(state)
  const decisions = pendingDecisions(state)
  const unacknowledged = state.notifications.filter((entry) => entry.state === 'delivered' && state.clock > (state.tasks.find((task) => task.id === entry.taskId)?.ackDueAt ?? 0))
  const theatreFree = state.resources.filter((resource) => resource.kind === 'theatre' && resource.state === 'available').length
  const icuFree = state.resources.filter((resource) => resource.kind === 'icu-bed' && resource.state === 'available').length
  const ctFree = state.resources.filter((resource) => resource.kind === 'ct' && resource.state === 'available').length
  const cases = state.cases.filter((entry) => entry.status !== 'closed')
  const urgentPredictions = data.predictions.filter((entry) => entry.severity === 'urgent').slice(0, 4)

  if (cases.length === 0 && state.tasks.length === 0) {
    return `<div class="panel">
      <h2>No active case</h2>
      <p class="muted">The command centre is live and the hospital is running normally. Start the major trauma demonstration to see the event-driven coordination from the 999 call to the intensive care unit.</p>
      <div class="stack" style="max-width:420px;margin-top:.8rem">
        <button class="btn primary wide" data-act="run">Run major trauma scenario</button>
      </div>
      <div class="grid three" style="margin-top:1.2rem">
        <div class="card"><h4>What it orchestrates</h4><p class="meta">Emergency control, dispatch, paramedics, A&amp;E, trauma team, radiology, laboratory, blood bank, theatres, anaesthetics, nursing, supplies, pharmacy, ICU, bed management, portering, command and family liaison: 24 units on one event bus.</p></div>
        <div class="card"><h4>What it never does</h4><p class="meta">No clinical judgement. The pre-alert, imaging, blood, surgery, the safety checklist and the destination are all human authorisations held in the decision queue.</p></div>
        <div class="card"><h4>What it does under strain</h4><p class="meta">Fault injection closes a theatre, delays blood, removes an ICU bed, withholds an acknowledgement or changes the plan; each one is detected, escalated to an accountable owner and recovered with a recorded decision.</p></div>
      </div>
    </div>`
  }

  return `
    <div class="grid" style="gap:.9rem">
      <div class="kpis">
        <div class="kpi ${alerts.length ? 'urgent' : 'good'}"><div class="label">Open escalations</div><div class="value">${alerts.length}</div><div class="note">${alerts.filter((entry) => entry.level > 1).length} at level 2</div></div>
        <div class="kpi ${decisions.length ? 'watch' : 'good'}"><div class="label">Awaiting authorisation</div><div class="value">${decisions.length}</div><div class="note">clinical gates in the queue</div></div>
        <div class="kpi ${blocked.length ? 'urgent' : 'good'}"><div class="label">Blocked work</div><div class="value">${blocked.length}</div><div class="note">${overdue.length} overdue</div></div>
        <div class="kpi ${unacknowledged.length ? 'watch' : 'good'}"><div class="label">Unacknowledged</div><div class="value">${unacknowledged.length}</div><div class="note">notifications past their deadline</div></div>
        <div class="kpi"><div class="label">Theatres free</div><div class="value">${theatreFree}</div><div class="note">of ${state.resources.filter((r) => r.kind === 'theatre').length}</div></div>
        <div class="kpi"><div class="label">ICU beds free</div><div class="value">${icuFree}</div><div class="note">of ${state.resources.filter((r) => r.kind === 'icu-bed').length}</div></div>
        <div class="kpi"><div class="label">CT free</div><div class="value">${ctFree}</div><div class="note">trauma protocol</div></div>
        <div class="kpi"><div class="label">Open tasks</div><div class="value">${tasks.length}</div><div class="note">${state.tasks.filter((t) => t.status === 'completed').length} completed</div></div>
      </div>

      <div class="split">
        <div>
          <h2 style="margin-bottom:.4rem">Active cases <span class="count">${cases.length}</span></h2>
          ${cases.length === 0 ? '<p class="empty">No active case.</p>' : cases.map((c) => caseCard(data, c)).join('')}
          <div class="panel" style="margin-top:.9rem">
            <div class="panel-head"><h2>Decisions requiring a person</h2><span class="count">${decisions.length}</span></div>
            ${decisions.length === 0 ? '<p class="empty">Nothing is waiting on a human decision.</p>' : decisionList(data, decisions, { compact: true })}
            ${decisions.length > 0 ? `<div class="row" style="margin-top:.6rem"><button class="btn amber sm" data-act="decide-all">Approve the gates this role may authorise</button><span class="dim" style="font-size:.72rem">Explicit human action; each decision is recorded with the role that made it.</span></div>` : ''}
          </div>
        </div>
        <div>
          <div class="panel">
            <div class="panel-head"><h2>Escalations and blocks</h2><span class="count">${alerts.length}</span></div>
            ${alerts.length === 0 ? '<p class="empty">Nothing blocked or escalated.</p>' : alerts.slice(0, 6).map((entry) => escalationCard(data, entry, { compact: true })).join('')}
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Forward-looking intelligence</h2><span class="count">${data.predictions.length}</span></div>
            ${data.predictions.length === 0 ? '<p class="empty">No prediction at this stage.</p>' : urgentPredictions.map((entry) => predictionCard(entry)).join('') || data.predictions.slice(0, 3).map((entry) => predictionCard(entry)).join('')}
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Latest coordination events</h2></div>
            ${bullets(state.events.slice(-6).reverse().map((entry) => `<span><span class="mono" style="color:var(--dim)">${esc(wallText(entry.at))}</span> <strong>${esc(entry.name)}</strong> ${esc(entry.detail)}</span>`))}
          </div>
        </div>
      </div>
    </div>`
}

function caseCard(data, c) {
  const state = data.state
  const stages = data.stageDefinitions
  const readiness = (data.readiness[c.id] ?? []).filter((entry) => entry.readiness !== 'unknown')
  const blockedUnits = readiness.filter((entry) => entry.readiness === 'blocked')
  const readyUnits = readiness.filter((entry) => entry.readiness === 'ready').length
  const progress = stages.length > 1 ? Math.round((c.stageIndex / (stages.length - 1)) * 100) : 0
  const caseOpen = state.tasks.filter((task) => task.caseId === c.id && task.status !== 'completed' && task.status !== 'cancelled')
  return `<div class="card ${blockedUnits.length ? 'urgent' : ''}">
    <div class="spread">
      <div>
        <h4>${esc(c.code)} ${priorityPill(c.priority)} ${pill(c.status, c.status)}</h4>
        <p class="meta">${esc(c.patientName)}${c.age ? `, ${c.age}${esc(c.sex || '')}` : ''} &middot; ${esc(c.operationalSummary)}</p>
      </div>
      <div class="mono" style="font-size:.78rem;color:var(--muted)">${c.eta > 0 && c.status === 'incoming' ? `ETA ${relative(c.eta - state.clock)}` : esc(wallText(c.arrivedAt ?? state.clock))}</div>
    </div>
    <p class="detail">Stage: <strong>${esc(stageName(c.stage))}</strong> &middot; destination: ${esc(c.destination)} &middot; ${caseOpen.length} open task(s)</p>
    <div class="bar ${blockedUnits.length ? 'red' : ''}" style="margin:.45rem 0 .3rem"><span style="width:${progress}%"></span></div>
    <div class="row" style="font-size:.72rem;color:var(--muted)">
      <span>${readyUnits}/${readiness.length} units ready</span>
      ${blockedUnits.length ? `<span style="color:var(--red)">Blocked: ${blockedUnits.map((entry) => esc(deptShort(entry.department))).join(', ')}</span>` : ''}
      ${c.surgicalDecision === 'authorised' ? '<span class="pill ready">surgery authorised</span>' : c.surgicalDecision === 'indicated' ? '<span class="pill watch">surgery indicated</span>' : ''}
      ${c.theatreId ? `<span class="pill occupied">${esc(c.theatreId)}</span>` : ''}
      ${c.icuBedId ? `<span class="pill occupied">${esc(c.icuBedId)}</span>` : ''}
    </div>
    ${c.flags.length ? `<p class="why">Flags: ${c.flags.map((flag) => esc(flag)).join(' &middot; ')}</p>` : ''}
    <div class="map" style="margin-top:.45rem">
      ${readiness.slice(0, 12).map((entry) => `<span class="chip ${entry.readiness}" title="${esc(entry.detail)}"><span class="dept">${esc(deptShort(entry.department))}</span><span class="state">${esc(entry.readiness)}</span></span>`).join('')}
    </div>
  </div>`
}

function predictionCard(entry) {
  const kind = entry.kind === 'fact' ? 'fact' : entry.kind === 'prediction' ? 'prediction' : 'needs a decision'
  return `<div class="card ${entry.severity === 'urgent' ? 'urgent' : entry.severity === 'watch' ? 'watch' : ''}">
    <div class="spread"><h4>${esc(entry.title)}</h4><span class="pill ${entry.kind === 'decision' ? 'watch' : entry.kind === 'prediction' ? 'preparing' : 'pending'}">${esc(kind)}</span></div>
    <p class="detail">${esc(entry.detail)}</p>
    <p class="why">Why: ${esc(entry.why)}</p>
    <p class="meta" style="color:var(--teal)">Next: ${esc(entry.recommended)}</p>
  </div>`
}

function escalationCard(data, entry, options = {}) {
  const state = data.state
  const task = state.tasks.find((item) => item.id === entry.taskId)
  const role = data.role
  const canResolve = (option) => option.requiresRoles.includes(role.id)
  return `<div class="card ${entry.status === 'resolved' ? '' : entry.level > 1 ? 'urgent' : 'watch'}">
    <div class="spread">
      <h4>${esc(entry.reason)}</h4>
      <div class="row">${pill(entry.status, entry.status)}<span class="pill ${entry.level > 1 ? 'urgent' : 'watch'}">L${entry.level}</span></div>
    </div>
    <p class="meta">Owner: ${esc(roleName(entry.ownerRole))} &middot; ${esc(deptName(entry.department))} &middot; raised ${esc(wallText(entry.createdAt))}</p>
    <p class="detail">${esc(entry.impact)}</p>
    ${task ? `<p class="meta">Task: ${esc(task.title)} ${task.blockedReason ? `&middot; ${esc(task.blockedReason)}` : ''}</p>` : ''}
    ${entry.status !== 'resolved'
      ? `<div class="stack" style="margin-top:.5rem">
          ${entry.options.length === 0 ? '<p class="dim" style="font-size:.74rem">No automated option: this needs the accountable person to act and record the outcome.</p>' : entry.options.map((option) => `<div class="row"><button class="btn sm ${canResolve(option) ? 'teal' : ''}" data-act="esc-resolve" data-id="${esc(entry.id)}" data-option="${esc(option.id)}" ${canResolve(option) ? '' : 'disabled'} title="${canResolve(option) ? '' : `Requires: ${option.requiresRoles.map(roleName).join(', ')}`}">${esc(option.label)}</button><span class="dim" style="font-size:.72rem">${esc(option.consequence)} &middot; needs ${option.requiresRoles.map((id) => esc(roleName(id))).join(' or ')}</span></div>`).join('')}
          <div class="row"><button class="btn sm ghost" data-act="esc-ack" data-id="${esc(entry.id)}">Acknowledge ownership as ${esc(roleName(role.id))}</button></div>
        </div>`
      : `<p class="meta" style="color:var(--teal)">Resolved: ${esc(entry.resolution ?? '')} (${esc(entry.resolvedBy ?? '')})</p>`}
  </div>`
}

function decisionList(data, decisions, options = {}) {
  const role = data.role
  return decisions.map((decision) => {
    const authorised = decision.authorisedRoles.includes(role.id)
    return `<div class="card decide">
      <div class="spread"><h4>${esc(decision.title)}</h4><span class="pill ${decision.clinical ? 'watch' : 'preparing'}">${decision.clinical ? 'clinical authorisation' : 'operational'}</span></div>
      <p class="question">${esc(decision.question)}</p>
      <p class="meta">Authorised: ${decision.authorisedRoles.map((id) => esc(roleName(id))).join(', ')} &middot; due ${esc(wallText(decision.dueAt))}${decision.dueAt < data.state.clock ? ' (overdue)' : ''}</p>
      ${options.compact ? '' : `<div class="option">${decision.options.map((option) => `<div class="row"><button class="btn sm ${authorised ? 'amber' : ''}" data-act="decide" data-id="${esc(decision.id)}" data-option="${esc(option.id)}" ${authorised ? '' : 'disabled'}>${esc(option.label)}</button><span class="cons">${esc(option.consequence)}</span></div>`).join('')}</div>`}
      ${options.compact ? `<div class="row" style="margin-top:.4rem">${decision.options.map((option) => `<button class="btn sm ${authorised ? 'amber' : ''}" data-act="decide" data-id="${esc(decision.id)}" data-option="${esc(option.id)}" ${authorised ? '' : 'disabled'}>${esc(option.label)}</button>`).join('')}</div>` : ''}
      ${authorised ? '' : `<p class="dim" style="font-size:.72rem">Your role (${esc(role.name)}) is not authorised for this decision.</p>`}
    </div>`
  }).join('')
}

// ------------------------------------------------------------------ department workspace

VIEWS.department = (data) => {
  const view = data.departmentView
  if (!view) return '<p class="empty">No department workspace for this role.</p>'
  const state = data.state
  const tasks = view.tasks
  const byStatus = { blocked: tasks.filter((task) => task.status === 'blocked'), noted: tasks.filter((task) => task.status === 'notified' || task.status === 'escalated'), working: tasks.filter((task) => task.status === 'in_progress' || task.status === 'acknowledged'), done: tasks.filter((task) => task.status === 'completed') }
  return `
    <div class="panel">
      <div class="spread">
        <div>
          <p class="eyebrow">Department workspace</p>
          <h2>${esc(view.department.name)} <span class="count">${esc(view.department.short)}</span></h2>
          <p class="muted">Acting as ${esc(view.role.name)} &middot; ${esc(view.department.group)}</p>
        </div>
        <div class="row">${pill(view.readiness, view.readiness)}<span class="count">${tasks.length} tasks</span></div>
      </div>
      <div class="split" style="margin-top:.6rem">
        <div>
          <h3>What this means for you</h3>
          ${bullets(view.nextActions.length ? view.nextActions.map((text) => esc(text)) : ['Nothing open. Keep the resources ready.'])}
        </div>
        <div>
          <h3>Responsibility and authority</h3>
          <p class="meta">${view.department.responsibilities.map((text) => esc(text)).join(' &middot; ')}</p>
          <p class="meta" style="margin-top:.3rem"><span class="muted">Depends on:</span> ${view.department.dependsOn.map((id) => esc(deptShort(id))).join(', ') || 'nothing'} &middot; <span class="muted">Approves:</span> ${view.department.approves.map((id) => esc(roleName(id))).join(', ')}</p>
          <p class="meta"><span class="muted">Escalates to:</span> ${esc(roleName(view.department.escalatesTo))} &middot; <span class="muted">Releases:</span> ${view.department.downstream.map((id) => esc(deptShort(id))).join(', ') || 'nothing'}</p>
        </div>
      </div>
    </div>

    ${view.decisions.length ? `<div class="panel"><div class="panel-head"><h2>Decisions waiting on this role</h2><span class="count">${view.decisions.length}</span></div>${decisionList(data, view.decisions)}</div>` : ''}

    ${view.escalations.length ? `<div class="panel"><div class="panel-head"><h2>Escalations you own</h2><span class="count">${view.escalations.length}</span></div>${view.escalations.map((entry) => escalationCard(data, entry)).join('')}</div>` : ''}

    <div class="panel">
      <div class="panel-head"><h2>Task queue</h2><span class="count">${tasks.length}</span></div>
      ${tasks.length === 0 ? '<p class="empty">Nothing assigned yet. When an event concerns this unit, its tasks appear here.</p>' : ''}
      ${byStatus.blocked.map((task) => taskCard(data, task, 'blocked')).join('')}
      ${byStatus.noted.map((task) => taskCard(data, task, 'noted')).join('')}
      ${byStatus.working.map((task) => taskCard(data, task, 'working')).join('')}
      ${byStatus.done.slice(-4).reverse().map((task) => taskCard(data, task, 'done')).join('')}
    </div>

    <div class="split">
      <div class="panel">
        <div class="panel-head"><h2>Notifications received</h2><span class="count">${view.notifications.length}</span></div>
        ${view.notifications.length === 0 ? '<p class="empty">No notification yet.</p>' : `<table><thead><tr><th>Sent</th><th>Subject</th><th>Delivered</th><th>Acknowledged</th></tr></thead><tbody>${view.notifications.slice(0, 12).map((entry) => `<tr><td class="mono">${esc(wallText(entry.sentAt))}</td><td>${esc(entry.subject)}<div class="dim">${esc(entry.body)}</div></td><td>${entry.deliveredAt !== null ? '<span class="pill ready">yes</span>' : '<span class="pill urgent">no</span>'}</td><td>${entry.acknowledgedAt !== null ? `<span class="pill ready">${esc(wallText(entry.acknowledgedAt))}</span>` : '<span class="pill urgent">outstanding</span>'}</td></tr>`).join('')}</tbody></table>`}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Resources you control</h2><span class="count">${view.resourceSummary.length}</span></div>
        ${view.resourceSummary.length === 0 ? '<p class="empty">This unit holds no tracked resource.</p>' : view.resourceSummary.map((resource) => `<div class="row" style="justify-content:space-between;padding:.25rem 0;border-bottom:1px solid var(--line-soft)"><span>${esc(resource.name)}</span>${pill(resource.state, resource.state)}<span class="dim" style="font-size:.7rem">${esc(resource.note)}</span></div>`).join('')}
        ${view.cases.length ? `<h3 style="margin-top:.7rem">Cases in your care</h3>${view.cases.map((c) => `<div class="card"><h4>${esc(c.code)} ${priorityPill(c.priority)}</h4><p class="meta">${esc(c.stage)} &middot; ${esc(c.summary)}${c.eta ? ` &middot; ETA ${esc(c.eta)}` : ''}</p>${c.clinicalDetail ? `<p class="detail">${esc(c.clinicalDetail)}</p>` : '<p class="dim" style="font-size:.74rem">Clinical detail is withheld from this non-clinical role.</p>'}</div>`).join('')}` : ''}
      </div>
    </div>
    <p class="dim" style="font-size:.72rem">Every action here is checked against ${esc(view.role.name)} on the server and written to the audit trail. Current simulated time ${esc(wallText(state.clock))}.</p>`
}

function taskCard(data, task, group) {
  const state = data.state
  const ownerCase = state.cases.find((entry) => entry.id === task.caseId)
  const deps = task.dependsOn.map((id) => state.tasks.find((entry) => entry.id === id)).filter(Boolean)
  const open = OPEN.has(task.id)
  const escalation = state.escalations.find((entry) => entry.id === task.escalationId)
  const canManage = data.permissions.includes('task.manage')
  const overdue = task.status !== 'completed' && task.dueAt < state.clock
  return `<div class="card ${task.status === 'blocked' ? 'blocked' : overdue ? 'watch' : ''}">
    <div class="spread">
      <h4>${esc(task.title)}</h4>
      <div class="row">${ownerCase ? `<span class="mono dim" style="font-size:.72rem">${esc(ownerCase.code)}</span>` : ''}${priorityPill(task.priority)}${pill(task.status, task.status)}<span class="count">${esc(deptShort(task.department))}</span></div>
    </div>
    <p class="meta">Due ${esc(wallText(task.dueAt))} ${overdue ? '<span style="color:var(--amber)">overdue</span>' : ''} &middot; owner ${esc(roleName(task.ownerRole))} &middot; ${esc(task.kind)}${task.notifiedAt !== null ? ` &middot; notified ${esc(wallText(task.notifiedAt))}` : ''}${task.acknowledgedAt !== null ? ` &middot; acknowledged ${esc(wallText(task.acknowledgedAt))}` : ''}</p>
    ${task.blockedReason ? `<p class="detail" style="color:#ffb3b7">Blocked: ${esc(task.blockedReason)}</p>` : ''}
    ${deps.length ? `<p class="meta">Depends on: ${deps.map((dep) => `${esc(dep.title)} (${esc(dep.status)})`).join(', ')}</p>` : ''}
    ${escalation ? `<p class="meta" style="color:var(--red)">Escalated to ${esc(roleName(escalation.ownerRole))}: ${esc(escalation.reason)}</p>` : ''}
    ${open ? `<p class="detail">${esc(task.detail)}</p>` : ''}
    <div class="row" style="margin-top:.4rem">
      <button class="btn sm ghost" data-act="toggle" data-id="${esc(task.id)}">${open ? 'Hide detail' : 'Show detail'}</button>
      ${group === 'noted' && canManage ? `<button class="btn sm teal" data-act="task" data-id="${esc(task.id)}" data-op="acknowledge">Acknowledge</button>` : ''}
      ${group === 'working' && canManage ? `<button class="btn sm" data-act="task" data-id="${esc(task.id)}" data-op="complete">Mark complete</button>` : ''}
      ${group === 'blocked' && canManage ? `<button class="btn sm amber" data-act="task" data-id="${esc(task.id)}" data-op="escalate">Escalate</button>` : ''}
      ${group !== 'done' && canManage ? `<button class="btn sm red" data-act="task" data-id="${esc(task.id)}" data-op="block">Report blocker</button>` : ''}
    </div>
    ${open ? `<div class="list" style="margin-top:.4rem">${task.history.slice(-6).map((entry) => `<div class="meta mono">${esc(wallText(entry.at))} ${esc(entry.status)} &middot; ${esc(entry.actor)} &middot; ${esc(entry.note)}</div>`).join('')}</div>` : ''}
  </div>`
}

// ------------------------------------------------------------------ journey

VIEWS.journey = (data) => {
  const state = data.state
  if (state.cases.length === 0) return '<p class="empty">No case yet. Run the major trauma scenario.</p>'
  return state.cases.map((c) => {
    const readiness = data.readiness[c.id] ?? []
    const blockedStages = new Set()
    for (const entry of readiness) {
      if (entry.readiness !== 'blocked') continue
      const stage = data.stageDefinitions.find((definition) => definition.units.includes(entry.department))
      if (stage) blockedStages.add(stage.id)
    }
    const handovers = state.handovers.filter((entry) => entry.caseId === c.id)
    const overdue = state.tasks.filter((task) => task.caseId === c.id && task.status !== 'completed' && task.dueAt < state.clock)
    const clinical = data.role.clinical
    return `<div class="panel">
      <div class="spread">
        <div>
          <p class="eyebrow">Case ${esc(c.code)}</p>
          <h2>${esc(c.patientName)} ${priorityPill(c.priority)}</h2>
          <p class="muted">${esc(c.incidentSummary)}</p>
        </div>
        <div class="row">${pill(c.status, c.status)}${c.eta > 0 && c.status === 'incoming' ? `<span class="pill preparing">ETA ${esc(relative(c.eta - state.clock))}</span>` : ''}<span class="count">${esc(c.location)}</span></div>
      </div>
      ${clinical ? `<p class="detail" style="margin-top:.5rem">Observations HR ${c.vitals.hr}, BP ${esc(c.vitals.bp)}, SpO2 ${c.vitals.spo2}%, GCS ${c.vitals.gcs}. ${esc(c.injuries.join('; '))}. ${esc(c.clinicalNotes)}</p>` : `<p class="dim" style="font-size:.76rem">Clinical detail is restricted: this workspace sees the operational record only.</p>`}
      <div class="timeline" style="margin-top:.7rem">
        ${data.stageDefinitions.map((stage, index) => {
          const cls = index < c.stageIndex ? 'done' : index === c.stageIndex ? (blockedStages.has(stage.id) ? 'blocked' : 'now') : ''
          const label = index < c.stageIndex ? 'complete' : index === c.stageIndex ? (blockedStages.has(stage.id) ? 'blocked' : 'current') : 'upcoming'
          return `<div class="stage ${cls}"><span class="idx">${String(index + 1).padStart(2, '0')}</span><span class="name">${esc(stage.name)}</span><span class="state">${label}</span></div>`
        }).join('')}
      </div>
      <div class="split" style="margin-top:.7rem">
        <div>
          <h3>Responsible units at this stage</h3>
          <div class="map">${data.stageDefinitions[c.stageIndex]?.units.map((id) => {
            const ready = readiness.find((entry) => entry.department === id)
            return `<span class="chip ${ready?.readiness ?? ''}"><span class="dept">${esc(deptShort(id))}</span><span class="state">${esc(ready?.readiness ?? 'idle')}</span></span>`
          }).join('') ?? ''}</div>
          <h3 style="margin-top:.8rem">Next steps and delays</h3>
          ${bullets([
            ...overdue.slice(0, 4).map((task) => `${esc(task.title)} is overdue in ${esc(deptName(task.department))} (${esc(task.blockedReason ?? 'preparation continuing')})`),
            ...data.stageDefinitions.slice(c.stageIndex + 1, c.stageIndex + 3).map((stage) => `Next: ${esc(stage.name)} (${stage.units.map((id) => esc(deptShort(id))).join(', ')})`),
          ])}
        </div>
        <div>
          <h3>Structured handovers</h3>
          ${handovers.length === 0 ? '<p class="empty">No handover recorded yet.</p>' : handovers.map((handover) => `<div class="card">
            <div class="spread"><h4>${esc(deptName(handover.from))} to ${esc(deptName(handover.to))}</h4>${pill(handover.status, handover.status)}</div>
            <p class="meta">${esc(wallText(handover.createdAt))}${handover.acceptedBy ? ` &middot; accepted by ${esc(handover.acceptedBy)}` : ''}</p>
            <ul class="checklist">${handover.checklist.map((item) => `<li class="${item.confirmed ? 'on' : ''}"><span class="box">${item.confirmed ? '[x]' : '[ ]'}</span>${esc(item.label)}</li>`).join('')}</ul>
            ${handover.status === 'pending' && data.permissions.includes('handover.accept') ? `<button class="btn sm teal" style="margin-top:.4rem" data-act="handover" data-id="${esc(handover.id)}">Accept handover as ${esc(data.role.name)}</button>` : ''}
          </div>`).join('')}
          <h3 style="margin-top:.8rem">Operational summary</h3>
          <p class="meta">${esc(c.operationalSummary)}</p>
          <p class="meta">Plan: ${esc(c.plan)}</p>
          <p class="meta">Destination: ${esc(c.destination)}</p>
          ${c.flags.length ? `<p class="meta">Flags: ${c.flags.map((flag) => esc(flag)).join(' &middot; ')}</p>` : ''}
        </div>
      </div>
    </div>`
  }).join('')
}

// ------------------------------------------------------------------ coordination

VIEWS.coordination = (data) => {
  const state = data.state
  const groups = CATALOG ? [...new Set(CATALOG.departments.map((department) => department.group))] : []
  return `
    <div class="panel">
      <div class="panel-head"><h2>Department coordination map</h2><span class="count">${CATALOG?.departments.length ?? 0} units</span></div>
      <p class="muted" style="font-size:.8rem">Each unit is a workflow participant with its own responsibilities, dependencies and escalation owner. The state shown is the current readiness across all active cases.</p>
      ${groups.map((group) => `<h3 style="margin:.7rem 0 .3rem">${esc(group)}</h3><div class="map">${(CATALOG?.departments ?? []).filter((department) => department.group === group).map((department) => {
        const entries = state.cases.map((c) => (data.readiness[c.id] ?? []).find((entry) => entry.department === department.id)).filter(Boolean)
        const blocked = entries.some((entry) => entry.readiness === 'blocked')
        const ready = entries.length > 0 && entries.every((entry) => entry.readiness === 'ready')
        const preparing = entries.some((entry) => entry.readiness === 'preparing')
        const cls = blocked ? 'blocked' : ready ? 'ready' : preparing ? 'preparing' : ''
        const label = entries.length === 0 ? 'idle' : blocked ? 'blocked' : ready ? 'ready' : preparing ? 'preparing' : 'notified'
        return `<span class="chip ${cls}" title="${esc(department.responsibilities[0] ?? '')}"><span class="dept">${esc(department.name)}</span><span class="state">${esc(label)}</span></span>`
      }).join('')}</div>`).join('')}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Event propagation</h2><span class="count">${state.events.length} events</span></div>
      <p class="muted" style="font-size:.8rem">Every significant event is published once and routed to the units that subscribe to it. This is the audit-visible trace of what reached whom, and why.</p>
      ${state.events.slice(-25).reverse().map((event) => `<div class="card">
        <div class="spread"><h4 class="mono" style="font-size:.8rem">${esc(event.name)}</h4><span class="count">${esc(wallText(event.at))}</span></div>
        <p class="meta">${esc(event.detail)}</p>
        ${event.reached.length ? `<div class="map" style="margin-top:.3rem">${event.reached.map((reached) => `<span class="chip arrownote">${esc(deptShort(reached.department))} <span class="dim">&larr; ${esc(reached.reason)}</span></span>`).join('')}</div>` : '<p class="dim" style="font-size:.72rem">Recorded; no unit subscribes to this event.</p>'}
      </div>`).join('') || '<p class="empty">No event yet.</p>'}
    </div>`
}

// ------------------------------------------------------------------ resources

VIEWS.resources = (data) => {
  const state = data.state
  const kinds = [...new Set(state.resources.map((resource) => resource.kind))]
  const counts = {}
  for (const resource of state.resources) {
    counts[resource.state] = (counts[resource.state] ?? 0) + 1
  }
  return `
    <div class="panel">
      <div class="panel-head"><h2>Hospital resources</h2></div>
      <div class="row">${Object.entries(counts).map(([stateName, count]) => `${pill(stateName, `${count} ${stateName.replace(/_/gu, ' ')}`)}`).join('')}</div>
      ${kinds.map((kind) => `<h3 style="margin:.8rem 0 .3rem">${esc(kind.replace(/-/gu, ' '))}</h3>
        <table><thead><tr><th>Resource</th><th>Unit</th><th>State</th><th>Case</th><th>Note</th><th>Since</th></tr></thead><tbody>
        ${state.resources.filter((resource) => resource.kind === kind).map((resource) => `<tr>
          <td><strong>${esc(resource.name)}</strong></td>
          <td class="dim">${esc(deptShort(resource.department))}</td>
          <td>${pill(resource.state, resource.state)}</td>
          <td class="mono">${esc(resource.caseId ?? '-')}</td>
          <td class="dim">${esc(resource.note)}</td>
          <td class="mono dim">${esc(wallText(resource.since))}</td>
        </tr>`).join('')}
        </tbody></table>`).join('')}
    </div>`
}

// ------------------------------------------------------------------ alerts

VIEWS.alerts = (data) => {
  const state = data.state
  const escalations = [...state.escalations].reverse()
  const notifications = [...state.notifications].reverse()
  return `
    <div class="panel">
      <div class="panel-head"><h2>Escalations</h2><span class="count">${openAlerts(state).length} open</span></div>
      <p class="muted" style="font-size:.8rem">One escalation per condition: repeated checks never raise a duplicate alert. Acknowledgement closes an escalation; a block or an SLA breach opens one with an accountable owner.</p>
      ${escalations.length === 0 ? '<p class="empty">No escalation yet.</p>' : escalations.map((entry) => escalationCard(data, entry)).join('')}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Notifications and acknowledgements</h2><span class="count">${notifications.length}</span></div>
      <p class="muted" style="font-size:.8rem">Delivery is not acknowledgement. A notification that passes its acknowledgement deadline escalates to the unit's accountable role.</p>
      <table><thead><tr><th>Sent</th><th>Unit</th><th>Subject</th><th>Delivered</th><th>Acknowledged</th></tr></thead><tbody>
        ${notifications.slice(0, 40).map((entry) => {
          const task = state.tasks.find((item) => item.id === entry.taskId)
          const late = entry.state !== 'acknowledged' && state.clock > (task?.ackDueAt ?? 0)
          return `<tr><td class="mono">${esc(wallText(entry.sentAt))}</td><td>${esc(deptShort(entry.department))}</td><td>${esc(entry.subject)}</td><td>${pill('ready', 'delivered')}</td><td>${entry.acknowledgedAt !== null ? `<span class="pill ready">${esc(wallText(entry.acknowledgedAt))}</span>` : late ? '<span class="pill urgent">escalated</span>' : '<span class="pill pending">waiting</span>'}</td></tr>`
        }).join('') || '<tr><td colspan="5" class="empty">No notification yet.</td></tr>'}
      </tbody></table>
    </div>`
}

// ------------------------------------------------------------------ decisions

VIEWS.decisions = (data) => {
  const state = data.state
  const pending = pendingDecisions(state)
  const made = [...state.decisions].filter((entry) => entry.status !== 'pending').reverse()
  return `
    <div class="panel">
      <div class="panel-head"><h2>Decision queue</h2><span class="count">${pending.length} pending</span></div>
      <p class="muted" style="font-size:.8rem">Clinical and safety-critical decisions are human authorisations. Simulation time never approves them; the orchestration engine waits, escalates the wait to the accountable role, and records who decided what, and when.</p>
      ${pending.length === 0 ? '<p class="empty">No decision waiting.</p>' : decisionList(data, pending)}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Decisions recorded</h2><span class="count">${made.length}</span></div>
      ${made.length === 0 ? '<p class="empty">None yet.</p>' : `<table><thead><tr><th>Decided</th><th>Decision</th><th>Choice</th><th>By</th></tr></thead><tbody>${made.map((entry) => `<tr><td class="mono">${esc(wallText(entry.decidedAt ?? entry.createdAt))}</td><td>${esc(entry.title)}</td><td>${esc(entry.note)}</td><td>${esc(entry.decidedBy ?? '')}</td></tr>`).join('')}</tbody></table>`}
    </div>`
}

// ------------------------------------------------------------------ intelligence

VIEWS.intelligence = (data) => {
  const kinds = [
    ['fact', 'Facts', 'What the hospital knows now, from its own records.'],
    ['prediction', 'Simulated predictions', 'Deterministic rules over the current state and the expected pathway. Tentative: never a booking or an authorisation.'],
    ['decision', 'Human decisions pending', 'What the engine will not decide by itself.'],
  ]
  return `<div class="panel">
    <div class="panel-head"><h2>Forward-looking operational intelligence</h2><span class="count">${data.predictions.length}</span></div>
    <p class="muted" style="font-size:.8rem">Every entry distinguishes a fact, a simulated prediction and a decision. Each one explains why it appears and what coordination it recommends; none of them orders treatment.</p>
    ${kinds.map(([kind, title, blurb]) => {
      const entries = data.predictions.filter((entry) => entry.kind === kind)
      return `<h3 style="margin:.9rem 0 .2rem">${title} <span class="count">${entries.length}</span></h3><p class="dim" style="font-size:.76rem">${blurb}</p>${entries.length === 0 ? '<p class="empty">Nothing at this stage.</p>' : entries.map((entry) => predictionCard(entry)).join('')}`
    }).join('')}
  </div>`
}

// ------------------------------------------------------------------ faults

const FAULT_CATALOGUE = [
  ['theatre-unavailable', 'No operating theatre immediately available', 'Every theatre is marked unavailable. The allocation task blocks and theatre coordination, surgery and ICU are told.'],
  ['blood-delay', 'Blood supply delayed', 'O negative is held back. Blood-dependent preparation blocks and affected teams are informed.'],
  ['icu-shortage', 'ICU bed shortage', 'Free ICU beds disappear. The reservation blocks, and transfer readiness cannot be declared.'],
  ['missed-acknowledgement', 'Critical notification not acknowledged', 'A delivered notification is withheld from acknowledgement until the accountable role reacts.'],
  ['ambulance-delay', 'Ambulance arrival delayed', 'The ETA moves by twelve minutes and the receiving team is re-timed.'],
  ['ct-unavailable', 'CT scanner unavailable', 'CT 1 fails. The imaging task blocks and radiology must resolve capacity.'],
  ['staff-unavailable', 'Required staff member unavailable', 'The anaesthetist and theatre coordinator are unavailable; their tasks block.'],
  ['plan-change', 'Patient status or treatment plan changed', 'The patient deteriorates. A revised operative plan needs clinical authorisation and downstream teams are updated.'],
]

VIEWS.faults = (data) => {
  const state = data.state
  return `
    <div class="panel">
      <div class="panel-head"><h2>Fault injection and recovery</h2><span class="count">${state.faults.length} injected</span></div>
      <p class="muted" style="font-size:.8rem">Simulation controls, outside the hospital permission model. Each fault is detected by the workflow, its impact is assessed, the accountable owner is notified and escalated, permitted alternatives are offered for human approval, and the affected workflow resumes with every dependent task and resource updated.</p>
      <div class="fault-grid">
        ${FAULT_CATALOGUE.map(([kind, name, note]) => `<div class="fault">
          <div class="name">${esc(name)}</div>
          <div class="note">${esc(note)}</div>
          <button class="btn sm red" data-act="fault" data-kind="${kind}">Inject fault</button>
        </div>`).join('')}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Fault log</h2><span class="count">${state.faults.filter((fault) => fault.status !== 'resolved').length} active</span></div>
      ${state.faults.length === 0 ? '<p class="empty">No fault injected.</p>' : [...state.faults].reverse().map((fault) => {
        const escalation = state.escalations.find((entry) => entry.id === fault.escalationId)
        return `<div class="card ${fault.status === 'resolved' ? '' : 'urgent'}">
          <div class="spread"><h4>${esc(fault.label)}</h4><div class="row">${pill(fault.status, fault.status)}<span class="count">${esc(wallText(fault.createdAt))}</span></div></div>
          <p class="detail">${esc(fault.detail)}</p>
          <p class="meta">Impact assessment: ${fault.impact.map((id) => esc(deptName(id))).join(', ') || 'no unit affected'}</p>
          ${escalation ? `<p class="meta">Recovery owner: ${esc(roleName(escalation.ownerRole))} &middot; ${escalation.status === 'resolved' ? `resolved with: ${esc(escalation.resolution ?? '')}` : 'awaiting a decision'}</p>` : ''}
        </div>`
      }).join('')}
    </div>`
}

// ------------------------------------------------------------------ audit

VIEWS.audit = (data) => {
  const state = data.state
  const audit = [...state.audit].reverse()
  return `
    <div class="panel">
      <div class="panel-head"><h2>Audit trail</h2><span class="count">${state.audit.length} records</span></div>
      <p class="muted" style="font-size:.8rem">Chronological, append-only: every state change, acknowledgement, decision, resource move, escalation and override, with who acted and why. Persisted with the case.</p>
      <div class="audit">
        ${audit.slice(0, 120).map((entry) => `<div class="audit-row">
          <span class="t">${esc(wallText(entry.at))}</span>
          <span class="a">${esc(entry.action)}</span>
          <span class="s">${esc(entry.subject)}</span>
          <span class="d">${esc(entry.actor)} (${esc(entry.role)})${entry.department ? ` &middot; ${esc(deptName(entry.department))}` : ''}${entry.caseId ? ` &middot; ${esc(entry.caseId)}` : ''} &mdash; ${esc(entry.detail)}</span>
        </div>`).join('') || '<p class="empty">No audit record yet.</p>'}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Operational events</h2><span class="count">${state.events.length}</span></div>
      ${state.events.slice(-60).reverse().map((event) => `<div class="audit-row"><span class="t">${esc(wallText(event.at))}</span><span class="a">${esc(event.name)}</span><span class="s">${esc(event.detail)}</span></div>`).join('') || '<p class="empty">No event yet.</p>'}
    </div>`
}

// ------------------------------------------------------------------ boot

async function boot() {
  const fromHash = location.hash.replace(/^#/, '')
  if (TABS.some(([id]) => id === fromHash)) TAB = fromHash
  try {
    CATALOG = await request('/api/catalog')
  } catch (error) {
    document.getElementById('app').innerHTML = `<p class="flash error">The catalogue could not be loaded: ${esc(String(error.message ?? error))}</p>`
    return
  }
  await refresh(true)
  setInterval(() => {
    if (!document.hidden) void refresh()
  }, 900)
}

void boot()
