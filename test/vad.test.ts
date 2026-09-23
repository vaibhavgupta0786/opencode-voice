import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  hadSpeech,
  initialVadState,
  mergeOptions,
  vadStep,
  type VadState,
} from "../logic.ts"

const LOUD = 0.5 // clearly voice
const QUIET = 0.0 // silence

function runTicks(state: VadState, peaks: number[]): VadState {
  const opts = mergeOptions()
  let s = state
  for (const peak of peaks) s = vadStep(s, peak, opts)
  return s
}

const ticks = (n: number, peak: number): number[] => Array.from({ length: n }, () => peak)

describe("vad", () => {
  it("stays silent and finishes on start-timeout when nobody speaks", () => {
    const s = runTicks(initialVadState(), ticks(80, QUIET)) // 80 x 50ms = 4s
    assert.equal(s.done, true)
    assert.equal(s.doneReason, "start-timeout")
    assert.equal(hadSpeech(s, mergeOptions()), false)
  })

  it("counts voiced time and tracks the loudest peak", () => {
    const s = runTicks(initialVadState(), ticks(10, LOUD))
    assert.equal(s.done, false)
    assert.equal(s.spoken, true)
    assert.equal(s.voicedMs, 500)
    assert.equal(s.loudest, LOUD)
    assert.equal(hadSpeech(s, mergeOptions()), true)
  })

  it("requires minSpeechMs before hadSpeech (a cough is not speech)", () => {
    const s = runTicks(initialVadState(), ticks(2, LOUD)) // 100ms < 300ms
    assert.equal(s.spoken, true)
    assert.equal(hadSpeech(s, mergeOptions()), false)
  })

  it("toggle mode survives long thinking pauses", () => {
    // 2s speech, 10s silence, 2s speech — one take in toggle mode.
    const s = runTicks(initialVadState(), [...ticks(40, LOUD), ...ticks(200, QUIET), ...ticks(40, LOUD)])
    assert.equal(s.done, false)
    assert.equal(s.voicedMs, 4000)
  })

  it("auto mode ends the take after silenceMs", () => {
    const opts = mergeOptions({ toggle: false, silenceMs: 900 })
    let s = initialVadState()
    for (const peak of [...ticks(40, LOUD), ...ticks(18, QUIET)]) s = vadStep(s, peak, opts)
    assert.equal(s.done, true)
    assert.equal(s.doneReason, "silence")
  })

  it("caps a take at maxMs", () => {
    const opts = mergeOptions({ maxMs: 1000 })
    let s = initialVadState()
    for (const peak of ticks(40, LOUD)) s = vadStep(s, peak, opts)
    assert.equal(s.done, true)
    assert.equal(s.doneReason, "max-length")
  })

  it("ignores ticks after done", () => {
    const s = runTicks(initialVadState(), ticks(200, QUIET))
    const again = vadStep(s, LOUD, mergeOptions())
    assert.equal(again, s)
  })
})
