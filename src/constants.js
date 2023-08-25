'use strict'

const ACTION_STATUS = Object.freeze({
  VOTING: 'VOTING',
  APPROVED: 'APPROVED',
  DENIED: 'DENIED',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
})

module.exports = {
  ACTION_STATUS
}
