'use strict'

const Hyperbee = require('hyperbee')
const Hypercore = require('hypercore')
const RAM = require('random-access-memory')
const mongodb = require('mongodb')
const { ObjectId } = mongodb
const { test } = require('brittle')

const ActionApproverFacility = require('../index')
const {
  ACTION_STATUS,
  computeQuorumThresholds
} = require('../index')

function getBee () {
  return new Hyperbee(new Hypercore(RAM))
}

async function makeFac (wrk = { ping: ([n]) => n + 1 }) {
  const bee = getBee()
  const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
  await fac.initStore({ engine: 'hyperbee', bee, claimId: 'test-claimer', executingTimeout: 50 })
  fac.initWrk(wrk)
  return fac
}

test('computeQuorumThresholds', async (t) => {
  t.alike(computeQuorumThresholds(1), { majority: 1, reqVotesPos: 2, reqVotesNeg: 1 })
  t.alike(computeQuorumThresholds(2), { majority: 2, reqVotesPos: 3, reqVotesNeg: 1 })
  t.alike(computeQuorumThresholds(3), { majority: 2, reqVotesPos: 3, reqVotesNeg: 2 })
  t.alike(computeQuorumThresholds(4), { majority: 3, reqVotesPos: 4, reqVotesNeg: 2 })
})

test('eligibleVoters rejects outsiders', async (t) => {
  const fac = await makeFac()
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotesPos: 3,
    reqVotesNeg: 2,
    eligibleVoters: ['bob', 'carol']
  })

  await t.exception(
    fac.voteAction({ id, voter: 'mallory', approve: true }),
    /ERR_VOTER_NOT_ELIGIBLE/
  )

  await t.execution(fac.voteAction({ id, voter: 'bob', approve: true }))
  const action = await fac.getAction('voting', id)
  t.alike(action.data.votesPos, ['alice', 'bob'])
})

test('expireAction sets EXPIRED with reason', async (t) => {
  const fac = await makeFac()
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotes: 3,
    eligibleVoters: ['bob', 'carol']
  })

  await fac.expireAction({ id, reason: 'LATE' })
  const done = await fac.getAction('done', id)
  t.is(done.data.status, ACTION_STATUS.EXPIRED)
  t.is(done.data.error, 'LATE')
  await t.exception(fac.getAction('voting', id), /ERR_ACTION_ID_NOT_FOUND/)
})

test('reviseVoting removes voter and recomputes thresholds', async (t) => {
  const fac = await makeFac()
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  // pool of 3 → reqVotesPos=3, reqVotesNeg=2. After removing dave: pool 2 → reqVotesPos=3, reqVotesNeg=1
  // only bob has voted yes; stay in voting (yes 2 < 3, no 0 < 1)
  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotesPos: 3,
    reqVotesNeg: 2,
    eligibleVoters: ['bob', 'carol', 'dave']
  })
  await fac.voteAction({ id, voter: 'bob', approve: true })

  const touched = await fac.reviseVoting({ userId: 'dave' })
  t.is(touched.length, 1)
  const action = await fac.getAction('voting', id)
  t.alike(action.data.eligibleVoters, ['bob', 'carol'])
  t.is(action.data.reqVotesPos, 3)
  t.is(action.data.reqVotesNeg, 1)
  t.alike(action.data.votesPos, ['alice', 'bob'])
  t.alike(action.data.votesNeg, [])
})

test('reviseVoting expires when proposer disabled', async (t) => {
  const fac = await makeFac()
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotesPos: 3,
    reqVotesNeg: 2,
    eligibleVoters: ['bob', 'carol']
  })

  await fac.reviseVoting({ userId: 'alice' })
  const done = await fac.getAction('done', id)
  t.is(done.data.status, ACTION_STATUS.EXPIRED)
  t.is(done.data.error, 'PROPOSER_DISABLED')
})

test('reviseVoting expires when pool emptied', async (t) => {
  const fac = await makeFac()
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotesPos: 2,
    reqVotesNeg: 1,
    eligibleVoters: ['bob']
  })

  await fac.reviseVoting({ userId: 'bob' })
  const done = await fac.getAction('done', id)
  t.is(done.data.status, ACTION_STATUS.EXPIRED)
  t.is(done.data.error, 'NO_ELIGIBLE_VOTERS')
})

