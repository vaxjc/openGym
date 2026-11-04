/* The routine write tools: create_routine, update_routine, delete_routine and set_week_schedule.

   They write the way log_workout does (write-tools.js): read the profile from the server, change
   it, PUT it back with the revision it was read at, and on a 409 build the same change again on
   top of what the server sent. A new routine goes in through the plan importer (lib/plan-share.js
   parsePlan + mergePlan), so it is checked and shaped exactly like a routine someone shared, and a
   deletion goes through lib/routines.js deleteRoutine, which also clears the weekdays naming it. */
import { z } from 'zod'
import { invalidate } from './state.js'
import { apiConfig, apiFetch } from './api-client.js'
import { resolveExercise } from '../../frontend/src/lib/log-workout.js'
import { parsePlan, mergePlan } from '../../frontend/src/lib/plan-share.js'
import { deleteRoutine } from '../../frontend/src/lib/routines.js'
import { defaultConfig, exLine } from '../../frontend/src/lib/history.js'
import { isCardio, isHold, exOr } from '../../frontend/src/lib/exercises.js'

const MAX_ATTEMPTS = 3
export const ROUTINE_WRITE_LIMIT = 30
const WINDOW_MS = 60 * 60000
let saves = []
export const _resetRoutineWriteWindow = () => { saves = [] }

export const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
const DAY_NAMES = Object.keys(DAYS)
const dayName = i => DAY_NAMES.find(d => DAYS[d] === Number(i))

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

const slotSchema = z.object({
  exercise: z.string().min(1).max(120).describe('Exercise name ("push-up", "pull-up") or an id from an earlier answer. Ambiguous names come back as problems with candidates.'),
  sets: z.number().int().min(1).max(20).optional().describe('Number of sets (default 3; 1 for cardio).'),
  reps: z.number().int().min(1).max(1000).optional().describe('Target reps per set. With reps_min it is the top of a rep range.'),
  reps_min: z.number().int().min(1).max(1000).optional().describe('Bottom of a rep range ("8-12" is reps_min 8, reps 12): double progression.'),
  seconds: z.number().int().min(1).max(3600).optional().describe('Seconds per set, for a hold (plank, L-sit, dead hang). Makes the exercise timed.'),
  minutes: z.number().positive().max(600).optional().describe('Minutes, for a cardio exercise.'),
  speed: z.number().positive().max(100).optional().describe('Cardio target speed in km/h.'),
  weight: z.number().min(0).max(2000).optional().describe('Planned load in the profile\'s unit (0 or omitted for bodyweight; added weight for a weighted pull-up or dip).'),
  rest_sec: z.number().int().min(5).max(1800).optional().describe('This exercise\'s own rest between sets, in seconds. Omit to use the profile\'s rest timer.'),
})

const routineInput = {
  name: z.string().min(1).max(60).describe('Routine name, e.g. "Calistenia A" or "Push".'),
  emoji: z.string().max(8).optional().describe('One emoji for the routine card.'),
  exercises: z.array(slotSchema).min(1).max(40).describe('The exercises in order.'),
}

