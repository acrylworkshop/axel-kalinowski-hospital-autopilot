/**
 * Hospital Autopilot: an event-driven coordination and patient-flow prototype for a simulated major trauma centre.
 *
 * One plugin: the page at `/autopilot`, the client script it loads, the JSON API the page uses, and the simulation clock. The
 * orchestration rules and the state live in `engine.ts`; the hospital model is `catalog.ts`. The state is written to one JSON
 * file in the app's home after every action and periodically while the clock runs, so a reload or a restart keeps the case,
 * the audit trail and the running simulation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@acryldev/instance'
import { Acryl } from '@acryldev/blends'
import { DEPARTMENTS, HOSPITAL, ROLES, STAGES } from './catalog.ts'
import { Orchestrator, emptyState, formatWall } from './engine.ts'
import { type FaultKind, type SimState, STATE_VERSION, type Task } from './model.ts'
import { renderPage } from './page.ts'

export const name = 'autopilot'
export const inject = ['router', 'appInstance']

export interface Config {
  /** The path the plugin answers at. `/autopilot` unless a copy of it needs another. */
  mount?: string
}

const FAULTS: FaultKind[] = [
  'theatre-unavailable',
  'blood-delay',
  'icu-shortage',
  'missed-acknowledgement',
  'ambulance-delay',
  'ct-unavailable',
  'staff-unavailable',
  'plan-change',
]

function isFault(value: unknown): value is FaultKind {
  return typeof value === 'string' && (FAULTS as string[]).includes(value)
}

