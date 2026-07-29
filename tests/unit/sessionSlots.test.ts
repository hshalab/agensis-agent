import { describe, expect, it } from 'vitest'

// @ts-expect-error — plain .mjs with JSDoc types, no .d.ts
import { createSessionSlots } from '../../packages/agensis-cli/src/sessionSlots.mjs'

const SILO = 'ws-1:agent-1'

describe('the default of one slot reproduces today exactly', () => {
  it('gives every lane the same slot, so every conversation shares one session', () => {
    const slots = createSessionSlots({ slots: 1 })
    const a = slots.claim(SILO, 'session-a::')
    slots.release(SILO, a)
    const b = slots.claim(SILO, 'session-b::')
    slots.release(SILO, b)
    expect(a).toBe(0)
    expect(b).toBe(0)
  })

  it('still returns slot 0 when the single slot is already busy', () => {
    // Admission control belongs to the queue and the keyed mutex, not here. A
    // second concurrent lane must land on the SAME key so it queues behind the
    // first, rather than being handed a key that would open a second session.
    const slots = createSessionSlots({ slots: 1 })
    expect(slots.claim(SILO, 'lane-a')).toBe(0)
    expect(slots.claim(SILO, 'lane-b')).toBe(0)
  })

  it('clamps nonsense configuration to at least one slot', () => {
    for (const bad of [0, -3, NaN, undefined, null, 'two']) {
      const slots = createSessionSlots({ slots: bad as number })
      expect(slots.size).toBe(1)
      expect(slots.claim(SILO, 'lane')).toBe(0)
    }
  })
})

describe('with more than one slot', () => {
  it('two concurrent lanes get two DISTINCT slots', () => {
    const slots = createSessionSlots({ slots: 2 })
    const a = slots.claim(SILO, 'lane-a')
    const b = slots.claim(SILO, 'lane-b')
    expect(a).not.toBe(b)
    expect(new Set([a, b])).toEqual(new Set([0, 1]))
  })

  it('a lane is sticky: it returns to the slot holding its own warm history', () => {
    const slots = createSessionSlots({ slots: 2 })
    const a1 = slots.claim(SILO, 'lane-a')
    const b1 = slots.claim(SILO, 'lane-b')
    slots.release(SILO, a1)
    slots.release(SILO, b1)
    expect(slots.claim(SILO, 'lane-a')).toBe(a1)
    slots.release(SILO, a1)
    expect(slots.claim(SILO, 'lane-b')).toBe(b1)
  })

  it('a third lane evicts the least-recently-used binding, not the freshest', () => {
    const slots = createSessionSlots({ slots: 2 })
    const a = slots.claim(SILO, 'lane-a')
    slots.release(SILO, a)
    const b = slots.claim(SILO, 'lane-b')
    slots.release(SILO, b)
    // lane-a is now the oldest, so lane-c takes its slot and lane-b keeps its own.
    expect(slots.claim(SILO, 'lane-c')).toBe(a)
    slots.release(SILO, a)
    expect(slots.claim(SILO, 'lane-b')).toBe(b)
  })

  it('prefers an idle slot over a busy one when it has to evict', () => {
    const slots = createSessionSlots({ slots: 2 })
    const a = slots.claim(SILO, 'lane-a') // stays BUSY
    const b = slots.claim(SILO, 'lane-b')
    slots.release(SILO, b) // idle
    // lane-a was claimed first so it is the LRU by time, but it is mid-turn.
    expect(slots.claim(SILO, 'lane-c')).toBe(b)
  })

  it('keeps silos independent — one workspace/agent cannot consume another\'s slots', () => {
    const slots = createSessionSlots({ slots: 2 })
    slots.claim('ws-1:agent-1', 'lane-a')
    slots.claim('ws-1:agent-1', 'lane-b')
    expect(slots.busyCount('ws-1:agent-1')).toBe(2)
    // A different agent starts from a full set of its own.
    const other = slots.claim('ws-2:agent-9', 'lane-a')
    expect(other).toBe(0)
    expect(slots.busyCount('ws-2:agent-9')).toBe(1)
  })
})

describe('a leak can cost preference but never capacity', () => {
  it('claim / throw / release / claim again still succeeds', () => {
    const slots = createSessionSlots({ slots: 2 })
    const first = slots.claim(SILO, 'lane-a')
    try {
      throw new Error('the turn blew up')
    } catch {
      slots.release(SILO, first)
    }
    expect(slots.claim(SILO, 'lane-a')).toBe(first)
    expect(slots.busyCount(SILO)).toBe(1)
  })

  // THE DEADLOCK TEST. This is the failure this repo has already lived through
  // in another form (a wedged DM that never answered again). If a leaked claim
  // could make claim() fail, one lost `finally` would silence an agent forever.
  it('never stops handing out slots, even when every claim leaks', () => {
    const slots = createSessionSlots({ slots: 2 })
    for (let i = 0; i < 50; i += 1) {
      const slot = slots.claim(SILO, `lane-${i}`)
      expect(typeof slot).toBe('number')
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(2)
      // deliberately NO release
    }
  })

  it('release is safe for a slot that was never claimed, and for unknown silos', () => {
    const slots = createSessionSlots({ slots: 2 })
    expect(() => slots.release('never-seen', 0)).not.toThrow()
    expect(() => slots.release(SILO, null)).not.toThrow()
    expect(() => slots.release(SILO, undefined)).not.toThrow()
    const slot = slots.claim(SILO, 'lane-a')
    slots.release(SILO, slot)
    slots.release(SILO, slot) // idempotent
    expect(slots.busyCount(SILO)).toBe(0)
  })

  it('forgetLane drops affinity without consuming the slot', () => {
    const slots = createSessionSlots({ slots: 2 })
    const a = slots.claim(SILO, 'lane-a')
    slots.release(SILO, a)
    slots.forgetLane(SILO, 'lane-a')
    expect(slots.busyCount(SILO)).toBe(0)
    // The slot is free for anyone, including lane-a again.
    expect(slots.claim(SILO, 'lane-z')).toBe(a)
  })
})
