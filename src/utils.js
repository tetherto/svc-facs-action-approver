'use strict'

/**
 * @param {number} val
 */
const convIntToBin = (val) => {
  const buf = Buffer.allocUnsafe(6)
  buf.writeUIntBE(val, 0, 6)

  return buf
}

/**
 * @param {object} val
 */
const isValidObject = (val) => val !== null && typeof val === 'object' && !Array.isArray(val)

/**
 * Majority = floor(pool / 2) + 1.
 * reqVotesPos = majority + 1 (proposer is first yes).
 * reqVotesNeg = pool.length - majority + 1.
 * @param {number} poolSize
 * @returns {{ majority: number, reqVotesPos: number, reqVotesNeg: number }}
 */
const computeQuorumThresholds = (poolSize) => {
  const size = Math.max(0, Number(poolSize) || 0)
  if (size < 1) {
    return { majority: 0, reqVotesPos: 0, reqVotesNeg: 0 }
  }
  const majority = Math.floor(size / 2) + 1
  return {
    majority,
    reqVotesPos: majority + 1,
    reqVotesNeg: size - majority + 1
  }
}

/**
 * @param {(string|number)[]} list
 * @param {string|number} voter
 */
const includesVoter = (list, voter) => {
  if (!Array.isArray(list)) return false
  const asStr = String(voter)
  return list.some((v) => String(v) === asStr)
}

/**
 * @param {(string|number)[]} list
 * @param {string|number} voter
 */
const withoutVoter = (list, voter) => {
  if (!Array.isArray(list)) return []
  const asStr = String(voter)
  return list.filter((v) => String(v) !== asStr)
}

module.exports = {
  convIntToBin,
  isValidObject,
  computeQuorumThresholds,
  includesVoter,
  withoutVoter
}