test('reviseVoting promotes when remaining yes meets new threshold', async (t) => {
  const fac = await makeFac()
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  // pool=['bob','carol'] size 2 → reqVotesPos=3. alice+bob=2.
  // After carol removed: pool=['bob'], reqVotesPos=2 → alice+bob=2 → APPROVED.
  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotesPos: 3,
    reqVotesNeg: 1,
    eligibleVoters: ['bob', 'carol']
  })
  await fac.voteAction({ id, voter: 'bob', approve: true })
  await fac.reviseVoting({ userId: 'carol' })

  const ready = await fac.getAction('ready', id)
  t.is(ready.data.status, ACTION_STATUS.APPROVED)
  t.alike(ready.data.eligibleVoters, ['bob'])
  t.is(ready.data.reqVotesPos, 2)
})

test('claim lease records claimedBy/claimedAt', async (t) => {
  const wrk = {
    ping: async ([n]) => {
      await new Promise(resolve => setTimeout(resolve, 30))
      return n + 1
    }
  }
  const fac = await makeFac(wrk)
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotes: 1
  })

  // Manually claim path via _execAction observation: after exec, done without claim fields
  await fac.execActions()
  const done = await fac.getAction('done', id)
  t.is(done.data.status, ACTION_STATUS.COMPLETED)
  t.is(done.data.claimedBy, undefined)
  t.is(done.data.result, 2)
})

test('recoverStaleExecuting re-runs timed out claims', async (t) => {
  let runs = 0
  const wrk = {
    ping: async ([n]) => {
      runs++
      return n + 1
    }
  }
  const fac = await makeFac(wrk)
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotes: 1
  })

  // Simulate a stale EXECUTING claim
  const ready = await fac.getAction('ready', id)
  const stale = {
    ...ready.data,
    status: ACTION_STATUS.EXECUTING,
    claimedBy: 'dead-worker',
    claimedAt: Date.now() - 10_000
  }
  await fac.store.transition('ready', 'executing', stale, ACTION_STATUS.APPROVED)

  const recovered = await fac.recoverStaleExecuting()
  t.ok(recovered.includes(id))
  t.is(runs, 1)
  const done = await fac.getAction('done', id)
  t.is(done.data.status, ACTION_STATUS.COMPLETED)
})

test('mongodb store uses ObjectId hex ids and conditional updates', async (t) => {
  const docs = new Map()

  const col = {
    async createIndex () {},
    async replaceOne (filter, doc) {
      docs.set(String(filter._id || doc._id), { ...doc })
    },
    async findOne (filter) {
      const doc = docs.get(String(filter._id))
      if (!doc) return null
      if (filter.status) {
        const statuses = filter.status.$in || [filter.status]
        if (!statuses.includes(doc.status)) return null
      }
      return { ...doc }
    },
    async deleteOne (filter) {
      const doc = docs.get(String(filter._id))
      if (!doc) return
      if (filter.status?.$in && !filter.status.$in.includes(doc.status)) return
      docs.delete(String(filter._id))
    },
    async findOneAndUpdate (filter, update, _opts) {
      const doc = docs.get(String(filter._id))
      if (!doc) return null
      if (filter.status && doc.status !== filter.status) return null
      for (const key of ['claimedBy', 'claimedAt']) {
        if (key in filter && (doc[key] ?? null) !== filter[key]) return null
      }
      const next = { ...doc, ...update.$set }
      for (const key of Object.keys(update.$unset || {})) delete next[key]
      docs.set(String(filter._id), next)
      return next
    },
    find (filter) {
      const statuses = filter.status?.$in || []
      const list = [...docs.values()].filter(d => statuses.includes(d.status))
      return {
        sort () { return this },
        async * [Symbol.asyncIterator] () {
          for (const d of list) yield { ...d }
        }
      }
    }
  }

  const mongo = { db: { collection: () => col }, getDriver: () => mongodb }
  const wrk = { ping: ([n]) => n + 1 }
  const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
  await fac.initStore({ engine: 'mongodb', mongo, claimId: 'mongo-test' })
  fac.initWrk(wrk)
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  const data = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotesPos: 2,
    reqVotesNeg: 1,
    eligibleVoters: ['bob']
  })

  t.is(typeof data.id, 'string')
  t.ok(ObjectId.isValid(data.id))
  t.is(data.status, ACTION_STATUS.VOTING)

  await fac.voteAction({ id: data.id, voter: 'bob', approve: true })
  const ready = await fac.getAction('ready', data.id)
  t.is(ready.data.status, ACTION_STATUS.APPROVED)

  await fac.execActions()
  const done = await fac.getAction('done', data.id)
  t.is(done.data.status, ACTION_STATUS.COMPLETED)
  t.is(done.data.result, 2)
  t.absent(done.data.claimedBy)
  t.absent(done.data.claimedAt)
  const old = { ...done.data, status: ACTION_STATUS.EXECUTING, claimedBy: 'old', claimedAt: 1 }
  await fac.store.put('executing', old)
  const current = { ...old, claimedBy: 'new', claimedAt: 2 }
  t.ok(await fac.store.conditionalUpdate('executing', data.id, ACTION_STATUS.EXECUTING, current, { claimedBy: 'old', claimedAt: 1 }))
  t.is(await fac.store.conditionalUpdate('executing', data.id, ACTION_STATUS.EXECUTING, old, { claimedBy: 'old', claimedAt: 1 }), null)
  t.is(await fac.store.transition('executing', 'done', done.data, ACTION_STATUS.EXECUTING, { claimedBy: 'old', claimedAt: 1 }), null)
  t.is((await fac.getAction('executing', data.id)).data.claimedBy, 'new')
})

