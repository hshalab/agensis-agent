// packages/agensis-cli/src/sessionSlots.mjs
//
// Which warm session a conversation gets to run on.
//
// THE PROBLEM THIS EXISTS FOR. `--max-concurrency 2` is a no-op on the default
// code path. The lane queue admits two conversations at once (agensis.mjs), but
// every job is handed the SAME sessionKey — `${workspaceId}:${agent}` — and
// connectionExecutors.mjs serialises same-key runs behind a keyed mutex. So the
// queue lets two lanes in and the mutex funnels them onto one connection:
// effective parallelism is 1. That mutex is CORRECT — two jobs must never race
// one connection — the missing piece is more than one connection to hand out.
//
// A second, quieter consequence: because one session serves the whole silo,
// consecutive turns in DIFFERENT conversations share one runtime conversation
// history. A turn in #build is visible to the next turn in a DM. Within one
// workspace and one agent that is not a privilege escalation, but it is
// cross-channel bleed nobody chose, and giving each lane its own slot fixes it
// as a side effect — which also makes it a BEHAVIOUR change, hence the default
// of 1 slot (exactly today) until someone opts in.
//
// Pure: a Map and some integers, no I/O and no timers, so every leak and eviction
// path is unit-testable without a subprocess. In Rust a slot would be an owned
// value the compiler reclaims; here a claim without a matching release is a
// permanent capacity loss that nothing will catch for us, so `release` MUST be
// called from a `finally`.

/**
 * @param {{ slots?: number }} [opts] slots per silo; 1 reproduces today exactly.
 */
export function createSessionSlots({ slots = 1 } = {}) {
  const size = Math.max(1, Math.floor(Number(slots) || 1));
  // silo -> { byLane: Map<lane, slot>, busy: Set<slot>, lastUsed: Map<slot, seq> }
  const silos = new Map();
  let seq = 0;

  const siloState = (silo) => {
    let state = silos.get(silo);
    if (!state) {
      state = { byLane: new Map(), busy: new Set(), lastUsed: new Map() };
      silos.set(silo, state);
    }
    return state;
  };

  /**
   * Reserve a slot for `lane` within `silo`.
   *
   * Lane-STICKY: a lane that ran on slot 2 prefers slot 2, so a conversation
   * keeps its own warm session (and its own history) turn after turn instead of
   * being reshuffled onto whichever slot happens to be free.
   *
   * ALWAYS returns a slot in [0, size) — never null, and this is load-bearing
   * twice over:
   *
   *  - Admission control is the QUEUE's job (`maxConcurrency`), and the keyed
   *    mutex in connectionExecutors.mjs already serialises two jobs that land on
   *    one session. A null here would mean the caller had to invent a fallback
   *    key, and at the default of one slot that fallback would be a SECOND
   *    session key for the same silo — quietly breaking the promise that one
   *    slot reproduces today's behaviour exactly.
   *  - It designs the deadlock out rather than mitigating it. A leaked claim
   *    (a `finally` that never ran, a crash between claim and release) can only
   *    ever cost slot PREFERENCE here, never capacity. At one slot a wedged
   *    allocator would otherwise look exactly like the wedged DM this repo has
   *    already lived through.
   *
   * @returns {number}
   */
  const claim = (silo, lane) => {
    const state = siloState(silo);
    const laneKey = String(lane || "");

    const sticky = state.byLane.get(laneKey);
    if (sticky !== undefined && !state.busy.has(sticky)) {
      state.busy.add(sticky);
      state.lastUsed.set(sticky, (seq += 1));
      return sticky;
    }

    // A slot nobody has bound yet is always better than evicting someone.
    for (let slot = 0; slot < size; slot += 1) {
      if (state.busy.has(slot)) continue;
      const bound = [...state.byLane.values()].includes(slot);
      if (bound) continue;
      state.byLane.set(laneKey, slot);
      state.busy.add(slot);
      state.lastUsed.set(slot, (seq += 1));
      return slot;
    }

    // Every slot is bound to some lane. Take the least-recently-used one and
    // move its lane off it — LRU because the lane that has gone longest without
    // a turn is the one whose warm history is least likely to be wanted next.
    //
    // Idle slots are preferred over busy ones, but a busy slot IS eligible: see
    // the contract above. Landing on one means this job queues behind the other
    // on that session's mutex, which is precisely what every job does today.
    let victim = null;
    const better = (a, b) => {
      if (b === null) return true;
      const aBusy = state.busy.has(a);
      const bBusy = state.busy.has(b);
      if (aBusy !== bBusy) return !aBusy;
      return (state.lastUsed.get(a) || 0) < (state.lastUsed.get(b) || 0);
    };
    for (let slot = 0; slot < size; slot += 1) {
      if (better(slot, victim)) victim = slot;
    }

    for (const [otherLane, slot] of [...state.byLane]) {
      if (slot === victim) state.byLane.delete(otherLane);
    }
    state.byLane.set(laneKey, victim);
    state.busy.add(victim);
    state.lastUsed.set(victim, (seq += 1));
    return victim;
  };

  /**
   * Hand a slot back. Idempotent, and safe for a slot that was never claimed —
   * a release path that could itself throw would be one more way to strand
   * capacity, and this is called from `finally` blocks.
   */
  const release = (silo, slot) => {
    const state = silos.get(silo);
    if (!state || slot === null || slot === undefined) return;
    state.busy.delete(slot);
  };

  /**
   * Forget a lane's affinity (its session died, so the binding means nothing).
   * The slot itself stays available — this is about which lane prefers it.
   */
  const forgetLane = (silo, lane) => {
    const state = silos.get(silo);
    if (!state) return;
    state.byLane.delete(String(lane || ""));
  };

  const busyCount = (silo) => (silos.get(silo)?.busy.size || 0);

  return { claim, release, forgetLane, busyCount, size };
}
