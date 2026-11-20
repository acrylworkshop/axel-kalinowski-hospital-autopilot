# Hospital Autopilot

An event-driven coordination and patient-flow prototype for a simulated major trauma centre. It is one Cordis plugin of this
app: the page at `/autopilot`, the API behind it, the orchestration engine, and the simulated clock. All patients, staff,
vehicles and results are synthetic; nothing is connected to a real clinical system.

Open it at `/autopilot` on the app's own server, or at `/app/autopilot` inside the ACRYL frame (`npm run dev`). Press
**Run major trauma scenario**. Five clinical gates then need a person in the **Decisions** tab (or the decision card on the
command centre): pre-alert, trauma CT, blood components, emergency surgery, the surgical safety checklist and the
postoperative destination. Approve them from a role that is authorised; the role switcher is in the left column.

## The files

| File | What it holds |
| --- | --- |
| `index.ts` | The plugin: its routes, the JSON API, the simulation interval, and the state file in the app's home (`autopilot-state.json`). |
| `model.ts` | The entities: case, task, notification, decision, escalation, dependency, resource, handover, fault, audit record, event, snapshot. |
| `catalog.ts` | The hospital as data: 24 units with responsibilities, needs, triggers, tasks, resources, dependencies, approvals, acknowledgement and escalation owner; 24 roles with permissions; the resource register; the pathway stages. |
| `engine.ts` | The orchestration engine: the event queue and rules, task lifecycle and dependencies, decisions, escalations, resource allocation and conflict handling, fault injection and recovery, predictions, and the role-filtered snapshot. |
| `page.ts` | The page shell and its styles. |
| `client.js` | The interface: command centre, department workspace, journey, coordination map, resources, alerts, decisions, intelligence, fault injection, audit. Served by the plugin, not bundled. |
| `screenshots/` | Captures of the running page (2026-05-12 shift, paused mid-pathway with two cases and two injected faults). |

State is written after every action and every second or so while the clock runs, through a temporary file and a rename. A
reload, a restart or a switch in Settings > Plugins keeps the case, the running clock and the audit trail.

## How it works

- **One authoritative state.** Every case, task and resource lives in one JSON state; the snapshot the page reads is derived
  from it, filtered by the acting role.
- **One ordered event queue.** A significant event (`prealert.sent`, `surgery.authorised`, `theatre.arrived`,
  `fault.injected`, `escalation.raised`, ...) is recorded with the units that subscribe to it, then drained in order. The
  rules turn an event into tasks, decisions, resource claims and further events. Nothing is driven by real time.
- **Simulated time only moves on `tick` and `step`.** Pausing stops it. A tick processes due timers (acknowledgements,
  preparation completion, patient arrival), checks acknowledgement and completion deadlines, and drains the queue.
  Department staff are simulated and act on their own when "Departments act automatically" is on; clinical gates never do.
- **Tasks have a lifecycle:** pending, notified, acknowledged, in progress, completed, blocked, escalated, cancelled. Delivery
  of a notification is recorded separately from its acknowledgement. Each task has an owner role, priority, due time,
  dependencies, an optional resource it must hold, a history, and an audit record for every transition.
- **Dependencies gate work.** A task with unmet dependencies waits (acknowledged, not started); completing the dependency
  starts it. The theatre transfer gate depends on theatre allocation, anaesthesia, theatre nursing, sterile supplies, blood,
  pharmacy, the ICU bed, the porter team and the safety checklist, so it cannot open while any of them is missing.
- **Resources are exclusive and shared.** Theatres, CT scanners, resuscitation bays, ICU beds, porters, ventilators, sterile
  sets, pharmacy stock and ambulance crews are claimed by the case that needs them. A task that cannot claim one blocks,
  with a reason, and opens an escalation that offers permitted alternatives (another theatre, an HDU bay, emergency blood
  release, a delay, a transfer out). The recovery is applied only by an authorised role and is audited.
- **Escalations are deduplicated.** One escalation per condition (per task, per acknowledgement deadline, per decision, per
  fault). A delivered notification that misses its acknowledgement deadline escalates to the unit's accountable role, and
  once only.
- **Clinical responsibility stays human.** The pre-alert, imaging, blood, surgery, the safety checklist and the destination
  are decisions with named authorised roles. The engine waits, escalates the wait, and records who decided what.
- **Roles are checked on the server.** The acting role's permissions gate every action; data minimisation redacts clinical
  details and sensitive task text for non-clinical workspaces (porter, bed manager, reception, family liaison).
- **Intelligence is deterministic.** Predictions separate a fact, a simulated prediction and a pending decision, each with
  the reason it appears and the coordination it recommends: likely surgical requirement (tentative, never a booking), imaging
  competition, ICU capacity risk before the transfer stage, late acknowledgements, handover risk.

## Extending it

- **A unit, a role, a resource:** add an entry to `catalog.ts`. The coordination map, the workspaces, the readiness view and
  the resource dashboard pick it up. Add a rule arm in `engine.ts` (`handleEvent`) for the events it should act on, and a
  `TaskSpec` for the work it does.
- **A hospital's own workflow:** the pathway is the stage list plus the rules; a different hospital (or a second site) is a
  second catalog and a second rule table. The engine already keys everything by case id and resource id, so several hospitals
  or sites can run side by side under one command view.
- **Real integrations:** the event queue is the seam. A simulation adapter publishes an event today; an FHIR or HL7 adapter
  would publish a patient update, an ambulance CAD adapter an ETA, a theatre management system a status change, and the same
  rules would run. Outbound, the same queue feeds an integration adapter instead of the screen (SIU scheduling, ADT, transfer
  of care). No clinical ordering is ever issued automatically.
- **A larger store:** state is one JSON file because this prototype has one active shift. Moving it to the app's `db` port
  keeps the engine's interface: load a snapshot, write a snapshot.

## Safety and scope

Synthetic data only. Operational coordination only: the prototype does not order treatment, change clinical instructions or
take a clinical decision. Every authorisation, override, resource move and escalation is written to an append-only audit
trail with the role that made it. The design keeps clinical and operational responsibility separate, so it can later be
reviewed against privacy, security and medical-device regulation with the real interfaces behind the adapters.
