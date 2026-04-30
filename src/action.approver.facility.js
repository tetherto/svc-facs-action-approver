'use strict'

const async = require('async')
const BaseFacility = require('@bitfinex/bfx-facs-base')
const Hyperbee = require('hyperbee')
const { format: sformat } = require('util')
const { setTimeout: sleep } = require('timers/promises')
const { TaskQueue } = require('@bitfinex/lib-js-util-task-queue')

const { ACTION_STATUS } = require('./constants')
const { convIntToBin, isValidObject } = require('./utils')

class ActionApproverFacility extends BaseFacility {
  constructor (caller, opts, ctx) {
    super(caller, opts, ctx)

    this.name = 'action-approver'
    this._hasConf = false

    this.init()
    this.queue = new TaskQueue(1) // concurrency 1
  }

  async _stop (cb) {
    try {
      await this.bee.close()

      if (this.itv) {
        clearInterval(this.itv)
      }

      return cb()
    } catch (err) {
      return cb(err)
    }
  }

  /**
   * @param {string} subdb
   * @returns {Hyperbee}
   */
  _resolveDb (subdb) {
    switch (subdb) {
      case 'voting': return this.dbActVoting
      case 'ready': return this.dbActReady
      case 'executing': return this.dbActExec
      case 'done': return this.dbActDone
      default:
        throw new Error('ERR_SUBDB_UNKOWN')
    }
  }

  _encode (data) {
    return Buffer.from(JSON.stringify(data), 'utf-8')
  }

  /**
   * @param {Buffer} data
   * @returns {{
   *    id: number,
   *    action: string,
   *    payload: any[],
   *    votesPos: (string|number)[],
   *    votesNeg: (string|number)[],
   *    reqVotesPos: number,
   *    reqVotesNeg: number,
   *    status: string,
   *    error?: string,
   *    result?: any
   *  }}
   */
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

  /**
   * @param {Hyperbee} bee
   */
  async initDb (bee) {
    if (!(bee instanceof Hyperbee)) {
      throw new Error('ERR_OPTS_BEE_INSTANCE_INVALID')
    }

    this.bee = bee
    await this.bee.ready()

    /*
    Sub will be deprecated in future hyperbee releases. Holepunch recommends using sub-encoder (https://github.com/holepunchto/sub-encoder).
    Verify backward compatibility and thoroughly test before migrating. This will be handled separately.
    */

    this.dbActVoting = this.bee.sub('actions:voting')
    this.dbActReady = this.bee.sub('actions:ready')
    this.dbActExec = this.bee.sub('actions:executing')
    this.dbActDone = this.bee.sub('actions:done')
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
  }

  /**
   * @param {Object} opts
   * @param {string} opts.action
   * @param {any[]} opts.payload
   * @param {string|number} opts.voter
   * @param {number} [opts.reqVotes] - Use either reqVotes or reqVotesPos and reqVotesNeg
   * @param {number} [opts.reqVotesPos]
   * @param {number} [opts.reqVotesNeg]
   * @returns {Promise<string>}
   */
  async pushAction ({ action, payload, voter, reqVotes, reqVotesPos, reqVotesNeg, batchActionUID }) {
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

    const data = await this.queue.pushTask(async () => {
      const id = Date.now()
      await sleep(50) // ensure unique timestamp

      const data = {
        id,
        batchActionUID,
        action,
        payload,
        votesPos: [voter],
        votesNeg: [],
        reqVotesPos,
        reqVotesNeg,
        status: reqVotesPos > 1 ? ACTION_STATUS.VOTING : ACTION_STATUS.APPROVED
      }
      const key = convIntToBin(id)

      const db = reqVotesPos > 1 ? this.dbActVoting : this.dbActReady
      await db.put(key, this._encode(data))
      return data
    })

    return data
  }

  async getAction (subdb, id) {
    const db = this._resolveDb(subdb)
    const key = convIntToBin(id)
    const raw = await db.get(key)
    if (!raw) {
      throw new Error('ERR_ACTION_ID_NOT_FOUND')
    }

    const data = this._decode(raw.value)
    return { id, key, data }
  }

  /**
   * @param {Object} opts
   * @param {number} opts.id
   * @param {string|number} opts.voter
   * @param {boolean} opts.approve
   */
  async voteAction ({ id, voter, approve }) {
    const { key, data } = await this.getAction('voting', id)

    const votes = approve ? data.votesPos : data.votesNeg
    const reqVotes = approve ? data.reqVotesPos : data.reqVotesNeg
    if (data.votesPos.includes(voter) || data.votesNeg.includes(voter)) {
      throw new Error('ERR_VOTER_EXISTS')
    }

    votes.push(voter)
    if (votes.length < reqVotes) {
      await this.dbActVoting.put(key, this._encode(data))
      return
    }
    data.status = approve ? ACTION_STATUS.APPROVED : ACTION_STATUS.DENIED

    const db = approve ? this.dbActReady : this.dbActDone
    await this.dbActVoting.del(key)
    await db.put(key, this._encode(data))
  }

  /**
   * @param {Object} opts
   * @param {number} opts.id
   * @param {string|number} opts.voter
   */
  async cancelAction ({ id, voter }) {
    /*
    Performing one hyperbee operation at a time due to batch action limitations with multiple subs on the same DB.
    Switching to new sub-encoder can support batches but need to test for backwards compatibility.
    */
    const { key, data } = await this.getAction('voting', id)
    if (data.votesPos[0] !== voter) {
      throw new Error('ERR_CALLER_NOT_CREATOR')
    }
    data.status = ACTION_STATUS.DENIED

    await this.dbActVoting.del(key)
    await this.dbActDone.put(key, this._encode(data))
  }

  /**
   * @param {Object} opts
   * @param {Array<number>} opts.ids
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
      const stream = this.dbActReady.createReadStream()
      for await (const entry of stream) {
        await this._execAction(entry)
      }
    } finally {
      this.executing = false
    }

    return true
  }

  /**
   * @param {Object} entry
   * @param {number} entry.seq
   * @param {Buffer} entry.key
   * @param {Buffer} entry.value
   */
  async _execAction (entry) {
    const key = entry.key
    const data = this._decode(entry.value)

    data.status = ACTION_STATUS.EXECUTING
    await this.dbActExec.put(key, this._encode(data))
    await this.dbActReady.del(key)
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
      await this.dbActDone.put(key, this._encode(data))
      await this.dbActExec.del(key)
    }
  }

  /**
   * @param {string} subdb
   * @param {Object} [range]
   * @param {number} [range.gt]
   * @param {number} [range.gte]
   * @param {number} [range.lt]
   * @param {number} [range.lte]
   * @param {Object} [opts]
   */
  async * query (subdb, range = undefined, opts = undefined) {
    if (range?.gt) range.gt = convIntToBin(range.gt)
    if (range?.gte) range.gte = convIntToBin(range.gte)
    if (range?.lt) range.lt = convIntToBin(range.lt)
    if (range?.lte) range.lte = convIntToBin(range.lte)

    const db = this._resolveDb(subdb)

    const stream = db.createReadStream(range, opts)
    for await (const entry of stream) {
      const data = this._decode(entry.value)
      yield data
    }
  }
}

module.exports = ActionApproverFacility
module.exports.ACTION_STATUS = ACTION_STATUS
