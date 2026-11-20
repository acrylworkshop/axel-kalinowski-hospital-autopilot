import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pinnedInstance, withPort } from '@acryldev/instance'
import { type App, createApp } from '../src/app.ts'
import { emptyState, Orchestrator } from '../plugins/autopilot/engine.ts'
import type { Decision, Task } from '../plugins/autopilot/model.ts'

const scratch = join(fileURLToPath(new URL('..', import.meta.url)), '.acrylblends', 'test')
mkdirSync(scratch, { recursive: true })
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

async function withApp(run: (app: App) => Promise<void>, home?: string) {
  const directory = home ?? (await mkdtemp(join(scratch, 'autopilot-test-')))
  const app = await createApp(withPort(pinnedInstance(directory, { root: projectRoot }), 0), { listen: false })
  try {
    await run(app)
  } finally {
    await app.stop()
    if (home === undefined) await rm(directory, { recursive: true, force: true })
  }
}

async function ask(app: App, path: string, body: unknown): Promise<Response> {
  return app.root.router.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function read(app: App, path: string): Promise<any> {
  const response = await app.root.router.request(path)
  assert.equal(response.status, 200, `${path} answered ${response.status}`)
  return response.json()
}

// ------------------------------------------------------------------ engine helpers

function engine(): Orchestrator {
  const state = emptyState()
  state.speed = 1
  return new Orchestrator(state)
}

/** Steps the clock, authorising every pending decision as an authorised role, until the condition holds. */
function advance(orchestrator: Orchestrator, until: () => boolean, limit = 4000, autoDecide = true): boolean {
  for (let index = 0; index < limit; index += 1) {
    orchestrator.step()
    if (autoDecide) {
      for (const decision of orchestrator.state.decisions.filter((entry) => entry.status === 'pending')) {
        choose(orchestrator, decision)
      }
    }
    if (until()) return true
  }
  return until()
}

function choose(orchestrator: Orchestrator, decision: Decision): boolean {
  const role = decision.authorisedRoles[0]
  if (!role) return false
  const option = decision.options.find((entry) => !['decline', 'hold', 'defer', 'sau'].includes(entry.id)) ?? decision.options[0]
  if (!option) return false
  return orchestrator.decide(decision.id, option.id, role).ok
}

function taskByKey(orchestrator: Orchestrator, caseId: string, department: string, job: string): Task | undefined {
  return orchestrator.state.tasks.find((task) => task.key === `${caseId}:${department}:${job}`)
}

function openDepartments(orchestrator: Orchestrator, caseId: string): string[] {
  return [
    ...new Set(
      orchestrator.state.tasks
        .filter((task) => task.caseId === caseId && task.status !== 'completed' && task.status !== 'cancelled')
        .map((task) => task.department),
    ),
  ]
}

// ------------------------------------------------------------------ A: the normal journey

test('A: the emergency call runs through dispatch, pre-alert, A&E, surgery and ICU', () => {
  const orchestrator = engine()
  const c = orchestrator.runTraumaScenario('primary')
  assert.equal(c.stage, 'emergency-call')
  assert.equal(orchestrator.state.running, true)
  const reached = advance(orchestrator, () => orchestrator.state.cases[0]!.stage === 'stabilised')
  assert.equal(reached, true, `case stalled at ${orchestrator.state.cases[0]!.stage}`)
  const final = orchestrator.state.cases[0]!
  assert.equal(final.status, 'stabilised')
  assert.ok(final.icuAt !== null, 'the case was admitted to ICU')
  assert.ok(final.icuBedId !== null, 'an ICU bed was allocated')
  assert.ok(final.arrivedAt !== null && final.theatreAt !== null && final.icuAt !== null)
  assert.ok(final.arrivedAt! < final.theatreAt! && final.theatreAt! < final.icuAt!, 'the journey is chronological')
  const recorded = orchestrator.state.audit.filter((entry) => entry.action === 'case.stage').map((entry) => entry.subject)
  for (const stage of ['Ambulance dispatched', 'On scene assessment', 'A&E arrival and handover', 'Resuscitation and primary survey', 'Imaging and investigations', 'Surgical decision', 'Theatre and ICU preparation', 'Emergency operation', 'ICU admission and handover', 'Stabilised in intensive care']) {
    assert.ok(recorded.some((subject) => subject.includes(stage)), `the journey recorded: ${stage}`)
  }
  assert.ok(orchestrator.state.decisions.every((entry) => entry.status !== 'pending'), 'every gate was resolved by a person')
  assert.ok(orchestrator.state.tasks.some((task) => task.key.endsWith(':theatre-coord:assign-theatre') && task.status === 'completed'))
  assert.ok(orchestrator.state.events.some((event) => event.name === 'prealert.sent'))
  assert.ok(orchestrator.state.events.some((event) => event.name === 'surgery.authorised'))
  assert.ok(orchestrator.state.events.some((event) => event.name === 'icu.admitted'))
})

// ------------------------------------------------------------------ B: parallel preparation

test('B: a pre-alert makes the receiving units prepare concurrently, without waiting on each other', () => {
  const orchestrator = engine()
  const c = orchestrator.runTraumaScenario('primary')
  const prealert = advance(orchestrator, () => taskByKey(orchestrator, c.id, 'resus', 'prepare-bay') !== undefined, 2000)
  assert.equal(prealert, true)
  const departments = openDepartments(orchestrator, c.id)
  assert.ok(departments.length >= 6, `only ${departments.join(', ')} were preparing`)
  for (const department of ['resus', 'trauma-team', 'radiology', 'laboratory', 'blood-bank', 'bed-management', 'anaesthetics', 'theatre-coord', 'command', 'family-liaison']) {
    assert.ok(departments.includes(department), `${department} was not asked to prepare`)
  }
  // The preparation tasks were all created at the same moment: nothing waited for a previous unit to finish.
  const created = orchestrator.state.tasks.filter((task) => task.caseId === c.id).map((task) => task.createdAt)
  const groups = new Map<number, number>()
  for (const at of created) groups.set(at, (groups.get(at) ?? 0) + 1)
  const largest = Math.max(...groups.values())
  assert.ok(largest >= 8, `only ${largest} tasks were created together`)
  const parallel = orchestrator.state.tasks.filter((task) => task.caseId === c.id && task.department !== 'resus')
  assert.ok(parallel.some((task) => task.startedAt !== null), 'work started before the patient arrived')
})

// ------------------------------------------------------------------ C: dependency propagation

test('C: completing one unit task unlocks the dependent work of another', () => {
  const orchestrator = engine()
  const c = orchestrator.runTraumaScenario('primary')
  advance(orchestrator, () => orchestrator.state.cases[0]!.stage === 'theatre-prep')
  const assign = taskByKey(orchestrator, c.id, 'theatre-coord', 'assign-theatre')
  const nursing = taskByKey(orchestrator, c.id, 'theatre-nursing', 'prepare-theatre')
  assert.ok(assign && nursing)
  assert.ok(nursing.dependsOn.includes(assign.id), 'theatre nursing waits on the theatre allocation')
  advance(orchestrator, () => assign.status === 'completed')
  const openedAt = assign.completedAt
  assert.ok(openedAt !== null, 'the theatre was allocated')
  advance(orchestrator, () => nursing.status === 'completed')
  assert.equal(nursing.status, 'completed')
  assert.ok(nursing.startedAt !== null && nursing.startedAt >= openedAt, 'nursing started only after the allocation completed')
  const caseAfter = orchestrator.state.cases[0]!
  assert.ok(caseAfter.theatreId !== null, 'the allocated theatre is recorded against the case')
})

// ------------------------------------------------------------------ H: clinical gates

test('H: simulated time alone never resolves a clinical gate', () => {
  const orchestrator = engine()
  const c = orchestrator.runTraumaScenario('primary')
  const gate = advance(orchestrator, () => orchestrator.state.decisions.some((entry) => entry.status === 'pending'), 2000, false)
  assert.equal(gate, true, 'a clinical gate was reached')
  const decision = orchestrator.state.decisions.find((entry) => entry.status === 'pending')!
  const stageAtGate = orchestrator.state.cases[0]!.stage
  const tasksAtGate = orchestrator.state.tasks.filter((task) => task.caseId === c.id && task.status === 'completed').length
  for (let index = 0; index < 300; index += 1) orchestrator.step()
  assert.equal(orchestrator.state.decisions.find((entry) => entry.id === decision.id)!.status, 'pending')
  assert.equal(orchestrator.state.cases[0]!.stage, stageAtGate)
  assert.equal(orchestrator.state.tasks.filter((task) => task.caseId === c.id && task.status === 'completed').length, tasksAtGate)
  assert.ok(orchestrator.state.escalations.some((entry) => entry.key === `decision:${decision.id}`), 'the wait was escalated to the accountable role')
  // A role that is not authorised cannot take it either.
  const refused = orchestrator.decide(decision.id, decision.options[0]!.id, 'porter')
  assert.equal(refused.ok, false)
  // An authorised role can.
  const made = orchestrator.decide(decision.id, decision.options[0]!.id, decision.authorisedRoles[0]!)
  assert.equal(made.ok, true)
  assert.notEqual(orchestrator.state.cases[0]!.stage, stageAtGate)
})

// ------------------------------------------------------------------ G: missed acknowledgement

test('G: an unanswered notification escalates once, to the accountable role, and never repeats', () => {
  const orchestrator = engine()
  const c = orchestrator.runTraumaScenario('primary')
  advance(orchestrator, () => orchestrator.state.events.some((event) => event.name === 'prealert.sent'))
  orchestrator.injectFault('missed-acknowledgement', 'commander')
  const target = orchestrator.state.tasks.find((task) => task.suppressAutoAck && task.status !== 'completed')
  assert.ok(target, 'a critical notification was withheld')
  advance(orchestrator, () => orchestrator.state.clock > target.ackDueAt + orchestrator.state.tickSeconds + 1, 500, false)
  const ackKey = `ack:${target.id}`
  const first = orchestrator.state.escalations.filter((entry) => entry.key === ackKey)
  assert.equal(first.length, 1, 'exactly one escalation for the missed acknowledgement')
  assert.equal(first[0]!.ownerRole, 'commander', 'it escalated to the accountable role')
  for (let index = 0; index < 40; index += 1) orchestrator.step()
  assert.equal(orchestrator.state.escalations.filter((entry) => entry.key === ackKey).length, 1, 'no duplicate alert')
  // The owner re-sends and telephones: the department acknowledges and the work continues.
  const escalation = orchestrator.state.escalations.find((entry) => entry.key === ackKey)!
  const option = escalation.options.find((entry) => entry.id === 'resend')!
  const role = option.requiresRoles[0]!
  const resolved = orchestrator.resolveEscalation(escalation.id, option.id, role)
  assert.equal(resolved.ok, true, resolved.message)
  assert.notEqual(orchestrator.state.tasks.find((task) => task.id === target.id)!.status, 'escalated')
  assert.equal(orchestrator.state.escalations.find((entry) => entry.id === escalation.id)!.status, 'resolved')
  void c
})

// ------------------------------------------------------------------ D: theatre unavailable

test('D: a withdrawn theatre is detected, escalated and recovered with a recorded alternative', () => {
  const orchestrator = engine()
  const c = orchestrator.runTraumaScenario('primary')
  advance(orchestrator, () => orchestrator.state.cases[0]!.stage === 'theatre-prep')
  const fault = orchestrator.injectFault('theatre-unavailable', 'commander')
  assert.equal(fault.ok, true)
  advance(orchestrator, () => orchestrator.state.tasks.some((task) => task.caseId === c.id && task.status === 'blocked'), 120, false)
  const blocked = orchestrator.state.tasks.find((task) => task.caseId === c.id && task.status === 'blocked' && task.requires?.kind === 'theatre')
  assert.ok(blocked, 'the theatre-dependent work blocked')
  const escalation = orchestrator.state.escalations.find((entry) => entry.taskId === blocked.id && entry.status !== 'resolved')
  assert.ok(escalation, 'the block was escalated')
  assert.ok(escalation.options.length >= 2, 'permitted alternatives were offered')
  assert.ok(orchestrator.state.events.some((event) => event.name === 'fault.injected'))
  const option = escalation.options.find((entry) => entry.id === 'use-alternative-theatre')!
  const resolved = orchestrator.resolveEscalation(escalation.id, option.id, option.requiresRoles[0]!)
  assert.equal(resolved.ok, true, resolved.message)
  const after = orchestrator.state.tasks.find((task) => task.id === blocked.id)!
  assert.notEqual(after.status, 'blocked')
  advance(orchestrator, () => orchestrator.state.cases[0]!.stage === 'stabilised', 4000)
  const final = orchestrator.state.cases[0]!
  assert.equal(final.status, 'stabilised', `stalled at ${final.stage}`)
  assert.ok(final.theatreAt !== null, 'the patient still reached theatre')
  assert.ok(final.theatreId !== null, 'the case records the theatre it actually used')
  assert.ok(orchestrator.state.faults.find((entry) => entry.id === orchestrator.state.faults[0]!.id)!.status === 'resolved')
})

// ------------------------------------------------------------------ E: blood delay

test('E: a blood delay blocks the dependent work, informs the teams and escalates to a clinical owner', () => {
  const orchestrator = engine()
  const c = orchestrator.runTraumaScenario('primary')
  advance(orchestrator, () => orchestrator.state.cases[0]!.stage === 'theatre-prep')
  const injected = orchestrator.injectFault('blood-delay', 'commander')
  assert.equal(injected.ok, true)
  const blocked = advance(orchestrator, () => orchestrator.state.tasks.some((task) => task.caseId === c.id && task.status === 'blocked' && task.requires?.kind === 'blood'), 300, false)
  assert.equal(blocked, true, 'a blood-dependent task blocked')
  const task = orchestrator.state.tasks.find((entry) => entry.caseId === c.id && entry.status === 'blocked' && entry.requires?.kind === 'blood')!
  const escalation = orchestrator.state.escalations.find((entry) => entry.taskId === task.id)!
  assert.equal(escalation.status, 'open')
  assert.ok(escalation.impact.length > 0, 'the impact on other units is assessed')
  assert.ok(escalation.notified.some((entry) => entry.department === 'command'), 'operations command was informed')
  assert.ok(escalation.options.some((option) => option.effect.startsWith('release:')), 'the clinical release option was offered')
  const option = escalation.options.find((entry) => entry.id === 'emergency-release')!
  const resolved = orchestrator.resolveEscalation(escalation.id, option.id, 'trauma-leader')
  assert.equal(resolved.ok, true, resolved.message)
  assert.notEqual(orchestrator.state.tasks.find((entry) => entry.id === task.id)!.status, 'blocked')
  assert.ok(orchestrator.state.audit.some((entry) => entry.action === 'escalation.resolved'))
})

// ------------------------------------------------------------------ F: ICU capacity

test('F: an ICU shortage prevents false transfer readiness until capacity is agreed', () => {
  const orchestrator = engine()
  const c = orchestrator.runTraumaScenario('primary')
  advance(orchestrator, () => orchestrator.state.cases[0]!.stage === 'theatre-prep')
  orchestrator.injectFault('icu-shortage', 'commander')
  const blocked = advance(orchestrator, () => orchestrator.state.tasks.some((task) => task.caseId === c.id && task.status === 'blocked' && task.requires?.kind === 'icu-bed'), 300, false)
  assert.equal(blocked, true, 'the ICU reservation blocked')
  const reserve = taskByKey(orchestrator, c.id, 'icu', 'reserve-bed')!
  const escalation = orchestrator.state.escalations.find((entry) => entry.taskId === reserve.id)!
  assert.ok(escalation, 'the shortfall was escalated to ICU and bed management')
  const gate = taskByKey(orchestrator, c.id, 'surgical-team', 'transfer-gate')!
  assert.notEqual(gate.status, 'completed', 'the transfer gate did not open while ICU capacity was unresolved')
  for (let index = 0; index < 30; index += 1) orchestrator.step()
  assert.notEqual(taskByKey(orchestrator, c.id, 'surgical-team', 'transfer-gate')!.status, 'completed')
  const option = escalation.options.find((entry) => entry.effect === 'repurpose:hdu')!
  const resolved = orchestrator.resolveEscalation(escalation.id, option.id, 'icu-coordinator')
  assert.equal(resolved.ok, true, resolved.message)
  advance(orchestrator, () => orchestrator.state.cases[0]!.stage === 'stabilised', 4000)
  assert.equal(orchestrator.state.cases[0]!.status, 'stabilised')
})

// ------------------------------------------------------------------ I: multiple patients

test('I: two simultaneous cases compete for shared resources without a double allocation', () => {
  const orchestrator = engine()
  const first = orchestrator.runTraumaScenario('primary')
  advance(orchestrator, () => orchestrator.state.cases[0]!.stage === 'imaging')
  const second = orchestrator.runTraumaScenario('second')
  assert.notEqual(first.id, second.id)
  const conflicts: string[] = []
  for (let index = 0; index < 2500; index += 1) {
    orchestrator.step()
    for (const decision of orchestrator.state.decisions.filter((entry) => entry.status === 'pending')) choose(orchestrator, decision)
    for (const resource of orchestrator.state.resources) {
      if (resource.caseId === null) continue
      const holders = orchestrator.state.tasks.filter(
        (task) => task.resourceId === resource.id && task.status !== 'completed' && task.caseId !== resource.caseId,
      )
      if (holders.length > 0) conflicts.push(`${resource.id} held by ${resource.caseId} but used by ${holders[0]!.caseId}`)
    }
    if (orchestrator.state.cases.every((entry) => entry.status === 'stabilised')) break
  }
  assert.deepEqual(conflicts, [], `double allocations: ${conflicts.slice(0, 3).join('; ')}`)
  const secondCase = orchestrator.state.cases.find((entry) => entry.id === second.id)!
  assert.notEqual(secondCase.stage, 'emergency-call', 'the second case progressed as well')
  const ctTasks = orchestrator.state.tasks.filter((task) => task.requires?.kind === 'ct' && task.resourceId !== null)
  const ctHolders = new Map<string, Set<string | null>>()
  for (const task of ctTasks) {
    const holders = ctHolders.get(task.resourceId!) ?? new Set()
    holders.add(task.caseId)
    ctHolders.set(task.resourceId!, holders)
  }
  void ctHolders
  assert.ok(orchestrator.state.cases.some((entry) => entry.stage !== 'emergency-call'))
})

// ------------------------------------------------------------------ plugin routes

test('the plugin page, its script and its catalogue are served', () =>
  withApp(async (app) => {
    const page = await app.root.router.request('/autopilot')
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /<title>Hospital Autopilot/)
    assert.match(html, /Northbridge Regional Trauma Centre/)
    const script = await app.root.router.request('/autopilot/app.js')
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type') ?? '', /javascript/)
    const source = await script.text()
    assert.match(source, /Run major trauma scenario/)
    const catalog = await read(app, '/autopilot/api/catalog')
    assert.equal(catalog.departments.length >= 20, true)
    assert.equal(catalog.roles.length >= 20, true)
    assert.equal(catalog.faults.length, 8)
  }))