function roleExists(value: unknown): boolean {
  return typeof value === 'string' && ROLES.some((role) => role.id === value)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function apply(ctx: Context, config: Config = {}): void {
  const mount = (config.mount ?? '/autopilot').replace(/\/+$/u, '')
  const home = ctx.appInstance.home
  const file = join(home, 'autopilot-state.json')

  let state: SimState = loadState()
  const engine = new Orchestrator(state)
  let lastSave = 0
  let closed = false

  function loadState(): SimState {
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as SimState
        if (parsed && parsed.version === STATE_VERSION && Array.isArray(parsed.tasks) && Array.isArray(parsed.cases)) {
          if (!roleExists(parsed.role)) parsed.role = 'commander'
          if (!Array.isArray(parsed.unavailableRoles)) parsed.unavailableRoles = []
          return parsed
        }
      }
    } catch {
      /* a corrupt file is replaced by a fresh shift instead of stopping the plugin */
    }
    return emptyState()
  }

  function save(force = false): void {
    const now = Date.now()
    if (!force && now - lastSave < 1200) return
    lastSave = now
    try {
      mkdirSync(home, { recursive: true })
      const body = JSON.stringify(engine.state)
      writeFileSync(`${file}.tmp`, body)
      renameSync(`${file}.tmp`, file)
    } catch (error) {
      console.warn(`autopilot: the state file could not be written: ${String(error)}`)
    }
  }

  function clientScript(): string {
    return readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  }

  function page(): string {
    const open = engine.state.tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled')
    const snapshot = engine.snapshot(engine.state.role)
    return renderPage({
      clock: engine.state.clock,
      running: engine.state.running,
      cases: snapshot.state.cases.filter((entry) => entry.status !== 'closed').length,
      openTasks: open.length,
      alerts: engine.state.escalations.filter((entry) => entry.status !== 'resolved').length,
      decisions: engine.state.decisions.filter((entry) => entry.status === 'pending').length,
    })
  }

  function snapshot() {
    return engine.snapshot(engine.state.role)
  }

  function auditEntry(message: string, kind = 'request'): void {
    engine.audit(kind, message, `Requested from the web interface as ${engine.state.role}`, { actor: 'Operator', role: engine.state.role })
  }

  const app = new Acryl()
    .get('/', () => new Response(page(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }))
    .get('/app.js', () =>
      new Response(clientScript(), {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
      }),
    )
    .get('/api/catalog', () =>
      json({
        hospital: HOSPITAL,
        departments: DEPARTMENTS,
        roles: ROLES,
        stages: STAGES,
        faults: FAULTS,
      }),
    )
    .get('/api/state', () => json(snapshot()))
    .post('/api/role', async (c) => {
      const body = await readBody(c.req.raw)
      if (!roleExists(body.role)) return fail('Unknown role')
      engine.state.role = body.role as string
      engine.audit('role.switch', `Workspace switched to ${engine.state.role}`, 'The interface now acts as this role; the server checks its permissions', { actor: 'Operator' })
      save(true)
      return json({ ok: true, message: `Now acting as ${engine.state.role}`, snapshot: snapshot() })
    })
    .post('/api/sim', async (c) => {
      const body = await readBody(c.req.raw)
      const action = String(body.action ?? '')
      if (action === 'play') {
        if (engine.state.cases.length === 0) return fail('Run the major trauma scenario first')
        engine.setRunning(true)
      } else if (action === 'pause') {
        engine.setRunning(false)
      } else if (action === 'step') {
        engine.step()
        auditEntry('Simulation stepped by one tick', 'simulation')
      } else if (action === 'reset') {
        engine.reset()
        auditEntry('Simulation reset', 'simulation')
      } else if (action === 'speed') {
        engine.setSpeed(numberOr(body.speed, 2))
      } else if (action === 'automation') {
        engine.state.departmentAutomation = body.enabled !== false
        engine.audit('simulation', `Department automation ${engine.state.departmentAutomation ? 'on' : 'off'}`, 'When on, synthetic departments acknowledge and prepare on their own; clinical gates never do', {})
      } else {
        return fail('Unknown simulation action')
      }
      save(true)
      return json({ ok: true, message: 'Simulation updated', snapshot: snapshot() })
    })
    .post('/api/scenario', async (c) => {
      const body = await readBody(c.req.raw)
      const kind = body.kind === 'second' ? 'second' : 'primary'
      const existing = engine.state.cases.find(
        (entry) => entry.scenario === kind && entry.status !== 'closed' && entry.status !== 'stabilised',
      )
      if (existing) {
        engine.setRunning(true)
        save(true)
        return json({ ok: true, message: `${existing.code} is already running`, snapshot: snapshot() })
      }
      const created = engine.runTraumaScenario(kind)
      save(true)
      return json({ ok: true, message: `${created.code} created and dispatched`, snapshot: snapshot() })
    })
    .post('/api/task/:id', async (c) => {
      const body = await readBody(c.req.raw)
      const action = String(body.action ?? '')
      const result = engine.taskAction(c.req.param('id'), action, engine.state.role)
      save(true)
      return result.ok ? json({ ...result, snapshot: snapshot() }) : fail(result.message, 409)
    })
    .post('/api/decision/:id', async (c) => {
      const body = await readBody(c.req.raw)
      const result = engine.decide(c.req.param('id'), String(body.option ?? ''), engine.state.role)
      save(true)
      return result.ok ? json({ ...result, snapshot: snapshot() }) : fail(result.message, 403)
    })
    .post('/api/decisions/approve-pending', () => {
      const role = engine.state.role
      const pending = engine.pendingDecisionsFor(role)
      if (pending.length === 0) return fail('No pending decision is yours to authorise', 403)
      const done: string[] = []
      for (const decision of pending) {
        const choice =
          decision.options.find((option) => !['decline', 'hold', 'defer', 'sau'].includes(option.id) && !option.id.startsWith('decline')) ??
          decision.options[0]
        if (!choice) continue
        const result = engine.decide(decision.id, choice.id, role)
        if (result.ok) done.push(`${decision.title}: ${choice.label}`)
      }
      save(true)
      if (done.length === 0) return fail('This role is not authorised for the pending decisions', 403)
      return json({ ok: true, message: `Authorised ${done.length} decision(s)`, done, snapshot: snapshot() })
    })
    .post('/api/escalation/:id', async (c) => {
      const body = await readBody(c.req.raw)
      const action = String(body.action ?? '')
      const id = c.req.param('id')
      if (action === 'acknowledge') {
        const result = engine.acknowledgeEscalation(id, engine.state.role)
        save(true)
        return result.ok ? json({ ...result, snapshot: snapshot() }) : fail(result.message, 403)
      }
      if (action === 'resolve') {
        const result = engine.resolveEscalation(id, String(body.option ?? ''), engine.state.role)
        save(true)
        return result.ok ? json({ ...result, snapshot: snapshot() }) : fail(result.message, 403)
      }
      return fail('Unknown escalation action')
    })
    .post('/api/handover/:id', async (c) => {
      const result = engine.acceptHandover(c.req.param('id'), engine.state.role)
      save(true)
      return result.ok ? json({ ...result, snapshot: snapshot() }) : fail(result.message, 403)
    })
    .post('/api/fault', async (c) => {
      const body = await readBody(c.req.raw)
      if (!isFault(body.kind)) return fail('Unknown fault')
      const result = engine.injectFault(body.kind, engine.state.role)
      save(true)
      return json({ ...result, snapshot: snapshot() })
    })
    .get('/api/audit', () => json({ audit: engine.state.audit.slice(-200), events: engine.state.events.slice(-200) }))
    .get('/api/tasks', () => json(engine.state.tasks.map((task: Task) => ({ id: task.id, status: task.status }))))

  ctx.router.route(mount, app)

  ctx.effect(() => {
    const interval = setInterval(() => {
      if (closed || !engine.state.running) return
      try {
        engine.tick()
        save(false)
      } catch (error) {
        ctx.logger?.error?.(`autopilot: the simulation tick failed: ${String(error)}`)
      }
    }, Math.max(200, engine.state.tickIntervalMs))
    return () => {
      closed = true
      clearInterval(interval)
      save(true)
    }
  })

  engine.audit('app.started', 'Hospital Autopilot started', `Simulated clock ${formatWall(engine.state.clock)} (${engine.state.running ? 'running' : 'paused'})`, {})
  save(true)
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json()
    if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {
    /* an action with no body is fine */
  }
  return {}
}
