// The routine write tools and remote reads against a stand-in for the api, as write-tools.test.js
// does for log_workout.
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRoutine, updateRoutine, deleteRoutineTool, setWeekSchedule, _resetRoutineWriteWindow } from '../src/routine-tools.js'
import { apiConfig } from '../src/api-client.js'
import { refresh, getState, getUser, remoteMode, _resetRemoteForTests } from '../src/state.js'

const TOKEN = 'tok.secret-value'

function stubApi(doc) {
  const s = { doc: structuredClone(doc), rev: 3, puts: [], gets: 0 }
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: 'not signed in' })
    if (req.url === '/api/me') return send(200, { user: { id: 'u1', name: 'Juan' } })
    if (req.url === '/api/data' && req.method === 'GET') { s.gets++; return send(200, { state: s.doc, rev: s.rev }) }
    if (req.url === '/api/data' && req.method === 'PUT') {
      let raw = ''
      for await (const c of req) raw += c
      const body = JSON.parse(raw)
      s.puts.push(body)
      if (s.conflictOnce) {
        s.conflictOnce = false
        s.doc = { ...s.doc, routines: [...s.doc.routines, { id: 'phone', name: 'From phone', ex: [{ id: '0025', sets: 3, reps: 5 }] }] }
        s.rev++
        return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      }
      if (body.baseRev !== s.rev) return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      s.doc = body.state
      s.rev++
      return send(200, { ok: true, rev: s.rev })
    }
    send(404, { error: 'not found' })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    s.server = server
    s.env = { OPENGYM_URL: `http://127.0.0.1:${server.address().port}`, OPENGYM_TOKEN: TOKEN }
    resolve(s)
  }))
}

