'use strict'

const Hyperbee = require('hyperbee')
const Hypercore = require('hypercore')
const RAM = require('random-access-memory')
const { test } = require('brittle')

const ActionApproverFacility = require('../index')
const { ACTION_STATUS } = require('../src/constants')
const { convIntToBin } = require('../src/utils')

test('action.approver.facility', async (t) => {
  const getBee = () => {
    const core = new Hypercore(RAM)
    const db = new Hyperbee(core)
    return db
  }

  await t.test('stop tests', async (t) => {
    const bee = getBee()
    const f1 = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
    await f1.initDb(bee)
    f1.initWrk({})

    t.is(f1.bee.closed, false)
    await new Promise((resolve, reject) => {
      f1.stop((err) => err ? reject(err) : resolve())
    })
    t.is(f1.bee.closed, true, 'should close bee')

    const f2 = new ActionApproverFacility({}, { ns: 'm0', interval: 20000 }, { env: 'test' })
    await f2.initDb(bee)
    f2.initWrk({})
    f2.startInterval()
    t.is(f2.itv._destroyed, false)

    await new Promise((resolve, reject) => {
      f2.stop((err) => err ? reject(err) : resolve())
    })
    t.is(f2.bee.closed, true, 'should close bee')
    t.is(f2.itv._destroyed, true, 'should close interval')
  })

  await t.test('pushAction tests', async (t) => {
    const bee = getBee()
    const wrk = { ping: (nonce) => nonce + 1 }
    const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
    await fac.initDb(bee)
    fac.initWrk(wrk)

    t.teardown(async () => {
      await new Promise((resolve, reject) => fac._stop((err) => err ? reject(err) : resolve()))
    })

    const data = { action: 'ping', payload: [1], voter: 'joe', reqVotes: 3 }

    let id = await fac.pushAction(data)
    t.is(typeof id, 'number', 'should return action id on success')
    let res = await fac.getAction('voting', id)
    t.alike(res.data, {
      id,
      action: 'ping',
      payload: [1],
      votesPos: ['joe'],
      votesNeg: [],
      reqVotesPos: 3,
      reqVotesNeg: 3,
      status: ACTION_STATUS.VOTING
    }, 'should store action as voting')

    id = await fac.pushAction({ ...data, reqVotes: undefined, reqVotesPos: 5, reqVotesNeg: 2 })
    res = await fac.getAction('voting', id)
    t.alike(res.data, {
      id,
      action: 'ping',
      payload: [1],
      votesPos: ['joe'],
      votesNeg: [],
      reqVotesPos: 5,
      reqVotesNeg: 2,
      status: ACTION_STATUS.VOTING
    }, 'should support different voting conditions for approval and rejection')

    id = await fac.pushAction({ ...data, reqVotes: undefined, reqVotesPos: 1, reqVotesNeg: 2 })
    res = await fac.getAction('ready', id)
    t.alike(res.data, {
      id,
      action: 'ping',
      payload: [1],
      votesPos: ['joe'],
      votesNeg: [],
      reqVotesPos: 1,
      reqVotesNeg: 2,
      status: ACTION_STATUS.APPROVED
    }, 'should auto approve action if it requires 1 vote')
  })

  await t.test('getAction tests', async (t) => {
    const bee = getBee()
    const wrk = { ping: (nonce) => nonce + 1 }
    const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
    await fac.initDb(bee)
    fac.initWrk(wrk)

    t.teardown(async () => {
      await new Promise((resolve, reject) => fac._stop((err) => err ? reject(err) : resolve()))
    })

    const id = Date.now()
    const key = convIntToBin(id)
    const tmpl = {
      id,
      action: 'ping',
      payload: [1],
      votesPos: ['joe'],
      votesNeg: [],
      reqVotesPos: 2,
      reqVotesNeg: 2,
      status: ACTION_STATUS.VOTING
    }

    const data = {
      voting: tmpl,
      ready: { ...tmpl, votesPos: ['joe', 'jane'], status: ACTION_STATUS.APPROVED },
      executing: { ...tmpl, votesPos: ['joe', 'jane'], status: ACTION_STATUS.EXECUTING },
      done: { ...tmpl, votesNeg: ['john', 'jane'], status: ACTION_STATUS.DENIED }
    }

    await fac.dbActVoting.put(key, fac._encode(data.voting))
    await fac.dbActReady.put(key, fac._encode(data.ready))
    await fac.dbActExec.put(key, fac._encode(data.executing))
    await fac.dbActDone.put(key, fac._encode(data.done))

    for (const subdb of ['voting', 'ready', 'executing', 'done']) {
      const res = await fac.getAction(subdb, id)
      await t.alike(res.data, data[subdb], `should fetch actions with ${subdb} type`)
    }
  })

  await t.test('query tests', async (t) => {
    const bee = getBee()
    const wrk = { ping: (nonce) => nonce + 1 }
    const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
    await fac.initDb(bee)
    fac.initWrk(wrk)

    t.teardown(async () => {
      await new Promise((resolve, reject) => fac._stop((err) => err ? reject(err) : resolve()))
    })

    const ids = [Date.now(), Date.now() + 3000]
    const keys = ids.map(convIntToBin)
    const data = ids.map((id, i) => ({
      id,
      action: 'ping',
      payload: [1],
      votesPos: ['joe'],
      votesNeg: [],
      reqVotesPos: 2 + i,
      reqVotesNeg: 2,
      status: ACTION_STATUS.VOTING
    }))

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      await fac.dbActVoting.put(key, fac._encode(data[i]))
    }

    let query = fac.query('voting')
    let res = []

    for await (const value of query) {
      res.push(value)
    }
    t.alike(res, data, 'by default should return all data')

    query = fac.query('voting', { gt: ids[0] })
    res = []
    for await (const value of query) {
      res.push(value)
    }
    t.alike(res, [data[1]], 'gt should allow only ids greater than')

    query = fac.query('voting', { gte: ids[1] })
    res = []
    for await (const value of query) {
      res.push(value)
    }
    t.alike(res, [data[1]], 'gte should allow only ids greater than or equal')

    query = fac.query('voting', { lt: ids[1] })
    res = []
    for await (const value of query) {
      res.push(value)
    }
    t.alike(res, [data[0]], 'lt should allow only ids less than')

    query = fac.query('voting', { lte: ids[0] })
    res = []
    for await (const value of query) {
      res.push(value)
    }
    t.alike(res, [data[0]], 'lte should allow only ids less than or equal')
  })

  await t.test('voteAction tests', async (t) => {
    const bee = getBee()
    const wrk = { ping: (nonce) => nonce + 1 }
    const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
    await fac.initDb(bee)
    fac.initWrk(wrk)

    t.teardown(async () => {
      await new Promise((resolve, reject) => fac._stop((err) => err ? reject(err) : resolve()))
    })

    const pushData = { action: 'ping', payload: [1], voter: 'joe', reqVotes: 3 }
    const tmpl = {
      action: 'ping',
      payload: [1],
      votesPos: ['joe'],
      votesNeg: [],
      reqVotesPos: 3,
      reqVotesNeg: 3,
      status: ACTION_STATUS.VOTING
    }

    let id = await fac.pushAction(pushData)
    t.is(typeof id, 'number', 'should return action id on success')

    await fac.voteAction({ id, voter: 'john', approve: 1 })

    let action = await fac.getAction('voting', id)
    t.alike(
      action.data,
      { ...tmpl, id, votesPos: ['joe', 'john'] },
      'vote action should push approve voter to votesPos'
    )

    await fac.voteAction({ id, voter: 'jane', approve: 0 })

    action = await fac.getAction('voting', id)
    t.alike(
      action.data,
      { ...tmpl, id, votesPos: ['joe', 'john'], votesNeg: ['jane'] },
      'vote action should push disapprove voter to votesNeg'
    )

    await fac.voteAction({ id, voter: 'mike', approve: 1 })

    action = await fac.getAction('ready', id)
    t.alike(
      action.data,
      { ...tmpl, id, votesPos: ['joe', 'john', 'mike'], votesNeg: ['jane'], status: ACTION_STATUS.APPROVED },
      'when approval condition is met status should be APPROVED and action should be moved to ready'
    )
    await t.exception(
      fac.getAction('voting', id),
      /ERR_ACTION_ID_NOT_FOUND/,
      'should remove action from voting uppon reaching approval condition'
    )

    id = await fac.pushAction(pushData)

    await fac.voteAction({ id, voter: 'john', approve: 0 })
    await fac.voteAction({ id, voter: 'jane', approve: 0 })
    await fac.voteAction({ id, voter: 'mike', approve: 0 })

    action = await fac.getAction('done', id)
    t.alike(
      action.data,
      { ...tmpl, id, votesPos: ['joe'], votesNeg: ['john', 'jane', 'mike'], status: ACTION_STATUS.DENIED },
      'when dissapproval condition is met status should be DENIED and action should be moved to done'
    )
    await t.exception(
      fac.getAction('voting', id),
      /ERR_ACTION_ID_NOT_FOUND/,
      'should remove action from voting uppon reaching dissapproval condition'
    )
  })

  await t.test('cancelAction tests', async (t) => {
    const bee = getBee()
    const wrk = { ping: (nonce) => nonce + 1 }
    const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
    await fac.initDb(bee)
    fac.initWrk(wrk)

    t.teardown(async () => {
      await new Promise((resolve, reject) => fac._stop((err) => err ? reject(err) : resolve()))
    })

    const pushData = { action: 'ping', payload: [1], voter: 'joe', reqVotes: 3 }
    const tmpl = {
      action: 'ping',
      payload: [1],
      votesPos: ['joe', 'mike'],
      votesNeg: ['jane'],
      reqVotesPos: 3,
      reqVotesNeg: 3,
      status: ACTION_STATUS.VOTING
    }

    const id = await fac.pushAction(pushData)
    t.is(typeof id, 'number', 'should return action id on success')
    tmpl.id = id

    await fac.voteAction({ id, voter: 'mike', approve: 1 })
    await fac.voteAction({ id, voter: 'jane', approve: 0 })

    let action = await fac.getAction('voting', id)
    t.alike(action.data, tmpl)

    await t.exception(
      fac.cancelAction({ id, voter: 'jane' }),
      /ERR_CALLER_NOT_CREATOR/,
      'disapprovers cannot cancel action'
    )
    await t.exception(
      fac.cancelAction({ id, voter: 'mike' }),
      /ERR_CALLER_NOT_CREATOR/,
      'approvers cannot cancel action'
    )

    await t.execution(
      fac.cancelAction({ id, voter: 'joe' }),
      'creator can cancel action'
    )

    action = await fac.getAction('done', id)
    t.alike(
      action.data,
      { ...tmpl, status: ACTION_STATUS.DENIED },
      'canceled action should be moved to done with status DENIED'
    )
    await t.exception(
      fac.getAction('voting', id),
      /ERR_ACTION_ID_NOT_FOUND/,
      'should remove action from voting uppon cancelation'
    )
  })

  await t.test('execActions tests', async (t) => {
    const bee = getBee()
    const wrk = {
      ping: (nonce) => nonce + 1,
      freeze: () => { },
      nail: () => Promise.reject(new Error('ERR_NAILED'))
    }
    const fac = new ActionApproverFacility({}, { ns: 'm0' }, { env: 'test' })
    await fac.initDb(bee)
    fac.initWrk(wrk)

    t.teardown(async () => {
      await new Promise((resolve, reject) => fac._stop((err) => err ? reject(err) : resolve()))
    })

    const pushData = { action: 'ping', payload: [1], voter: 'joe', reqVotes: 1 }
    let id = await fac.pushAction(pushData)
    const tmpl = {
      id,
      action: 'ping',
      payload: [1],
      votesPos: ['joe'],
      votesNeg: [],
      reqVotesPos: 1,
      reqVotesNeg: 1,
      status: ACTION_STATUS.APPROVED
    }

    let action = await fac.getAction('ready', id)
    t.alike(action.data, tmpl)

    fac.executing = true
    let res = await fac.execActions()
    t.alike(res, false, 'executing fac should not execute actions again')

    fac.executing = false
    res = await fac.execActions()
    t.alike(res, true, 'fac should return true when it manages to execute actions')

    await t.exception(
      fac.getAction('voting', id),
      /ERR_ACTION_ID_NOT_FOUND/,
      'execution should remove action from ready type'
    )
    action = await fac.getAction('done', id)
    t.alike(
      action.data,
      { ...tmpl, status: ACTION_STATUS.COMPLETED, result: 2 },
      'upon successful exection status should be COMPLETED and result should be stored'
    )

    id = await fac.pushAction({ ...pushData, action: 'freeze' })
    tmpl.id = id
    await fac.execActions()
    action = await fac.getAction('done', id)
    t.is(action.data.result, undefined, 'result should be omitted if it is void')

    id = await fac.pushAction({ ...pushData, action: 'nail' })
    tmpl.id = id
    await fac.execActions()
    action = await fac.getAction('done', id)
    t.is(action.data.error.startsWith('Error: ERR_NAILED'), true, 'error should be stored as string on execution failure')
  })
})
