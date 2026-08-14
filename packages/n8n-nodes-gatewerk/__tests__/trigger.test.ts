import { describe, it, expect } from 'vitest';
import {
  GatewerkTrigger,
  eventPassesFilter,
  GATEWERK_EVENT_NAMES,
} from '../nodes/Gatewerk/GatewerkTrigger.node';

describe('GatewerkTrigger descriptor', () => {
  const node = new GatewerkTrigger();

  it('is a trigger: no inputs, one output', () => {
    expect(node.description.group).toEqual(['trigger']);
    expect(node.description.inputs).toEqual([]);
    expect(node.description.outputs).toEqual(['main']);
  });

  it('exposes a POST webhook', () => {
    const webhook = (node.description.webhooks ?? [])[0];
    expect(webhook.httpMethod).toBe('POST');
    expect(webhook.responseMode).toBe('onReceived');
    // A trigger listens on a stable path, unlike the resume webhook on
    // Request Review which must be keyed by node id.
    expect(webhook.restartWebhook).toBeUndefined();
  });

  it('does not require a credential, because verification is optional', () => {
    expect(node.description.credentials?.[0].required).toBe(false);
  });

  it('offers every event the API can emit, plus the custom-iteration catch-all', () => {
    const events = node.description.properties.find((p) => p.name === 'events');
    const values = (events?.options ?? []).map((o) => (o as { value: string }).value);
    for (const name of GATEWERK_EVENT_NAMES) {
      expect({ name, offered: values.includes(name) }).toEqual({ name, offered: true });
    }
    expect(values).toContain('custom.iteration');
  });
});

describe('eventPassesFilter', () => {
  it('passes everything when no filter is set', () => {
    // A trigger with no configuration should fire, not sit silent.
    expect(eventPassesFilter('review.decided', 'decision', [])).toBe(true);
    expect(eventPassesFilter('chain.aborted', 'chain', [])).toBe(true);
    expect(eventPassesFilter('anything.at.all', 'unknown', [])).toBe(true);
  });

  it('passes only the selected events', () => {
    expect(eventPassesFilter('review.decided', 'decision', ['review.decided'])).toBe(true);
    expect(eventPassesFilter('review.expired', 'expiry', ['review.decided'])).toBe(false);
  });

  it('matches operator-defined iteration events via the catch-all', () => {
    // These have project-specific names, so they cannot be listed individually.
    expect(eventPassesFilter('review.iteration_needs_legal', 'iteration', ['custom.iteration'])).toBe(
      true,
    );
  });

  it('does not let the catch-all swallow named events', () => {
    // review.action_taken is class 'iteration' but is a named event; selecting
    // only the catch-all must not deliver it.
    expect(eventPassesFilter('review.action_taken', 'iteration', ['custom.iteration'])).toBe(false);
    expect(eventPassesFilter('review.retried', 'iteration', ['custom.iteration'])).toBe(false);
  });

  it('does not match an unknown-class event via the iteration catch-all', () => {
    expect(eventPassesFilter('weird.thing', 'unknown', ['custom.iteration'])).toBe(false);
  });
});