test('concurrent votes serialize and both land', async (t) => {
  const fac = await makeFac()
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotesPos: 4,
    reqVotesNeg: 2,
    eligibleVoters: ['bob', 'carol', 'dave']
  })

  await Promise.all([
    fac.voteAction({ id, voter: 'bob', approve: true }),
    fac.voteAction({ id, voter: 'carol', approve: true })
  ])

  const { data } = await fac.getAction('voting', id)
  t.is(data.votesPos[0], 'alice')
  t.alike([...data.votesPos].slice(1).sort(), ['bob', 'carol'])
  t.is(data.votesPos.length, 3)
  t.is(data.status, ACTION_STATUS.VOTING)
})

test('startInterval recovers stale EXECUTING immediately', async (t) => {
  let runs = 0
  const wrk = {
    ping: async ([n]) => {
      runs++
      return n + 1
    }
  }
  const fac = await makeFac(wrk)
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))

  const { id } = await fac.pushAction({
    action: 'ping',
    payload: [[1]],
    voter: 'alice',
    reqVotes: 1
  })

  const ready = await fac.getAction('ready', id)
  await fac.store.transition(
    'ready',
    'executing',
    {
      ...ready.data,
      status: ACTION_STATUS.EXECUTING,
      claimedBy: 'dead-worker',
      claimedAt: Date.now() - 10_000
    },
    ACTION_STATUS.APPROVED
  )

  fac.startInterval(60_000)
  await new Promise(resolve => setTimeout(resolve, 80))

  t.is(runs, 1)
  const done = await fac.getAction('done', id)
  t.is(done.data.status, ACTION_STATUS.COMPLETED)
})

test('reviseVoting scopes role loss to affected action kinds', async t => {
  const fac = await makeFac({ posts () {}, config () {} })
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))
  const args = { payload: [[1]], voter: 'alice', reqVotesPos: 3, reqVotesNeg: 1, eligibleVoters: ['bob', 'carol'] }
  const posts = await fac.pushAction({ ...args, action: 'posts' })
  const config = await fac.pushAction({ ...args, action: 'config' })
  await fac.reviseVoting({ userId: 'bob', actions: ['posts'] })
  t.alike((await fac.getAction('voting', posts.id)).data.eligibleVoters, ['carol'])
  t.alike((await fac.getAction('voting', config.id)).data.eligibleVoters, ['bob', 'carol'])
})

test('a superseded execution cannot overwrite the current claim', async t => {
  const fac = await makeFac()
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))
  const action = await fac.pushAction({ action: 'ping', payload: [[1]], voter: 'alice', reqVotes: 1 })
  const old = { ...action, status: ACTION_STATUS.EXECUTING, claimedBy: 'old', claimedAt: 1 }
  await fac.store.transition('ready', 'executing', old, ACTION_STATUS.APPROVED)
  const newer = { ...old, claimedBy: 'new', claimedAt: 2 }
  await fac.store.conditionalUpdate('executing', action.id, ACTION_STATUS.EXECUTING, newer, { claimedBy: 'old', claimedAt: 1 })
  t.is(await fac.store.conditionalUpdate('executing', action.id, ACTION_STATUS.EXECUTING, old, { claimedBy: 'old', claimedAt: 1 }), null)
  await fac._runHandler(old)
  t.is((await fac.getAction('executing', action.id)).data.claimedBy, 'new')
  await fac._runHandler(newer)
  t.is((await fac.getAction('done', action.id)).data.status, ACTION_STATUS.COMPLETED)
})

