import { describe, it, expect } from 'vitest'
import { reviews } from './reviews'

describe('reviews schema', () => {
  it('reviews has reminder_sent_at', () => {
    expect(Object.keys(reviews)).toContain('reminder_sent_at')
  })
})
