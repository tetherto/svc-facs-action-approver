'use strict'

const async = require('async')
const BaseFacility = require('@bitfinex/bfx-facs-base')
const Hyperbee = require('hyperbee')
const { format: sformat } = require('util')
const { setTimeout: sleep } = require('timers/promises')
const { TaskQueue } = require('@bitfinex/lib-js-util-task-queue')

const {
  ACTION_STATUS,
  PARTITIONS,
  ENGINES,
  DEFAULT_EXECUTING_TIMEOUT_MS
} = require('./constants')
const {
  isValidObject,
  computeQuorumThresholds,
  includesVoter,
  withoutVoter
} = require('./utils')
const { createStore } = require('./stores')

class ActionApproverFacility extends BaseFacility {
  constructor (caller, opts, ctx) {
    super(caller, opts, ctx)

    this.name = 'action-approver'
    this._hasConf = false

    this.init()
    this.queue = new TaskQueue(1) // concurrency 1
    this.store = null
    this.executingTimeout = DEFAULT_EXECUTING_TIMEOUT_MS
    this.claimId = null
    this._recoverItv = null
    this._activeExecutions = new Set()
  }

  /**
   * Store-agnostic init. Prefer this over initDb.
   * @param {object} opts
   * @param {'hyperbee'|'hyperdb'|'mongodb'} opts.engine
   * @param {import('hyperbee')} [opts.bee]
   * @param {object} [opts.hyperdb]
   * @param {object} [opts.mongo] - Caller worker's dbMongo_m0
   * @param {number} [opts.executingTimeout] - Claim lease timeout ms (default 5m)
   * @param {string} [opts.claimId] - Identity recorded on EXECUTING claims
   */
  async initStore (opts = {}) {
    const engine = opts.engine || ENGINES.HYPERBEE
    this.executingTimeout = Number.isInteger(opts.executingTimeout) && opts.executingTimeout > 0
      ? opts.executingTimeout
      : DEFAULT_EXECUTING_TIMEOUT_MS
    this.claimId = opts.claimId || `pid:${process.pid}`

    this.store = createStore({
      engine,
      bee: opts.bee,
      hyperdb: opts.hyperdb,
      mongo: opts.mongo
    })
    await this.store.ready()

    // Back-compat accessors used by existing tests
    if (engine === ENGINES.HYPERBEE) {
      this.bee = opts.bee
      this.dbActVoting = this.store._dbs[PARTITIONS.VOTING]
      this.dbActReady = this.store._dbs[PARTITIONS.READY]
      this.dbActExec = this.store._dbs[PARTITIONS.EXECUTING]
      this.dbActDone = this.store._dbs[PARTITIONS.DONE]
    }

    return this
  }

  /**
   * @deprecated Prefer initStore({ engine: 'hyperbee', bee })
   * @param {Hyperbee} bee
   */
  async initDb (bee) {
    if (!(bee instanceof Hyperbee)) {
      throw new Error('ERR_OPTS_BEE_INSTANCE_INVALID')
    }
    return this.initStore({ engine: ENGINES.HYPERBEE, bee })
  }

  async _stop (cb) {
    try {
      if (this.itv) {
        clearInterval(this.itv)
      }
      if (this._recoverItv) {
        clearInterval(this._recoverItv)
        this._recoverItv = null
      }
      if (this.store) {
        await this.store.close()
      } else if (this.bee) {
        await this.bee.close()
      }
      return cb()
    } catch (err) {
      return cb(err)
    }
  }

  /**
   * @param {string} subdb
   * @returns {string}
   */
  _resolvePartition (subdb) {
    switch (subdb) {
      case 'voting': return PARTITIONS.VOTING
      case 'ready': return PARTITIONS.READY
      case 'executing': return PARTITIONS.EXECUTING
      case 'done': return PARTITIONS.DONE
      default:
        throw new Error('ERR_SUBDB_UNKOWN')
    }
  }