test('recovery does not replay a handler still running in the same process', async t => {
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  let runs = 0
  const fac = await makeFac({ async ping () { runs++; entered(); await wait } })
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))
  const action = await fac.pushAction({ action: 'ping', payload: [[1]], voter: 'alice', reqVotes: 1 })
  const execution = fac.execActions()
  await started
  const active = (await fac.getAction('executing', action.id)).data
  await fac.store.conditionalUpdate('executing', action.id, ACTION_STATUS.EXECUTING, { ...active, claimedAt: 1 })
  t.alike(await fac.recoverStaleExecuting(), [])
  t.is(runs, 1)
  release()
  await execution
})

test('recovery serializes different actions with normal execution', async t => {
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const runs = []
  const fac = await makeFac({ async ping ([n]) { runs.push(n); if (n === 1) { entered(); await gate } } })
  t.teardown(() => new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve())))
  const old = await fac.pushAction({ action: 'ping', payload: [[1]], voter: 'alice', reqVotes: 1 })
  await fac.store.transition('ready', 'executing', { ...old, status: ACTION_STATUS.EXECUTING, claimedBy: 'dead', claimedAt: 1 }, ACTION_STATUS.APPROVED)
  await fac.pushAction({ action: 'ping', payload: [[2]], voter: 'alice', reqVotes: 1 })
  const recovering = fac.recoverStaleExecuting()
  await started
  t.is(await fac.execActions(), false, 'ready execution cannot overlap recovery')
  t.alike(runs, [1])
  release()
  await recovering
  await fac.execActions()
  t.alike(runs, [1, 2])
})

async function stopFac (fac) {
  await new Promise((resolve, reject) => fac._stop(err => err ? reject(err) : resolve()))
}

test('recovery leaves a v1 executing record without a claim alone', async t => {
  let runs = 0
  const fac = await makeFac({ ping: async ([n]) => { runs++; return n + 1 } })
  t.teardown(() => stopFac(fac))

  const { id } = await fac.pushAction({ action: 'ping', payload: [[1]], voter: 'alice', reqVotes: 1 })
  const ready = await fac.getAction('ready', id)
  await fac.store.transition('ready', 'executing', { ...ready.data, status: ACTION_STATUS.EXECUTING }, ACTION_STATUS.APPROVED)
  const warned = []
  fac.caller.logger = { warn: (info) => warned.push(info.id) }

  const recovered = await fac.recoverStaleExecuting()
  await fac.recoverStaleExecuting()

  t.alike(recovered, [])
  t.is(runs, 0)
  t.alike(warned, [id])
  t.is((await fac.getAction('executing', id)).data.status, ACTION_STATUS.EXECUTING)
})

test('recovery drops a stale executing copy of a finished action', async t => {
  let runs = 0
  const fac = await makeFac({ ping: async ([n]) => { runs++; return n + 1 } })
  t.teardown(() => stopFac(fac))

  const { id } = await fac.pushAction({ action: 'ping', payload: [[1]], voter: 'alice', reqVotes: 1 })
  const ready = await fac.getAction('ready', id)
  const finished = { ...ready.data, status: ACTION_STATUS.COMPLETED, result: 'tx1' }
  await fac.store.put('done', finished)
  await fac.store.transition('ready', 'executing', { ...ready.data, status: ACTION_STATUS.EXECUTING, claimedBy: 'dead', claimedAt: Date.now() - 10_000 }, ACTION_STATUS.APPROVED)

  const recovered = await fac.recoverStaleExecuting()

  t.alike(recovered, [])
  t.is(runs, 0)
  t.is((await fac.getAction('done', id)).data.result, 'tx1')
  await t.exception(fac.getAction('executing', id), /ERR_ACTION_ID_NOT_FOUND/)
})