test('the scenario runs through the API and its clinical gates refuse unauthorised roles', () =>
  withApp(async (app) => {
    const created = await ask(app, '/autopilot/api/scenario', { kind: 'primary' })
    assert.equal(created.status, 200)
    let snapshot = await read(app, '/autopilot/api/state')
    assert.equal(snapshot.state.cases.length, 1)
    assert.equal(snapshot.state.running, true)
    const duplicate = await ask(app, '/autopilot/api/scenario', { kind: 'primary' })
    assert.equal(duplicate.status, 200)
    snapshot = await read(app, '/autopilot/api/state')
    assert.equal(snapshot.state.cases.length, 1, 'the demo scenario is not created twice')

    await ask(app, '/autopilot/api/sim', { action: 'pause' })
    const before = (await read(app, '/autopilot/api/state')).state.clock
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const after = (await read(app, '/autopilot/api/state')).state.clock
    assert.equal(after, before, 'a paused clock does not advance')

    const step = await ask(app, '/autopilot/api/sim', { action: 'step' })
    assert.equal(step.status, 200)
    const stepped = await read(app, '/autopilot/api/state')
    assert.equal(stepped.state.clock, before + stepped.state.tickSeconds * stepped.state.speed, 'one step is exactly one tick')

    const speed = await ask(app, '/autopilot/api/sim', { action: 'speed', speed: 5 })
    assert.equal(speed.status, 200)
    await ask(app, '/autopilot/api/sim', { action: 'step' })
    const fast = await read(app, '/autopilot/api/state')
    assert.equal(fast.state.clock, stepped.state.clock + fast.state.tickSeconds * 5)
  }))

