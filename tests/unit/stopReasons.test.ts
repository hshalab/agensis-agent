import { describe, expect, it } from 'vitest'

import {
  STOP_REASONS,
  isStopReason,
  stopFromAmpResult,
  stopFromCodexTurn,
  stopFromSdkResult,
  stopReasonFromSdkResult,
  stopValue,
  // @ts-expect-error — plain .mjs with JSDoc types, no .d.ts
} from '../../packages/agensis-cli/src/stopReasons.mjs'

describe('stopReasonFromSdkResult', () => {
  it('maps every documented subtype to exactly one member of the vocabulary', () => {
    expect(stopReasonFromSdkResult({ subtype: 'success' })).toBe('completed')
    expect(stopReasonFromSdkResult({ subtype: 'error_max_turns' })).toBe('max_turns')
    expect(stopReasonFromSdkResult({ subtype: 'error_max_budget_usd' })).toBe('max_budget')
    expect(stopReasonFromSdkResult({ subtype: 'error_during_execution' })).toBe('agent_error')
  })

  it('lets a recognised terminal_reason refine the subtype', () => {
    expect(stopReasonFromSdkResult({ subtype: 'success', terminal_reason: 'aborted_streaming' })).toBe('cancelled')
    expect(stopReasonFromSdkResult({ subtype: 'success', terminal_reason: 'aborted_tools' })).toBe('cancelled')
    expect(stopReasonFromSdkResult({ subtype: 'success', terminal_reason: 'max_turns' })).toBe('max_turns')
    expect(stopReasonFromSdkResult({ subtype: 'success', terminal_reason: 'budget_exhausted' })).toBe('max_budget')
    expect(stopReasonFromSdkResult({ subtype: 'success', terminal_reason: 'prompt_too_long' })).toBe('max_tokens')
    expect(stopReasonFromSdkResult({ subtype: 'success', terminal_reason: 'refusal' })).toBe('refused')
  })

  // The load-bearing case. terminal_reason is typed OPTIONAL on the SDK result
  // and new values appear between releases; an unknown one must never turn a
  // failed turn into a reported success.
  it('falls back to the subtype when terminal_reason is unknown — never to completed', () => {
    expect(stopReasonFromSdkResult({ subtype: 'error_during_execution', terminal_reason: 'brand_new_value' }))
      .toBe('agent_error')
    expect(stopReasonFromSdkResult({ subtype: 'error_max_turns', terminal_reason: 'brand_new_value' }))
      .toBe('max_turns')
    expect(stopReasonFromSdkResult({ subtype: 'success', terminal_reason: 'brand_new_value' }))
      .toBe('completed')
  })

  it('treats an unrecognised subtype as an agent error rather than a clean finish', () => {
    expect(stopReasonFromSdkResult({ subtype: 'rate_limit' })).toBe('agent_error')
    expect(stopReasonFromSdkResult({})).toBe('completed')
  })

  it('upgrades only the generic failure bucket when tools were denied', () => {
    expect(stopReasonFromSdkResult({
      subtype: 'error_during_execution',
      permission_denials: [{ tool_name: 'Bash' }],
    })).toBe('permission_denied')

    // A turn that hit its cap stopped because of the cap, even if a tool was
    // denied along the way. Naming the denial would send the human to fix the
    // wrong thing.
    expect(stopReasonFromSdkResult({
      subtype: 'error_max_turns',
      permission_denials: [{ tool_name: 'Bash' }],
    })).toBe('max_turns')

    // A denial on a turn that SUCCEEDED is not why it stopped.
    expect(stopReasonFromSdkResult({
      subtype: 'success',
      permission_denials: [{ tool_name: 'Bash' }],
    })).toBe('completed')
  })

  it('only ever returns a member of the closed vocabulary', () => {
    const subtypes = ['success', 'error_max_turns', 'error_max_budget_usd', 'error_during_execution', 'nonsense', '']
    const terminals = ['', 'aborted_tools', 'refusal', 'made_up']
    for (const subtype of subtypes) {
      for (const terminal_reason of terminals) {
        expect(isStopReason(stopReasonFromSdkResult({ subtype, terminal_reason }))).toBe(true)
      }
    }
  })
})

describe('stopFromSdkResult', () => {
  it('carries the fields the daemon used to discard', () => {
    const stop = stopFromSdkResult({
      subtype: 'success',
      terminal_reason: 'max_turns',
      num_turns: 7,
      total_cost_usd: 0.42,
      permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Write' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    })
    expect(stop).toEqual({
      reason: 'max_turns',
      detail: 'max_turns',
      numTurns: 7,
      costUsd: 0.42,
      permissionDenials: 2,
      usage: { input_tokens: 100, output_tokens: 20 },
    })
  })

  it('degrades to the subtype for detail when terminal_reason is absent, and never NaN', () => {
    const stop = stopFromSdkResult({ subtype: 'error_during_execution' })
    expect(stop.detail).toBe('error_during_execution')
    expect(stop.numTurns).toBe(0)
    expect(stop.costUsd).toBe(0)
    expect(stop.usage).toBeNull()
  })
})

describe('the other two runtimes fold onto the same vocabulary', () => {
  it('maps codex turn/completed', () => {
    expect(stopFromCodexTurn({ turn: { status: 'completed' } }).reason).toBe('completed')
    expect(stopFromCodexTurn({ turn: { status: 'failed', error: { message: 'boom' } } }).reason).toBe('agent_error')
    expect(stopFromCodexTurn({ turn: { status: 'cancelled' } }).reason).toBe('cancelled')
    // An error with no status is still a failure.
    expect(stopFromCodexTurn({ turn: { error: 'boom' } }).reason).toBe('agent_error')
  })

  it('maps amp error codes', () => {
    expect(stopFromAmpResult('', false).reason).toBe('completed')
    expect(stopFromAmpResult('amp_turn_cancelled', true).reason).toBe('cancelled')
    expect(stopFromAmpResult('amp_cli_crashed', true).reason).toBe('agent_error')
    // An unmapped code is honestly an agent error, not a success.
    expect(stopFromAmpResult('amp_something_new', false).reason).toBe('agent_error')
  })
})

describe('the vocabulary itself', () => {
  it('has no duplicates and accepts only its own members', () => {
    expect(new Set(STOP_REASONS).size).toBe(STOP_REASONS.length)
    for (const reason of STOP_REASONS) expect(isStopReason(reason)).toBe(true)
    for (const bad of ['COMPLETED', 'completed ', '', null, undefined, 42, {}]) {
      expect(isStopReason(bad)).toBe(false)
    }
  })

  it('stopValue produces the same shape as the SDK mapper', () => {
    expect(Object.keys(stopValue('cancelled')).sort())
      .toEqual(Object.keys(stopFromSdkResult({ subtype: 'success' })).sort())
  })
})