  /** @deprecated hyperbee-only helper kept for older callers */
  _resolveDb (subdb) {
    const partition = this._resolvePartition(subdb)
    if (!this.store?._dbs) throw new Error('ERR_SUBDB_UNKOWN')
    return this.store._dbs[partition]
  }

  _encode (data) {
    return Buffer.from(JSON.stringify(data), 'utf-8')
  }

  _decode (data) {
    return JSON.parse(data.toString('utf-8'))
  }

  _validVoter (voter) {
    if (!voter) return false

    const type = typeof voter
    if (!['number', 'string'].includes(type)) return false
    if (type === 'string' && !voter.trim()) return false
    if (type === 'number' && (voter < 1 || !Number.isInteger(voter))) return false

    return true
  }

  initWrk (wrk) {
    if (!isValidObject(wrk)) {
      throw new Error('ERR_OPTS_WRK_INVALID_TYPE')
    }
    this.wrk = wrk
  }

  startInterval (interval) {
    if (!Number.isInteger(interval) || interval < 100) {
      throw new Error('ERR_OPTS_INTERVAL_INVALID')
    }

    this.executing = false
    this.itv = setInterval(this.execActions.bind(this), interval)
    // Startup recovery, then periodic re-claim of stale EXECUTING leases
    this.recoverStaleExecuting().catch(() => {})
    this._recoverItv = setInterval(() => {
      this.recoverStaleExecuting().catch(() => {})
    }, Math.max(interval, 1000))
  }

  /**
   * Serialize voting-partition mutations (push/vote/cancel/expire/revise)
   * so concurrent RPCs cannot lose votes via read-modify-write races.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  _runVotingMutation (fn) {
    return this.queue.pushTask(fn)
  }

  /**
   * @param {Object} opts
   * @param {string} opts.action
   * @param {any[]} opts.payload
   * @param {string|number} opts.voter
   * @param {number} [opts.reqVotes] - Use either reqVotes or reqVotesPos and reqVotesNeg
   * @param {number} [opts.reqVotesPos]
   * @param {number} [opts.reqVotesNeg]
   * @param {(string|number)[]} [opts.eligibleVoters]
   * @param {string|number} [opts.target]
   * @returns {Promise<object>}
   */
  async pushAction ({
    action,
    payload,
    voter,
    reqVotes,
    reqVotesPos,
    reqVotesNeg,
    batchActionUID,
    eligibleVoters,
    target
  }) {
    if (!this.store) throw new Error('ERR_STORE_NOT_INITIALIZED')
    if (!action || typeof action !== 'string' || !action.trim()) {
      throw new Error('ERR_ACTION_INVALID')
    }
    if (typeof this.wrk[action] !== 'function') {
      throw new Error('ERR_ACTION_UNKOWN')
    }
    if (!Array.isArray(payload)) {
      throw new Error('ERR_PAYLOAD_INVALID')
    }
    if (!this._validVoter(voter)) {
      throw new Error('ERR_VOTER_INVALID')
    }
    if (reqVotes && (reqVotesPos || reqVotesNeg)) {
      throw new Error('ERR_REQ_VOTES_CONFLICT')
    }

    reqVotesPos = reqVotesPos || reqVotes
    reqVotesNeg = reqVotesNeg || reqVotes

    if (reqVotesPos < 1 || !Number.isInteger(reqVotesPos)) {
      throw new Error('ERR_REQ_VOTES_POS_INVALID')
    }
    if (reqVotesNeg < 1 || !Number.isInteger(reqVotesNeg)) {
      throw new Error('ERR_REQ_VOTES_NEG_INVALID')
    }

    if (eligibleVoters !== undefined && eligibleVoters !== null) {
      if (!Array.isArray(eligibleVoters)) {
        throw new Error('ERR_ELIGIBLE_VOTERS_INVALID')
      }
    }

    return this._runVotingMutation(async () => {
      const id = this.store.createId()
      if (typeof id === 'number') {
        await sleep(50) // ensure unique timestamp for hyperbee/hyperdb
      }

      const status = reqVotesPos > 1 ? ACTION_STATUS.VOTING : ACTION_STATUS.APPROVED
      const record = {
        id,
        batchActionUID,
        action,
        payload,
        votesPos: [voter],
        votesNeg: [],
        reqVotesPos,
        reqVotesNeg,
        status
      }
      if (eligibleVoters !== undefined && eligibleVoters !== null) {
        record.eligibleVoters = eligibleVoters.map((v) => (typeof v === 'number' ? v : String(v)))
      }
      if (target !== undefined && target !== null) {
        record.target = typeof target === 'number' ? target : String(target)
      }

      const partition = status === ACTION_STATUS.APPROVED ? PARTITIONS.READY : PARTITIONS.VOTING
      await this.store.put(partition, record)
      return record
    })
  }

