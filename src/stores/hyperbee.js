'use strict'

const Hyperbee = require('hyperbee')
const { PARTITIONS } = require('../constants')
const { convIntToBin } = require('../utils')

class HyperbeeStore {
  /**
   * @param {Hyperbee} bee
   */
  constructor (bee) {
    if (!(bee instanceof Hyperbee)) {
      throw new Error('ERR_OPTS_BEE_INSTANCE_INVALID')
    }
    this.bee = bee
    this.engine = 'hyperbee'
    this._dbs = null
  }

  async ready () {
    await this.bee.ready()
    /*
    Sub will be deprecated in future hyperbee releases. Holepunch recommends using sub-encoder.
    Verify backward compatibility and thoroughly test before migrating. This will be handled separately.
    */
    this._dbs = {
      [PARTITIONS.VOTING]: this.bee.sub('actions:voting'),
      [PARTITIONS.READY]: this.bee.sub('actions:ready'),
      [PARTITIONS.EXECUTING]: this.bee.sub('actions:executing'),
      [PARTITIONS.DONE]: this.bee.sub('actions:done')
    }
  }

  _db (partition) {
    const db = this._dbs?.[partition]
    if (!db) throw new Error('ERR_SUBDB_UNKOWN')
    return db
  }

  _encode (data) {
    return Buffer.from(JSON.stringify(data), 'utf-8')
  }

  _decode (data) {
    return JSON.parse(data.toString('utf-8'))
  }

  createId () {
    return Date.now()
  }

  async put (partition, record) {
    const key = convIntToBin(Number(record.id))
    await this._db(partition).put(key, this._encode(record))
    return record
  }

  async get (partition, id) {
    const key = convIntToBin(Number(id))
    const raw = await this._db(partition).get(key)
    if (!raw) return null
    return this._decode(raw.value)
  }

  async del (partition, id) {
    const key = convIntToBin(Number(id))
    await this._db(partition).del(key)
  }

  /**
   * Move record between partitions (del + put). Not transactional across subs.
   */
  async transition (fromPartition, toPartition, record, expectedStatus) {
    const existing = await this.get(fromPartition, record.id)
    if (!existing) return null
    if (expectedStatus && existing.status !== expectedStatus) return null
    await this.put(toPartition, record)
    await this.del(fromPartition, record.id)
    return record
  }

  /**
   * Conditional in-place update within a partition.
   */
  async conditionalUpdate (partition, id, expectedStatus, record) {
    const existing = await this.get(partition, id)
    if (!existing) return null
    if (expectedStatus && existing.status !== expectedStatus) return null
    await this.put(partition, record)
    return record
  }

  async * read (partition, range = undefined, opts = undefined) {
    const mapped = range ? { ...range } : undefined
    if (mapped?.gt !== undefined) mapped.gt = convIntToBin(Number(mapped.gt))
    if (mapped?.gte !== undefined) mapped.gte = convIntToBin(Number(mapped.gte))
    if (mapped?.lt !== undefined) mapped.lt = convIntToBin(Number(mapped.lt))
    if (mapped?.lte !== undefined) mapped.lte = convIntToBin(Number(mapped.lte))

    const stream = this._db(partition).createReadStream(mapped, opts)
    for await (const entry of stream) {
      yield this._decode(entry.value)
    }
  }

  async close () {
    if (this.bee && !this.bee.closed) {
      await this.bee.close()
    }
  }
}

module.exports = HyperbeeStore