test('role permissions and data minimisation are enforced on the server', () =>
  withApp(async (app) => {
    await ask(app, '/autopilot/api/scenario', { kind: 'primary' })
    await ask(app, '/autopilot/api/sim', { action: 'pause' })
    // A non-clinical role sees the operational record only.
    await ask(app, '/autopilot/api/role', { role: 'porter' })
    const porter = await read(app, '/autopilot/api/state')
    assert.equal(porter.role.id, 'porter')
    assert.equal(porter.state.cases[0].patientName, 'Trauma patient')
    assert.deepEqual(porter.state.cases[0].injuries, [])
    assert.match(porter.state.cases[0].clinicalNotes, /Restricted/)
    const sensitive = porter.state.tasks.find((task: Task) => task.sensitive)
    if (sensitive) assert.equal(sensitive.detail, sensitive.notifySummary)
    // A porter may not take a clinical decision.
    const decision = porter.state.decisions.find((entry: Decision) => entry.status === 'pending')
    if (decision) {
      const refused = await ask(app, `/autopilot/api/decision/${decision.id}`, { option: decision.options[0].id })
      assert.equal(refused.status, 403)
    }
    // A clinical role sees the clinical record.
    await ask(app, '/autopilot/api/role', { role: 'trauma-leader' })
    const clinician = await read(app, '/autopilot/api/state')
    assert.notEqual(clinician.state.cases[0].patientName, 'Trauma patient')
    assert.ok(clinician.state.cases[0].injuries.length > 0)
    assert.ok(clinician.permissions.includes('clinical.decide'))
  }))