  async getAction (subdb, id) {
    if (!this.store) throw new Error('ERR_STORE_NOT_INITIALIZED')
    const partition = this._resolvePartition(subdb)
    const data = await this.store.get(partition, id)
    if (!data) {
      throw new Error('ERR_ACTION_ID_NOT_FOUND')
    }
    return { id: data.id, key: data.id, data }
  }

  /**
   * @param {Object} opts
   * @param {number|string} opts.id
   * @param {string|number} opts.voter
   * @param {boolean} opts.approve
   */
  async voteAction ({ id, voter, approve }) {
    if (!this.store) throw new Error('ERR_STORE_NOT_INITIALIZED')
    return this._runVotingMutation(() => this._voteAction({ id, voter, approve }))
  }

  async _voteAction ({ id, voter, approve }) {
    const { data } = await this.getAction('voting', id)

    if (Array.isArray(data.eligibleVoters) && !includesVoter(data.eligibleVoters, voter)) {
      throw new Error('ERR_VOTER_NOT_ELIGIBLE')
    }

    if (!this._validVoter(voter)) {
      throw new Error('ERR_VOTER_INVALID')
    }

    const votes = approve ? data.votesPos : data.votesNeg
    const reqVotes = approve ? data.reqVotesPos : data.reqVotesNeg
    if (includesVoter(data.votesPos, voter) || includesVoter(data.votesNeg, voter)) {
      throw new Error('ERR_VOTER_EXISTS')
    }

    votes.push(voter)
    if (votes.length < reqVotes) {
      await this.store.conditionalUpdate(PARTITIONS.VOTING, id, ACTION_STATUS.VOTING, data)
      return
    }
    data.status = approve ? ACTION_STATUS.APPROVED : ACTION_STATUS.DENIED

    const toPartition = approve ? PARTITIONS.READY : PARTITIONS.DONE
    const moved = await this.store.transition(PARTITIONS.VOTING, toPartition, data, ACTION_STATUS.VOTING)
    if (!moved) throw new Error('ERR_ACTION_TRANSITION_FAILED')
  }

  /**
   * @param {Object} opts
   * @param {number|string} opts.id
   * @param {string|number} opts.voter
   */
  async cancelAction ({ id, voter }) {
    if (!this.store) throw new Error('ERR_STORE_NOT_INITIALIZED')
    return this._runVotingMutation(() => this._cancelAction({ id, voter }))
  }

  async _cancelAction ({ id, voter }) {
    const { data } = await this.getAction('voting', id)
    if (String(data.votesPos[0]) !== String(voter)) {
      throw new Error('ERR_CALLER_NOT_CREATOR')
    }
    data.status = ACTION_STATUS.DENIED

    const moved = await this.store.transition(
      PARTITIONS.VOTING,
      PARTITIONS.DONE,
      data,
      ACTION_STATUS.VOTING
    )
    if (!moved) throw new Error('ERR_ACTION_TRANSITION_FAILED')
  }

  /**
   * Expire a VOTING action with a reason (LATE, NO_ELIGIBLE_VOTERS, PROPOSER_DISABLED, …).
   * @param {Object} opts
   * @param {number|string} opts.id
   * @param {string} opts.reason
   */
  async expireAction ({ id, reason }) {
    if (!this.store) throw new Error('ERR_STORE_NOT_INITIALIZED')
    return this._runVotingMutation(() => this._expireAction({ id, reason }))
  }

