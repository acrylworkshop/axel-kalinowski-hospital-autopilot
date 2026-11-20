/**
 * Hospital Autopilot: the entities the orchestration engine works with.
 *
 * Everything here is plain JSON so the whole operational state can be written to one file in the app's home and read back
 * after a reload or a restart. Simulated time is an integer number of seconds since the shift opened; the wall clock is only
 * for display.
 */

/** The version of the persisted shape. A file from another version is discarded instead of being misread. */
export const STATE_VERSION = 3

export type Priority = 'P1' | 'P2' | 'P3'

export const TASK_STATUSES = [
  'pending',
  'notified',
  'acknowledged',
  'in_progress',
  'completed',
  'blocked',
  'escalated',
  'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export type TaskKind = 'prep' | 'clinical' | 'decision' | 'transport' | 'admin' | 'handover'

export type ResourceState = 'available' | 'reserved' | 'occupied' | 'unavailable' | 'awaiting_release'

export type Readiness = 'unknown' | 'notified' | 'preparing' | 'ready' | 'blocked'

/** A department's own view of a case: what it has been asked for and where that stands. */
export interface DepartmentReadiness {
  department: string
  readiness: Readiness
  detail: string
}

export interface TaskHistoryEntry {
  at: number
  status: TaskStatus
  actor: string
  note: string
}

/** A resource a task must hold before it can start; a missing one blocks the task and escalates. */
export interface TaskRequirement {
  kind: string
  label: string
  /** A specific resource, when the kind alone would do (blood units, a named scanner). */
  id?: string
}

export interface Task {
  id: string
  /** Deduplication key: one task per case, department and job. */
  key: string
  caseId: string | null
  department: string
  title: string
  detail: string
  /** What a non-clinical department is told: no clinical detail. */
  notifySummary: string
  priority: Priority
  kind: TaskKind
  status: TaskStatus
  ownerRole: string
  /** Simulated seconds of preparation once acknowledged. */
  duration: number
  createdAt: number
  /** Expected completion, for the SLA check. */
  dueAt: number
  /** A notification nobody acknowledged by then is escalated, once. */
  ackDueAt: number
  notifiedAt: number | null
  acknowledgedAt: number | null
  startedAt: number | null
  completedAt: number | null
  dependsOn: string[]
  requires: TaskRequirement | null
  /** The resource the task claimed when it started. */
  resourceId: string | null
  blockedReason: string | null
  escalationId: string | null
  decisionId: string | null
  /** The event the workflow emits once this task is completed. */
  onCompleteEvent: string | null
  /** False for a clinical gate: nothing auto-completes it. */
  auto: boolean
  /** Set by the "missed acknowledgement" fault. */
  suppressAutoAck: boolean
  sensitive: boolean
  history: TaskHistoryEntry[]
}

export type NotificationState = 'delivered' | 'acknowledged' | 'escalated'

export interface Notification {
  id: string
  taskId: string
  caseId: string | null
  department: string
  role: string
  subject: string
  body: string
  sentAt: number
  deliveredAt: number
  acknowledgedAt: number | null
  state: NotificationState
}

export interface DecisionOption {
  id: string
  label: string
  consequence: string
}

export type DecisionStatus = 'pending' | 'approved' | 'declined' | 'superseded'

/** A human authorisation. The workflow never resolves one of these on simulated time alone. */
export interface Decision {
  id: string
  caseId: string
  title: string
  question: string
  clinical: boolean
  options: DecisionOption[]
  authorisedRoles: string[]
  status: DecisionStatus
  createdAt: number
  dueAt: number
  decidedAt: number | null
  decidedBy: string | null
  selectedOption: string | null
  /** The workflow event an approval emits. */
  unlocks: string
  /** When an option leads somewhere other than {@link unlocks}. */
  optionEvents: Record<string, string>
  taskId: string | null
  escalationId: string | null
  note: string
}

export interface RecoveryOption {
  id: string
  label: string
  consequence: string
  requiresRoles: string[]
  /** The engine's key for what choosing this does. */
  effect: string
  applied: boolean
}

export type EscalationStatus = 'open' | 'acknowledged' | 'resolved'

export interface Escalation {
  id: string
  /** Deduplication key: one open escalation per condition. */
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
  status: EscalationStatus
  createdAt: number
  resolvedAt: number | null
  resolvedBy: string | null
  resolution: string | null
  options: RecoveryOption[]
  notified: { department: string; role: string; at: number }[]
}

export type FaultKind =
  | 'theatre-unavailable'
  | 'blood-delay'
  | 'icu-shortage'
  | 'missed-acknowledgement'
  | 'ambulance-delay'
  | 'ct-unavailable'
  | 'staff-unavailable'
  | 'plan-change'

export interface Fault {
  id: string
  kind: FaultKind
  label: string
  caseId: string | null
  createdAt: number
  detectedAt: number
  impact: string[]
  status: 'active' | 'recovering' | 'resolved'
  escalationId: string | null
  resolvedAt: number | null
  detail: string
}

export interface HandoverItem {
  id: string
  label: string
  confirmed: boolean
}

export interface Handover {
  id: string
  caseId: string
  from: string
  to: string
  createdAt: number
  status: 'pending' | 'accepted'
  acceptedAt: number | null
  acceptedBy: string | null
  checklist: HandoverItem[]
}

export interface CaseVitals {
  hr: number
  bp: string
  spo2: number
  gcs: number
}

export interface ClinicalCase {
  id: string
  code: string
  /** Which demonstration case this is, so the scenario is never created twice. */
  scenario: 'primary' | 'second'
  patientName: string
  age: number
  sex: string
  incidentSummary: string
  location: string
  mechanism: string
  casualties: number
  stage: string
  stageIndex: number
  status: 'incoming' | 'active' | 'stabilised' | 'closed'
  priority: Priority
  /** The pre-hospital estimate used when the pre-alert is sent. */
  etaSeconds: number
  dispatchedAt: number | null
  sceneAt: number | null
  prealertAt: number | null
  eta: number | null
  arrivedAt: number | null
  theatreAt: number | null
  icuAt: number | null
  vitals: CaseVitals
  injuries: string[]
  clinicalNotes: string
  operationalSummary: string
  plan: string
  destination: string
  surgicalDecision: 'none' | 'indicated' | 'authorised'
  theatreId: string | null
  icuBedId: string | null
  flags: string[]
}

export interface Resource {
  id: string
  name: string
  kind: string
  department: string
  state: ResourceState
  caseId: string | null
  note: string
  since: number
}

export interface AuditEntry {
  seq: number
  at: number
  actor: string
  role: string
  action: string
  subject: string
  caseId: string | null
  department: string | null
  detail: string
}

export interface OperationalEvent {
  seq: number
  at: number
  name: string
  caseId: string | null
  detail: string
  /** Which departments the event reached, and why. */
  reached: { department: string; reason: string }[]
}

export type TimerKind =
  | 'auto-ack'
  | 'auto-start'
  | 'auto-complete'
  | 'scene-arrival'
  | 'patient-arrival'
  | 'fault-trigger'

export interface SimTimer {
  id: string
  kind: TimerKind
  at: number
  ref: string
  detail: string
}

export interface SimState {
  version: number
  /** Simulated seconds since the shift opened. */
  clock: number
  running: boolean
  /** Simulated seconds added per tick. */
  tickSeconds: number
  /** How many ticks one real second is divided into. */
  tickIntervalMs: number
  ticks: number
  seed: number
  speed: number
  caseSeq: number
  taskSeq: number
  decisionSeq: number
  escalationSeq: number
  notificationSeq: number
  auditSeq: number
  eventSeq: number
  timerSeq: number
  handoverSeq: number
  faultSeq: number
  cases: ClinicalCase[]
  tasks: Task[]
  notifications: Notification[]
  decisions: Decision[]
  escalations: Escalation[]
  resources: Resource[]
  handovers: Handover[]
  faults: Fault[]
  audit: AuditEntry[]
  events: OperationalEvent[]
  timers: SimTimer[]
  role: string
  /** Roles whose staff are unavailable: their tasks block instead of progressing. */
  unavailableRoles: string[]
  /** Synthetic department staff acknowledge and prepare on their own. Clinical gates never do. */
  departmentAutomation: boolean
}

export type PredictionKind = 'fact' | 'prediction' | 'decision'

export interface Prediction {
  id: string
  kind: PredictionKind
  title: string
  detail: string
  why: string
  severity: 'info' | 'watch' | 'urgent'
  caseId: string | null
  department: string | null
  recommended: string
}

/** The stage list of the major trauma pathway. Order matters: the journey view walks it. */
export interface StageDefinition {
  id: string
  name: string
  units: string[]
}

export type Snapshot = {
  state: SimState
  stageDefinitions: StageDefinition[]
  predictions: Prediction[]
  readiness: Record<string, DepartmentReadiness[]>
  departmentView: DepartmentWorkView | null
  permissions: string[]
  role: RoleDefinition
  clock: string
  /** The simulated shift's wall-clock start, in seconds. */
  shiftStart: number
}

/** What one role needs to know, and may act on. */
export interface DepartmentWorkView {
  role: RoleDefinition
  department: DepartmentDefinition
  cases: {
    id: string
    code: string
    summary: string
    stage: string
    priority: Priority
    eta: string | null
    clinicalDetail: string | null
  }[]
  tasks: Task[]
  notifications: Notification[]
  decisions: Decision[]
  escalations: Escalation[]
  readiness: Readiness
  resourceSummary: { id: string; name: string; state: ResourceState; note: string }[]
  nextActions: string[]
}

export interface DepartmentDefinition {
  id: string
  name: string
  short: string
  group: string
  /** The role that owns this department's work. */
  role: string
  responsibilities: string[]
  /** Information the department needs to do its job. */
  needs: string[]
  /** Events that require this department's attention. */
  triggers: string[]
  /** The tasks it performs in the major trauma pathway. */
  taskTypes: string[]
  /** Resources it controls. */
  resources: string[]
  /** Departments it depends upon. */
  dependsOn: string[]
  /** Who authorises its actions. */
  approves: string[]
  /** How it acknowledges readiness. */
  acknowledges: string
  /** Who receives an escalation when it cannot deliver. */
  escalatesTo: string
  /** What its completion unblocks downstream. */
  downstream: string[]
}

export interface RoleDefinition {
  id: string
  name: string
  short: string
  department: string
  clinical: boolean
  permissions: string[]
}
