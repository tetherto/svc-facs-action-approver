'use strict'

const { PARTITIONS } = require('../constants')

const COLLECTION_BY_PARTITION = Object.freeze({
  [PARTITIONS.VOTING]: '@action-approver/actions-voting',
  [PARTITIONS.READY]: '@action-approver/actions-ready',
  [PARTITIONS.EXECUTING]: '@action-approver/actions-executing',
  [PARTITIONS.DONE]: '@action-approver/actions-done'
})

class HyperdbStore {
  /**
   * @param {object} hyperdb - Open HyperDB instance built with package schema
   */
  constructor (hyperdb) {
    if (!hyperdb || typeof hyperdb.insert !== 'function') {
      throw new Error('ERR_OPTS_HYPERDB_INSTANCE_INVALID')
    }
    this.db = hyperdb
    this.engine = 'hyperdb'
  }

  async ready () {
    if (typeof this.db.ready === 'function') {
      await this.db.ready()
    }
  }

  _collection (partition) {
    const name = COLLECTION_BY_PARTITION[partition]
    if (!name) throw new Error('ERR_SUBDB_UNKOWN')
    return name
  }

  createId () {
    return Date.now()
  }

  _normalize (record) {
    return {
      ...record,
      id: Number(record.id),
      eligibleVoters: record.eligibleVoters ?? null,
      target: record.target ?? null,
      error: record.error ?? null,
      result: record.result === undefined ? null : record.result,
      claimedBy: record.claimedBy ?? null,
      claimedAt: record.claimedAt ?? null,
      batchActionUID: record.batchActionUID ?? null
    }
  }

  async put (partition, record) {
    const collection = this._collection(partition)
    const doc = this._normalize(record)
    const existing = await this.db.get(collection, { id: doc.id })
    if (existing) {
      await this.db.delete(collection, { id: doc.id })
    }
    await this.db.insert(collection, doc)
    if (typeof this.db.flush === 'function') await this.db.flush()
    return record
  }

  async get (partition, id) {
    const collection = this._collection(partition)
    const doc = await this.db.get(collection, { id: Number(id) })
    if (!doc) return null
    return stripNulls(doc)
  }

  async del (partition, id) {
    const collection = this._collection(partition)
    await this.db.delete(collection, { id: Number(id) })
    if (typeof this.db.flush === 'function') await this.db.flush()
  }

  async transition (fromPartition, toPartition, record, expectedStatus, expected = {}) {
    const existing = await this.get(fromPartition, record.id)
    if (!existing) return null
    if (expectedStatus && existing.status !== expectedStatus) return null
    if (Object.entries(expected).some(([key, value]) => (existing[key] ?? null) !== value)) return null
    // put-then-del: crash window may leave a duplicate, not a lost record
    await this.put(toPartition, record)
    await this.del(fromPartition, record.id)
    return record
  }

  async conditionalUpdate (partition, id, expectedStatus, record, expected = {}) {
    const existing = await this.get(partition, id)
    if (!existing) return null
    if (expectedStatus && existing.status !== expectedStatus) return null
    if (Object.entries(expected).some(([key, value]) => (existing[key] ?? null) !== value)) return null
    await this.put(partition, record)
    return record
  }

  async * read (partition, range = undefined, opts = {}) {
    const collection = this._collection(partition)
    const query = { reverse: Boolean(opts?.reverse) }
    if (range?.gt !== undefined) query.gt = { id: Number(range.gt) }
    if (range?.gte !== undefined) query.gte = { id: Number(range.gte) }
    if (range?.lt !== undefined) query.lt = { id: Number(range.lt) }
    if (range?.lte !== undefined) query.lte = { id: Number(range.lte) }

    const stream = this.db.find(collection, query)
    for await (const doc of stream) {
      yield stripNulls(doc)
    }
  }

  async close () {
    if (this.db && typeof this.db.close === 'function') {
      await this.db.close()
    }
  }
}

function stripNulls (doc) {
  const out = { ...doc }
  for (const key of Object.keys(out)) {
    if (out[key] === null) delete out[key]
  }
  return out
}

module.exports = HyperdbStore
module.exports.COLLECTION_BY_PARTITION = COLLECTION_BY_PARTITION
