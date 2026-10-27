/**
 * Semaphore: concurrency cap, FIFO grants, abort while queued.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { JevAbortError, Semaphore } from '../../lib/index.js'

test('rejects invalid limits', () => {
  assert.throws(() => new Semaphore(0), RangeError)
  assert.throws(() => new Semaphore(Number.NaN), RangeError)
})

test('caps active slots and reports maxObserved', async () => {
  const semaphore = new Semaphore(2)
  const releaseA = await semaphore.acquire()
  const releaseB = await semaphore.acquire()
  assert.equal(semaphore.active, 2)
  assert.equal(semaphore.maxObserved, 2)
  let third = false
  const thirdPromise = semaphore.acquire().then((release) => {
    third = true
    return release
  })
  await Promise.resolve()
  assert.equal(third, false)
  assert.equal(semaphore.waiting, 1)
  releaseA()
  const releaseC = await thirdPromise
  assert.equal(third, true)
  assert.equal(semaphore.active, 2)
  releaseB()
  releaseC()
  assert.equal(semaphore.active, 0)
})

test('release is idempotent', async () => {
  const semaphore = new Semaphore(1)
  const release = await semaphore.acquire()
  release()
  release()
  assert.equal(semaphore.active, 0)
  const again = await semaphore.acquire()
  again()
  assert.equal(semaphore.active, 0)
})

test('abort before acquire rejects', async () => {
  const semaphore = new Semaphore(1)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(semaphore.acquire(controller.signal), JevAbortError)
  assert.equal(semaphore.active, 0)
})

test('abort while waiting rejects and leaves no stale waiter', async () => {
  const semaphore = new Semaphore(1)
  const release = await semaphore.acquire()
  const controller = new AbortController()
  const waiting = semaphore.acquire(controller.signal)
  assert.equal(semaphore.waiting, 1)
  controller.abort()
  await assert.rejects(waiting, JevAbortError)
  assert.equal(semaphore.waiting, 0)
  release()
  assert.equal(semaphore.active, 0)
  const next = await semaphore.acquire()
  next()
  assert.equal(semaphore.active, 0)
})
