/**
 * The orchestration engine: one authoritative state for every case and resource, an ordered event queue, the workflow
 * rules, task and dependency handling, escalation, fault detection and recovery, and the snapshot each view reads.
 *
 * The rules are deterministic. Simulated time advances only through `tick` and `step`; nothing clinical ever resolves
 * because time passed. A decision is resolved only by a role the decision names.
 */
import {
  DEPARTMENTS,
  INITIAL_RESOURCES,
  ROLES,
  STAGES,
  departmentById,
  departmentOfRole,
  roleById,
} from './catalog.ts'
import {
  type AuditEntry,
  type ClinicalCase,
  type Decision,
  type DepartmentReadiness,
  type DepartmentWorkView,
  type Escalation,
  type Fault,
  type FaultKind,
  type Handover,
  type Notification,
  type OperationalEvent,
  type Prediction,
  type Priority,
  type Readiness,
  type RecoveryOption,
  type Resource,
  type RoleDefinition,
  type SimState,
  type Snapshot,
  type Task,
  type TaskKind,
  type TaskRequirement,
  STATE_VERSION,
} from './model.ts'

const HOSPITAL_SHIFT = 7 * 3600 + 42 * 60

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600) % 24
  const m = Math.floor(total / 60) % 60
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatWall(seconds: number): string {
  return formatClock(HOSPITAL_SHIFT + seconds)
}

export function formatMinutes(seconds: number | null): string {
  if (seconds === null) return 'n/a'
  const minutes = Math.max(0, Math.round(seconds / 60))
  return `${minutes} min`
}

const PRIORITY_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 }

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48)
}

export function emptyState(): SimState {
  return {
    version: STATE_VERSION,
    clock: 0,
    running: false,
    tickSeconds: 10,
    tickIntervalMs: 500,
    ticks: 0,
    seed: 20260512,
    speed: 2,
    caseSeq: 0,
    taskSeq: 0,
    decisionSeq: 0,
    escalationSeq: 0,
    notificationSeq: 0,
    auditSeq: 0,
    eventSeq: 0,
    timerSeq: 0,
    handoverSeq: 0,
    faultSeq: 0,
    cases: [],
    tasks: [],
    notifications: [],
    decisions: [],
    escalations: [],
    resources: INITIAL_RESOURCES.map((resource) => ({ ...resource })),
    handovers: [],
    faults: [],
    audit: [],
    events: [],
    timers: [],
    role: 'commander',
    unavailableRoles: [],
    departmentAutomation: true,
  }
}

interface TaskSpec {
  caseId: string | null
  department: string
  job: string
  title: string
  detail: string
  notifySummary: string
  priority?: Priority
  kind?: TaskKind
  duration: number
  dueIn?: number
  ackIn?: number
  dependsOn?: string[]
  requires?: TaskRequirement | null
  onCompleteEvent?: string | null
  auto?: boolean
  sensitive?: boolean
  decisionId?: string | null
}

interface DecisionSpec {
  caseId: string
  title: string
  question: string
  clinical: boolean
  options: { id: string; label: string; consequence: string }[]
  authorisedRoles: string[]
  dueIn: number
  unlocks: string
  optionEvents?: Record<string, string>
  department: string
  taskDetail: string
  taskTitle: string
  sensitive?: boolean
}

interface CaseSpec {
  patientName: string
  age: number
  sex: string
  incidentSummary: string
  location: string
  mechanism: string
  casualties: number
  priority: Priority
  injuries: string[]
  clinicalNotes: string
  operationalSummary: string
  plan: string
  vitals: { hr: number; bp: string; spo2: number; gcs: number }
  etaSeconds: number
}

interface PendingEvent {
  name: string
  caseId: string | null
  detail: string
}

const CASE_SPECS: Record<'primary' | 'second', CaseSpec> = {
  primary: {
    patientName: 'Jordan Miller',
    age: 34,
    sex: 'M',
    incidentSummary: 'High-speed single-vehicle collision, driver unrestrained, trapped 20 minutes',
    location: 'A19 northbound, Kingsway junction, 6.4 km from hospital',
    mechanism: 'Road traffic collision at speed, ejection avoided, steering wheel deformation',
    casualties: 1,
    priority: 'P1',
    injuries: ['Suspected unstable pelvic fracture', 'Suspected splenic laceration', 'Bilateral rib fractures, right pneumothorax'],
    clinicalNotes:
      'Synthetic clinical record. Airway patent with collar, tachycardic and cool peripherally. Underwent roadside chest decompression. Requires trauma CT and likely damage control laparotomy.',
    operationalSummary: 'Adult driver, major trauma, needs trauma CT and likely emergency theatre with ICU after surgery.',
    plan: 'Trauma CT, then trauma team decision on emergency laparotomy',
    vitals: { hr: 124, bp: '92/58', spo2: 94, gcs: 14 },
    etaSeconds: 600,
  },
  second: {
    patientName: 'Sam Okafor',
    age: 27,
    sex: 'F',
    incidentSummary: 'Motorcyclist versus car, thrown 8 metres, helmet damaged',
    location: 'Kingsway roundabout, 3.1 km from hospital',
    mechanism: 'Road traffic collision, motorcycle versus car, rotational injury',
    casualties: 1,
    priority: 'P1',
    injuries: ['Open right femoral fracture with bleeding', 'Suspected traumatic brain injury', 'Suspected cervical spine injury'],
    clinicalNotes:
      'Synthetic clinical record. Responding to painful stimulus, gross deformity of the right thigh with a pressure dressing. Needs urgent CT head and consideration of emergency wound debridement.',
    operationalSummary: 'Adult motorcyclist, major trauma, needs urgent CT and likely emergency surgery, ICU admission expected.',
    plan: 'Urgent CT head and trauma series, then orthopaedic and neurosurgical decision',
    vitals: { hr: 138, bp: '86/50', spo2: 91, gcs: 11 },
    etaSeconds: 480,
  },
}

const DEPARTMENT_ROLE: Record<string, string> = Object.fromEntries(
  DEPARTMENTS.map((department) => [department.id, department.role]),
)

const ESCALATION_ROLE_FOR: Record<string, string> = Object.fromEntries(
  DEPARTMENTS.map((department) => [department.id, department.escalatesTo]),
)

function roleName(roleId: string): string {
  return roleById(roleId)?.name ?? roleId
}

function departmentName(id: string): string {
  return departmentById(id)?.name ?? id
}

function stageIndex(id: string): number {
  return STAGES.findIndex((stage) => stage.id === id)
}

export class Orchestrator {
  state: SimState
  private queue: PendingEvent[] = []

  constructor(state: SimState) {
    this.state = state
  }

  // ---------------------------------------------------------------- time and setup

  now(): number {
    return this.state.clock
  }

  setRunning(running: boolean): void {
    this.state.running = running
    this.audit('simulation', running ? 'Simulation resumed' : 'Simulation paused', running ? 'Clock running' : 'Clock stopped by the operator', {})
  }

  setSpeed(speed: number): void {
    this.state.speed = Math.max(1, Math.min(5, Math.round(speed)))
    this.audit('simulation', `Simulation speed ${this.state.speed}x`, `${this.state.tickSeconds * this.state.speed} simulated seconds per tick`, {})
  }

  tick(): void {
    this.state.ticks += 1
    this.state.clock += this.state.tickSeconds * this.state.speed
    this.runDueTimers()
    this.checkSla()
    this.drain()
  }

  step(): void {
    this.state.running = false
    this.tick()
  }

  reset(): void {
    const role = this.state.role
    const speed = this.state.speed
    this.state = emptyState()
    this.state.role = role
    this.state.speed = speed
    this.queue = []
    this.audit('simulation', 'Simulation reset', 'All cases, tasks and audit records cleared', {})
  }

  runTraumaScenario(kind: 'primary' | 'second' = 'primary'): ClinicalCase {
    const existing = this.state.cases.find(
      (entry) => entry.scenario === kind && entry.status !== 'closed' && entry.status !== 'stabilised',
    )
    if (existing) {
      this.state.running = true
      return existing
    }
    const spec = CASE_SPECS[kind]
    const created = this.createCase(spec, kind)
    this.state.running = true
    this.dispatch('incident.created', created.id, `${created.code}: ${spec.incidentSummary}`)
    this.drain()
    return created
  }

  private createCase(spec: CaseSpec, scenario: 'primary' | 'second'): ClinicalCase {
    this.state.caseSeq += 1
    const created: ClinicalCase = {
      id: `C${this.state.caseSeq}`,
      code: `MT-${1041 + this.state.caseSeq}`,
      scenario,
      patientName: spec.patientName,
      age: spec.age,
      sex: spec.sex,
      incidentSummary: spec.incidentSummary,
      location: spec.location,
      mechanism: spec.mechanism,
      casualties: spec.casualties,
      stage: 'emergency-call',
      stageIndex: stageIndex('emergency-call'),
      status: 'incoming',
      priority: spec.priority,
      etaSeconds: spec.etaSeconds,
      dispatchedAt: null,
      sceneAt: null,
      prealertAt: null,
      eta: null,
      arrivedAt: null,
      theatreAt: null,
      icuAt: null,
      vitals: { ...spec.vitals },
      injuries: [...spec.injuries],
      clinicalNotes: spec.clinicalNotes,
      operationalSummary: spec.operationalSummary,
      plan: spec.plan,
      destination: 'Emergency department, resuscitation',
      surgicalDecision: 'none',
      theatreId: null,
      icuBedId: null,
      flags: [],
    }
    this.state.cases.push(created)
    this.audit('case.created', `${created.code} created`, spec.incidentSummary, { caseId: created.id, actor: 'Emergency Call Centre', role: 'calltaker' })
    return created
  }

  private caseById(id: string | null): ClinicalCase | undefined {
    if (!id) return undefined
    return this.state.cases.find((entry) => entry.id === id)
  }

  private stage(c: ClinicalCase, stage: string): void {
    if (c.stage === stage) return
    c.stage = stage
    c.stageIndex = stageIndex(stage)
    if (stage === 'arrival') c.status = 'active'
    this.audit('case.stage', `${c.code} reached ${STAGES.find((entry) => entry.id === stage)?.name ?? stage}`, c.plan, {
      caseId: c.id,
      department: null,
    })
  }

  // ---------------------------------------------------------------- events

  private dispatch(name: string, caseId: string | null, detail: string): void {
    this.record(name, caseId, detail)
    this.queue.push({ name, caseId, detail })
  }

  private record(name: string, caseId: string | null, detail: string): OperationalEvent {
    this.state.eventSeq += 1
    const reached = DEPARTMENTS.filter((department) => department.triggers.includes(name)).map((department) => ({
      department: department.id,
      reason: `${department.name} routes ${name}`,
    }))
    const event: OperationalEvent = {
      seq: this.state.eventSeq,
      at: this.state.clock,
      name,
      caseId,
      detail,
      reached,
    }
    this.state.events.push(event)
    if (this.state.events.length > 400) this.state.events.splice(0, this.state.events.length - 400)
    return event
  }

  private drain(): void {
    let guard = 0
    while (this.queue.length > 0 && guard < 400) {
      guard += 1
      const next = this.queue.shift()
      if (!next) break
      this.handleEvent(next)
    }
  }

