'use strict'

const { ENGINES } = require('../constants')
const HyperbeeStore = require('./hyperbee')
const HyperdbStore = require('./hyperdb')
const MongodbStore = require('./mongodb')

/**
 * @param {object} opts
 * @param {string} opts.engine
 * @param {object} [opts.bee]
 * @param {object} [opts.hyperdb]
 * @param {object} [opts.mongo]
 */
function createStore ({ engine, bee, hyperdb, mongo }) {
  switch (engine) {
    case ENGINES.HYPERBEE:
      return new HyperbeeStore(bee)
    case ENGINES.HYPERDB:
      return new HyperdbStore(hyperdb)
    case ENGINES.MONGODB:
      return new MongodbStore(mongo)
    default:
      throw new Error('ERR_ENGINE_INVALID')
  }
}

module.exports = {
  createStore,
  HyperbeeStore,
  HyperdbStore,
  MongodbStore
}