// One described slot as the routine config the app stores, or a problem to put to the user.
function slotOf(S, ex, at) {
  const hit = resolveExercise(S, ex.exercise)
  if (hit.problem) return { problem: { field: at + '.exercise', exercise: ex.exercise, problem: hit.problem, ...(hit.candidates ? { candidates: hit.candidates } : {}) } }
  const id = hit.id
  const cardio = isCardio(id) || (S.customEx || []).find(c => c?.id === id)?.bp === 'cardio'
  const mode = cardio ? 'cardio' : ex.seconds != null ? 'time' : (ex.reps != null || ex.reps_min != null) ? 'reps' : isHold(id) ? 'time' : 'reps'
  if (!cardio && (ex.minutes != null || ex.speed != null)) return { problem: { field: at, exercise: ex.exercise, problem: 'minutes and speed are for cardio exercises' } }
  if (cardio && (ex.reps != null || ex.seconds != null || ex.weight != null)) return { problem: { field: at, exercise: ex.exercise, problem: 'a cardio exercise is planned in minutes (and speed), not reps, seconds or weight' } }
  if (ex.seconds != null && ex.reps != null) return { problem: { field: at, exercise: ex.exercise, problem: 'give reps or seconds, not both' } }
  const cfg = { id, ...defaultConfig(id, mode) }
  if (ex.sets != null) cfg.sets = ex.sets
  if (mode === 'reps') {
    if (ex.reps != null) cfg.reps = ex.reps
    if (ex.reps_min != null) {
      if (ex.reps_min >= cfg.reps) return { problem: { field: at + '.reps_min', exercise: ex.exercise, problem: 'reps_min must be below reps (the top of the range)' } }
      cfg.repsMin = ex.reps_min
    }
  } else if (ex.reps_min != null) {
    return { problem: { field: at + '.reps_min', exercise: ex.exercise, problem: 'a rep range is for rep exercises' } }
  }
  if (mode === 'time' && ex.seconds != null) cfg.sec = ex.seconds
  if (mode === 'cardio') {
    if (ex.minutes != null) cfg.min = ex.minutes
    if (ex.speed != null) cfg.speed = ex.speed
  }
  if (mode !== 'cardio' && ex.weight != null) cfg.weight = ex.weight
  if (ex.rest_sec != null) cfg.restSec = ex.rest_sec
  return { cfg, resolved: { you_said: ex.exercise, id, name: hit.name, mode } }
}

function slotsOf(S, exercises) {
  const problems = [], cfgs = [], resolved = []
  exercises.forEach((ex, i) => {
    const r = slotOf(S, ex, `exercises[${i}]`)
    if (r.problem) problems.push(r.problem)
    else { cfgs.push(r.cfg); resolved.push(r.resolved) }
  })
  return problems.length ? { problems } : { cfgs, resolved }
}

// A routine read back in the words the app uses, so the user can check what was saved.
function routineView(S, r) {
  const unit = S.unit === 'lb' ? 'lb' : 'kg'
  const days = Object.entries(S.week || {}).filter(([, v]) => [].concat(v).includes(r.id)).map(([d]) => dayName(d)).filter(Boolean)
  return {
    routine_id: r.id,
    name: r.name,
    emoji: r.emoji || null,
    weekdays: days,
    exercises: (r.ex || []).map((cfg, i) => ({ position: i + 1, id: cfg.id, name: (S.customEx || []).find(c => c?.id === cfg.id)?.n || exOr(cfg.id)?.n || cfg.id, summary: exLine(cfg, unit) })),
  }
}

function findRoutine(S, ref) {
  const rs = S.routines || []
  const byId = rs.find(r => r.id === ref)
  if (byId) return { routine: byId }
  const key = String(ref || '').trim().toLowerCase()
  const named = rs.filter(r => String(r.name || '').trim().toLowerCase() === key)
  if (named.length === 1) return { routine: named[0] }
  if (named.length > 1) return { problem: 'several routines have this name; pass the routine_id', candidates: named.map(r => ({ routine_id: r.id, name: r.name })) }
  return { problem: 'no routine with that id or name', candidates: rs.map(r => ({ routine_id: r.id, name: r.name })) }
}

function addDays(S, id, weekdays) {
  S.week = S.week && typeof S.week === 'object' ? S.week : {}
  for (const d of weekdays || []) {
    const k = String(DAYS[d])
    const ids = [].concat(S.week[k] || [])
    if (!ids.includes(id)) S.week[k] = [...ids, id]
  }
}

/**
 * Read the profile, apply `change` to a copy, write it back. `change(S)` mutates S and returns
 * { problems } to stop without saving, or the result to answer with. Retried on a 409 against the
 * document the server sent back, so a phone syncing in between is never overwritten.
 */
