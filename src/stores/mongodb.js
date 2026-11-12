'use strict'

const { PARTITIONS, ACTION_STATUS } = require('../constants')

const COLLECTION = 'action_approver'

const PARTITION_STATUSES = Object.freeze({
  [PARTITIONS.VOTING]: [ACTION_STATUS.VOTING],
  [PARTITIONS.READY]: [ACTION_STATUS.APPROVED],
  [PARTITIONS.EXECUTING]: [ACTION_STATUS.EXECUTING],
  [PARTITIONS.DONE]: [
    ACTION_STATUS.DENIED,
    ACTION_STATUS.COMPLETED,
    ACTION_STATUS.FAILED,
    ACTION_STATUS.EXPIRED
  ]
})

/**
 * Resolve the Mongo Db handle from the caller's started bfx-facs-db-mongo.
 * @param {object} mongo
 */
function resolveDb (mongo) {
  if (typeof mongo?.getDriver !== 'function') throw new Error('ERR_OPTS_MONGO_INVALID')
  if (mongo.db && typeof mongo.db.collection === 'function') return mongo.db
  if (mongo.cli && typeof mongo.cli.db === 'function') {
    const name = mongo.conf?.database
    return name ? mongo.cli.db(name) : mongo.cli.db()
  }
  throw new Error('ERR_OPTS_MONGO_INVALID')
}

class MongodbStore {
  /**
   * @param {object} mongo - Caller worker's started dbMongo_m0
   */
  constructor (mongo) {
    this.mongo = mongo
    this.engine = 'mongodb'
    this.db = resolveDb(mongo)
    this.ObjectId = mongo.getDriver().ObjectId
    this.col = this.db.collection(COLLECTION)
  }

  async ready () {
    await this.col.createIndex({ status: 1 })
    await this.col.createIndex({ status: 1, claimedAt: 1 })
  }

  createId () {
    return new this.ObjectId().toHexString()
  }

  _toDoc (record) {
    const { id, ...rest } = record
    return { _id: id, ...rest }
  }

  _fromDoc (doc) {
    if (!doc) return null
    const { _id, ...rest } = doc
    return { id: typeof _id === 'string' ? _id : String(_id), ...rest }
  }

  async put (partition, record) {
    const statuses = PARTITION_STATUSES[partition]
    if (!statuses) throw new Error('ERR_SUBDB_UNKOWN')
    const doc = this._toDoc(record)
    await this.col.replaceOne({ _id: doc._id }, doc, { upsert: true })
    return record
  }

  async get (partition, id) {
    const statuses = PARTITION_STATUSES[partition]
    if (!statuses) throw new Error('ERR_SUBDB_UNKOWN')
    const doc = await this.col.findOne({ _id: String(id), status: { $in: statuses } })
    return this._fromDoc(doc)
  }

  async getById (id) {
    const doc = await this.col.findOne({ _id: String(id) })
    return this._fromDoc(doc)
  }

  async del (partition, id) {
    const statuses = PARTITION_STATUSES[partition]
    if (!statuses) throw new Error('ERR_SUBDB_UNKOWN')
    await this.col.deleteOne({ _id: String(id), status: { $in: statuses } })
  }

  /**
   * Conditional status transition via findOneAndUpdate on {_id, status}.
   */
  async transition (fromPartition, toPartition, record, expectedStatus, expected = {}) {
    const fromStatuses = PARTITION_STATUSES[fromPartition]
    const expect = expectedStatus || (fromStatuses && fromStatuses[0])
    if (!expect) throw new Error('ERR_SUBDB_UNKOWN')

    const { id, ...rest } = record
    const update = { $set: { ...rest, status: record.status } }
    if (expect === ACTION_STATUS.EXECUTING && record.status !== ACTION_STATUS.EXECUTING) {
      delete update.$set.claimedBy
      delete update.$set.claimedAt
      update.$unset = { claimedBy: '', claimedAt: '' }
    }
    const result = await this.col.findOneAndUpdate(
      { _id: String(id), status: expect, ...expected },
      update,
      { returnDocument: 'after' }
    )
    const updated = unwrapFindResult(result)
    return this._fromDoc(updated)
  }

  async conditionalUpdate (partition, id, expectedStatus, record, expected = {}) {
    const { id: _ignore, ...rest } = record
    const result = await this.col.findOneAndUpdate(
      { _id: String(id), status: expectedStatus, ...expected },
      { $set: { ...rest, status: record.status } },
      { returnDocument: 'after' }
    )
    return this._fromDoc(unwrapFindResult(result))
  }

  async * read (partition, range = undefined, opts = {}) {
    const statuses = PARTITION_STATUSES[partition]
    if (!statuses) throw new Error('ERR_SUBDB_UNKOWN')

    const filter = { status: { $in: statuses } }
    // range gt/gte/lt/lte apply to string ObjectId hex lexicographic order
    if (range?.gt !== undefined || range?.gte !== undefined || range?.lt !== undefined || range?.lte !== undefined) {
      filter._id = {}
      if (range.gt !== undefined) filter._id.$gt = String(range.gt)
      if (range.gte !== undefined) filter._id.$gte = String(range.gte)
      if (range.lt !== undefined) filter._id.$lt = String(range.lt)
      if (range.lte !== undefined) filter._id.$lte = String(range.lte)
    }

    const cursor = this.col.find(filter).sort({ _id: opts?.reverse ? -1 : 1 })
    for await (const doc of cursor) {
      yield this._fromDoc(doc)
    }
  }

  async close () {
    // Caller owns mongo fac lifecycle
  }
}

function unwrapFindResult (result) {
  if (!result) return null
  if (typeof result === 'object' && 'value' in result && !('status' in result)) {
    return result.value
  }
  return result
}

module.exports = MongodbStore
module.exports.COLLECTION = COLLECTION
module.exports.PARTITION_STATUSES = PARTITION_STATUSES
