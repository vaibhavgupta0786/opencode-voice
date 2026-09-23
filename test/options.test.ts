import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DEFAULTS, mergeOptions, sttEndpoint } from "../logic.ts"

describe("options + stt", () => {
  it("mergeOptions fills every default", () => {
    assert.deepEqual(mergeOptions(), { ...DEFAULTS })
  })

  it("mergeOptions honours overrides", () => {
    const opts = mergeOptions({ silenceMs: 2500, toggle: false })
    assert.equal(opts.silenceMs, 2500)
    assert.equal(opts.toggle, false)
    assert.equal(opts.model, DEFAULTS.model)
  })

  it("sttEndpoint appends the transcriptions path once", () => {
    assert.equal(sttEndpoint("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1/audio/transcriptions")
    assert.equal(sttEndpoint("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080/v1/audio/transcriptions")
    assert.equal(
      sttEndpoint("http://x/v1/audio/transcriptions"),
      "http://x/v1/audio/transcriptions",
    )
  })
})