export async function writeProfile(change, { dryRun = false, env = process.env, fetchImpl } = {}) {
  const cfg = apiConfig(env)
  const opts = fetchImpl ? { fetchImpl } : {}
  const now = Date.now()
  saves = saves.filter(t => now - t < WINDOW_MS)
  if (!dryRun && saves.length >= ROUTINE_WRITE_LIMIT) {
    throw fail('ERATE', `already ${ROUTINE_WRITE_LIMIT} routine changes in the last hour, the most taken in one go; nothing was saved`)
  }
  let got = await apiFetch(cfg, '/api/data', opts)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const doc = got.body?.state
    if (!doc || typeof doc !== 'object') throw fail('ENOSTATE', 'this profile has no synced data on the server yet: open openGym and sign in on a device once, then try again')
    const S = structuredClone(doc)
    S.routines = Array.isArray(S.routines) ? S.routines : []
    const res = change(S)
    if (res?.problems) return { saved: false, problems: res.problems, next: 'Nothing was saved. Settle these with the user and call again.' }
    if (dryRun) return { saved: false, dry_run: true, ...res }
    const put = await apiFetch(cfg, '/api/data', { ...opts, method: 'PUT', body: { state: S, baseRev: got.body.rev ?? 0, ...(typeof doc._wid === 'string' ? { baseWid: doc._wid } : {}) } })
    if (put.status !== 409) {
      invalidate()
      saves.push(now)
      return { saved: true, ...res, revision: put.body?.rev ?? null }
    }
    if (!put.body?.state || typeof put.body.state !== 'object' || typeof put.body.rev !== 'number') {
      throw fail('EAPI', 'the openGym server answered 409 without the current profile; nothing was saved')
    }
    got = { status: 200, body: { state: put.body.state, rev: put.body.rev } }
  }
  throw fail('ECONFLICT', 'another device kept writing this profile; nothing was saved. Try again in a moment.')
}

const weekdaysSchema = z.array(z.enum(DAY_NAMES)).max(7)

export const createRoutine = {
  name: 'create_routine',
  description: [
    'Create a new routine in the user\'s openGym plan (it syncs to all their devices). Use it to build a personalised routine from what list_workouts, estimate_1rm and muscle_balance show.',
    'Each exercise: sets plus reps (or reps_min..reps for a range), seconds for a hold, or minutes (and speed in km/h) for cardio; weight only for added load.',
    'Exercise names are matched like log_workout\'s: an ambiguous or unknown name comes back as problems with candidates and nothing is saved.',
    'weekdays puts it on those days of the weekly plan, next to whatever is already there. Call with dry_run: true first and show the user the result before saving.',
    'It always creates a new routine, never overwrites one; to change an existing routine use update_routine.',
  ].join(' '),
  schema: {
    ...routineInput,
    weekdays: weekdaysSchema.optional().describe('Days to schedule it on, e.g. ["monday", "thursday"].'),
    dry_run: z.boolean().optional().describe('Check and preview without saving.'),
  },
  handler: (p, ctx = {}) => writeProfile(S => {
    const built = slotsOf(S, p.exercises)
    if (built.problems) return built
    const unit = S.unit === 'lb' ? 'lb' : 'kg'
    const parsed = parsePlan({ opengym_plan: 1, unit, week: {}, routines: [{ id: 'new', name: p.name.trim(), ...(p.emoji ? { emoji: p.emoji } : {}), ex: built.cfgs }] }, unit)
    if (parsed.dropped) return { problems: [{ field: 'exercises', problem: `${parsed.dropped} exercise(s) are not in this app's library` }] }
    const taken = new Set(S.routines.map(r => String(r.name || '').trim().toLowerCase()))
    if (taken.has(p.name.trim().toLowerCase())) return { problems: [{ field: 'name', problem: 'a routine with this name already exists; pick another name or use update_routine' }] }
    const { ids } = mergePlan(S, parsed, { schedule: false })
    addDays(S, ids[0], p.weekdays)
    return { routine: routineView(S, S.routines.find(r => r.id === ids[0])), matched: built.resolved }
  }, { dryRun: p.dry_run === true, ...ctx }),
}