  async _expireAction ({ id, reason }) {
    if (!reason || typeof reason !== 'string') {
      throw new Error('ERR_EXPIRE_REASON_INVALID')
    }
    const { data } = await this.getAction('voting', id)
    data.status = ACTION_STATUS.EXPIRED
    data.error = reason

    const moved = await this.store.transition(
      PARTITIONS.VOTING,
      PARTITIONS.DONE,
      data,
      ACTION_STATUS.VOTING
    )
    if (!moved) throw new Error('ERR_ACTION_TRANSITION_FAILED')
    return data
  }

  /**
   * Remove a voter from open VOTING actions, discard their votes, recompute
   * thresholds, and reevaluate (or expire).
   * @param {Object} opts
   * @param {string|number} opts.userId
   * @returns {Promise<object[]>} touched actions
   */
  async reviseVoting ({ userId, actions, reason }) {
    if (!this.store) throw new Error('ERR_STORE_NOT_INITIALIZED')
    return this._runVotingMutation(() => this._reviseVoting({ userId, actions, reason }))
  }

  async _reviseVoting ({ userId, actions, reason }) {
    if (!this._validVoter(userId)) {
      throw new Error('ERR_VOTER_INVALID')
    }

    const touched = []
    for await (const data of this.store.read(PARTITIONS.VOTING)) {
      if (Array.isArray(actions) && !actions.includes(data.action)) continue
      const isProposer = String(data.votesPos?.[0]) === String(userId)
      const inPool = Array.isArray(data.eligibleVoters) && includesVoter(data.eligibleVoters, userId)
      if (!isProposer && !inPool) continue

      // Proposer disabled → expire (even when proposer is not in eligibleVoters)
      // Use unlocked expire to avoid nested TaskQueue deadlock
      if (isProposer) {
        const expired = await this._expireAction({ id: data.id, reason: reason || 'PROPOSER_DISABLED' })
        touched.push(expired)
        continue
      }

      data.eligibleVoters = withoutVoter(data.eligibleVoters, userId)
      data.votesPos = withoutVoter(data.votesPos, userId)
      data.votesNeg = withoutVoter(data.votesNeg, userId)

      if (data.eligibleVoters.length === 0) {
        data.status = ACTION_STATUS.EXPIRED
        data.error = 'NO_ELIGIBLE_VOTERS'
        const moved = await this.store.transition(
          PARTITIONS.VOTING,
          PARTITIONS.DONE,
          data,
          ACTION_STATUS.VOTING
        )
        if (moved) touched.push(moved)
        continue
      }

      const { reqVotesPos, reqVotesNeg } = computeQuorumThresholds(data.eligibleVoters.length)
      data.reqVotesPos = reqVotesPos
      data.reqVotesNeg = reqVotesNeg

      if (data.votesPos.length >= data.reqVotesPos) {
        data.status = ACTION_STATUS.APPROVED
        const moved = await this.store.transition(
          PARTITIONS.VOTING,
          PARTITIONS.READY,
          data,
          ACTION_STATUS.VOTING
        )
        if (moved) touched.push(moved)
        continue
      }

      if (data.votesNeg.length >= data.reqVotesNeg) {
        data.status = ACTION_STATUS.DENIED
        const moved = await this.store.transition(
          PARTITIONS.VOTING,
          PARTITIONS.DONE,
          data,
          ACTION_STATUS.VOTING
        )
        if (moved) touched.push(moved)
        continue
      }

      const updated = await this.store.conditionalUpdate(
        PARTITIONS.VOTING,
        data.id,
        ACTION_STATUS.VOTING,
        data
      )
      if (updated) touched.push(updated)
    }

    return touched
  }

  /**
   * @param {Object} opts
   * @param {Array<number|string>} opts.ids
   * @param {string|number} opts.voter
   */
  async cancelActionsBatch ({ ids, voter }) {
    return await async.mapLimit(ids, 25, async id => {
      try {
        await this.cancelAction({ id, voter })
        return { id, success: true }
      } catch (error) {
        return {
          id,
          success: false,
          error: `ERR_CANCEL_BATCH_ACTION-ID-${id} ${error.message}`
        }
      }
    })
  }