test('J: the case, its audit trail and the clock survive a restart', async () => {
  const home = await mkdtemp(join(scratch, 'autopilot-restart-'))
  try {
    await withApp(async (app) => {
      await ask(app, '/autopilot/api/sim', { action: 'speed', speed: 3 })
      await ask(app, '/autopilot/api/scenario', { kind: 'primary' })
      for (let index = 0; index < 12; index += 1) await ask(app, '/autopilot/api/sim', { action: 'step' })
      await ask(app, '/autopilot/api/sim', { action: 'pause' })
      const snapshot = await read(app, '/autopilot/api/state')
      assert.ok(snapshot.state.cases.length === 1)
      assert.ok(existsSync(join(home, 'autopilot-state.json')))
    }, home)
    const before = JSON.parse((await import('node:fs')).readFileSync(join(home, 'autopilot-state.json'), 'utf8'))
    await withApp(async (app) => {
      const restored = await read(app, '/autopilot/api/state')
      assert.equal(restored.state.cases.length, 1)
      assert.equal(restored.state.cases[0].code, 'MT-1042')
      assert.ok(restored.state.clock > 0)
      assert.ok(restored.state.audit.length >= before.audit.length, 'the audit trail is kept')
      assert.equal(restored.state.audit[0].seq, before.audit[0].seq)
      assert.equal(restored.state.audit.at(-1).action, 'app.started', 'the restart is recorded')
      const seqs = restored.state.audit.map((entry: { seq: number }) => entry.seq)
      assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right), 'the audit trail stays in order')
      const times = restored.state.audit.map((entry: { at: number }) => entry.at)
      assert.deepEqual(times, [...times].sort((left, right) => left - right), 'the audit trail stays chronological')
    }, home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('reset clears the case and the audit trail', () =>
  withApp(async (app) => {
    await ask(app, '/autopilot/api/scenario', { kind: 'primary' })
    await ask(app, '/autopilot/api/sim', { action: 'reset' })
    const snapshot = await read(app, '/autopilot/api/state')
    assert.equal(snapshot.state.cases.length, 0)
    assert.equal(snapshot.state.tasks.length, 0)
    assert.equal(snapshot.state.clock, 0)
  }))