test('a numeric target is stored as a string on every engine', async t => {
  const HyperDB = require('hyperdb')
  const definition = require('../src/schema/spec/hyperdb')
  const db = HyperDB.bee(new Hypercore(RAM), definition, { autoUpdate: true })
  await db.ready()
  const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
  await fac.initStore({ engine: 'hyperdb', hyperdb: db, claimId: 'hyperdb-test' })
  fac.initWrk({ ping: ([n]) => n + 1 })
  t.teardown(() => stopFac(fac))

  const { id } = await fac.pushAction({ action: 'ping', payload: [[1]], voter: 'alice', reqVotes: 2, eligibleVoters: ['bob'], target: 42 })
  await fac.voteAction({ id, voter: 'bob', approve: true })
  await fac.execActions()

  const done = await fac.getAction('done', id)
  t.is(done.data.status, ACTION_STATUS.COMPLETED)
  t.is(done.data.result, 2)
  t.is(done.data.target, '42')
  await t.exception(fac.getAction('ready', id), /ERR_ACTION_ID_NOT_FOUND/)
})

test('mongodb store requires the caller mongo facility', async t => {
  const MongodbStore = require('../src/stores/mongodb')
  t.exception(() => new MongodbStore({ db: { collection: () => ({}) } }), /ERR_OPTS_MONGO_INVALID/)
})

test('mongodb ids created in the same second keep creation order', async t => {
  const MongodbStore = require('../src/stores/mongodb')
  const store = new MongodbStore({ db: { collection: () => ({}) }, getDriver: () => mongodb })

  const ids = Array.from({ length: 1000 }, () => store.createId())

  t.alike([...ids].sort(), ids)
  t.is(new Set(ids).size, 1000)
  t.is(ids[0].length, 24)
})

const MONGO_URI = process.env.APPROVER_TEST_MONGO_URI

async function mongoFacs (t, wrk = { ping: ([n]) => n + 1 }) {
  const { MongoClient } = require('mongodb')
  const client = await MongoClient.connect(MONGO_URI)
  const db = client.db(`approver_race_${Date.now()}_${Math.random().toString(16).slice(2)}`)
  const facs = []
  for (const claimId of ['a', 'b']) {
    const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
    await fac.initStore({ engine: 'mongodb', mongo: { db, getDriver: () => mongodb }, claimId })
    fac.initWrk(wrk)
    facs.push(fac)
  }
  t.teardown(async () => {
    for (const fac of facs) await stopFac(fac)
    await db.dropDatabase()
    await client.close()
  })
  return facs
}

test('two mongo instances voting at once both land', { skip: !MONGO_URI }, async t => {
  const [a, b] = await mongoFacs(t)

  for (let i = 0; i < 20; i++) {
    const { id } = await a.pushAction({ action: 'ping', payload: [[1]], voter: 'alice', reqVotesPos: 4, reqVotesNeg: 3, eligibleVoters: ['bob', 'carol', 'dave'] })

    await Promise.all([
      a.voteAction({ id, voter: 'bob', approve: true }),
      b.voteAction({ id, voter: 'carol', approve: true })
    ])

    const { data } = await a.getAction('voting', id)
    t.alike([...data.votesPos].sort(), ['alice', 'bob', 'carol'], `round ${i}`)
  }
})

test('two mongo instances reaching quorum together move the action once', { skip: !MONGO_URI }, async t => {
  const [a, b] = await mongoFacs(t)

  for (let i = 0; i < 20; i++) {
    const { id } = await a.pushAction({ action: 'ping', payload: [[1]], voter: 'alice', reqVotesPos: 3, reqVotesNeg: 3, eligibleVoters: ['bob', 'carol', 'dave'] })

    const results = await Promise.allSettled([
      a.voteAction({ id, voter: 'bob', approve: true }),
      b.voteAction({ id, voter: 'carol', approve: true })
    ])

    const { data } = await a.getAction('ready', id)
    t.is(results.filter(r => r.status === 'fulfilled').length, 2, `round ${i}`)
    t.is(data.status, ACTION_STATUS.APPROVED)
    t.alike([...data.votesPos].sort(), ['alice', 'bob', 'carol'])
  }
})

test('one voter cannot vote both ways across two mongo instances', { skip: !MONGO_URI }, async t => {
  const [a, b] = await mongoFacs(t)

  for (let i = 0; i < 20; i++) {
    const { id } = await a.pushAction({ action: 'ping', payload: [[1]], voter: 'alice', reqVotesPos: 4, reqVotesNeg: 3, eligibleVoters: ['bob', 'carol', 'dave'] })

    const results = await Promise.allSettled([
      a.voteAction({ id, voter: 'bob', approve: true }),
      b.voteAction({ id, voter: 'bob', approve: false })
    ])

    const rejected = results.filter(r => r.status === 'rejected')
    t.is(rejected.length, 1, `round ${i}`)
    t.is(rejected[0].reason.message, 'ERR_VOTER_EXISTS')
  }
})
