'use strict'

/**
 * Hyperschema + HyperDB definition for action-approver partitions.
 * Run: node src/schema/build.js
 */

const path = require('path')
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const NS = 'action-approver'

const ACTION_FIELDS = [
  { name: 'id', type: 'uint', required: true },
  { name: 'action', type: 'string', required: true },
  { name: 'payload', type: 'json', required: true },
  { name: 'votesPos', type: 'json', required: true },
  { name: 'votesNeg', type: 'json', required: true },
  { name: 'reqVotesPos', type: 'uint', required: true },
  { name: 'reqVotesNeg', type: 'uint', required: true },
  { name: 'eligibleVoters', type: 'json', required: false },
  { name: 'target', type: 'string', required: false },
  { name: 'status', type: 'string', required: true },
  { name: 'error', type: 'string', required: false },
  { name: 'result', type: 'json', required: false },
  { name: 'claimedBy', type: 'string', required: false },
  { name: 'claimedAt', type: 'uint', required: false },
  { name: 'batchActionUID', type: 'string', required: false },
  { name: 'rev', type: 'uint', required: false }
]

const COLLECTIONS = [
  'actions-voting',
  'actions-ready',
  'actions-executing',
  'actions-done'
]

function setupSchema (schemaDir) {
  const schema = Hyperschema.from(schemaDir)
  const ns = schema.namespace(NS)
  for (const name of COLLECTIONS) {
    ns.register({ name, fields: ACTION_FIELDS })
  }
  Hyperschema.toDisk(schema)
}

function setupDb (schemaDir, dbDir) {
  const db = HyperDB.from(schemaDir, dbDir)
  const dbNs = db.namespace(NS)
  for (const name of COLLECTIONS) {
    dbNs.collections.register({
      name,
      schema: `@${NS}/${name}`,
      key: ['id']
    })
  }
  HyperDB.toDisk(db)
}

module.exports = {
  NS,
  COLLECTIONS,
  setupSchema,
  setupDb
}

if (require.main === module) {
  const schemaDir = path.join(__dirname, 'spec', 'hyperschema')
  const dbDir = path.join(__dirname, 'spec', 'hyperdb')
  setupSchema(schemaDir)
  setupDb(schemaDir, dbDir)
}