  private handleEvent(event: PendingEvent): void {
    const c = this.caseById(event.caseId)
    switch (event.name) {
      case 'incident.created': {
        if (!c) return
        this.addTask({
          caseId: c.id,
          department: 'emergency-call',
          job: 'confirm-incident',
          title: 'Confirm incident record and access',
          detail: `${c.code}: ${c.incidentSummary}. Location checked with the caller, access route passed to dispatch.`,
          notifySummary: `Incident record for ${c.code} awaiting confirmation`,
          duration: 60,
          dueIn: 120,
        })
        this.addTask({
          caseId: c.id,
          department: 'dispatch',
          job: 'assign-ambulance',
          title: 'Assign ambulance and crew',
          detail: `Nearest advanced crew to ${c.location}. Confirm skill mix and the response clock.`,
          notifySummary: `Assign the nearest crew to ${c.code}`,
          duration: 90,
          dueIn: 180,
          onCompleteEvent: 'ambulance.assigned',
          requires: { kind: 'crew', label: 'Ambulance crew' },
        })
        return
      }
      case 'ambulance.assigned': {
        if (!c) return
        c.dispatchedAt = this.now()
        this.stage(c, 'dispatch')
        this.addTask({
          caseId: c.id,
          department: 'paramedics',
          job: 'respond-scene',
          title: 'Respond to scene and begin assessment',
          detail: `Proceed to ${c.location}. Scene safety, mechanism and casualty count to be confirmed on arrival.`,
          notifySummary: `Crew en route to ${c.code}`,
          duration: 300,
          dueIn: 420,
          onCompleteEvent: 'scene.arrived',
        })
        this.addTask({
          caseId: c.id,
          department: 'dispatch',
          job: 'track-response',
          title: 'Track response and estimated arrival',
          detail: 'Monitor the response clock and tell the receiving hospital if the ETA moves by more than five minutes.',
          notifySummary: `Response clock for ${c.code}`,
          duration: 420,
          dueIn: 600,
        })
        return
      }
      case 'scene.arrived': {
        if (!c) return
        c.sceneAt = this.now()
        this.stage(c, 'scene')
        this.addTask({
          caseId: c.id,
          department: 'paramedics',
          job: 'scene-assessment',
          title: 'Scene assessment and observations',
          detail: 'Primary survey, observations, suspected injuries, treatment given and the transport decision.',
          notifySummary: `Clinical assessment of ${c.code} in progress`,
          duration: 240,
          dueIn: 300,
          sensitive: true,
          onCompleteEvent: 'assessment.recorded',
        })
        return
      }
      case 'assessment.recorded': {
        if (!c) return
        c.vitals = { hr: 126, bp: '90/56', spo2: 93, gcs: 14 }
        this.requestDecision({
          caseId: c.id,
          title: 'Major trauma pre-alert indicated',
          question: `Send an authorised major trauma pre-alert for ${c.code} to Northbridge Regional Trauma Centre?`,
          clinical: true,
          options: [
            { id: 'send', label: 'Send major trauma pre-alert', consequence: 'Trauma team, resuscitation, radiology, laboratory, blood bank and theatre coordination begin preparation before arrival.' },
            { id: 'decline', label: 'No pre-alert: transport without activation', consequence: 'The hospital receives no advance notice. Preparation starts only on arrival.' },
          ],
          authorisedRoles: ['paramedic'],
          dueIn: 180,
          unlocks: 'prealert.authorised',
          optionEvents: { send: 'prealert.authorised', decline: 'prealert.declined' },
          department: 'paramedics',
          taskTitle: 'Authorise major trauma pre-alert',
          taskDetail: 'Confirm the receiving hospital, severity and estimated arrival, then transmit the pre-alert.',
          sensitive: true,
        })
        return
      }
      case 'prealert.authorised': {
        if (!c) return
        c.prealertAt = this.now()
        c.eta = this.now() + c.etaSeconds
        c.status = 'incoming'
        this.stage(c, 'hospital-prep')
        this.schedule('patient-arrival', c.eta, c.id, `${c.code} expected at the emergency department`)
        this.dispatch('prealert.sent', c.id, `Major trauma pre-alert transmitted for ${c.code}, ETA ${formatMinutes(c.eta - this.now())}`)
        return
      }
      case 'prealert.declined': {
        if (!c) return
        this.stage(c, 'en-route')
        c.eta = this.now() + 600
        this.schedule('patient-arrival', c.eta, c.id, `${c.code} arriving without pre-alert`)
        this.audit('decision.declined', 'Pre-alert declined', 'Patient will arrive without advance activation', { caseId: c.id, actor: 'Paramedic Crew Lead', role: 'paramedic' })
        return
      }
      case 'prealert.sent': {
        if (!c) return
        const team = this.parallelPreparation(c)
        this.record('coordination.parallel', c.id, `${team.length} departments preparing in parallel for ${c.code}`)
        this.stage(c, 'en-route')
        return
      }
      case 'patient.arrived': {
        if (!c) return
        c.arrivedAt = this.now()
        c.eta = 0
        c.status = 'active'
        this.stage(c, 'arrival')
        this.reserve('RESUS-2', c.id, 'Trauma resuscitation bay in use')
        this.claimSpecific('RESUS-2', c, 'Resuscitation bay')
        this.createHandover(c, 'paramedics', 'resus', 'Structured trauma handover: pre-hospital to resuscitation team')
        const registration = this.addTask({
          caseId: c.id,
          department: 'ae-reception',
          job: 'registration',
          title: 'Fast-track registration',
          detail: 'Register against the incident record and attach the major trauma pathway, without delaying resuscitation.',
          notifySummary: `Register ${c.code} on the major trauma pathway`,
          duration: 60,
          dueIn: 180,
        })
        const handoverTask = this.addTask({
          caseId: c.id,
          department: 'resus',
          job: 'receive-handover',
          title: 'Receive structured handover',
          detail: 'Receive the pre-hospital handover: mechanism, observations, injuries, treatment and ETA.',
          notifySummary: `Handover of ${c.code} awaiting acceptance`,
          duration: 120,
          dueIn: 240,
          kind: 'handover',
          onCompleteEvent: 'handover.accepted',
        })
        this.addTask({
          caseId: c.id,
          department: 'triage',
          job: 'direct-to-resus',
          title: 'Confirm direct-to-resuscitation pathway',
          detail: 'Confirm the patient is on the resuscitation pathway rather than ordinary streaming.',
          notifySummary: `Confirm the pathway for ${c.code}`,
          duration: 60,
          dueIn: 180,
          dependsOn: [handoverTask.id],
        })
        this.addTask({
          caseId: c.id,
          department: 'trauma-team',
          job: 'primary-survey',
          title: 'Primary survey and stabilisation',
          detail: 'Airway, breathing, circulation, disability and exposure. Stabilise for imaging and record the findings.',
          notifySummary: `Trauma team assessment of ${c.code}`,
          duration: 300,
          dueIn: 420,
          sensitive: true,
          dependsOn: [handoverTask.id, registration.id],
          onCompleteEvent: 'primary.survey.complete',
        })
        return
      }
      case 'handover.accepted': {
        if (!c) return
        this.stage(c, 'resus')
        this.record('handover.complete', c.id, `Pre-hospital handover accepted for ${c.code}`)
        return
      }
      case 'primary.survey.complete': {
        if (!c) return
        this.stage(c, 'imaging')
        this.requestDecision({
          caseId: c.id,
          title: 'Authorise trauma CT',
          question: `Authorise whole-body trauma CT for ${c.code}, with the portering and radiology team standing by?`,
          clinical: true,
          options: [
            { id: 'authorise', label: 'Authorise trauma CT now', consequence: 'Radiology scans on a trauma protocol; portering transfers the patient; findings go back to the trauma team.' },
            { id: 'defer', label: 'Defer imaging and continue resuscitation', consequence: 'No CT slot is taken. The trauma team must reassess before any surgical decision.' },
          ],
          authorisedRoles: ['trauma-leader'],
          dueIn: 240,
          unlocks: 'ct.requested',
          optionEvents: { authorise: 'ct.requested', defer: 'imaging.deferred' },
          department: 'trauma-team',
          taskTitle: 'Authorise imaging',
          taskDetail: 'Confirm imaging is clinically indicated and authorise the request.',
          sensitive: true,
        })
        this.requestDecision({
          caseId: c.id,
          title: 'Authorise blood component request',
          question: `Authorise emergency blood components for ${c.code}: 4 units red cells and 2 units plasma?`,
          clinical: true,
          options: [
            { id: 'authorise', label: 'Authorise 4 units and plasma', consequence: 'Blood bank cross-matches and reserves units for resuscitation and theatre.' },
            { id: 'decline', label: 'Hold blood until clinically indicated', consequence: 'Blood bank keeps O negative on standby only. Theatre preparation will wait on release.' },
          ],
          authorisedRoles: ['trauma-leader'],
          dueIn: 240,
          unlocks: 'blood.requested',
          optionEvents: { authorise: 'blood.requested', decline: 'blood.deferred' },
          department: 'trauma-team',
          taskTitle: 'Authorise blood products',
          taskDetail: 'Authorise the request with urgency and component detail.',
          sensitive: true,
        })
        return
      }
      case 'ct.requested': {
        if (!c) return
        const porter = this.addTask({
          caseId: c.id,
          department: 'portering',
          job: 'ct-transfer',
          title: 'Transfer to CT and return',
          detail: `Transfer ${c.code} from the resuscitation bay to imaging and back. Monitoring and the trauma team travel with the patient.`,
          notifySummary: `CT transfer task for ${c.code}`,
          duration: 180,
          dueIn: 300,
          requires: { kind: 'porter', label: 'Porter team' },
          kind: 'transport',
        })
        this.addTask({
          caseId: c.id,
          department: 'radiology',
          job: 'trauma-ct',
          title: 'Perform trauma CT',
          detail: 'Trauma protocol: head, cervical spine, chest, abdomen and pelvis. Report critical findings to the trauma team immediately.',
          notifySummary: `Trauma CT for ${c.code}`,
          duration: 420,
          dueIn: 600,
          sensitive: true,
          dependsOn: [porter.id, this.findTask(c.id, 'radiology', 'reserve-ct')?.id].filter((id): id is string => Boolean(id)),
          requires: { kind: 'ct', label: 'CT scanner' },
          onCompleteEvent: 'imaging.complete',
        })
        this.addTask({
          caseId: c.id,
          department: 'laboratory',
          job: 'urgent-panel',
          title: 'Run urgent trauma panel',
          detail: 'Blood gas, full blood count, coagulation and cross-match sample. Report critical values by telephone and on the board.',
          notifySummary: `Urgent laboratory panel for ${c.code}`,
          duration: 240,
          dueIn: 420,
          onCompleteEvent: 'labs.reported',
        })
        return
      }
      case 'imaging.deferred': {
        if (!c) return
        c.flags.push('Imaging deferred by the trauma team')
        this.audit('clinical.hold', 'Imaging deferred', 'The case waits for a clinical reassessment', { caseId: c.id, role: 'trauma-leader', department: 'trauma-team' })
        return
      }
      case 'blood.deferred': {
        if (!c) return
        c.flags.push('Blood held pending clinical indication')
        return
      }
      case 'blood.requested': {
        if (!c) return
        this.addTask({
          caseId: c.id,
          department: 'blood-bank',
          job: 'crossmatch-theatre',
          title: 'Cross-match and reserve 4 units',
          detail: 'Cross-match 4 units of red cells and 2 units of plasma, reserved for resuscitation and theatre.',
          notifySummary: `Blood reserve for ${c.code}, 4 units`,
          duration: 300,
          dueIn: 420,
          requires: { id: 'BLOOD-O-NEG', kind: 'blood', label: 'Red cell units' },
          onCompleteEvent: 'blood.ready',
        })
        return
      }
      case 'laboratory.ready':
      case 'labs.reported': {
        if (!c) return
        this.record('lab.reported', c.id, `Laboratory results reported for ${c.code}`)
        return
      }
      case 'imaging.complete': {
        if (!c) return
        this.stage(c, 'surgery-decision')
        c.plan = 'CT shows suspected splenic laceration with pelvic bleeding; surgery indicated'
        c.destination = 'Theatre, then intensive care'
        this.release('CT-1', 'Available after trauma CT')
        this.release('CT-2', 'Available after trauma CT')
        this.requestDecision({
          caseId: c.id,
          title: 'Emergency surgery indicated',
          question: `The trauma CT shows active bleeding. Authorise emergency laparotomy for ${c.code}?`,
          clinical: true,
          options: [
            { id: 'authorise', label: 'Authorise emergency laparotomy', consequence: 'Theatre, anaesthetics, blood bank, pharmacy, ICU and portering begin preparation in parallel.' },
            { id: 'hold', label: 'Continue resuscitation and reassess', consequence: 'No surgical booking is made. The team reassesses with repeat observations.' },
          ],
          authorisedRoles: ['trauma-leader', 'surgeon'],
          dueIn: 300,
          unlocks: 'surgery.authorised',
          optionEvents: { authorise: 'surgery.authorised', hold: 'surgery.deferred' },
          department: 'trauma-team',
          taskTitle: 'Clinical decision: emergency surgery',
          taskDetail: 'Review the imaging and the observations, then authorise or hold the surgical plan.',
          sensitive: true,
        })
        return
      }
      case 'surgery.deferred': {
        if (!c) return
        c.surgicalDecision = 'indicated'
        c.flags.push('Surgery indicated but not authorised')
        this.audit('clinical.hold', 'Surgery not authorised', 'The case stays in the emergency department for reassessment', { caseId: c.id, role: 'trauma-leader', department: 'trauma-team' })
        return
      }
      case 'surgery.authorised': {
        if (!c) return
        c.surgicalDecision = 'authorised'
        this.stage(c, 'theatre-prep')
        c.destination = 'Theatre 2, then intensive care'
        this.parallelTheatrePreparation(c)
        return
      }
      case 'operative.plan.confirmed': {
        if (!c) return
        this.record('plan.confirmed', c.id, `Operative plan confirmed for ${c.code}`)
        return
      }
      case 'theatre.assigned': {
        if (!c) return
        this.record('theatre.allocated', c.id, `${c.theatreId ? this.resourceName(c.theatreId) : 'Theatre'} allocated to ${c.code}`)
        return
      }
      case 'icu.reserved': {
        if (!c) return
        this.record('icu.reserved', c.id, `ICU bed reserved for ${c.code}`)
        return
      }
      case 'safety.check.complete': {
        if (!c) return
        this.record('safety.check', c.id, `Surgical safety checklist complete for ${c.code}`)
        return
      }
      case 'transfer.to.theatre': {
        if (!c) return
        this.stage(c, 'to-theatre')
        this.release('RESUS-2', 'Awaiting cleaning after transfer to theatre')
        this.addTask({
          caseId: c.id,
          department: 'portering',
          job: 'transfer-theatre',
          title: 'Transfer patient to theatre',
          detail: `Move ${c.code} to ${c.theatreId ? this.resourceName(c.theatreId) : 'the allocated theatre'} with anaesthetic support.`,
          notifySummary: `Theatre transfer for ${c.code}`,
          duration: 240,
          dueIn: 360,
          kind: 'transport',
          requires: { kind: 'porter', label: 'Porter team' },
          onCompleteEvent: 'theatre.arrived',
        })
        return
      }
      case 'theatre.arrived': {
        if (!c) return
        c.theatreAt = this.now()
        this.stage(c, 'operation')
        if (c.theatreId) this.occupy(c.theatreId, c.id, 'Patient in theatre')
        this.addTask({
          caseId: c.id,
          department: 'surgical-team',
          job: 'operate',
          title: 'Perform emergency laparotomy',
          detail: 'Damage control laparotomy with pelvic packing. Record the operative findings and the endpoints of resuscitation.',
          notifySummary: `Operation in progress for ${c.code}`,
          duration: 1800,
          dueIn: 2400,
          sensitive: true,
          onCompleteEvent: 'operation.complete',
        })
        this.addTask({
          caseId: c.id,
          department: 'anaesthetics',
          job: 'maintain-anaesthesia',
          title: 'Maintain anaesthesia and blood products',
          detail: 'Maintain anaesthesia, monitor physiology and give blood products as authorised.',
          notifySummary: `Anaesthetic support during operation for ${c.code}`,
          duration: 1800,
          dueIn: 2400,
          sensitive: true,
        })
        this.addTask({
          caseId: c.id,
          department: 'theatre-nursing',
          job: 'operative-record',
          title: 'Record operative milestones and counts',
          detail: 'Record the start time, instrument and swab counts, and inform theatre coordination at the close.',
          notifySummary: `Operative record for ${c.code}`,
          duration: 1800,
          dueIn: 2400,
        })
        this.addTask({
          caseId: c.id,
          department: 'icu',
          job: 'prepare-bed-space',
          title: 'Prepare ICU bed space and ventilator',
          detail: 'Prepare the reserved bed space: ventilator checked, monitoring, infusion pumps, blood products and a receiving nurse.',
          notifySummary: `ICU bed space preparation for ${c.code}`,
          duration: 600,
          dueIn: 1200,
          onCompleteEvent: 'icu.bedspace.ready',
        })
        this.addTask({
          caseId: c.id,
          department: 'icu-nursing',
          job: 'allocate-nurse',
          title: 'Allocate the receiving ICU nurse',
          detail: 'Allocate the receiving nurse and confirm the skill mix for a ventilated postoperative patient.',
          notifySummary: `ICU nurse allocation for ${c.code}`,
          duration: 300,
          dueIn: 900,
        })
        return
      }
      case 'operation.complete': {
        if (!c) return
        this.stage(c, 'icu-prep')
        this.requestDecision({
          caseId: c.id,
          title: 'Confirm postoperative destination',
          question: `Surgery is complete. Confirm the postoperative destination for ${c.code}.`,
          clinical: true,
          options: [
            { id: 'icu', label: 'Admit to intensive care', consequence: 'ICU accepts the patient, portering is requested and the theatre is released after transfer.' },
            { id: 'sau', label: 'Admit to the surgical assessment unit', consequence: 'The ward accepts the patient; ICU capacity is not used. Only permitted if the clinical team judges ICU is not required.' },
          ],
          authorisedRoles: ['surgeon', 'icu-coordinator'],
          dueIn: 300,
          unlocks: 'icu.admission.confirmed',
          optionEvents: { icu: 'icu.admission.confirmed', sau: 'sau.admission.confirmed' },
          department: 'surgical-team',
          taskTitle: 'Confirm postoperative destination',
          taskDetail: 'Decide the destination with the ICU coordinator and record the clinical reason.',
          sensitive: true,
        })
        return
      }
      case 'icu.admission.confirmed': {
        if (!c) return
        this.stage(c, 'icu-admission')
        c.destination = 'Intensive care'
        this.addTask({
          caseId: c.id,
          department: 'icu',
          job: 'accept-admission',
          title: 'Accept ICU admission',
          detail: 'Confirm the bed, the staffing and the equipment, and accept the patient from theatre.',
          notifySummary: `ICU acceptance of ${c.code}`,
          duration: 120,
          dueIn: 300,
          onCompleteEvent: 'icu.accepted',
        })
        this.addTask({
          caseId: c.id,
          department: 'portering',
          job: 'transfer-icu',
          title: 'Transfer patient to intensive care',
          detail: 'Transfer from theatre to ICU with the anaesthetist and the receiving ICU nurse. Record pickup and arrival.',
          notifySummary: `ICU transfer for ${c.code}`,
          duration: 300,
          dueIn: 480,
          kind: 'transport',
          requires: { kind: 'porter', label: 'Porter team' },
          onCompleteEvent: 'icu.arrived',
        })
        return
      }
      case 'sau.admission.confirmed': {
        if (!c) return
        this.stage(c, 'icu-admission')
        c.destination = 'Surgical assessment unit'
        c.flags.push('ICU not required: direct ward admission')
        this.addTask({
          caseId: c.id,
          department: 'sau',
          job: 'accept-admission',
          title: 'Accept ward admission',
          detail: 'Confirm the ward bed, monitoring capability and receiving nurse for the postoperative patient.',
          notifySummary: `Ward acceptance of ${c.code}`,
          duration: 180,
          dueIn: 420,
          onCompleteEvent: 'sau.accepted',
        })
        this.addTask({
          caseId: c.id,
          department: 'portering',
          job: 'transfer-ward',
          title: 'Transfer patient to the ward',
          detail: 'Transfer from theatre to the surgical assessment unit with the receiving nurse.',
          notifySummary: `Ward transfer for ${c.code}`,
          duration: 300,
          dueIn: 480,
          kind: 'transport',
          requires: { kind: 'porter', label: 'Porter team' },
          onCompleteEvent: 'sau.arrived',
        })
        return
      }
      case 'icu.accepted': {
        if (!c) return
        this.record('icu.accepted', c.id, `ICU accepted ${c.code}`)
        return
      }
      case 'icu.bedspace.ready': {
        if (!c) return
        this.record('icu.bedspace', c.id, `ICU bed space ready for ${c.code}`)
        return
      }
      case 'icu.arrived': {
        if (!c) return
        this.stage(c, 'icu-admission')
        if (c.icuBedId) this.occupy(c.icuBedId, c.id, 'Patient admitted to ICU')
        this.releaseCaseResources(c, 'theatre')
        this.createHandover(c, 'theatre', 'icu', 'Structured handover: theatre to intensive care')
        this.addTask({
          caseId: c.id,
          department: 'icu-nursing',
          job: 'accept-handover',
          title: 'ICU handover acceptance',
          detail: 'Accept the structured handover and confirm the monitoring and ventilation plan.',
          notifySummary: `ICU handover for ${c.code}`,
          duration: 120,
          dueIn: 300,
          kind: 'handover',
          onCompleteEvent: 'icu.admitted',
        })
        return
      }
      case 'icu.admitted': {
        if (!c) return
        c.icuAt = this.now()
        c.status = 'stabilised'
        this.stage(c, 'icu-admission')
        this.releaseCaseResources(c, 'porter')
        this.addTask({
          caseId: c.id,
          department: 'icu',
          job: 'stabilise',
          title: 'Stabilise and plan the next care phase',
          detail: 'Stabilise physiology, plan the next care phase and hand the case to the intensive care team.',
          notifySummary: `ICU stabilisation of ${c.code}`,
          duration: 600,
          dueIn: 900,
          sensitive: true,
          onCompleteEvent: 'case.stabilised',
        })
        this.addTask({
          caseId: c.id,
          department: 'family-liaison',
          job: 'family-contact',
          title: 'Brief the family',
          detail: 'Contact the family with the operational status once identity and permission are confirmed. No clinical detail beyond what the clinical team authorises.',
          notifySummary: `Family contact for ${c.code}`,
          duration: 600,
          dueIn: 1200,
        })
        return
      }
      case 'case.stabilised': {
        if (!c) return
        c.status = 'stabilised'
        this.stage(c, 'stabilised')
        this.releaseCaseResources(c, 'all')
        this.record('case.complete', c.id, `${c.code} is stable in intensive care; the operational pathway is complete`)
        return
      }
      case 'sau.accepted': {
        if (!c) return
        this.record('sau.accepted', c.id, `The surgical assessment unit accepted ${c.code}`)
        return
      }
      case 'sau.arrived': {
        if (!c) return
        c.status = 'stabilised'
        this.stage(c, 'stabilised')
        this.releaseCaseResources(c, 'all')
        this.record('case.complete', c.id, `${c.code} admitted to the ward; the operative pathway is complete`)
        return
      }
      case 'eta.updated': {
        if (!c) return
        this.clearTimers('patient-arrival', c.id)
        if (c.eta !== null && c.eta > this.now()) this.schedule('patient-arrival', c.eta, c.id, `${c.code} revised arrival`)
        this.addTask({
          caseId: c.id,
          department: 'resus',
          job: 'retime-preparation',
          title: 'Re-time preparation for the revised ETA',
          detail: 'Re-plan the resuscitation and trauma team readiness for the revised arrival time.',
          notifySummary: `Preparation re-timed for ${c.code}`,
          duration: 120,
          dueIn: 300,
        })
        return
      }
      case 'plan.change': {
        if (!c) return
        this.requestDecision({
          caseId: c.id,
          title: 'Patient deterioration: revise the plan',
          question: `The patient has deteriorated. Authorise the revised operative plan and 2 additional units of blood for ${c.code}?`,
          clinical: true,
          options: [
            { id: 'authorise', label: 'Authorise the revised plan', consequence: 'A specialist attends, theatre is informed of the extended procedure and the blood bank releases 2 more units.' },
            { id: 'decline', label: 'Keep the current plan', consequence: 'Downstream teams keep their current preparation; the change is recorded in the audit trail.' },
          ],
          authorisedRoles: ['trauma-leader', 'surgeon'],
          dueIn: 240,
          unlocks: 'plan.change.approved',
          optionEvents: { authorise: 'plan.change.approved', decline: 'plan.change.declined' },
          department: 'trauma-team',
          taskTitle: 'Revise the plan after deterioration',
          taskDetail: 'Review the revised physiology and authorise the changed operative plan.',
          sensitive: true,
        })
        return
      }
      case 'plan.change.approved': {
        if (!c) return
        c.priority = 'P1'
        c.injuries.push('New: suspected retroperitoneal bleeding')
        c.flags.push('Plan revised: extended procedure with specialist support')
        c.plan = 'Extended laparotomy with vascular specialist support'
        this.addTask({
          caseId: c.id,
          department: 'specialist-support',
          job: 'revised-plan-advice',
          title: 'Urgent specialist advice and theatre attendance',
          detail: 'Provide vascular advice and attend theatre for the extended procedure.',
          notifySummary: `Specialist support for ${c.code}`,
          duration: 300,
          dueIn: 600,
          sensitive: true,
        })
        this.addTask({
          caseId: c.id,
          department: 'blood-bank',
          job: 'additional-units',
          title: 'Issue 2 additional units',
          detail: 'Release 2 more units for the extended procedure.',
          notifySummary: `Additional 2 units for ${c.code}`,
          duration: 240,
          dueIn: 420,
          requires: { id: 'BLOOD-O-NEG', kind: 'blood', label: 'Red cell units' },
        })
        this.addTask({
          caseId: c.id,
          department: 'theatre-coord',
          job: 'revised-theatre',
          title: 'Extend the theatre booking',
          detail: 'Inform the theatre team of the extended procedure and protect the theatre and staff for the longer case.',
          notifySummary: `Extended theatre booking for ${c.code}`,
          duration: 180,
          dueIn: 420,
        })
        this.addTask({
          caseId: c.id,
          department: 'icu',
          job: 'revised-icu',
          title: 'Re-plan ICU for a longer procedure',
          detail: 'Re-plan the ICU bed, staffing and equipment for a longer and higher-risk postoperative course.',
          notifySummary: `Revised ICU plan for ${c.code}`,
          duration: 240,
          dueIn: 600,
        })
        return
      }
      case 'plan.change.declined': {
        if (!c) return
        c.flags.push('Deterioration recorded; the plan was not revised')
        return
      }
      default:
        return
    }
  }

