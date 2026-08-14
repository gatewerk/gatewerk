import { describe, expect, it } from 'vitest'
import { decryptAtRest, encryptAtRest } from './secret-crypto'

const TEST_KEY = 'a'.repeat(64) // 64 hex chars = 32 bytes

describe('encryptAtRest / decryptAtRest', () => {
  it('round-trips plaintext correctly', () => {
    const plaintext = 'xoxb-slack-bot-token-example'
    const ciphertext = encryptAtRest(plaintext, TEST_KEY)
    expect(decryptAtRest(ciphertext, TEST_KEY)).toBe(plaintext)
  })

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'same-plaintext'
    const ct1 = encryptAtRest(plaintext, TEST_KEY)
    const ct2 = encryptAtRest(plaintext, TEST_KEY)
    expect(ct1).not.toBe(ct2)
  })

  it('throws on a tampered ciphertext (GCM auth tag mismatch)', () => {
    const ct = encryptAtRest('secret', TEST_KEY)
    const parts = ct.split(':')
    // XOR the first ciphertext byte so it is GUARANTEED to differ.
    // This previously ASSIGNED 'ff', which is a no-op whenever the ciphertext
    // already began with ff — and the IV is random, so that happened about 1
    // run in 256 (measured: 84/20000 = 0.42%). On those runs the value was
    // byte-identical to the original, decryption correctly succeeded, and the
    // test failed while asserting nothing about tampering.
    const firstByte = parseInt(parts[1].slice(0, 2), 16)
    const flipped = (firstByte ^ 0xff).toString(16).padStart(2, '0')
    const tampered = parts[0] + ':' + (flipped + parts[1].slice(2)) + ':' + parts[2]
    expect(tampered).not.toBe(ct)
    expect(() => decryptAtRest(tampered, TEST_KEY)).toThrow()
  })

  it('throws when decrypting with a wrong key', () => {
    const ct = encryptAtRest('secret', TEST_KEY)
    const wrongKey = 'b'.repeat(64)
    expect(() => decryptAtRest(ct, wrongKey)).toThrow()
  })

  it('throws when keyHex is not 64 hex chars', () => {
    expect(() => encryptAtRest('secret', 'tooshort')).toThrow(
      'encryption key must be 64 hex chars (32 bytes)',
    )
    expect(() => decryptAtRest('iv:ct:tag', 'tooshort')).toThrow(
      'encryption key must be 64 hex chars (32 bytes)',
    )
  })

  it('throws on malformed ciphertext (missing segments)', () => {
    expect(() => decryptAtRest('notavalidformat', TEST_KEY)).toThrow('malformed ciphertext')
  })
})