const DOC = () => ({ unit: 'kg', workouts: [], routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0662', sets: 3, reps: 10, weight: 0, mode: 'reps', inc: 2 }] }], week: { 1: ['r1'] }, customEx: [], exWeights: {}, _wid: 'w1' })
let api
beforeEach(async () => { _resetRoutineWriteWindow(); api = await stubApi(DOC()) })
afterEach(() => api.server.close())
const ctx = () => ({ env: api.env })

describe('create_routine', () => {
  test('a calisthenics routine: reps, a range, a hold, cardio, scheduled next to what is there', async () => {
    const r = await createRoutine.handler({
      name: 'Calistenia A', emoji: '💪', weekdays: ['monday', 'thursday'],
      exercises: [
        { exercise: '0684', minutes: 10 },
        { exercise: '0662', sets: 4, reps: 12, rest_sec: 90 },
        { exercise: '0652', sets: 3, reps_min: 5, reps: 8 },
        { exercise: '0463', sets: 3, seconds: 45 },
      ],
    }, ctx())
    expect(r.problems).toBeUndefined()
    expect(r.saved).toBe(true)
    const saved = api.doc.routines.find(x => x.name === 'Calistenia A')
    expect(saved.id).not.toBe('new')
    expect(saved.emoji).toBe('💪')
    expect(saved.ex.map(e => e.id)[0]).toBe('0684')
    expect(saved.ex[0]).toMatchObject({ min: 10 })
    expect(saved.ex[1]).toMatchObject({ id: '0662', sets: 4, reps: 12, restSec: 90 })
    expect(saved.ex[2]).toMatchObject({ reps: 8, repsMin: 5 })
    expect(saved.ex[3]).toMatchObject({ mode: 'time', sec: 45 })
    expect(api.doc.week['1']).toEqual(['r1', saved.id])
    expect(api.doc.week['4']).toEqual([saved.id])
    expect(r.routine.weekdays).toEqual(['monday', 'thursday'])
    expect(api.puts[0].baseRev).toBe(3)
    expect(api.puts[0].baseWid).toBe('w1')
  })

  test('dry_run saves nothing; an ambiguous name and a taken name come back as problems', async () => {
    const dry = await createRoutine.handler({ name: 'X', exercises: [{ exercise: '0662', reps: 10 }], dry_run: true }, ctx())
    expect(dry.dry_run).toBe(true)
    expect(dry.routine.exercises[0].id).toBe('0662')
    expect(api.puts).toHaveLength(0)
    const bad = await createRoutine.handler({ name: 'Y', exercises: [{ exercise: 'zzqq frobnicate', reps: 10 }] }, ctx())
    expect(bad.saved).toBe(false)
    expect(bad.problems[0].field).toBe('exercises[0].exercise')
    const taken = await createRoutine.handler({ name: 'push', exercises: [{ exercise: '0662', reps: 10 }] }, ctx())
    expect(taken.problems[0].field).toBe('name')
    expect(api.puts).toHaveLength(0)
  })

  test('reps on cardio and minutes on a lift are refused', async () => {
    const r = await createRoutine.handler({ name: 'Z', exercises: [{ exercise: '0684', reps: 10 }, { exercise: '0662', minutes: 5 }] }, ctx())
    expect(r.problems).toHaveLength(2)
  })

  test('a 409 builds the routine again on top of the phone\'s write, keeping both', async () => {
    api.conflictOnce = true
    const r = await createRoutine.handler({ name: 'Calistenia B', exercises: [{ exercise: '0662', reps: 15 }] }, ctx())
    expect(r.saved).toBe(true)
    expect(api.doc.routines.map(x => x.name)).toEqual(['Push', 'From phone', 'Calistenia B'])
  })
})

describe('update_routine, delete_routine, set_week_schedule', () => {
  test('replacing the list keeps per-exercise settings on an exercise that stays', async () => {
    const r = await updateRoutine.handler({ routine: 'Push', name: 'Empuje', exercises: [{ exercise: '0662', sets: 5, reps: 15 }, { exercise: '0274', reps: 20 }] }, ctx())
    expect(r.saved).toBe(true)
    const p = api.doc.routines[0]
    expect(p.id).toBe('r1')
    expect(p.name).toBe('Empuje')
    expect(p.ex[0]).toMatchObject({ id: '0662', sets: 5, reps: 15, inc: 2 })
    expect(p.ex[1].id).toBe('0274')
  })

  test('an unknown routine lists the ones there are', async () => {
    const r = await updateRoutine.handler({ routine: 'Legs', name: 'x' }, ctx())
    expect(r.problems[0].candidates).toEqual([{ routine_id: 'r1', name: 'Push' }])
  })

  test('delete clears the weekdays naming it', async () => {
    const r = await deleteRoutineTool.handler({ routine: 'r1', confirm: true }, ctx())
    expect(r.deleted.name).toBe('Push')
    expect(api.doc.routines).toHaveLength(0)
    expect(api.doc.week['1']).toBeUndefined()
  })

  test('set_week_schedule sets the days given and leaves the others', async () => {
    const r = await setWeekSchedule.handler({ days: [{ day: 'wednesday', routines: ['Push'] }, { day: 'monday', routines: [] }] }, ctx())
    expect(api.doc.week).toEqual({ 3: ['r1'] })
    expect(r.week.wednesday).toEqual(['Push'])
  })
})

describe('remote reads', () => {
  const cwd = process.cwd()
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogmcp-')); process.chdir(dir); _resetRemoteForTests() })
  afterEach(() => { process.chdir(cwd); _resetRemoteForTests() })

  test('with no data directory, the profile comes from GET /api/data and is cached briefly', async () => {
    expect(remoteMode(api.env)).toBe(true)
    await refresh({ env: api.env })
    expect(getUser()).toMatchObject({ id: 'u1', name: 'Juan' })
    expect(getState().routines[0].name).toBe('Push')
    await refresh({ env: api.env })
    expect(api.gets).toBe(1)
    await refresh({ env: api.env, force: true })
    expect(api.gets).toBe(2)
  })

  test('OPENGYM_REMOTE=1 turns remote reads on with just a URL; an explicit OPENGYM_DATA still wins', () => {
    expect(remoteMode({ OPENGYM_URL: api.env.OPENGYM_URL, OPENGYM_REMOTE: '1' })).toBe(true)
    expect(remoteMode({ ...api.env, OPENGYM_REMOTE: '1', OPENGYM_DATA: dir })).toBe(false)
  })

  test('OPENGYM_TOKEN_FILE stands in for OPENGYM_TOKEN', () => {
    const f = path.join(dir, 'tok')
    fs.writeFileSync(f, TOKEN + '\n')
    expect(apiConfig({ OPENGYM_URL: api.env.OPENGYM_URL, OPENGYM_TOKEN_FILE: f }).token).toBe(TOKEN)
  })
})
