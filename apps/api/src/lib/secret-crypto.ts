import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'

function keyBuf(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex))
    throw new Error('encryption key must be 64 hex chars (32 bytes)')
  return Buffer.from(keyHex, 'hex')
}

export function encryptAtRest(plaintext: string, keyHex: string): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGO, keyBuf(keyHex), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`
}

export function decryptAtRest(ciphertext: string, keyHex: string): string {
  const [ivHex, ctHex, tagHex] = ciphertext.split(':')
  if (!ivHex || !ctHex || !tagHex) throw new Error('malformed ciphertext')
  const decipher = createDecipheriv(ALGO, keyBuf(keyHex), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString(
    'utf8',
  )
}
