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

module.exports = {
  convIntToBin,
  isValidObject
}
