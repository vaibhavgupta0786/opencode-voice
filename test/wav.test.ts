import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { RATE, peakOf, wavFromPcm } from "../logic.ts"

function pcm16(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(s * 32767), i * 2))
  return buf
}

describe("pcm + wav", () => {
  it("peakOf measures the loudest sample", () => {
    assert.equal(peakOf(Buffer.alloc(0)), 0)
    assert.equal(peakOf(pcm16([0, 0, 0])), 0)
    const peak = peakOf(pcm16([0, 0.5, -0.25]))
    assert.ok(Math.abs(peak - 0.5) < 0.001, `got ${peak}`)
  })

  it("wavFromPcm writes a valid 16kHz mono header and keeps the samples", () => {
    const pcm = pcm16([0.1, -0.1, 0.3])
    const wav = wavFromPcm(pcm)
    assert.equal(wav.length, 44 + pcm.length)
    assert.equal(wav.toString("ascii", 0, 4), "RIFF")
    assert.equal(wav.readUInt32LE(4), 36 + pcm.length)
    assert.equal(wav.toString("ascii", 8, 12), "WAVE")
    assert.equal(wav.readUInt16LE(20), 1) // PCM
    assert.equal(wav.readUInt16LE(22), 1) // mono
    assert.equal(wav.readUInt32LE(24), RATE)
    assert.equal(wav.readUInt16LE(34), 16)
    assert.equal(wav.toString("ascii", 36, 40), "data")
    assert.equal(wav.readUInt32LE(40), pcm.length)
    assert.ok(wav.subarray(44).equals(pcm))
  })
})
