# svc-facs-action-approver

Multi-party action approval facility. Store backends: **hyperbee** (default), **hyperdb**, **mongodb**.

## Install

```bash
npm i @tetherto/svc-facs-action-approver
```

## Init

```js
const ActionApprover = require('@tetherto/svc-facs-action-approver')

const fac = new ActionApprover(caller, { ns: 'aa0' }, ctx)

// Hyperbee (legacy initDb still works)
await fac.initStore({ engine: 'hyperbee', bee })

// HyperDB — pass an open HyperDB built with package schema (`npm run build:schema`)
await fac.initStore({ engine: 'hyperdb', hyperdb })

// MongoDB — pass caller worker's dbMongo_m0 (or { db })
await fac.initStore({
  engine: 'mongodb',
  mongo: this.dbMongo_m0,
  claimId: 'wrk-admin-proposal:1',
  executingTimeout: 5 * 60 * 1000
})

fac.initWrk(this)
fac.startInterval(2000)
```

## Record fields

`id`, `action`, `payload`, `votesPos`, `votesNeg`, `reqVotesPos`, `reqVotesNeg`, `eligibleVoters`, `target`, `status`, optional `error` / `result` / `claimedBy` / `claimedAt`.

Mongo ids are ObjectId hex strings. Hyperbee/HyperDB ids are timestamps.

## Quorum helpers

`voteAction` rejects voters not in `eligibleVoters`.  
`reviseVoting({ userId })` removes a voter from open VOTING actions and recomputes thresholds.  
`expireAction({ id, reason })` → `EXPIRED`.  
Claim lease on `EXECUTING` with recovery after `executingTimeout` (default 5m).

`computeQuorumThresholds(poolSize)` → `{ majority, reqVotesPos, reqVotesNeg }` where majority = floor(pool/2)+1 and reqVotesPos = majority+1.

## Tests

```bash
npm test
```