  // ---------------------------------------------------------------- tasks

  private addTask(spec: TaskSpec): Task {
    const key = `${spec.caseId ?? 'hospital'}:${spec.department}:${slug(spec.job)}`
    const existing = this.state.tasks.find((task) => task.key === key)
    if (existing) return existing
    this.state.taskSeq += 1
    const role = DEPARTMENT_ROLE[spec.department] ?? 'commander'
    const task: Task = {
      id: `T${this.state.taskSeq}`,
      key,
      caseId: spec.caseId,
      department: spec.department,
      title: spec.title,
      detail: spec.detail,
      notifySummary: spec.notifySummary,
      priority: spec.priority ?? 'P1',
      kind: spec.kind ?? 'prep',
      status: 'pending',
      ownerRole: role,
      duration: spec.duration,
      createdAt: this.now(),
      dueAt: this.now() + (spec.dueIn ?? Math.max(180, spec.duration)),
      ackDueAt: this.now() + (spec.ackIn ?? 120),
      notifiedAt: null,
      acknowledgedAt: null,
      startedAt: null,
      completedAt: null,
      dependsOn: spec.dependsOn ?? [],
      requires: spec.requires ?? null,
      resourceId: null,
      blockedReason: null,
      escalationId: null,
      decisionId: spec.decisionId ?? null,
      onCompleteEvent: spec.onCompleteEvent ?? null,
      auto: spec.auto ?? true,
      suppressAutoAck: false,
      sensitive: spec.sensitive ?? false,
      history: [],
    }
    this.state.tasks.push(task)
    this.audit('task.created', `${task.title}`, `${departmentName(spec.department)}: ${task.detail}`, {
      caseId: task.caseId,
      department: spec.department,
      actor: 'Orchestrator',
    })
    this.notifyTask(task)
    return task
  }

  private notifyTask(task: Task): void {
    this.state.notificationSeq += 1
    const notification: Notification = {
      id: `N${this.state.notificationSeq}`,
      taskId: task.id,
      caseId: task.caseId,
      department: task.department,
      role: task.ownerRole,
      subject: task.notifySummary,
      body:
        task.sensitive && !(roleById(task.ownerRole)?.clinical ?? false)
          ? task.notifySummary
          : task.kind === 'decision'
            ? `${task.title}: a decision is required.`
            : `${task.title}. Due ${formatWall(task.dueAt)}.`,
      sentAt: this.now(),
      deliveredAt: this.now(),
      acknowledgedAt: null,
      state: 'delivered',
    }
    this.state.notifications.push(notification)
    task.status = 'notified'
    task.notifiedAt = this.now()
    task.history.push({ at: this.now(), status: 'notified', actor: 'Orchestrator', note: `Notification delivered to ${departmentName(task.department)}` })
    if (task.auto && this.state.departmentAutomation && !task.suppressAutoAck) {
      const delay = Math.max(20, Math.round(task.duration * 0.06) + 20)
      this.schedule('auto-ack', this.now() + delay, task.id, 'Synthetic department acknowledgement')
    }
  }

  private findTask(caseId: string, department: string, job: string): Task | undefined {
    const key = `${caseId}:${department}:${slug(job)}`
    return this.state.tasks.find((task) => task.key === key)
  }

  private taskById(id: string): Task | undefined {
    return this.state.tasks.find((task) => task.id === id)
  }

  private notificationFor(taskId: string): Notification | undefined {
    return this.state.notifications.find((notification) => notification.taskId === taskId)
  }

