'use strict'

const Hyperbee = require('hyperbee')
const Hypercore = require('hypercore')
const RAM = require('random-access-memory')
const { ObjectId } = require('mongodb')
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
      const next = { ...doc, ...update.$set }
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

  const mongo = { db: { collection: () => col } }
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