  async execActions () {
    if (this.executing) {
      return false
    }

    this.executing = true

    try {
      for await (const data of this.store.read(PARTITIONS.READY)) {
        await this._execAction(data)
      }
    } finally {
      this.executing = false
    }

    return true
  }

  /**
   * Re-claim EXECUTING actions older than executingTimeout and re-run them.
   */
  async recoverStaleExecuting () {
    if (!this.store || this._recovering) return []
    this._recovering = true
    try {
      return await this._recoverStaleExecuting()
    } finally {
      this._recovering = false
    }
  }

  async _recoverStaleExecuting () {
    const cutoff = Date.now() - this.executingTimeout
    const recovered = []

    for await (const data of this.store.read(PARTITIONS.EXECUTING)) {
      if (this._activeExecutions.has(data.id)) continue
      const claimedAt = Number(data.claimedAt) || 0
      if (claimedAt && claimedAt > cutoff) continue

      const claim = {
        ...data,
        claimedBy: this.claimId,
        claimedAt: Date.now(),
        status: ACTION_STATUS.EXECUTING
      }
      const updated = await this.store.conditionalUpdate(
        PARTITIONS.EXECUTING,
        data.id,
        ACTION_STATUS.EXECUTING,
        claim,
        { claimedBy: data.claimedBy ?? null, claimedAt: data.claimedAt ?? null }
      )
      if (!updated) continue
      await this._runHandler(updated)
      recovered.push(updated.id)
    }
    return recovered
  }

  /**
   * @param {object} data - Action record in READY / APPROVED
   */
  async _execAction (data) {
    const claim = {
      ...data,
      status: ACTION_STATUS.EXECUTING,
      claimedBy: this.claimId,
      claimedAt: Date.now()
    }

    const claimed = await this.store.transition(
      PARTITIONS.READY,
      PARTITIONS.EXECUTING,
      claim,
      ACTION_STATUS.APPROVED
    )
    if (!claimed) return

    await this._runHandler(claimed)
  }

  async _runHandler (data) {
    this._activeExecutions.add(data.id)
    const claim = { claimedBy: data.claimedBy ?? null, claimedAt: data.claimedAt ?? null }
    const [params, ...otherPayload] = data.payload
    const paramsWithActionId = [
      ...params,
      { actionId: data.id, user: data.votesPos?.[0] }
    ]
    const updatedPayload = [paramsWithActionId, ...otherPayload]

    try {
      const result = await this.wrk[data.action](...updatedPayload)
      data.result = result
      data.status = ACTION_STATUS.COMPLETED
    } catch (err) {
      data.status = ACTION_STATUS.FAILED
      data.error = sformat(err)
    } finally {
      delete data.claimedBy
      delete data.claimedAt
      try {
        await this.store.transition(
          PARTITIONS.EXECUTING,
          PARTITIONS.DONE,
          data,
          ACTION_STATUS.EXECUTING,
          claim
        )
      } finally {
        this._activeExecutions.delete(data.id)
      }
    }
  }

  /**
   * @param {string} subdb
   * @param {Object} [range]
   * @param {number|string} [range.gt]
   * @param {number|string} [range.gte]
   * @param {number|string} [range.lt]
   * @param {number|string} [range.lte]
   * @param {Object} [opts]
   */
  async * query (subdb, range = undefined, opts = undefined) {
    if (!this.store) throw new Error('ERR_STORE_NOT_INITIALIZED')
    const partition = this._resolvePartition(subdb)
    yield * this.store.read(partition, range, opts)
  }
}

module.exports = ActionApproverFacility
module.exports.ACTION_STATUS = ACTION_STATUS
module.exports.PARTITIONS = PARTITIONS
module.exports.ENGINES = ENGINES
module.exports.computeQuorumThresholds = computeQuorumThresholds