  acknowledgeTask(task: Task, actor: string, note: string): void {
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'in_progress' || task.status === 'blocked') return
    this.clearTimers('auto-ack', task.id)
    task.status = 'acknowledged'
    task.acknowledgedAt = this.now()
    task.history.push({ at: this.now(), status: 'acknowledged', actor, note })
    const notification = this.notificationFor(task.id)
    if (notification) {
      notification.acknowledgedAt = this.now()
      notification.state = 'acknowledged'
    }
    this.audit('task.acknowledged', task.title, `${actor} acknowledged in ${departmentName(task.department)}`, {
      caseId: task.caseId,
      department: task.department,
      actor,
      role: task.ownerRole,
    })
    if (task.escalationId) {
      const escalation = this.state.escalations.find((entry) => entry.id === task.escalationId)
      if (escalation && escalation.status !== 'resolved' && escalation.trigger === 'unacknowledged') {
        escalation.status = 'resolved'
        escalation.resolvedAt = this.now()
        escalation.resolvedBy = actor
        escalation.resolution = 'The notification was acknowledged'
        this.record('escalation.resolved', task.caseId, `${task.title}: acknowledgement received; escalation closed`)
      }
    }
    this.startTask(task, actor)
  }

  private startTask(task: Task, actor: string): void {
    if (this.state.unavailableRoles.includes(task.ownerRole)) {
      this.blockTask(task, `${roleName(task.ownerRole)} unavailable`, null)
      return
    }
    if (task.requires) {
      const resource = this.claimResource(task.requires, task.caseId)
      if (!resource) {
        this.blockTask(task, `No ${task.requires.label.toLowerCase()} available`, task.requires)
        return
      }
      task.resourceId = resource.id
      if (resource.kind === 'theatre' && task.caseId) {
        const c = this.caseById(task.caseId)
        if (c) c.theatreId = resource.id
      }
      if (resource.kind === 'icu-bed' && task.caseId) {
        const c = this.caseById(task.caseId)
        if (c) c.icuBedId = resource.id
      }
    }
    const unmet = task.dependsOn.filter((id) => this.taskById(id)?.status !== 'completed')
    if (unmet.length > 0) {
      // Acknowledged, but not started: the dependency gate has not opened, so no work (and no resource) begins yet.
      task.status = 'acknowledged'
      task.blockedReason = `Waiting for ${unmet.map((id) => this.taskById(id)?.title ?? id).join(', ')}`
      task.history.push({ at: this.now(), status: 'acknowledged', actor, note: task.blockedReason })
      this.audit('task.dependency', task.title, task.blockedReason, { caseId: task.caseId, department: task.department, actor })
      return
    }
    task.status = 'in_progress'
    task.startedAt = this.now()
    task.blockedReason = null
    task.history.push({ at: this.now(), status: 'in_progress', actor, note: 'Preparation started' })
    this.audit('task.started', task.title, `In progress in ${departmentName(task.department)}`, {
      caseId: task.caseId,
      department: task.department,
      actor,
      role: task.ownerRole,
    })
    if (this.state.departmentAutomation) this.schedule('auto-complete', this.now() + task.duration, task.id, 'Synthetic preparation completes')
  }

  completeTask(task: Task, actor: string, auto: boolean): boolean {
    if (task.status === 'completed' || task.status === 'cancelled') return false
    this.clearTimers('auto-complete', task.id)
    const unmet = task.dependsOn.filter((id) => this.taskById(id)?.status !== 'completed')
    if (unmet.length > 0) {
      this.blockTask(task, `Blocked by dependency: ${unmet.map((id) => this.taskById(id)?.title ?? id).join(', ')}`, null)
      return false
    }
    if (this.state.unavailableRoles.includes(task.ownerRole) && !auto) {
      /* a person completing work is not stopped by a roster shortage: the action is real */
    }
    task.status = 'completed'
    task.completedAt = this.now()
    task.blockedReason = null
    task.history.push({ at: this.now(), status: 'completed', actor, note: auto ? 'Completed by the simulated department' : 'Completed by a person' })
    this.audit('task.completed', task.title, auto ? 'Completed by the simulated department' : `Completed by ${actor}`, {
      caseId: task.caseId,
      department: task.department,
      actor,
      role: task.ownerRole,
    })
    if (task.resourceId && task.requires && (task.requires.kind === 'porter' || task.requires.kind === 'supplies')) {
      this.release(task.resourceId, 'Released after use')
      task.resourceId = null
    }
    if (task.escalationId) {
      const escalation = this.state.escalations.find((entry) => entry.id === task.escalationId)
      if (escalation && escalation.status !== 'resolved' && escalation.trigger !== 'unacknowledged') {
        escalation.status = 'resolved'
        escalation.resolvedAt = this.now()
        escalation.resolvedBy = actor
        escalation.resolution = 'The task completed'
      }
    }
    for (const other of this.state.tasks) {
      if (other.status === 'blocked' && other.dependsOn.includes(task.id)) {
        const stillBlocked = other.dependsOn.some((id) => this.taskById(id)?.status !== 'completed')
        if (!stillBlocked) this.resumeTask(other, 'Dependency completed')
      } else if ((other.status === 'acknowledged' || other.status === 'in_progress') && other.blockedReason?.startsWith('Waiting for')) {
        const stillWaiting = other.dependsOn.some((id) => this.taskById(id)?.status !== 'completed')
        if (!stillWaiting) {
          other.status = 'in_progress'
          other.blockedReason = null
          other.startedAt = this.now()
          other.history.push({ at: this.now(), status: 'in_progress', actor: 'Orchestrator', note: 'Dependency completed; preparation started' })
          this.audit('task.started', other.title, 'The dependency gate opened and the work started', {
            caseId: other.caseId,
            department: other.department,
            actor: 'Orchestrator',
          })
          if (this.state.departmentAutomation) this.schedule('auto-complete', this.now() + other.duration, other.id, 'Unlocked preparation completes')
        }
      }
    }
    if (task.onCompleteEvent) this.dispatch(task.onCompleteEvent, task.caseId, `${task.title} completed in ${departmentName(task.department)}`)
    return true
  }

  private resumeTask(task: Task, note: string, delaySeconds?: number): void {
    this.clearTimers('auto-complete', task.id)
    const held = task.resourceId ? this.state.resources.find((entry) => entry.id === task.resourceId) : undefined
    const holdsResource = held !== undefined && held.state !== 'unavailable' && (held.caseId === null || held.caseId === task.caseId)
    if (task.requires && !holdsResource) {
      task.resourceId = null
      const resource = this.claimResource(task.requires, task.caseId)
      if (!resource) {
        this.blockTask(task, `Still no ${task.requires.label.toLowerCase()} available`, task.requires)
        return
      }
      task.resourceId = resource.id
      const owner = this.caseById(task.caseId)
      if (owner && resource.kind === 'theatre') owner.theatreId = resource.id
      if (owner && resource.kind === 'icu-bed') owner.icuBedId = resource.id
    }
    if (task.resourceId) {
      // A recovery can hand the task back a resource the incident had withdrawn: bind it to the case again.
      const bound = this.state.resources.find((entry) => entry.id === task.resourceId)
      if (bound && bound.kind !== 'blood') {
        if (bound.state === 'available' || bound.caseId === null) {
          bound.state = 'reserved'
          bound.caseId = task.caseId
          bound.since = this.now()
          bound.note = `Reserved for ${task.caseId ?? 'the hospital'}`
        }
        const owner = this.caseById(task.caseId)
        if (owner && bound.kind === 'theatre') owner.theatreId = bound.id
        if (owner && bound.kind === 'icu-bed') owner.icuBedId = bound.id
      }
    }
    const unmet = task.dependsOn.filter((id) => this.taskById(id)?.status !== 'completed')
    task.history.push({ at: this.now(), status: 'in_progress', actor: 'Orchestrator', note })
    this.audit('task.resumed', task.title, note, { caseId: task.caseId, department: task.department, actor: 'Orchestrator' })
    if (unmet.length > 0) {
      task.status = 'in_progress'
      task.blockedReason = `Waiting for ${unmet.map((id) => this.taskById(id)?.title ?? id).join(', ')}`
      task.history.push({ at: this.now(), status: 'in_progress', actor: 'Orchestrator', note: task.blockedReason })
      return
    }
    task.status = 'in_progress'
    task.blockedReason = null
    const wait = delaySeconds ?? Math.max(60, Math.round(task.duration * 0.3))
    if (this.state.departmentAutomation) {
      this.schedule('auto-complete', this.now() + wait, task.id, 'Recovery prepared')
    }
  }

  private blockTask(task: Task, reason: string, requirement: TaskRequirement | null): void {
    this.clearTimers('auto-complete', task.id)
    task.status = 'blocked'
    task.blockedReason = reason
    task.history.push({ at: this.now(), status: 'blocked', actor: 'Orchestrator', note: reason })
    this.audit('task.blocked', task.title, reason, { caseId: task.caseId, department: task.department, actor: 'Orchestrator' })
    const owner = ESCALATION_ROLE_FOR[task.department] ?? 'commander'
    const options = requirement ? recoveryOptions(requirement, task, this.state) : []
    const attempt = task.history.filter((entry) => entry.status === 'blocked').length
    const escalation = this.raiseEscalation({
      key: `blocked:${task.id}:${attempt}`,
      caseId: task.caseId,
      taskId: task.id,
      faultId: this.faultForRequirement(requirement),
      trigger: 'blocked',
      reason: `${task.title}: ${reason}`,
      impact: `Downstream work in ${this.downstreamText(task)} waits until this is resolved.`,
      department: task.department,
      ownerRole: owner,
      level: 1,
      options,
    })
    if (escalation) task.escalationId = escalation.id
  }

  private downstreamText(task: Task): string {
    const department = departmentById(task.department)
    if (!department) return 'the pathway'
    return department.downstream.map((id) => departmentName(id)).join(', ')
  }

  /** The active fault that made a resource missing, so its recovery is tracked against that fault. */
  private faultForRequirement(requirement: TaskRequirement | null): string | null {
    if (!requirement) return null
    const effectFor: Record<string, string> = {
      theatre: 'theatre-unavailable',
      ct: 'ct-unavailable',
      'icu-bed': 'icu-shortage',
      blood: 'blood-delay',
    }
    const fault = this.state.faults.find((entry) => entry.status !== 'resolved' && entry.kind === effectFor[requirement.kind])
    return fault?.id ?? null
  }

  taskAction(taskId: string, action: string, roleId: string): { ok: boolean; message: string } {
    const task = this.taskById(taskId)
    if (!task) return { ok: false, message: 'Task not found' }
    const role = roleById(roleId)
    if (!role) return { ok: false, message: 'Unknown role' }
    if (!role.permissions.includes('task.manage')) return { ok: false, message: `${role.name} may not manage tasks` }
    const actor = role.name
    switch (action) {
      case 'acknowledge':
        this.acknowledgeTask(task, actor, 'Acknowledged from the department workspace')
        this.drain()
        return { ok: true, message: `${task.title} acknowledged` }
      case 'start':
        if (task.status === 'notified' || task.status === 'escalated' || task.status === 'pending') this.acknowledgeTask(task, actor, 'Started from the department workspace')
        this.drain()
        return { ok: true, message: `${task.title} started` }
      case 'complete':
        if (task.status === 'blocked') {
          return { ok: false, message: `Blocked: ${task.blockedReason ?? 'unresolved dependency'}` }
        }
        this.completeTask(task, actor, false)
        this.drain()
        return { ok: true, message: `${task.title} completed` }
      case 'block':
        this.blockTask(task, 'Blocked by the department', task.requires)
        this.drain()
        return { ok: true, message: `${task.title} marked blocked` }
      case 'escalate': {
        const owner = ESCALATION_ROLE_FOR[task.department] ?? 'commander'
        this.raiseEscalation({
          key: `manual:${task.id}`,
          caseId: task.caseId,
          taskId: task.id,
          faultId: null,
          trigger: 'manual',
          reason: `${actor} escalated ${task.title}`,
          impact: `${departmentName(task.department)} cannot deliver this task as planned.`,
          department: task.department,
          ownerRole: owner,
          level: 2,
          options: task.requires ? recoveryOptions(task.requires, task, this.state) : [],
        })
        this.drain()
        return { ok: true, message: `${task.title} escalated to ${roleName(owner)}` }
      }
      default:
        return { ok: false, message: `Unknown action ${action}` }
    }
  }

  // ---------------------------------------------------------------- decisions

  private requestDecision(spec: DecisionSpec): Decision {
    this.state.decisionSeq += 1
    const decision: Decision = {
      id: `D${this.state.decisionSeq}`,
      caseId: spec.caseId,
      title: spec.title,
      question: spec.question,
      clinical: spec.clinical,
      options: spec.options,
      authorisedRoles: spec.authorisedRoles,
      status: 'pending',
      createdAt: this.now(),
      dueAt: this.now() + spec.dueIn,
      decidedAt: null,
      decidedBy: null,
      selectedOption: null,
      unlocks: spec.unlocks,
      optionEvents: spec.optionEvents ?? {},
      taskId: null,
      escalationId: null,
      note: '',
    }
    this.state.decisions.push(decision)
    const task = this.addTask({
      caseId: spec.caseId,
      department: spec.department,
      job: `decision-${decision.id}`,
      title: spec.taskTitle,
      detail: spec.taskDetail,
      notifySummary: `Decision required: ${spec.title}`,
      duration: 0,
      dueIn: spec.dueIn,
      ackIn: spec.dueIn + 300,
      kind: 'decision',
      auto: false,
      sensitive: spec.sensitive ?? spec.clinical,
      decisionId: decision.id,
    })
    decision.taskId = task.id
    this.audit('decision.requested', spec.title, spec.question, {
      caseId: spec.caseId,
      department: spec.department,
      actor: 'Orchestrator',
      role: spec.authorisedRoles[0],
    })
    return decision
  }

  decide(decisionId: string, optionId: string, roleId: string): { ok: boolean; message: string } {
    const decision = this.state.decisions.find((entry) => entry.id === decisionId)
    if (!decision) return { ok: false, message: 'Decision not found' }
    if (decision.status !== 'pending') return { ok: false, message: 'This decision has already been made' }
    const role = roleById(roleId)
    if (!role) return { ok: false, message: 'Unknown role' }
    if (!decision.authorisedRoles.includes(roleId)) {
      return { ok: false, message: `${role.name} is not authorised to make this decision (authorised: ${decision.authorisedRoles.map(roleName).join(', ')})` }
    }
    if (!role.permissions.includes('clinical.decide') && !role.permissions.includes('safety.check') && decision.clinical) {
      return { ok: false, message: `${role.name} has no clinical decision permission` }
    }
    const option = decision.options.find((entry) => entry.id === optionId)
    if (!option) return { ok: false, message: 'Unknown option' }
    decision.status = 'approved'
    decision.decidedAt = this.now()
    decision.decidedBy = role.name
    decision.selectedOption = optionId
    decision.note = option.label
    this.audit('decision.made', decision.title, `${option.label} (${role.name})`, {
      caseId: decision.caseId,
      department: role.department,
      actor: role.name,
      role: roleId,
    })
    if (decision.taskId) {
      const task = this.taskById(decision.taskId)
      if (task) {
        task.status = 'completed'
        task.completedAt = this.now()
        task.history.push({ at: this.now(), status: 'completed', actor: role.name, note: option.label })
        const notification = this.notificationFor(task.id)
        if (notification) {
          notification.acknowledgedAt = this.now()
          notification.state = 'acknowledged'
        }
      }
    }
    const event = decision.optionEvents[optionId] ?? decision.unlocks
    if (decision.escalationId) {
      const escalation = this.state.escalations.find((entry) => entry.id === decision.escalationId)
      if (escalation && escalation.status !== 'resolved') {
        escalation.status = 'resolved'
        escalation.resolvedAt = this.now()
        escalation.resolvedBy = role.name
        escalation.resolution = option.label
      }
    }
    this.dispatch(event, decision.caseId, `${decision.title}: ${option.label}`)
    this.drain()
    return { ok: true, message: `${decision.title}: ${option.label}` }
  }

  pendingDecisionsFor(roleId: string): Decision[] {
    const department = departmentOfRole(roleId)
    return this.state.decisions.filter(
      (decision) =>
        decision.status === 'pending' &&
        (decision.authorisedRoles.includes(roleId) ||
          (decision.taskId !== null && this.taskById(decision.taskId)?.department === department)),
    )
  }

  // ---------------------------------------------------------------- escalations

  private raiseEscalation(spec: {
    key: string
    caseId: string | null
    taskId: string | null
    faultId: string | null
    trigger: string
    reason: string
    impact: string
    department: string
    ownerRole: string
    level: number
    options: RecoveryOption[]
  }): Escalation | null {
    // One escalation per condition across its whole life: an acknowledged or resolved escalation is never raised again, so a
    // task that stays blocked cannot produce an alert every tick.
    const existing = this.state.escalations.find((entry) => entry.key === spec.key)
    if (existing) return existing
    this.state.escalationSeq += 1
    const escalation: Escalation = {
      id: `E${this.state.escalationSeq}`,
      key: spec.key,
      caseId: spec.caseId,
      taskId: spec.taskId,
      faultId: spec.faultId,
      trigger: spec.trigger,
      reason: spec.reason,
      impact: spec.impact,
      department: spec.department,
      ownerRole: spec.ownerRole,
      level: spec.level,
      status: 'open',
      createdAt: this.now(),
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      options: spec.options,
      notified: [
        { department: spec.department, role: spec.ownerRole, at: this.now() },
        { department: 'command', role: 'commander', at: this.now() },
      ],
    }
    this.state.escalations.push(escalation)
    this.record('escalation.raised', spec.caseId, spec.reason)
    this.audit('escalation.raised', `Escalation to ${roleName(spec.ownerRole)}`, `${spec.reason}. Impact: ${spec.impact}`, {
      caseId: spec.caseId,
      department: spec.department,
      actor: 'Orchestrator',
      role: spec.ownerRole,
    })
    if (spec.taskId) {
      const task = this.taskById(spec.taskId)
      if (task) {
        task.escalationId = escalation.id
        if (task.status === 'notified' || task.status === 'pending') {
          task.status = 'escalated'
          task.history.push({ at: this.now(), status: 'escalated', actor: 'Orchestrator', note: `Escalated to ${roleName(spec.ownerRole)}` })
        }
      }
    }
    return escalation
  }

  acknowledgeEscalation(id: string, roleId: string): { ok: boolean; message: string } {
    const escalation = this.state.escalations.find((entry) => entry.id === id)
    if (!escalation) return { ok: false, message: 'Escalation not found' }
    const role = roleById(roleId)
    if (!role) return { ok: false, message: 'Unknown role' }
    escalation.status = 'acknowledged'
    escalation.resolvedBy = role.name
    this.audit('escalation.acknowledged', `Escalation ${id} accepted`, `${role.name} owns the recovery`, {
      caseId: escalation.caseId,
      department: role.department,
      actor: role.name,
      role: roleId,
    })
    return { ok: true, message: `${role.name} now owns this escalation` }
  }

  resolveEscalation(id: string, optionId: string, roleId: string): { ok: boolean; message: string } {
    const escalation = this.state.escalations.find((entry) => entry.id === id)
    if (!escalation) return { ok: false, message: 'Escalation not found' }
    if (escalation.status === 'resolved') return { ok: false, message: 'Already resolved' }
    const role = roleById(roleId)
    if (!role) return { ok: false, message: 'Unknown role' }
    const option = escalation.options.find((entry) => entry.id === optionId)
    if (!option) return { ok: false, message: 'Unknown recovery option' }
    if (!option.requiresRoles.includes(roleId)) {
      return { ok: false, message: `${role.name} is not authorised; authorised: ${option.requiresRoles.map(roleName).join(', ')}` }
    }
    const task = escalation.taskId ? this.taskById(escalation.taskId) : undefined
    const effect = option.effect
    // The incident behind the escalation ends when its recovery is agreed: the units it closed reopen before the task resumes.
    if (escalation.faultId) {
      const fault = this.state.faults.find((entry) => entry.id === escalation.faultId)
      if (fault) {
        fault.status = 'resolved'
        fault.resolvedAt = this.now()
        const restored: Record<string, string[]> = {
          'theatre-unavailable': ['THEATRE-2', 'THEATRE-3'],
          'ct-unavailable': ['CT-1'],
          'blood-delay': ['BLOOD-O-NEG'],
        }
        for (const id of restored[fault.kind] ?? []) {
          const resource = this.state.resources.find((entry) => entry.id === id)
          if (resource && resource.state === 'unavailable') {
            resource.state = 'available'
            resource.caseId = null
            resource.note = 'Reopened after the incident was closed'
            resource.since = this.now()
          }
        }
      }
    }
    if (effect === 'resend' || effect === 'reassign') {
      if (task && (task.status === 'escalated' || task.status === 'notified' || task.status === 'pending')) {
        task.suppressAutoAck = false
        this.acknowledgeTask(task, `${role.name} on behalf of ${departmentName(task.department)}`, option.label)
      }
    } else if (effect.startsWith('release:')) {
      const resourceId = effect.split(':')[1] ?? ''
      const resource = this.state.resources.find((entry) => entry.id === (resourceId === 'required' ? task?.requires?.id ?? '' : resourceId))
      if (resource) {
        resource.state = 'available'
        resource.caseId = null
        resource.since = this.now()
        resource.note = `Released for ${task?.title ?? 'recovery'}`
      }
      if (task) this.resumeTask(task, `${option.label} (${role.name})`)
    } else if (effect.startsWith('use:') || effect.startsWith('free:')) {
      const resourceId = effect.split(':')[1] ?? ''
      const resource = this.state.resources.find((entry) => entry.id === resourceId)
      if (resource) {
        resource.state = 'available'
        resource.caseId = null
        resource.since = this.now()
        resource.note = `Released for ${task?.title ?? 'recovery'}`
      }
      if (task) this.resumeTask(task, `${option.label} (${role.name})`)
    } else if (effect.startsWith('wait:')) {
      const minutes = Number(effect.split(':')[1] ?? '15')
      if (task) this.resumeTask(task, `${option.label} (${role.name})`, minutes * 60)
    } else if (effect === 'repurpose:hdu') {
      const bed = this.state.resources.find((entry) => entry.kind === 'icu-bed' && entry.state !== 'available')
      if (bed) {
        bed.state = 'available'
        bed.caseId = null
        bed.note = 'Repurposed as an HDU bay for this admission'
        bed.since = this.now()
      }
      if (task) this.resumeTask(task, `HDU bay repurposed (${role.name})`)
    } else if (effect === 'external-transfer') {
      const c = this.caseById(escalation.caseId)
      if (c) {
        c.flags.push('Transferred to the tertiary centre (simulated)')
        c.destination = 'Tertiary trauma centre transfer'
        for (const other of this.state.tasks) {
          if (other.caseId === c.id && other.status !== 'completed' && other.status !== 'cancelled') {
            other.status = 'cancelled'
            other.history.push({ at: this.now(), status: 'cancelled', actor: role.name, note: 'Case transferred out' })
          }
        }
        this.record('case.transferred', c.id, `${c.code} transferred to the tertiary centre; local tasks cancelled`)
      }
    } else {
      if (task) this.resumeTask(task, `${option.label} (${role.name})`)
    }
    option.applied = true
    escalation.status = 'resolved'
    escalation.resolvedAt = this.now()
    escalation.resolvedBy = role.name
    escalation.resolution = option.label
    this.audit('escalation.resolved', `Escalation ${id} resolved`, `${option.label} (${role.name}). Affected departments updated.`, {
      caseId: escalation.caseId,
      department: role.department,
      actor: role.name,
      role: roleId,
    })
    this.record('escalation.resolved', escalation.caseId, `${option.label}; the workflow resumes and dependent departments are updated`)
    this.drain()
    return { ok: true, message: `Recovery recorded: ${option.label}` }
  }

  // ---------------------------------------------------------------- resources

  private claimSpecific(resourceId: string, c: ClinicalCase, note: string): void {
    const resource = this.state.resources.find((entry) => entry.id === resourceId)
    if (!resource) return
    resource.state = 'occupied'
    resource.caseId = c.id
    resource.since = this.now()
    resource.note = note
  }

  private reserve(resourceId: string, caseId: string, note: string): void {
    const resource = this.state.resources.find((entry) => entry.id === resourceId)
    if (!resource || resource.state === 'unavailable') return
    resource.state = 'reserved'
    resource.caseId = caseId
    resource.since = this.now()
    resource.note = note
  }

  private occupy(resourceId: string, caseId: string, note: string): void {
    const resource = this.state.resources.find((entry) => entry.id === resourceId)
    if (!resource) return
    resource.state = 'occupied'
    resource.caseId = caseId
    resource.since = this.now()
    resource.note = note
  }

  private claimResource(requirement: TaskRequirement, caseId: string | null): Resource | null {
    const candidates = this.state.resources.filter((resource) =>
      requirement.id ? resource.id === requirement.id : resource.kind === requirement.kind,
    )
    // Blood is a pooled supply: a task uses it without taking it out of the pool. Any other resource must be free.
    const resource = candidates.find(
      (entry) => entry.state !== 'unavailable' && (entry.kind === 'blood' || entry.state === 'available'),
    )
    if (!resource) return null
    if (resource.kind === 'blood') return resource
    resource.state = 'reserved'
    resource.caseId = caseId
    resource.since = this.now()
    resource.note = `Reserved for ${caseId ?? 'the hospital'}`
    this.audit('resource.reserved', resource.name, `Reserved for ${caseId ?? 'the hospital'}`, {
      caseId,
      department: resource.department,
      actor: 'Orchestrator',
    })
    return resource
  }

  release(resourceId: string, note: string): void {
    const resource = this.state.resources.find((entry) => entry.id === resourceId)
    if (!resource) return
    if (resource.state === 'available') return
    resource.state = 'available'
    resource.caseId = null
    resource.since = this.now()
    resource.note = note
    this.audit('resource.released', resource.name, note, { caseId: null, department: resource.department, actor: 'Orchestrator' })
  }

  private releaseCaseResources(c: ClinicalCase, which: 'theatre' | 'porter' | 'all'): void {
    for (const resource of this.state.resources) {
      if (resource.caseId !== c.id) continue
      const isTheatre = resource.kind === 'theatre'
      const isPorter = resource.kind === 'porter'
      if (which === 'theatre' && !isTheatre) continue
      if (which === 'porter' && !isPorter) continue
      resource.state = isTheatre ? 'awaiting_release' : 'available'
      resource.caseId = null
      resource.since = this.now()
      resource.note = isTheatre ? 'Turnaround and cleaning after the emergency case' : 'Released after use'
    }
  }

  resourceName(id: string): string {
    return this.state.resources.find((resource) => resource.id === id)?.name ?? id
  }

  // ---------------------------------------------------------------- handovers

  private createHandover(c: ClinicalCase, from: string, to: string, label: string): Handover {
    this.state.handoverSeq += 1
    const handover: Handover = {
      id: `H${this.state.handoverSeq}`,
      caseId: c.id,
      from,
      to,
      createdAt: this.now(),
      status: 'pending',
      acceptedAt: null,
      acceptedBy: null,
      checklist: [
        { id: 'identity', label: 'Case identity and code confirmed', confirmed: true },
        { id: 'observations', label: 'Observations and trend handed over', confirmed: true },
        { id: 'plan', label: 'Plan and destination agreed', confirmed: true },
        { id: 'checks', label: 'Lines, drugs and blood products checked', confirmed: false },
        { id: 'receiving', label: 'Receiving team confirms readiness', confirmed: false },
      ],
    }
    this.state.handovers.push(handover)
    this.audit('handover.created', label, 'Structured handover recorded with its checklist', { caseId: c.id, department: to, actor: 'Orchestrator' })
    return handover
  }

  acceptHandover(handoverId: string, roleId: string): { ok: boolean; message: string } {
    const handover = this.state.handovers.find((entry) => entry.id === handoverId)
    if (!handover) return { ok: false, message: 'Handover not found' }
    const role = roleById(roleId)
    if (!role) return { ok: false, message: 'Unknown role' }
    if (!role.permissions.includes('handover.accept')) return { ok: false, message: `${role.name} may not accept handovers` }
    handover.status = 'accepted'
    handover.acceptedAt = this.now()
    handover.acceptedBy = role.name
    handover.checklist = handover.checklist.map((item) => ({ ...item, confirmed: true }))
    this.audit('handover.accepted', `Handover ${handover.id} accepted`, `Accepted by ${role.name} (${departmentName(role.department)})`, {
      caseId: handover.caseId,
      department: role.department,
      actor: role.name,
      role: roleId,
    })
    return { ok: true, message: `Handover accepted by ${role.name}` }
  }

  // ---------------------------------------------------------------- faults

  injectFault(kind: FaultKind, roleId: string): { ok: boolean; message: string } {
    const c = this.state.cases.find((entry) => entry.status !== 'closed') ?? this.state.cases[0]
    this.state.faultSeq += 1
    const fault: Fault = {
      id: `F${this.state.faultSeq}`,
      kind,
      label: FAULT_LABELS[kind],
      caseId: c?.id ?? null,
      createdAt: this.now(),
      detectedAt: this.now(),
      impact: [],
      status: 'active',
      escalationId: null,
      resolvedAt: null,
      detail: '',
    }
    this.state.faults.push(fault)
    let message = ''
    switch (kind) {
      case 'theatre-unavailable': {
        const theatres = this.state.resources.filter((resource) => resource.kind === 'theatre' && resource.state !== 'unavailable')
        for (const theatre of theatres) {
          theatre.state = 'unavailable'
          theatre.caseId = null
          theatre.note = 'Flood damage in theatre suite 1: closed for safety checks'
        }
        fault.impact = ['theatre-coord', 'anaesthetics', 'surgical-team', 'theatre-nursing', 'icu']
        message = 'All theatres marked unavailable (flood damage in suite 1)'
        if (c) {
          const withdrawn = c.theatreId
          c.theatreId = null
          for (const task of this.state.tasks) {
            if (task.caseId === c.id && task.requires?.kind === 'theatre' && task.status !== 'completed' && task.status !== 'cancelled') {
              this.blockTask(task, 'No theatre available: suite closed for safety checks', task.requires)
            }
          }
          // The theatre was already allocated: the coordination task is done, so a replacement allocation is opened.
          if (withdrawn && this.findTask(c.id, 'theatre-coord', 'assign-theatre')?.status === 'completed') {
            const reassign = this.addTask({
              caseId: c.id,
              department: 'theatre-coord',
              job: 'reassign-theatre',
              title: 'Allocate a replacement theatre',
              detail: 'The allocated theatre has been withdrawn. Allocate a replacement, record why, and tell anaesthetics, surgery and nursing.',
              notifySummary: `Replacement theatre needed for ${c.code}`,
              duration: 120,
              dueIn: 240,
              requires: { kind: 'theatre', label: 'Operating theatre' },
              onCompleteEvent: 'theatre.assigned',
            })
            this.blockTask(reassign, 'No theatre available: suite closed for safety checks', reassign.requires)
          }
        }
        break
      }
      case 'blood-delay': {
        const units = this.state.resources.find((resource) => resource.id === 'BLOOD-O-NEG')
        if (units) {
          units.state = 'unavailable'
          units.caseId = null
          units.note = 'Supply delivery delayed: 24 minutes'
        }
        fault.impact = ['blood-bank', 'theatre-coord', 'anaesthetics', 'surgical-team']
        message = 'Blood supply delayed by 24 minutes'
        if (c) {
          for (const task of this.state.tasks) {
            if (task.caseId === c.id && task.requires?.id === 'BLOOD-O-NEG' && task.status !== 'completed' && task.status !== 'cancelled') {
              this.blockTask(task, 'Blood supply delayed: 24 minutes', task.requires)
            }
          }
        }
        break
      }
      case 'icu-shortage': {
        const beds = this.state.resources.filter((resource) => resource.kind === 'icu-bed' && resource.state === 'available')
        for (const bed of beds) {
          bed.state = 'occupied'
          bed.caseId = null
          bed.note = 'Occupied by an unrelated admission, discharge review pending'
        }
        const icu = this.state.resources.find((resource) => resource.id === 'ICU-06')
        if (icu) icu.note = 'Equipment service until 11:00'
        fault.impact = ['icu', 'icu-nursing', 'bed-management', 'anaesthetics', 'theatre-coord']
        message = 'All available ICU beds reported occupied'
        if (c) {
          for (const task of this.state.tasks) {
            if (task.caseId === c.id && task.requires?.kind === 'icu-bed' && task.status !== 'completed' && task.status !== 'cancelled') {
              this.blockTask(task, 'No ICU bed available', task.requires)
            }
          }
        }
        break
      }
      case 'missed-acknowledgement': {
        const target = [...this.state.tasks]
          .reverse()
          .find((task) => task.status === 'notified' && task.priority === 'P1' && task.kind !== 'decision')
        if (target) {
          target.suppressAutoAck = true
          this.clearTimers('auto-ack', target.id)
          fault.impact = [target.department]
          fault.detail = `${departmentName(target.department)}: ${target.title}`
          message = `Acknowledgement suppressed for ${target.title} (${departmentName(target.department)})`
        } else {
          const next = this.state.tasks.find((task) => task.status === 'notified')
          if (next) {
            next.suppressAutoAck = true
            this.clearTimers('auto-ack', next.id)
            fault.detail = `${departmentName(next.department)}: ${next.title}`
            fault.impact = [next.department]
            message = `Acknowledgement suppressed for ${next.title}`
          } else {
            message = 'No outstanding notification to withhold: inject this after a pre-alert'
            fault.status = 'resolved'
            fault.resolvedAt = this.now()
          }
        }
        break
      }
      case 'ambulance-delay': {
        if (!c) {
          message = 'No active case to delay'
          fault.status = 'resolved'
          fault.resolvedAt = this.now()
          break
        }
        const extra = 720
        if (c.eta !== null) c.eta += extra
        this.clearTimers('patient-arrival', c.id)
        if (c.eta !== null) this.schedule('patient-arrival', c.eta, c.id, `${c.code} delayed`)
        fault.impact = ['resus', 'trauma-team', 'command']
        message = `Ambulance delayed: ${c.code} ETA moved by 12 minutes`
        this.dispatch('eta.updated', c.id, `ETA for ${c.code} now ${formatMinutes((c.eta ?? this.now()) - this.now())}`)
        break
      }
      case 'ct-unavailable': {
        const scanner = this.state.resources.find((resource) => resource.id === 'CT-1')
        if (scanner) {
          scanner.state = 'unavailable'
          scanner.caseId = null
          scanner.note = 'Scanner fault: service engineer called'
        }
        fault.impact = ['radiology', 'trauma-team', 'portering']
        message = 'CT scanner 1 unavailable'
        if (c) {
          for (const task of this.state.tasks) {
            if (task.caseId === c.id && task.requires?.kind === 'ct' && task.status !== 'completed' && task.status !== 'cancelled') {
              this.blockTask(task, 'CT scanner 1 unavailable', task.requires)
            }
          }
        }
        break
      }
      case 'staff-unavailable': {
        this.state.unavailableRoles.push('anaesthetist')
        this.state.unavailableRoles.push('theatre-coordinator')
        fault.impact = ['anaesthetics', 'theatre-coord', 'surgical-team']
        message = 'Anaesthetist and theatre coordinator unavailable for 20 minutes'
        if (c) {
          for (const task of this.state.tasks) {
            if (
              task.caseId === c.id &&
              (task.ownerRole === 'anaesthetist' || task.ownerRole === 'theatre-coordinator') &&
              task.status !== 'completed' &&
              task.status !== 'cancelled'
            ) {
              this.blockTask(task, `${roleName(task.ownerRole)} unavailable`, task.requires)
            }
          }
        }
        break
      }
      case 'plan-change': {
        if (!c) {
          message = 'No active case to change'
          fault.status = 'resolved'
          fault.resolvedAt = this.now()
          break
        }
        c.vitals = { hr: 141, bp: '78/44', spo2: 89, gcs: 12 }
        c.priority = 'P1'
        c.flags.push('Clinical deterioration reported')
        fault.impact = ['trauma-team', 'theatre-coord', 'icu', 'blood-bank', 'anaesthetics']
        message = `Clinical deterioration reported for ${c.code}: revised plan needed`
        this.dispatch('plan.change', c.id, `${c.code} deteriorated: revised operative plan required`)
        break
      }
      default:
        break
    }
    fault.detail = message
    const open = this.state.escalations.filter((entry) => entry.status !== 'resolved' && fault.impact.includes(entry.department)).at(-1)
    if (open) {
      if (open.faultId === null) open.faultId = fault.id
      fault.escalationId = open.id
    }
    this.record('fault.injected', fault.caseId, `${fault.label}: ${message}`)
    this.audit('fault.injected', fault.label, `${message}. Affected: ${fault.impact.map(departmentName).join(', ')}`, {
      caseId: fault.caseId,
      department: null,
      actor: 'Simulation control',
      role: roleId,
    })
    this.drain()
    return { ok: true, message }
  }

  // ---------------------------------------------------------------- SLA and timers

  private schedule(kind: SimState['timers'][number]['kind'], at: number, ref: string, detail: string): string {
    this.state.timerSeq += 1
    const id = `S${this.state.timerSeq}`
    this.state.timers.push({ id, kind, at: Math.round(at), ref, detail })
    return id
  }

  private clearTimers(kind: string, ref: string): void {
    this.state.timers = this.state.timers.filter((timer) => !(timer.kind === kind && timer.ref === ref))
  }

  private runDueTimers(): void {
    let guard = 0
    for (;;) {
      if (guard > 500) return
      guard += 1
      const due = this.state.timers
        .filter((timer) => timer.at <= this.now())
        .sort((left, right) => (left.at === right.at ? left.id.localeCompare(right.id) : left.at - right.at))[0]
      if (!due) return
      this.state.timers = this.state.timers.filter((timer) => timer.id !== due.id)
      switch (due.kind) {
        case 'auto-ack': {
          const task = this.taskById(due.ref)
          if (task && (task.status === 'notified' || task.status === 'escalated') && !task.suppressAutoAck) {
            this.acknowledgeTask(task, 'Simulated department', 'Acknowledged automatically by the simulated department')
          }
          break
        }
        case 'auto-complete': {
          const task = this.taskById(due.ref)
          if (task && task.status === 'in_progress') this.completeTask(task, 'Simulated department', true)
          break
        }
        case 'patient-arrival': {
          this.dispatch('patient.arrived', due.ref, due.detail)
          break
        }
        case 'scene-arrival': {
          this.dispatch('scene.arrived', due.ref, due.detail)
          break
        }
        case 'fault-trigger': {
          this.record('fault.triggered', this.caseById(due.ref)?.id ?? null, due.detail)
          break
        }
        default:
          break
      }
    }
  }

  private checkSla(): void {
    for (const task of this.state.tasks) {
      if (task.status === 'notified' || task.status === 'escalated') {
        if (this.now() > task.ackDueAt) {
          const level = this.now() > task.ackDueAt + 600 ? 2 : 1
          const key = level === 2 ? `ack2:${task.id}` : `ack:${task.id}`
          const owner = level === 2 ? 'commander' : ESCALATION_ROLE_FOR[task.department] ?? 'commander'
          const escalation = this.raiseEscalation({
            key,
            caseId: task.caseId,
            taskId: task.id,
            faultId: null,
            trigger: 'unacknowledged',
            reason: `${departmentName(task.department)} has not acknowledged "${task.title}"`,
            impact: `The notification was delivered at ${formatWall(task.notifiedAt ?? task.createdAt)} and is still unacknowledged. Downstream preparation cannot start.`,
            department: task.department,
            ownerRole: owner,
            level,
            options: [
              {
                id: 'resend',
                label: 'Re-send and telephone the department',
                consequence: 'The notification is re-sent with a telephone call; the department acknowledges and starts work.',
                requiresRoles: [owner, 'commander'],
                effect: 'resend',
                applied: false,
              },
              {
                id: 'reassign',
                label: 'Reassign the task to the available colleague',
                consequence: 'The task is accepted by another authorised colleague in the same department.',
                requiresRoles: [owner, 'commander'],
                effect: 'reassign',
                applied: false,
              },
            ],
          })
          if (escalation) task.escalationId = escalation.id
        }
      }
      if ((task.status === 'in_progress' || task.status === 'acknowledged') && task.blockedReason === null && this.now() > task.dueAt) {
        this.raiseEscalation({
          key: `sla:${task.id}`,
          caseId: task.caseId,
          taskId: task.id,
          faultId: null,
          trigger: 'overdue',
          reason: `${task.title} is overdue in ${departmentName(task.department)}`,
          impact: this.downstreamText(task),
          department: task.department,
          ownerRole: ESCALATION_ROLE_FOR[task.department] ?? 'commander',
          level: 1,
          options: [
            {
              id: 'accept-late',
              label: 'Accept the revised time and inform affected units',
              consequence: 'The delay is recorded and every dependent department is told the new time.',
              requiresRoles: [ESCALATION_ROLE_FOR[task.department] ?? 'commander', 'commander'],
              effect: 'wait:5',
              applied: false,
            },
          ],
        })
      }
    }
    for (const decision of this.state.decisions) {
      if (decision.status !== 'pending') continue
      if (this.now() > decision.dueAt && decision.escalationId === null) {
        const escalation = this.raiseEscalation({
          key: `decision:${decision.id}`,
          caseId: decision.caseId,
          taskId: decision.taskId,
          faultId: null,
          trigger: 'decision-waiting',
          reason: `"${decision.title}" is still awaiting authorisation`,
          impact: `Authorised roles: ${decision.authorisedRoles.map(roleName).join(', ')}. No operational automation may take this decision.`,
          department: departmentOfRole(decision.authorisedRoles[0] ?? 'commander'),
          ownerRole: decision.authorisedRoles[0] ?? 'commander',
          level: 1,
          options: [],
        })
        if (escalation) decision.escalationId = escalation.id
      }
    }
  }

  // ---------------------------------------------------------------- views

  private readinessFor(department: string, caseId: string): { readiness: Readiness; detail: string } {
    const tasks = this.state.tasks.filter((task) => task.department === department && task.caseId === caseId)
    if (tasks.length === 0) return { readiness: 'unknown', detail: 'Not asked yet' }
    if (tasks.some((task) => task.status === 'blocked')) {
      const blocked = tasks.filter((task) => task.status === 'blocked')
      return { readiness: 'blocked', detail: `${blocked[0]?.blockedReason ?? 'Blocked'} (${blocked.length} blocked)` }
    }
    if (tasks.every((task) => task.status === 'completed')) {
      return { readiness: 'ready', detail: `${tasks.length} of ${tasks.length} tasks complete` }
    }
    const done = tasks.filter((task) => task.status === 'completed').length
    if (tasks.some((task) => task.status === 'in_progress' || task.status === 'acknowledged' || task.status === 'escalated')) {
      return { readiness: 'preparing', detail: `${done} of ${tasks.length} tasks complete` }
    }
    return { readiness: 'notified', detail: `${tasks.length} task(s) notified, none acknowledged` }
  }

  readinessByDepartment(): Record<string, { readiness: Readiness; detail: string }[]> {
    const byCase: Record<string, { readiness: Readiness; detail: string }[]> = {}
    for (const c of this.state.cases) {
      byCase[c.id] = DEPARTMENTS.map((department) => ({
        department: department.id,
        ...this.readinessFor(department.id, c.id),
      })).filter((entry) => entry.readiness !== 'unknown')
    }
    return byCase
  }

  predictions(): Prediction[] {
    const predictions: Prediction[] = []
    const active = this.state.cases.filter((c) => c.status !== 'closed')
    const labels = STAGES
    for (const c of active) {
      if (c.status === 'incoming' && c.eta !== null && c.eta > this.now()) {
        const remaining = c.eta - this.now()
        const ready = this.readinessFor('resus', c.id)
        predictions.push({
          id: `eta-${c.id}`,
          kind: 'fact',
          title: `${c.code} arriving in ${formatMinutes(remaining)}`,
          detail: `Expected at the emergency department at ${formatWall(c.eta)}. Resuscitation readiness: ${ready.readiness}.`,
          why: 'Derived from the pre-alert estimate and the readiness of the receiving units.',
          severity: remaining < 300 ? 'urgent' : 'watch',
          caseId: c.id,
          department: 'resus',
          recommended:
            ready.readiness === 'ready'
              ? 'Keep the bay and team protected until arrival.'
              : 'Confirm bay, team and equipment readiness before arrival.',
        })
      }
      const surgicalStage = ['imaging', 'surgery-decision']
      if (surgicalStage.includes(c.stage) || c.status === 'active') {
        const theatreThreat = this.state.resources.filter((resource) => resource.kind === 'theatre' && resource.state === 'available').length
        const icuFree = this.state.resources.filter((resource) => resource.kind === 'icu-bed' && resource.state === 'available').length
        const alreadyAuthorised = c.surgicalDecision === 'authorised'
        predictions.push({
          id: `surgery-${c.id}`,
          kind: alreadyAuthorised ? 'fact' : 'prediction',
          title: alreadyAuthorised
            ? `${c.code}: theatre and ICU authorised`
            : `${c.code}: emergency surgery likely`,
          detail: alreadyAuthorised
            ? `Authorised surgical case. Theatre: ${c.theatreId ? this.resourceName(c.theatreId) : 'not yet allocated'}. ICU beds free: ${icuFree}.`
            : `Injuries and imaging suggest a high probability of emergency surgery. Tentative requirement: 1 theatre, 1 ICU bed. Free theatres: ${theatreThreat}, free ICU beds: ${icuFree}.`,
          why: alreadyAuthorised
            ? 'The trauma team and the surgeon authorised the operation.'
            : 'Deterministic rule: a P1 trauma case past primary survey with bleeding on imaging usually needs theatre and ICU. This is a tentative plan, not a booking.',
          severity: icuFree === 0 || theatreThreat === 0 ? 'urgent' : 'watch',
          caseId: c.id,
          department: 'theatre-coord',
          recommended: alreadyAuthorised
            ? 'Confirm readiness gates and keep ICU capacity protected.'
            : 'Protect one theatre and one ICU bed before the formal decision, without booking them.',
        })
        if (icuFree === 0) {
          predictions.push({
            id: `icu-risk-${c.id}`,
            kind: 'prediction',
            title: 'ICU capacity risk before the transfer stage',
            detail: `No ICU bed is free while ${c.code} is heading for a postoperative admission. Bed management and ICU must resolve capacity before transfer readiness can be declared.`,
            why: 'Free ICU beds are counted from the resource register; the expected admission is derived from the surgical pathway.',
            severity: 'urgent',
            caseId: c.id,
            department: 'icu',
            recommended: 'Start the discharge and transfer review now, not at the theatre door.',
          })
        }
      }
      const needsCt = this.state.tasks.some(
        (task) => task.caseId === c.id && task.requires?.kind === 'ct' && task.status !== 'completed' && task.status !== 'cancelled',
      )
      if (needsCt) {
        const freeCt = this.state.resources.filter((resource) => resource.kind === 'ct' && resource.state === 'available').length
        if (freeCt <= 1) {
          predictions.push({
            id: `ct-${c.id}`,
            kind: 'prediction',
            title: 'Imaging capacity competition',
            detail: `${c.code} needs a CT and only ${freeCt} scanner(s) are free. Other emergency demand may collide with this slot.`,
            why: 'Radiology resource register compared with outstanding imaging tasks across all active cases.',
            severity: freeCt === 0 ? 'urgent' : 'watch',
            caseId: c.id,
            department: 'radiology',
            recommended: 'Agree the scan order with the trauma team before the transfer starts.',
          })
        }
      }
      const lateAcks = this.state.notifications.filter(
        (notification) => notification.caseId === c.id && notification.state !== 'acknowledged' && this.now() > (this.taskById(notification.taskId)?.ackDueAt ?? 0),
      )
      if (lateAcks.length > 0) {
        predictions.push({
          id: `late-${c.id}`,
          kind: 'fact',
          title: `${lateAcks.length} unacknowledged notification(s)`,
          detail: `${lateAcks.map((entry) => departmentName(entry.department)).join(', ')} have not confirmed the request.`,
          why: 'Notification delivery timestamps compared with the acknowledgement deadline.',
          severity: 'urgent',
          caseId: c.id,
          department: lateAcks[0]?.department ?? null,
          recommended: 'Escalate to the accountable coordinator; do not assume readiness.',
        })
      }
    }
    for (const decision of this.state.decisions.filter((entry) => entry.status === 'pending')) {
      const c = this.caseById(decision.caseId)
      predictions.push({
        id: `decision-${decision.id}`,
        kind: 'decision',
        title: `Awaiting authorisation: ${decision.title}`,
        detail: decision.question,
        why: `Clinical decisions are never taken by the orchestration engine. Authorised roles: ${decision.authorisedRoles.map(roleName).join(', ')}.`,
        severity: 'urgent',
        caseId: decision.caseId,
        department: c ? departmentOfRole(decision.authorisedRoles[0] ?? 'commander') : null,
        recommended: `Ask ${decision.authorisedRoles.map(roleName).join(' or ')} to decide.`,
      })
    }
    const theatreCases = this.state.cases.filter((c) => c.surgicalDecision === 'authorised' && c.theatreAt === null)
    if (theatreCases.length > 1) {
      predictions.push({
        id: 'theatre-conflict',
        kind: 'fact',
        title: `${theatreCases.length} authorised surgical cases competing for a theatre`,
        detail: `${theatreCases.map((c) => c.code).join(', ')} are all authorised. Allocation must be recorded against each case.`,
        why: 'Two authorisations and fewer than two suitable theatres free.',
        severity: 'urgent',
        caseId: null,
        department: 'theatre-coord',
        recommended: 'Theatre coordination decides the order and records the alternative for the second case.',
      })
    }
    return predictions
  }

  private caseForRole(c: ClinicalCase, clinical: boolean): ClinicalCase {
    if (clinical) return c
    return {
      ...c,
      patientName: 'Trauma patient',
      age: 0,
      sex: '',
      vitals: { hr: 0, bp: 'restricted', spo2: 0, gcs: 0 },
      injuries: [],
      clinicalNotes: 'Restricted: clinical detail is available only to clinical roles.',
      plan: c.plan,
      flags: c.flags,
    }
  }

  snapshot(roleId: string): Snapshot {
    const role = roleById(roleId) ?? ROLES.find((entry) => entry.id === 'commander') ?? ROLES[0]
    const clinical = role.clinical
    const cases = this.state.cases.map((c) => this.caseForRole(c, clinical))
    const tasks = this.state.tasks.map((task) =>
      !clinical && task.sensitive ? { ...task, detail: task.notifySummary } : task,
    )
    const state: SimState = {
      ...this.state,
      role: role.id,
      cases,
      tasks,
      handovers: this.state.handovers,
    }
    const readiness: Record<string, DepartmentReadiness[]> = {}
    for (const c of this.state.cases) {
      readiness[c.id] = DEPARTMENTS.map((department) => ({
        department: department.id,
        ...this.readinessFor(department.id, c.id),
      })).filter((entry) => entry.readiness !== 'unknown')
    }
    return {
      state,
      stageDefinitions: STAGES,
      predictions: this.predictions(),
      readiness,
      departmentView: this.departmentView(role),
      permissions: role.permissions,
      role,
      clock: formatWall(this.state.clock),
      shiftStart: HOSPITAL_SHIFT,
    }
  }

  private departmentView(role: RoleDefinition): DepartmentWorkView {
    const department = departmentById(role.department) ?? DEPARTMENTS[0]
    const clinical = role.clinical
    const tasks = this.state.tasks
      .filter((task) => task.department === department.id)
      .sort((left, right) => PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] || left.dueAt - right.dueAt)
      .map((task) => (!clinical && task.sensitive ? { ...task, detail: task.notifySummary } : task))
    const caseIds = new Set(tasks.map((task) => task.caseId).filter((id): id is string => Boolean(id)))
    const cases = this.state.cases
      .filter((c) => caseIds.has(c.id))
      .map((c) => {
        const view = this.caseForRole(c, clinical)
        return {
          id: c.id,
          code: c.code,
          summary: view.operationalSummary,
          stage: STAGES.find((stage) => stage.id === c.stage)?.name ?? c.stage,
          priority: c.priority,
          eta: c.eta !== null && c.eta > this.now() ? formatMinutes(c.eta - this.now()) : null,
          clinicalDetail: clinical ? `${view.injuries.join('; ')}. Observations: HR ${view.vitals.hr}, BP ${view.vitals.bp}, SpO2 ${view.vitals.spo2}%, GCS ${view.vitals.gcs}.` : null,
        }
      })
    const notifications = this.state.notifications.filter((notification) => notification.department === department.id)
    const decisions = this.state.decisions.filter(
      (decision) => decision.status === 'pending' && (decision.authorisedRoles.includes(role.id) || (decision.taskId !== null && this.taskById(decision.taskId)?.department === department.id)),
    )
    const escalations = this.state.escalations.filter(
      (escalation) => escalation.status !== 'resolved' && (escalation.department === department.id || escalation.ownerRole === role.id),
    )
    const readiness = tasks.length === 0
      ? 'unknown'
      : tasks.some((task) => task.status === 'blocked')
        ? 'blocked'
        : tasks.every((task) => task.status === 'completed')
          ? 'ready'
          : tasks.some((task) => task.status === 'in_progress' || task.status === 'acknowledged')
            ? 'preparing'
            : 'notified'
    const nextActions: string[] = []
    for (const decision of decisions) nextActions.push(`Decide: ${decision.title}`)
    for (const task of tasks.filter((entry) => entry.status === 'blocked')) nextActions.push(`Resolve blocker: ${task.title} (${task.blockedReason ?? 'blocked'})`)
    for (const task of tasks.filter((entry) => entry.status === 'notified')) nextActions.push(`Acknowledge: ${task.title}`)
    for (const task of tasks.filter((entry) => entry.status === 'in_progress')) nextActions.push(`Complete by ${formatWall(task.dueAt)}: ${task.title}`)
    for (const escalation of escalations) nextActions.push(`Own the escalation: ${escalation.reason}`)
    const resourceSummary = this.state.resources
      .filter((resource) => resource.department === department.id)
      .map((resource) => ({ id: resource.id, name: resource.name, state: resource.state, note: resource.note }))
    return {
      role,
      department,
      cases,
      tasks,
      notifications: notifications.slice(-40).reverse(),
      decisions,
      escalations,
      readiness,
      resourceSummary,
      nextActions,
    }
  }

  // ---------------------------------------------------------------- audit

  audit(action: string, subject: string, detail: string, options: { caseId?: string | null; department?: string | null; actor?: string; role?: string }): void {
    this.state.auditSeq += 1
    const entry: AuditEntry = {
      seq: this.state.auditSeq,
      at: this.state.clock,
      actor: options.actor ?? 'Orchestrator',
      role: options.role ?? 'orchestrator',
      action,
      subject,
      caseId: options.caseId ?? null,
      department: options.department ?? null,
      detail,
    }
    this.state.audit.push(entry)
    if (this.state.audit.length > 800) this.state.audit.splice(0, this.state.audit.length - 800)
  }

  // ---------------------------------------------------------------- parallel preparation

  private parallelPreparation(c: ClinicalCase): string[] {
    const team: string[] = []
    const add = (spec: TaskSpec): Task => {
      team.push(spec.department)
      return this.addTask(spec)
    }
    add({
      caseId: c.id,
      department: 'resus',
      job: 'prepare-bay',
      title: 'Prepare resuscitation bay',
      detail: 'Resus bay, airway trolley, monitoring, rapid transfusion set and warming. Name the receiving nurse.',
      notifySummary: `Resuscitation bay preparation for ${c.code}`,
      duration: 300,
      dueIn: 420,
      requires: { kind: 'bay', label: 'Resuscitation bay' },
      onCompleteEvent: 'resus.bay.ready',
    })
    add({
      caseId: c.id,
      department: 'trauma-team',
      job: 'assemble-team',
      title: 'Assemble trauma team and name leader',
      detail: 'Alert the trauma team, confirm the leader and the attendance times of surgery, anaesthetics and emergency nursing.',
      notifySummary: `Trauma team activation for ${c.code}`,
      duration: 180,
      dueIn: 300,
      onCompleteEvent: 'trauma.team.ready',
    })
    add({
      caseId: c.id,
      department: 'radiology',
      job: 'reserve-ct',
      title: 'Reserve CT slot in advance',
      detail: 'Protect a trauma CT slot and brief the radiographer on the suspected injuries. No scan takes place until a clinician requests it.',
      notifySummary: `CT slot held for ${c.code}`,
      duration: 120,
      dueIn: 300,
      requires: { kind: 'ct', label: 'CT scanner' },
      onCompleteEvent: 'radiology.reserved',
    })
    add({
      caseId: c.id,
      department: 'laboratory',
      job: 'anticipate-panel',
      title: 'Anticipate urgent trauma panel',
      detail: 'Queue the analyser, prepare reagents and cross-match tubes so the authorised panel starts on arrival.',
      notifySummary: `Urgent panel anticipated for ${c.code}`,
      duration: 120,
      dueIn: 300,
      onCompleteEvent: 'laboratory.ready',
    })
    add({
      caseId: c.id,
      department: 'blood-bank',
      job: 'reserve-units',
      title: 'Reserve emergency units pending authorisation',
      detail: 'Hold 2 units of O negative on standby. Release requires the trauma leader authorisation; no blood is issued on a pre-alert alone.',
      notifySummary: `O negative held for ${c.code}`,
      duration: 180,
      dueIn: 420,
      requires: { id: 'BLOOD-O-NEG', kind: 'blood', label: 'Red cell units' },
      onCompleteEvent: 'blood.reserved',
    })
    add({
      caseId: c.id,
      department: 'bed-management',
      job: 'assess-capacity',
      title: 'Assess downstream capacity',
      detail: 'Assess theatre and critical care capacity for a likely surgical admission, without booking it.',
      notifySummary: `Capacity assessment for ${c.code}`,
      duration: 240,
      dueIn: 420,
      onCompleteEvent: 'capacity.assessed',
    })
    add({
      caseId: c.id,
      department: 'anaesthetics',
      job: 'conditional-notice',
      title: 'Conditional advance notice of theatre requirement',
      detail: 'Review the pre-alert and note a conditional theatre requirement. This is not a booking and creates no staff obligation.',
      notifySummary: `Conditional theatre notice for ${c.code}`,
      duration: 90,
      dueIn: 240,
    })
    add({
      caseId: c.id,
      department: 'theatre-coord',
      job: 'protect-capacity',
      title: 'Protect emergency theatre capacity',
      detail: 'Hold an emergency theatre option against elective demand. Allocation waits for the authorised surgical decision.',
      notifySummary: `Emergency theatre protected for ${c.code}`,
      duration: 120,
      dueIn: 300,
    })
    add({
      caseId: c.id,
      department: 'command',
      job: 'overview',
      title: 'Operational overview of the expected major trauma',
      detail: 'Hold the operational overview for the incoming major trauma, including readiness, constraints and decisions required.',
      notifySummary: `Operational overview: ${c.code} inbound`,
      duration: 60,
      dueIn: 180,
    })
    add({
      caseId: c.id,
      department: 'family-liaison',
      job: 'prepare-contact',
      title: 'Prepare family contact route',
      detail: 'Identify the contact route and the quiet room. No clinical information is shared without clinical authorisation.',
      notifySummary: `Family contact prepared for ${c.code}`,
      duration: 120,
      dueIn: 420,
    })
    return [...new Set(team)]
  }

  private parallelTheatrePreparation(c: ClinicalCase): void {
    const theatreAssign = this.addTask({
      caseId: c.id,
      department: 'theatre-coord',
      job: 'assign-theatre',
      title: 'Assign an emergency theatre',
      detail: 'Allocate a suitable theatre for a damage control laparotomy and record why that theatre was chosen.',
      notifySummary: `Theatre allocation for ${c.code}`,
      duration: 120,
      dueIn: 240,
      requires: { kind: 'theatre', label: 'Operating theatre' },
      onCompleteEvent: 'theatre.assigned',
    })
    const anaesthetic = this.addTask({
      caseId: c.id,
      department: 'anaesthetics',
      job: 'prepare-anaesthetic',
      title: 'Prepare anaesthetic for major trauma',
      detail: 'Airway plan, drugs, blood products, warming and monitoring. Confirm the consultant anaesthetist.',
      notifySummary: `Anaesthetic preparation for ${c.code}`,
      duration: 480,
      dueIn: 720,
      requires: { kind: 'ventilator', label: 'Theatre ventilator' },
      onCompleteEvent: 'anaesthetic.ready',
    })
    const plan = this.addTask({
      caseId: c.id,
      department: 'surgical-team',
      job: 'confirm-plan',
      title: 'Confirm the operative plan',
      detail: 'Confirm the operative plan with the trauma leader and the theatre team.',
      notifySummary: `Operative plan confirmation for ${c.code}`,
      duration: 180,
      dueIn: 360,
      onCompleteEvent: 'operative.plan.confirmed',
    })
    const nursing = this.addTask({
      caseId: c.id,
      department: 'theatre-nursing',
      job: 'prepare-theatre',
      title: 'Prepare theatre and instrument counts',
      detail: 'Trolley, instrument set, diathermy, suction and counts. Confirm the theatre is set and staffed.',
      notifySummary: `Theatre preparation for ${c.code}`,
      duration: 420,
      dueIn: 600,
      dependsOn: [theatreAssign.id],
    })
    const supplies = this.addTask({
      caseId: c.id,
      department: 'sterile-supplies',
      job: 'release-set',
      title: 'Release the major trauma instrument set',
      detail: 'Release CSSD-SET-1 and confirm the implants and consumables for a damage control laparotomy.',
      notifySummary: `Instrument set for ${c.code}`,
      duration: 240,
      dueIn: 480,
      requires: { kind: 'supplies', label: 'Sterile instrument set' },
      onCompleteEvent: 'supplies.ready',
    })
    const bloodIssue = this.addTask({
      caseId: c.id,
      department: 'blood-bank',
      job: 'issue-theatre',
      title: 'Issue 4 units to theatre',
      detail: 'Cross-match and release 4 units of red cells and 2 units of plasma to theatre before the patient arrives.',
      notifySummary: `Theatre blood units for ${c.code}`,
      duration: 300,
      dueIn: 600,
      requires: { id: 'BLOOD-O-NEG', kind: 'blood', label: 'Red cell units' },
      onCompleteEvent: 'theatre.blood.ready',
    })
    const pharmacy = this.addTask({
      caseId: c.id,
      department: 'pharmacy',
      job: 'prepare-medicines',
      title: 'Prepare theatre medicines',
      detail: 'Prepare and check the authorised emergency medicines, including high-risk items, and deliver to theatre.',
      notifySummary: `Theatre medicines for ${c.code}`,
      duration: 240,
      dueIn: 480,
      dependsOn: [plan.id],
      onCompleteEvent: 'medicines.ready',
    })
    const icuReserve = this.addTask({
      caseId: c.id,
      department: 'icu',
      job: 'reserve-bed',
      title: 'Reserve ICU bed for the postoperative admission',
      detail: 'Identify a bed, ventilator and staffing for a ventilated postoperative patient, and record the reservation.',
      notifySummary: `ICU bed reservation for ${c.code}`,
      duration: 240,
      dueIn: 480,
      requires: { kind: 'icu-bed', label: 'ICU bed' },
      onCompleteEvent: 'icu.reserved',
    })
    this.addTask({
      caseId: c.id,
      department: 'icu-nursing',
      job: 'prepare-nurse',
      title: 'Prepare the receiving ICU nurse',
      detail: 'Identify the receiving nurse and prepare the bed space plan for the postoperative admission.',
      notifySummary: `ICU nursing plan for ${c.code}`,
      duration: 300,
      dueIn: 600,
      dependsOn: [icuReserve.id],
    })
    this.addTask({
      caseId: c.id,
      department: 'bed-management',
      job: 'reserve-destination',
      title: 'Reserve the downstream bed',
      detail: 'Reserve the ICU bed against other demand and record the reservation reference.',
      notifySummary: `Downstream bed reservation for ${c.code}`,
      duration: 180,
      dueIn: 420,
      dependsOn: [icuReserve.id],
    })
    const porter = this.addTask({
      caseId: c.id,
      department: 'portering',
      job: 'prepare-theatre-transfer',
      title: 'Prepare the theatre transfer team',
      detail: 'Assign a porter team to the theatre transfer and confirm the route and the lift.',
      notifySummary: `Theatre transfer team for ${c.code}`,
      duration: 120,
      dueIn: 300,
      requires: { kind: 'porter', label: 'Porter team' },
    })
    this.addTask({
      caseId: c.id,
      department: 'command',
      job: 'coordinate-readiness',
      title: 'Coordinate theatre and ICU readiness',
      detail: 'Track readiness across theatre, anaesthetics, blood, pharmacy and ICU; raise anything that will miss the target.',
      notifySummary: `Readiness coordination for ${c.code}`,
      duration: 300,
      dueIn: 480,
    })
    const checklistDecision = this.requestDecision({
      caseId: c.id,
      title: 'Surgical safety checklist',
      question: `Complete the surgical safety checklist for ${c.code} before the patient leaves the emergency department?`,
      clinical: true,
      options: [
        { id: 'confirm', label: 'All checks complete: proceed to theatre', consequence: 'The transfer to theatre is released and portering is dispatched.' },
        { id: 'hold', label: 'Hold in the emergency department', consequence: 'The patient stays in resuscitation until the checks are complete and the transfer wait is recorded.' },
      ],
      authorisedRoles: ['surgeon', 'anaesthetist', 'theatre-nurse'],
      dueIn: 600,
      unlocks: 'safety.check.complete',
      optionEvents: { confirm: 'safety.check.complete', hold: 'safety.check.hold' },
      department: 'surgical-team',
      taskTitle: 'Surgical safety checklist (WHO-style)',
      taskDetail: 'Identity, site, consent, allergies, airway, blood availability, instrumentation and staffing must be confirmed by the team.',
      sensitive: true,
    })
    this.addTask({
      caseId: c.id,
      department: 'surgical-team',
      job: 'transfer-gate',
      title: 'Transfer patient to theatre',
      detail: 'The transfer gate: it opens only when the theatre is allocated, anaesthesia, nursing, blood, ICU and portering are ready, and the safety checklist is complete.',
      notifySummary: `Theatre transfer gate for ${c.code}`,
      duration: 60,
      dueIn: 900,
      dependsOn: [theatreAssign.id, anaesthetic.id, nursing.id, supplies.id, bloodIssue.id, pharmacy.id, icuReserve.id, porter.id, checklistDecision.taskId ?? ''].filter((id) => id !== ''),
      onCompleteEvent: 'transfer.to.theatre',
    })
  }
}