export const updateRoutine = {
  name: 'update_routine',
  description: [
    'Change an existing routine: rename it, change its emoji, or replace its exercise list (the whole list, in order: pass every exercise it should keep).',
    'Settings the app keeps per exercise (progression, increments, warm-ups) stay on any exercise that remains; sets, reps, time and weight become what you pass.',
    'Find the routine with list_routines / get_routine. Call with dry_run: true first and show the user the change.',
  ].join(' '),
  schema: {
    routine: z.string().min(1).describe('routine_id from list_routines, or the routine\'s exact name.'),
    name: routineInput.name.optional(),
    emoji: routineInput.emoji,
    exercises: routineInput.exercises.optional(),
    dry_run: z.boolean().optional(),
  },
  handler: (p, ctx = {}) => writeProfile(S => {
    const found = findRoutine(S, p.routine)
    if (found.problem) return { problems: [{ field: 'routine', problem: found.problem, candidates: found.candidates }] }
    const r = found.routine
    if (p.name != null) {
      const key = p.name.trim().toLowerCase()
      if (S.routines.some(x => x.id !== r.id && String(x.name || '').trim().toLowerCase() === key)) return { problems: [{ field: 'name', problem: 'another routine already has this name' }] }
      r.name = p.name.trim()
    }
    if (p.emoji != null) r.emoji = p.emoji
    let matched
    if (p.exercises) {
      const built = slotsOf(S, p.exercises)
      if (built.problems) return built
      const unit = S.unit === 'lb' ? 'lb' : 'kg'
      const parsed = parsePlan({ opengym_plan: 1, unit, week: {}, routines: [{ id: r.id, name: r.name, ex: built.cfgs }] }, unit)
      const old = new Map((r.ex || []).map(e => [e.id, e]))
      const prescribed = ['sets', 'reps', 'repsMin', 'repsMax', 'sec', 'min', 'speed', 'weight', 'restSec', 'mode', 'pyramid', 'pyramidRest', 'pyramidWeight']
      r.ex = parsed.routines[0].ex.map(e => {
        const prev = old.get(e.id)
        if (!prev) return e
        const kept = Object.fromEntries(Object.entries(prev).filter(([k]) => !prescribed.includes(k)))
        return { ...kept, ...e }
      })
      matched = built.resolved
    }
    return { routine: routineView(S, r), ...(matched ? { matched } : {}) }
  }, { dryRun: p.dry_run === true, ...ctx }),
}

export const deleteRoutineTool = {
  name: 'delete_routine',
  description: 'Delete a routine from the plan, and from every weekday that names it. Logged workouts done with it stay in the history. Only after the user confirms by name; pass confirm: true.',
  schema: {
    routine: z.string().min(1).describe('routine_id, or the routine\'s exact name.'),
    confirm: z.literal(true).describe('The user confirmed deleting this routine.'),
  },
  handler: (p, ctx = {}) => writeProfile(S => {
    const found = findRoutine(S, p.routine)
    if (found.problem) return { problems: [{ field: 'routine', problem: found.problem, candidates: found.candidates }] }
    S.week = S.week && typeof S.week === 'object' ? S.week : {}
    S.dayPlan = S.dayPlan && typeof S.dayPlan === 'object' ? S.dayPlan : {}
    deleteRoutine(S, found.routine.id)
    return { deleted: { routine_id: found.routine.id, name: found.routine.name } }
  }, ctx),
}

export const setWeekSchedule = {
  name: 'set_week_schedule',
  description: 'Set which routines are planned on given weekdays. Each day you pass gets exactly the routines listed (an empty list makes it a rest day); days you leave out stay as they are. Read the current plan with get_week_plan first.',
  schema: {
    days: z.array(z.object({
      day: z.enum(DAY_NAMES),
      routines: z.array(z.string().min(1)).max(5).describe('routine_ids or exact names, in order; [] for a rest day.'),
    })).min(1).max(7),
  },
  handler: (p, ctx = {}) => writeProfile(S => {
    S.week = S.week && typeof S.week === 'object' ? S.week : {}
    const problems = []
    const plan = p.days.map(({ day, routines }, i) => {
      const ids = []
      routines.forEach((ref, j) => {
        const f = findRoutine(S, ref)
        if (f.problem) problems.push({ field: `days[${i}].routines[${j}]`, problem: f.problem, candidates: f.candidates })
        else if (!ids.includes(f.routine.id)) ids.push(f.routine.id)
      })
      return [String(DAYS[day]), ids]
    })
    if (problems.length) return { problems }
    for (const [k, ids] of plan) {
      if (ids.length) S.week[k] = ids
      else delete S.week[k]
    }
    const names = id => S.routines.find(r => r.id === id)?.name || id
    const week = Object.fromEntries(DAY_NAMES.map(d => [d, [].concat(S.week[String(DAYS[d])] || []).map(names)]))
    return { week }
  }, ctx),
}

export const ROUTINE_TOOLS = [createRoutine, updateRoutine, deleteRoutineTool, setWeekSchedule]
