import type {
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
  INodeExecutionData,
  IDataObject,
  ICredentialDataDecryptedObject,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { verifyGatewerkSignature } from '../../helpers/verifySignature';
import { classifyGatewerkEvent, toOutputJson } from '../../helpers/events';

/**
 * Every event name Gatewerk can deliver, for the filter dropdown.
 *
 * Mirrors apps/api/src/services/webhooks.ts and
 * apps/api/src/services/webhooks/chain-payloads.ts. Operator-authored iteration
 * events have arbitrary names, so they are matched by class rather than listed.
 */
export const GATEWERK_EVENT_NAMES = [
  'review.decided',
  'review.retried',
  'review.action_taken',
  'review.expired',
  'review.sent_back',
  'review.questions_raised',
  'review.vetoed',
  'review.confirmed',
  'assignment.escalated',
  'chain.next_step_ready',
  'chain.completed',
  'chain.rejected',
  'chain.step_decided',
  'chain.step_rejected',
  'chain.step_halted',
  'chain.aborted',
] as const;

/**
 * Decide whether a classified event passes the node's filter.
 *
 * Exported for direct testing. An empty filter means "everything", which is the
 * least surprising default for a trigger: a user who has not configured a filter
 * expects to see events, not silence.
 */
export function eventPassesFilter(
  eventName: string,
  eventClass: string,
  selectedEvents: string[],
): boolean {
  if (selectedEvents.length === 0) return true;
  if (selectedEvents.includes(eventName)) return true;
  // `custom.iteration` is the catch-all for operator-defined iteration events,
  // which cannot be enumerated because the names are chosen per project.
  if (selectedEvents.includes('custom.iteration')) {
    return eventClass === 'iteration' && !GATEWERK_EVENT_NAMES.includes(eventName as never);
  }
  return false;
}

export class GatewerkTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Gatewerk Trigger',
    name: 'gatewerkTrigger',
    icon: { light: 'file:gatewerk.svg', dark: 'file:gatewerk.dark.svg' },
    group: ['trigger'],
    version: 1,
    // Required by n8n's community-node lint, whose type only permits `true`.
    // It is inert here: a trigger has no execute(), so n8n generates no tool
    // variant for it, unlike the five action nodes.
    usableAsTool: true,
    subtitle: '={{$parameter["events"].length ? $parameter["events"].join(", ") : "all events"}}',
    description: 'Start a workflow when something happens to a Gatewerk review',
    defaults: {
      name: 'Gatewerk Trigger',
    },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'gatewerkApi',
        // Only needed to verify signatures. A trigger on a trusted network can
        // run without one, so this is not marked required.
        required: false,
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'webhook',
      },
    ],
    properties: [
      {
        displayName:
          'Gatewerk cannot register this URL for you: its webhook settings are admin and session only, so an API key cannot create a subscription. Copy the Production URL above and either paste it into Gatewerk under Settings, Webhooks, or pass it as the callback_url when a review is created (for example from a Gatewerk Request Review node with Wait for Decision turned off).',
        name: 'setupNotice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        default: [],
        description:
          'Which events start the workflow. Leave empty to receive every event Gatewerk sends to this URL.',
        // Alphabetised by name, as n8n's community-node lint requires. The
        // `value` strings are the wire event names and must not be reordered
        // into anything else.
        options: [
          {
            name: 'Assignment Escalated',
            value: 'assignment.escalated',
            description: 'The review moved to the next reviewer on the ladder',
          },
          { name: 'Chain Aborted', value: 'chain.aborted' },
          { name: 'Chain Completed', value: 'chain.completed' },
          { name: 'Chain Next Step Ready', value: 'chain.next_step_ready' },
          { name: 'Chain Rejected', value: 'chain.rejected' },
          {
            name: 'Chain Step Decided',
            value: 'chain.step_decided',
            description: 'One step of a route decided. The chain itself may still be open.',
          },
          { name: 'Chain Step Halted', value: 'chain.step_halted' },
          { name: 'Chain Step Rejected', value: 'chain.step_rejected' },
          {
            name: 'Custom Iteration Event',
            value: 'custom.iteration',
            description:
              'Any operator-defined iteration event. These have project-specific names, so they cannot be listed individually.',
          },
          {
            name: 'Review Action Taken',
            value: 'review.action_taken',
            description: 'A configurable action was invoked on the review',
          },
          {
            name: 'Review Confirmed',
            value: 'review.confirmed',
            description: 'A monitoring window closed without a veto',
          },
          {
            name: 'Review Decided',
            value: 'review.decided',
            description: 'A human approved, rejected or edited the review',
          },
          {
            name: 'Review Expired',
            value: 'review.expired',
            description: 'The review timed out',
          },
          {
            name: 'Review Questions Raised',
            value: 'review.questions_raised',
            description: 'An external recipient asked a question instead of deciding',
          },
          {
            name: 'Review Retried',
            value: 'review.retried',
            description: 'The review was sent back to the agent for another attempt',
          },
          {
            name: 'Review Sent Back',
            value: 'review.sent_back',
            description: 'An external recipient returned the review without deciding',
          },
          {
            name: 'Review Vetoed',
            value: 'review.vetoed',
            description: 'A monitoring gate was vetoed by a human',
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Include Raw Payload',
            name: 'includeRawPayload',
            type: 'boolean',
            default: true,
            description:
              'Whether to include the untouched Gatewerk body as rawPayload alongside the normalised fields',
          },
        ],
      },
    ],
  };

  /**
   * Lifecycle hooks are deliberate no-ops.
   *
   * Gatewerk exposes no API-key-reachable endpoint for creating a webhook
   * subscription: `POST /api/v1/settings/webhooks` sits behind session auth
   * (apps/api/src/routes/settings/index.ts:29) plus `requireRole("admin")`
   * (routes/settings/webhooks.ts:57). So the URL is registered by hand, and
   * there is nothing to create or tear down here.
   */
  webhookMethods = {
    default: {
      async checkExists(): Promise<boolean> {
        return false;
      },
      async create(): Promise<boolean> {
        return true;
      },
      async delete(): Promise<boolean> {
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    // Credentials are optional on this node, so a missing credential must not
    // throw: it means "no signature verification configured".
    let credentials: ICredentialDataDecryptedObject | undefined;
    try {
      credentials = (await this.getCredentials('gatewerkApi')) as ICredentialDataDecryptedObject;
    } catch {
      credentials = undefined;
    }

    const webhookSecret = (credentials?.webhookSecret as string | undefined) || '';
    const verification = ((credentials?.callbackVerification as string) || 'auto') as
      | 'auto'
      | 'require'
      | 'off';

    if (verification !== 'off') {
      if (verification === 'require' && !webhookSecret) {
        return { webhookResponse: { statusCode: 401, body: 'Unauthorized' } };
      }
      if (webhookSecret) {
        const headers = this.getHeaderData() as Record<string, string | string[] | undefined>;
        const req = this.getRequestObject() as { rawBody?: Buffer; body?: unknown };
        const rawBody: Buffer | string | undefined =
          req.rawBody ?? (typeof req.body === 'string' ? req.body : undefined);
        if (!rawBody) {
          return { webhookResponse: { statusCode: 401, body: 'Unauthorized' } };
        }
        const result = verifyGatewerkSignature({
          rawBody,
          v1Header: headers['x-webhook-signature'],
          v2Header: headers['x-webhook-signature-v2'],
          secret: webhookSecret,
        });
        if (!result.ok) {
          return { webhookResponse: { statusCode: 401, body: 'Unauthorized' } };
        }
      }
    }

    const bodyData = this.getBodyData() as Record<string, unknown>;
    const event = classifyGatewerkEvent(bodyData);

    const selectedEvents = this.getNodeParameter('events', []) as string[];
    if (!eventPassesFilter(event.eventName, event.eventClass, selectedEvents)) {
      // 200 so Gatewerk records the delivery and stops retrying. A filtered-out
      // event is a successful delivery that this workflow simply ignores.
      return { webhookResponse: 'OK' };
    }

    const options = this.getNodeParameter('options', {}) as IDataObject;
    const json = toOutputJson(event) as IDataObject;
    if (options.includeRawPayload === false) delete json.rawPayload;

    const workflowData: INodeExecutionData[][] = [this.helpers.returnJsonArray([json])];

    return { webhookResponse: 'OK', workflowData };
  }
}
