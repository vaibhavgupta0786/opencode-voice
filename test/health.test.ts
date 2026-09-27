import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { healthEndpoints, isLocalEndpoint } from "../logic.ts"

describe("health endpoints", () => {
  it("probes origin health first, then base health", () => {
    assert.deepEqual(healthEndpoints("http://127.0.0.1:8080/v1"), [
      "http://127.0.0.1:8080/health",
      "http://127.0.0.1:8080/v1/health",
    ])
  })

  it("dedupes when base is already the origin", () => {
    assert.deepEqual(healthEndpoints("http://127.0.0.1:8080"), ["http://127.0.0.1:8080/health"])
  })

  it("tolerates trailing slashes and full transcription URLs", () => {
    assert.deepEqual(healthEndpoints("http://127.0.0.1:8080/v1/"), [
      "http://127.0.0.1:8080/health",
      "http://127.0.0.1:8080/v1/health",
    ])
    const [first] = healthEndpoints("https://x.example/v1/audio/transcriptions")
    assert.equal(first, "https://x.example/health")
  })

  it("detects local endpoints only", () => {
    assert.equal(isLocalEndpoint("http://127.0.0.1:8080/v1"), true)
    assert.equal(isLocalEndpoint("http://localhost:8080/v1"), true)
    assert.equal(isLocalEndpoint("http://[::1]:8080/v1"), true)
    assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false)
    assert.equal(isLocalEndpoint("not a url"), false)
  })
})