// ---------------------------------------------------------------- recovery options

const FAULT_LABELS: Record<FaultKind, string> = {
  'theatre-unavailable': 'No operating theatre available',
  'blood-delay': 'Blood supply delayed',
  'icu-shortage': 'ICU bed shortage',
  'missed-acknowledgement': 'Critical notification not acknowledged',
  'ambulance-delay': 'Ambulance arrival delayed',
  'ct-unavailable': 'CT scanner unavailable',
  'staff-unavailable': 'Required staff member unavailable',
  'plan-change': 'Patient status or treatment plan changed',
}

function recoveryOptions(requirement: TaskRequirement, task: Task, state: SimState): RecoveryOption[] {
  const options: RecoveryOption[] = []
  const commander = 'commander'
  switch (requirement.kind) {
    case 'theatre': {
      const candidate =
        state.resources.find((resource) => resource.kind === 'theatre' && resource.state === 'awaiting_release' && resource.id !== task.resourceId) ??
        state.resources.find((resource) => resource.kind === 'theatre' && resource.state !== 'available' && resource.id !== task.resourceId)
      options.push({
        id: 'use-alternative-theatre',
        label: candidate ? `Use ${candidate.name} after its turnaround` : 'Use the day surgery theatre',
        consequence: 'The theatre coordinator re-plans preparation and tells anaesthetics, surgery and nursing of the new theatre.',
        requiresRoles: ['theatre-coordinator', commander],
        effect: `use:${candidate?.id ?? 'THEATRE-3'}`,
        applied: false,
      })
      options.push({
        id: 'wait-theatre',
        label: 'Accept a 25 minute delay and keep the current plan',
        consequence: 'Theatre, anaesthetics, ICU and portering are told the new time; the patient stays in resuscitation.',
        requiresRoles: ['theatre-coordinator', commander],
        effect: 'wait:25',
        applied: false,
      })
      options.push({
        id: 'transfer-out',
        label: 'Transfer the case to the tertiary centre',
        consequence: 'The local pathway is cancelled and every downstream task records the transfer. Only for an authorised operational decision.',
        requiresRoles: [commander],
        effect: 'external-transfer',
        applied: false,
      })
      return options
    }
    case 'ct': {
      const candidate = state.resources.find((resource) => resource.kind === 'ct' && resource.state !== 'available' && resource.id !== task.resourceId)
      options.push({
        id: 'use-alternative-ct',
        label: candidate ? `Use ${candidate.name}` : 'Use the second scanner',
        consequence: 'Radiology re-plans the slot and portering is re-timed.',
        requiresRoles: ['radiographer', commander],
        effect: `use:${candidate?.id ?? 'CT-2'}`,
        applied: false,
      })
      options.push({
        id: 'wait-ct',
        label: 'Wait 20 minutes for the scanner',
        consequence: 'The trauma team is told the new time; imaging and the surgical decision are delayed.',
        requiresRoles: ['radiographer', commander],
        effect: 'wait:20',
        applied: false,
      })
      return options
    }
    case 'icu-bed': {
      options.push({
        id: 'repurpose-hdu',
        label: 'Repurpose a high dependency bay for this admission',
        consequence: 'ICU confirms an HDU-level bed; the theatre transfer can proceed with a documented capacity override.',
        requiresRoles: ['icu-coordinator', commander],
        effect: 'repurpose:hdu',
        applied: false,
      })
      const freeable =
        state.resources.find((resource) => resource.kind === 'icu-bed' && resource.state === 'awaiting_release') ??
        state.resources.find((resource) => resource.kind === 'icu-bed' && resource.state !== 'available')
      options.push({
        id: 'expedite-discharge',
        label: freeable ? `Expedite the discharge review for ${freeable.name}` : 'Expedite a discharge review',
        consequence: 'Bed management and ICU free the bed now; the patient transferred out is recorded in the audit trail.',
        requiresRoles: ['bed-manager', 'icu-coordinator'],
        effect: `free:${freeable?.id ?? 'ICU-04'}`,
        applied: false,
      })
      options.push({
        id: 'hold-in-theatre',
        label: 'Keep the patient in theatre recovery for 20 minutes',
        consequence: 'The ICU admission is delayed; anaesthetics and portering are told the revised time.',
        requiresRoles: ['icu-coordinator', commander],
        effect: 'wait:20',
        applied: false,
      })
      return options
    }
    case 'blood': {
      options.push({
        id: 'emergency-release',
        label: 'Authorise emergency O negative release',
        consequence: 'Uncross-matched units are released under clinical authorisation and the transfusion is recorded.',
        requiresRoles: ['trauma-leader', 'surgeon', commander],
        effect: `release:${requirement.id ?? 'BLOOD-O-NEG'}`,
        applied: false,
      })
      options.push({
        id: 'activate-donors',
        label: 'Activate the on-site donor pool and accept a 20 minute delay',
        consequence: 'The blood bank starts an additional supply route; theatre and anaesthetics are told the new time.',
        requiresRoles: ['blood-bank-tech', commander],
        effect: 'wait:20',
        applied: false,
      })
      return options
    }
    case 'ventilator': {
      options.push({
        id: 'borrow-ventilator',
        label: 'Borrow the ICU ventilator',
        consequence: 'Anaesthetics re-checks the borrowed ventilator and records its asset number.',
        requiresRoles: ['anaesthetist', commander],
        effect: 'use:VENT-2',
        applied: false,
      })
      return options
    }
    case 'supplies': {
      options.push({
        id: 'use-alternative-set',
        label: 'Release the alternative sterile set',
        consequence: 'The supplies officer confirms traceability for the replacement set.',
        requiresRoles: ['supplies-officer', commander],
        effect: 'use:CSSD-SET-2',
        applied: false,
      })
      return options
    }
    case 'porter': {
      options.push({
        id: 'reassign-porter',
        label: 'Reassign the next porter team',
        consequence: 'Portering names the team and the pickup time; the destination is told.',
        requiresRoles: ['porter', commander],
        effect: 'use:PORTER-2',
        applied: false,
      })
      return options
    }
    case 'pharmacy': {
      options.push({
        id: 'use-urgent-fridge',
        label: 'Use the urgent medicines fridge',
        consequence: 'Pharmacy checks and dispatches the medicines from the urgent stock.',
        requiresRoles: ['pharmacist', commander],
        effect: 'use:PHARMACY-URGENT',
        applied: false,
      })
      return options
    }
    case 'crew': {
      options.push({
        id: 'use-second-crew',
        label: 'Assign the second ambulance crew',
        consequence: 'Dispatch re-tasks the next available crew and updates the ETA.',
        requiresRoles: ['dispatcher', commander],
        effect: 'use:AMB-214',
        applied: false,
      })
      return options
    }
    case 'lab': {
      options.push({
        id: 'use-second-analyser',
        label: 'Use the main laboratory analyser',
        consequence: 'The laboratory names the analyser and the revised turnaround time.',
        requiresRoles: ['lab-scientist', commander],
        effect: 'use:LAB-2',
        applied: false,
      })
      return options
    }
    default:
      options.push({
        id: 'accept-delay',
        label: 'Accept the delay and inform affected units',
        consequence: 'The delay is recorded and dependent tasks wait for the new time.',
        requiresRoles: [commander],
        effect: 'wait:15',
        applied: false,
      })
      return options
  }
}

export { DEPARTMENTS, ROLES, STAGES }
