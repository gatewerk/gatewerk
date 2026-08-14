import type {
  JsonObject,
  INodeType,
  INodeTypeDescription,
  IExecuteFunctions,
  IWebhookFunctions,
  INodeExecutionData,
  IWebhookResponseData,
  IDataObject,
  ICredentialDataDecryptedObject,
} from 'n8n-workflow';
import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  UserError,
} from 'n8n-workflow';
import { gatewerkApiRequest } from '../../helpers/api';
import { verifyGatewerkSignature } from '../../helpers/verifySignature';
import { getTemplates, getTemplateActions } from '../../helpers/loadOptions';
import { buildReviewBody, shouldResumeOn } from '../../helpers/review';
import { classifyGatewerkEvent, toOutputJson } from '../../helpers/events';

/** Accept either a JSON string or an already-parsed object from an expression. */
function parseJson(
  ctx: IExecuteFunctions,
  value: unknown,
  label: string,
  itemIndex: number,
): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new NodeOperationError(ctx.getNode(), `${label} must be valid JSON`, { itemIndex });
  }
}

/** Drop undefined/empty entries so we never send `?status=` with no value. */
function qs(input: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' || typeof v === 'string') out[k] = v;
  }
  return out;
}

export class Gatewerk implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Gatewerk',
    name: 'gatewerk',
    icon: { light: 'file:gatewerk.svg', dark: 'file:gatewerk.dark.svg' },
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description:
      'Put a human in the loop. Ask a person to approve, reject or edit what an AI agent is about to do, and read back reviews, chains, feedback and the audit trail.',
    usableAsTool: true,
    defaults: { name: 'Gatewerk' },
    inputs: [NodeConnectionTypes.Main],
    /**
     * ONE output. A waiting execution can only ever resume on output 0: n8n
     * assigns the resume webhook's `workflowData` to
     * `nodeExecutionStack[0].data.main` as this node's INPUT
     * (webhook-helpers.js:212-234) while `WaitingWebhooks` has the node disabled
     * (waiting-webhooks.js:172), and a disabled node forwards input 0 to output
     * 0 and discards the rest. Branch downstream on `outcome` with a Switch node.
     */
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'gatewerkApi', required: true }],
    /**
     * Resume webhook for `review: sendAndWait`.
     *
     * `path: '={{ $nodeId }}'` + `isFullPath: true` is mandatory: n8n's
     * waiting-webhook router matches `webhook.path === suffix`
     * (waiting-webhooks.js:205-209) where suffix is the node id embedded in the
     * URL that `getSignedResumeUrl()` mints. A literal path can never match, so
     * the callback would 404 and the execution would hang to its wait timeout.
     */
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        responseData: '',
        path: '={{ $nodeId }}',
        restartWebhook: true,
        isFullPath: true,
      },
    ],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'review',
        options: [
          { name: 'Audit', value: 'audit' },
          { name: 'Chain', value: 'chain' },
          { name: 'Feedback', value: 'feedback' },
          { name: 'Note', value: 'note' },
          { name: 'Review', value: 'review' },
          { name: 'Stat', value: 'stat' },
          { name: 'Template', value: 'template' },
        ],
      },

      // ---------------------------------------------------------------- review
      /**
       * The literal value `sendAndWait` is load-bearing beyond the UI.
       *
       * n8n only generates a real human-in-the-loop tool for a node whose
       * `operation` property offers it (tool-generation/hitl-tools.js:8-27,138),
       * and only that `…HitlTool` variant gets `rewireOutputLogTo = AiTool`,
       * which returns the human's decision to a calling AI Agent. Rename it and
       * the node silently degrades to an ordinary tool that suspends forever
       * from the agent's point of view, with no error anywhere.
       */
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['review'] } },
        default: 'sendAndWait',
        options: [
{
            name: 'Create',
            value: 'create',
            description: 'Create a review and continue immediately',
            action: 'Create a review',
          },
{
            name: 'Get',
            value: 'get',
            description: 'Get a single review by ID',
            action: 'Get a review',
          },
{
            name: 'Get Many',
            value: 'getAll',
            description: 'List reviews with optional filters',
            action: 'Get many reviews',
          },
{
            name: 'Get Versions',
            value: 'getVersions',
            description: 'Get the iteration history of a review',
            action: 'Get review versions',
          },
{
            name: 'Request Review and Wait',
            value: 'sendAndWait',
            description: 'Create a review and pause until a human decides',
            action: 'Request a review and wait for the decision',
          },
{
            name: 'Share Link',
            value: 'createToken',
            description: 'Mint an external review link so someone without an account can decide',
            action: 'Create an external review link',
          },
{
            name: 'Submit Revision',
            value: 'update',
            description:
              'Resubmit a revised payload after a reviewer asked for changes, so they can decide again',
            action: 'Submit a revision to a review',
          },
{
            name: 'Take Action',
            value: 'act',
            description: 'Invoke a configurable action such as approve or reject',
            action: 'Take an action on a review',
          },
],
      },
      {
        displayName: 'Template Name or ID',
        name: 'template',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getTemplates' },
        default: '',
        required: true,
        displayOptions: { show: { resource: ['review'], operation: ['sendAndWait', 'create'] } },
        description:
          'Pass the template slug, not the gw_tpl_ ID: the API matches templates on slug, and a gw_tpl_ ID fails with template_not_found even though the template exists. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Payload',
        name: 'payload',
        type: 'json',
        default: '{}',
        required: true,
        displayOptions: { show: { resource: ['review'], operation: ['sendAndWait', 'create'] } },
        description: 'The data to be reviewed. Map fields from previous nodes using expressions.',
        placeholder: '{"subject": "Hello", "body": "..."}',
      },
      {
        displayName:
          'While waiting, this node handles one input item per execution. To create many reviews at once use the Create operation and react to outcomes with a Gatewerk Trigger node.',
        name: 'multiItemNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { resource: ['review'], operation: ['sendAndWait'] } },
      },
      {
        displayName: 'Resume On',
        name: 'resumeOn',
        type: 'multiOptions',
        default: ['decision', 'expiry'],
        displayOptions: { show: { resource: ['review'], operation: ['sendAndWait'] } },
        description:
          'Which kinds of Gatewerk event resume this workflow. A review sends its whole event feed to the same callback and most events do not mean a decision was made. Events not selected here are acknowledged and the workflow keeps waiting.',
        options: [
          {
            name: 'Assignment Change',
            value: 'assignment',
            description: 'The review was escalated to a different reviewer. It is still open.',
          },
          {
            name: 'Chain Event',
            value: 'chain',
            description: 'A step in a chain run this review belongs to changed state',
          },
          {
            name: 'Decision',
            value: 'decision',
            description: 'Approved, rejected, edited, vetoed or confirmed. The review is finished.',
          },
          {
            name: 'Expiry',
            value: 'expiry',
            description: 'The review timed out or ran out of iterations',
          },
          {
            name: 'Iteration',
            value: 'iteration',
            description: 'Sent back, retried or questions raised. The review is still open.',
          },
        ],
      },
      {
        displayName: 'Priority',
        name: 'priority',
        type: 'options',
        default: 'normal',
        displayOptions: { show: { resource: ['review'], operation: ['sendAndWait', 'create'] } },
        options: [
          { name: 'Critical', value: 'critical' },
          { name: 'High', value: 'high' },
          { name: 'Low', value: 'low' },
          { name: 'Normal', value: 'normal' },
        ],
        description: 'Priority level of the review request',
      },
      {
        displayName: 'Allowed Action Names or IDs',
        name: 'actions',
        type: 'multiOptions',
        typeOptions: {
          loadOptionsMethod: 'getTemplateActions',
          loadOptionsDependsOn: ['template'],
        },
        // Empty means "send no `actions` field", so the server falls back to the
        // template's own action list.
        default: [],
        displayOptions: { show: { resource: ['review'], operation: ['sendAndWait', 'create'] } },
        description:
          'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
      {
        displayName: 'Timeout Action',
        name: 'timeoutAction',
        type: 'options',
        default: '',
        displayOptions: { show: { resource: ['review'], operation: ['sendAndWait', 'create'] } },
        options: [
          { name: 'Auto-Approve', value: 'auto_approve' },
          { name: 'Auto-Reject', value: 'auto_reject' },
          { name: 'Expire', value: 'expire' },
          { name: 'None (Wait Forever)', value: '' },
        ],
        description: 'What happens if no human responds within the timeout period',
      },
      {
        displayName: 'Timeout (Seconds)',
        name: 'timeoutSeconds',
        type: 'number',
        default: 3600,
        // The API rejects anything under 60 (routes/reviews/crud.ts:137-141).
        typeOptions: { minValue: 60 },
        displayOptions: {
          show: {
            resource: ['review'],
            operation: ['sendAndWait', 'create'],
            timeoutAction: ['auto_approve', 'auto_reject', 'expire'],
          },
        },
        description: 'Seconds to wait before the timeout action triggers. Minimum 60.',
      },
      {
        displayName: 'Review ID',
        name: 'reviewId',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'gw_rev_...',
        displayOptions: {
          show: {
            resource: ['review'],
            operation: ['get', 'act', 'update', 'getVersions', 'createToken'],
          },
        },
        description: 'ID of the review',
      },
      {
        displayName: 'Revised Payload',
        name: 'revisedPayload',
        type: 'json',
        default: '{}',
        required: true,
        displayOptions: { show: { resource: ['review'], operation: ['update'] } },
        description: 'The corrected data to resubmit for review',
      },
      {
        displayName: 'Version',
        name: 'revisionVersion',
        type: 'number',
        default: 1,
        required: true,
        typeOptions: { minValue: 1 },
        displayOptions: { show: { resource: ['review'], operation: ['update'] } },
        description:
          'Version you are revising. Use the iterationCount or current_version you received, so a concurrent change is rejected instead of overwritten.',
      },
      {
        displayName: 'Expiry Hours',
        name: 'expiryHours',
        type: 'number',
        default: 72,
        typeOptions: { minValue: 1 },
        displayOptions: { show: { resource: ['review'], operation: ['createToken'] } },
        description: 'How long the external link stays valid',
      },
      {
        displayName: 'Action Name or ID',
        name: 'actionId',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'approve',
        displayOptions: { show: { resource: ['review'], operation: ['act'] } },
        description:
          'Action to invoke. Built-in actions are approve, reject, request_changes and cancel_iteration; templates may define more.',
      },
      {
        displayName: 'Additional Fields',
        name: 'actionOptions',
        type: 'collection',
        placeholder: 'Add Field',
        default: {},
        displayOptions: { show: { resource: ['review'], operation: ['act'] } },
        options: [
          {
            displayName: 'Edited Payload',
            name: 'editedPayload',
            type: 'json',
            default: '{}',
            description: 'Replacement payload when the action edits the review',
          },
          {
            displayName: 'Feedback',
            name: 'feedback',
            type: 'string',
            default: '',
            description: 'Reason or note to record with the action',
          },
          {
            displayName: 'Version',
            name: 'version',
            type: 'number',
            default: 1,
            description:
              'Optimistic-concurrency guard. Fails if the review has moved on from this version.',
          },
        ],
      },
      {
        displayName: 'Filters',
        name: 'reviewFilters',
        type: 'collection',
        placeholder: 'Add Filter',
        default: {},
        displayOptions: { show: { resource: ['review'], operation: ['getAll'] } },
        options: [
          { displayName: 'Assignee', name: 'assignee', type: 'string', default: '' },
          {
            displayName: 'Priority',
            name: 'priority',
            type: 'options',
            default: 'normal',
            options: [
              { name: 'Critical', value: 'critical' },
              { name: 'High', value: 'high' },
              { name: 'Low', value: 'low' },
              { name: 'Normal', value: 'normal' },
            ],
          },
          {
            displayName: 'Status',
            name: 'status',
            type: 'options',
            default: 'pending',
            options: [
              { name: 'Archived', value: 'archived' },
              { name: 'Awaiting External', value: 'awaiting_external' },
              { name: 'Awaiting Iteration', value: 'awaiting_iteration' },
              { name: 'Decided', value: 'decided' },
              { name: 'Expired', value: 'expired' },
              { name: 'Monitoring', value: 'monitoring' },
              { name: 'Pending', value: 'pending' },
            ],
          },
          {
            displayName: 'Template Name or ID',
            name: 'template',
            type: 'options',
            typeOptions: { loadOptionsMethod: 'getTemplates' },
            default: '',
            description:
          'Pass the template slug, not the gw_tpl_ ID: the API matches templates on slug, and a gw_tpl_ ID fails with template_not_found even though the template exists. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
          },
        ],
      },
      {
        displayName: 'Additional Options',
        name: 'additionalOptions',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { show: { resource: ['review'], operation: ['sendAndWait', 'create'] } },
        options: [
          {
            displayName: 'Assignee',
            name: 'assignee',
            type: 'string',
            default: '',
            placeholder: 'reviewer@example.com',
            description:
              'Email of the reviewer to assign to. Falls back to the API key default reviewer when empty.',
          },
          {
            displayName: 'Assignment Ladder',
            name: 'assignmentLadder',
            type: 'json',
            default: '[]',
            description:
              'Escalation ladder as a JSON array, for example [{"actor":"a@x.com","trigger_after_seconds":3600}]. Each trigger_after_seconds must be at least 60 and strictly increasing.',
          },
          {
            displayName: 'Confidence',
            name: 'confidence',
            type: 'number',
            default: 0,
            typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
            description: 'AI agent confidence score, from 0.0 to 1.0',
          },
          {
            displayName: 'Idempotency Key',
            name: 'idempotencyKey',
            type: 'string',
            default: '',
            description:
              'Replay guard. Re-sending the same key returns the original review instead of creating a duplicate.',
          },
          {
            displayName: 'Irreversibility',
            name: 'irreversibility',
            type: 'options',
            default: 'reversible',
            options: [
              { name: 'Costly to Reverse', value: 'costly_reversible' },
              { name: 'Irreversible', value: 'irreversible' },
              { name: 'Reversible', value: 'reversible' },
            ],
            description: 'How hard it is to undo this action',
          },
          {
            displayName: 'Max Iterations',
            name: 'maxIterations',
            type: 'number',
            default: 0,
            typeOptions: { minValue: 0 },
            description:
              'Cap on how many times the review can be sent back. 0 uses the template default.',
          },
          {
            displayName: 'Metadata',
            name: 'metadata',
            type: 'json',
            default: '{}',
            description: 'Additional metadata to attach to the review',
          },
          {
            displayName: 'Oversight',
            name: 'oversight',
            type: 'options',
            default: 'blocking',
            options: [
              { name: 'Blocking (Human Decides First)', value: 'blocking' },
              { name: 'Monitoring (Agent Acts, Human Can Veto)', value: 'monitoring' },
            ],
            description:
              'Blocking pauses until a human decides. Monitoring lets the agent act and gives a human a window to veto.',
          },
          {
            displayName: 'Trace URL',
            name: 'traceUrl',
            type: 'string',
            default: '',
            placeholder: 'https://...',
            description: 'Link to the agent trace behind this review. Must be https.',
          },
          {
            displayName: 'Wait Timeout (Minutes)',
            name: 'waitTimeoutMinutes',
            type: 'number',
            default: 1440,
            description:
              'How long n8n keeps the execution waiting before giving up. Separate from the Gatewerk review timeout.',
          },
        ],
      },

      // ------------------------------------------------------------------ note
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['note'] } },
        default: 'create',
        /**
         * No Get Many here, deliberately.
         *
         * `GET /api/v1/notes` validates against ListNotesQuerySchema, whose
         * `project_id` is REQUIRED (packages/shared/src/api/schemas/notes.ts:102),
         * and no middleware injects it into req.query
         * (apps/api/src/routes/notes/read.ts:20). An API key is implicitly
         * project-scoped and `GET /api/v1/auth/key-info` does not return the
         * project id, so a key-authenticated caller has nothing to send and the
         * request 422s every time. That endpoint also pages by `cursor`, not
         * `offset`. Shipping the operation would guarantee a broken node.
         * Re-add it once the API resolves project_id server-side for api_key
         * subjects, as it already does for note creation.
         */
        options: [{ name: 'Create', value: 'create', action: 'Create a note' }],
      },
      {
        displayName: 'Body',
        name: 'noteBody',
        type: 'string',
        typeOptions: { rows: 3 },
        default: '',
        required: true,
        displayOptions: { show: { resource: ['note'], operation: ['create'] } },
        description: 'Text of the note',
      },
      {
        displayName: 'Shared',
        name: 'isShared',
        type: 'boolean',
        default: true,
        displayOptions: { show: { resource: ['note'], operation: ['create'] } },
        description:
          'Whether the note is visible to the whole project. API key callers cannot create private notes: the API rejects them with 422 api_key_cannot_create_private, and an API key is the only credential this package ships. Leave this on.',
      },
      {
        displayName: 'Additional Fields',
        name: 'noteOptions',
        type: 'collection',
        placeholder: 'Add Field',
        default: {},
        displayOptions: { show: { resource: ['note'], operation: ['create'] } },
        options: [
          {
            displayName: 'Tags',
            name: 'tags',
            type: 'string',
            default: '',
            description: 'Comma-separated tags',
          },
          {
            displayName: 'Target ID',
            name: 'targetId',
            type: 'string',
            default: '',
            description: 'ID of the object the note is attached to',
          },
          {
            displayName: 'Target Kind',
            name: 'targetKind',
            type: 'options',
            default: 'none',
            options: [
              { name: 'Chain Run', value: 'chain_run' },
              { name: 'None', value: 'none' },
              { name: 'Review', value: 'review' },
              { name: 'Template', value: 'template' },
            ],
            description: 'What to attach this note to',
          },
        ],
      },

      // ----------------------------------------------------------------- chain
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['chain'] } },
        default: 'start',
        options: [
          {
            name: 'Abort',
            value: 'abort',
            description: 'Force-stop an active chain run and skip its remaining steps',
            action: 'Abort a chain run',
          },
          { name: 'Get', value: 'get', action: 'Get a chain run' },
          {
            name: 'Get for Review',
            value: 'getForReview',
            action: 'Get the chain for a review',
          },
          { name: 'Start', value: 'start', action: 'Start a chain run' },
        ],
      },
      {
        displayName: 'Chain Definition',
        name: 'definition',
        type: 'json',
        default:
          '{\n  "version": "1.0",\n  "mode": "sequential",\n  "steps": [\n    {\n      "id": "step_1",\n      "template": "email-review",\n      "assignee": { "kind": "role", "role": "reviewer" }\n    }\n  ]\n}',
        required: true,
        displayOptions: { show: { resource: ['chain'], operation: ['start'] } },
        description:
          'Chain definition document (version 1.0). Must include version, mode and steps[].',
      },
      {
        displayName: 'Initial Payload',
        name: 'initialPayload',
        type: 'json',
        default: '{}',
        required: true,
        displayOptions: { show: { resource: ['chain'], operation: ['start'] } },
        description: 'Payload handed to the first step of the chain',
      },
      {
        displayName: 'Additional Fields',
        name: 'chainOptions',
        type: 'collection',
        placeholder: 'Add Field',
        default: {},
        displayOptions: { show: { resource: ['chain'], operation: ['start'] } },
        options: [
          {
            displayName: 'Callback URL',
            name: 'callbackUrl',
            type: 'string',
            default: '',
            placeholder: 'https://...',
            description:
              'Where Gatewerk posts this run\'s chain events. Without it the run emits nothing anywhere. Paste a Gatewerk Trigger node\'s production URL here to react to each step. Must be publicly reachable from Gatewerk.',
          },
          {
            displayName: 'Metadata',
            name: 'metadata',
            type: 'json',
            default: '{}',
            description: 'Additional metadata to attach to the chain run',
          },
        ],
      },
      {
        displayName: 'Chain Run ID',
        name: 'chainRunId',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'gw_chain_...',
        displayOptions: { show: { resource: ['chain'], operation: ['get', 'abort'] } },
        description: 'ID of the chain run',
      },
      {
        displayName: 'Review ID',
        name: 'chainReviewId',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'gw_rev_...',
        displayOptions: { show: { resource: ['chain'], operation: ['getForReview'] } },
        description: 'Review whose chain you want',
      },

      // -------------------------------------------------------------- feedback
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['feedback'] } },
        default: 'getAll',
        options: [{ name: 'Get Many', value: 'getAll', action: 'Get many feedback items' }],
      },
      {
        displayName: 'Filters',
        name: 'feedbackFilters',
        type: 'collection',
        placeholder: 'Add Filter',
        default: {},
        displayOptions: { show: { resource: ['feedback'] } },
        options: [
          {
            displayName: 'Outcome',
            name: 'outcome',
            type: 'options',
            default: 'approved',
            options: [
              { name: 'Approved', value: 'approved' },
              { name: 'Edited', value: 'edited' },
              { name: 'Rejected', value: 'rejected' },
            ],
          },
          {
            displayName: 'Template Name or ID',
            name: 'template',
            type: 'options',
            typeOptions: { loadOptionsMethod: 'getTemplates' },
            default: '',
            description:
          'Pass the template slug, not the gw_tpl_ ID: the API matches templates on slug, and a gw_tpl_ ID fails with template_not_found even though the template exists. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
          },
        ],
      },

      // -------------------------------------------------------------- template
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['template'] } },
        default: 'getAll',
        options: [{ name: 'Get Many', value: 'getAll', action: 'Get many templates' }],
      },

      // ----------------------------------------------------------------- audit
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['audit'] } },
        default: 'getAll',
        options: [{ name: 'Get Many', value: 'getAll', action: 'Get many audit entries' }],
      },
      {
        displayName: 'Filters',
        name: 'auditFilters',
        type: 'collection',
        placeholder: 'Add Filter',
        default: {},
        displayOptions: { show: { resource: ['audit'] } },
        options: [
          {
            displayName: 'Action',
            name: 'action',
            type: 'string',
            default: '',
            description: 'Audit action name, for example review.decided',
          },
          {
            displayName: 'Review ID',
            name: 'reviewId',
            type: 'string',
            default: '',
            placeholder: 'gw_rev_...',
            description:
              'Only entries about this review. Sent as resource_type plus resource_id, which is how review audit rows are keyed.',
          },
        ],
      },

      // ------------------------------------------------------------------ stat
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['stat'] } },
        default: 'get',
        options: [{ name: 'Get', value: 'get', action: 'Get project stats' }],
      },

      // ------------------------------------------------- shared list paging
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1, maxValue: 100 },
        displayOptions: {
          show: { resource: ['review', 'feedback', 'audit'], operation: ['getAll'] },
        },
        description: 'Max number of results to return',
      },
      {
        displayName: 'Offset',
        name: 'offset',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0 },
        displayOptions: {
          show: { resource: ['review', 'feedback', 'audit'], operation: ['getAll'] },
        },
        description: 'How many results to skip before returning',
      },
    ],
  };

  /**
   * Intentional no-ops. The resume webhook is a RESTART webhook for a waiting
   * execution, not a subscription on a third-party service: the "registration"
   * is passing the signed resume URL to Gatewerk as the review's callback_url.
   * n8n does not invoke these for restart webhooks; they exist because the
   * community-node lint requires a webhookMethods block alongside `webhooks`.
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

  methods = {
    loadOptions: {
      getTemplates,
      getTemplateActions,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const resource = this.getNodeParameter('resource', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;

    // The waiting path suspends the whole execution, so it can only ever serve
    // one item. Fail loudly rather than silently discarding the rest.
    if (resource === 'review' && operation === 'sendAndWait') {
      if (items.length > 1) {
        throw new NodeOperationError(
          this.getNode(),
          `Received ${items.length} input items, but a waiting review handles one item per execution.`,
          {
            description:
              'Either put this node inside a Loop Over Items (Split in Batches) node, or use the Create operation and react to outcomes with a Gatewerk Trigger node.',
          },
        );
      }

      const created = await createReview(this, 0, true);
      const opts = this.getNodeParameter('additionalOptions', 0, {}) as IDataObject;
      const waitMinutes = (opts.waitTimeoutMinutes as number) || 1440;

      // Pairs with getSignedResumeUrl(). Currently only enforced by n8n for
      // sendAndWait-operation nodes (waiting-webhooks.js:128-136) — which this
      // node now is — so it genuinely validates the resume signature.
      this.setSignatureValidationRequired();
      await this.putExecutionToWait(new Date(Date.now() + waitMinutes * 60 * 1000));

      // Not reached in normal operation: putExecutionToWait suspends first.
      return [[{ json: created, pairedItem: { item: 0 } }]];
    }

    const out: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const results = await runOperation(this, resource, operation, i);
        for (const json of results) out.push({ json, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw error instanceof NodeApiError ||
          error instanceof NodeOperationError ||
          error instanceof UserError
          ? error
          : new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
      }
    }
    return [out];
  }

  /**
   * Gatewerk POSTed something about a waiting review.
   *
   * A review's callback_url is its whole event feed, not a decision channel, so
   * this classifies first and resumes only for event classes the user opted
   * into. Acknowledging without resuming is safe: with no `workflowData` n8n
   * replies and returns before the runner starts (webhook-helpers.js:344-365)
   * and never persists the waiting-webhook's in-memory mutations, so the
   * execution stays `waiting` for the real decision.
   */
  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const credentials = (await this.getCredentials(
      'gatewerkApi',
    )) as ICredentialDataDecryptedObject;
    const secret = (credentials.webhookSecret as string | undefined) || '';
    const mode = ((credentials.callbackVerification as string) || 'auto') as
      | 'auto'
      | 'require'
      | 'off';

    if (mode !== 'off') {
      // Fail closed on a misconfiguration rather than accept forgeries.
      if (mode === 'require' && !secret) {
        return { webhookResponse: { statusCode: 401, body: 'Unauthorized' } };
      }
      if (secret) {
        const headers = this.getHeaderData() as Record<string, string | string[] | undefined>;
        // Raw body required: re-stringifying parsed JSON changes key order and
        // whitespace, which breaks the HMAC.
        const req = this.getRequestObject() as { rawBody?: Buffer; body?: unknown };
        const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : undefined);
        if (!rawBody) return { webhookResponse: { statusCode: 401, body: 'Unauthorized' } };
        const result = verifyGatewerkSignature({
          rawBody,
          v1Header: headers['x-webhook-signature'],
          v2Header: headers['x-webhook-signature-v2'],
          secret,
        });
        if (!result.ok) return { webhookResponse: { statusCode: 401, body: 'Unauthorized' } };
      }
    }

    const event = classifyGatewerkEvent(this.getBodyData() as Record<string, unknown>);
    const resumeOn = this.getNodeParameter('resumeOn', ['decision', 'expiry']) as string[];

    if (!shouldResumeOn(event.eventClass, resumeOn)) {
      // 200 so Gatewerk records the delivery and stops retrying, while the
      // execution keeps waiting for an event that actually matters.
      return { webhookResponse: 'OK' };
    }

    return {
      webhookResponse: 'OK',
      workflowData: [this.helpers.returnJsonArray([toOutputJson(event) as IDataObject])],
    };
  }
}

/** Create a review for one input item. */
async function createReview(
  ctx: IExecuteFunctions,
  i: number,
  withCallback: boolean,
): Promise<IDataObject> {
  const opts = ctx.getNodeParameter('additionalOptions', i, {}) as IDataObject;
  const timeoutAction = ctx.getNodeParameter('timeoutAction', i, '') as string;

  const ladderRaw = opts.assignmentLadder;
  let assignmentLadder: unknown[] | undefined;
  if (ladderRaw !== undefined && ladderRaw !== '' && ladderRaw !== '[]') {
    const parsed = parseJson(ctx, ladderRaw, 'Assignment Ladder', i);
    if (!Array.isArray(parsed)) {
      throw new NodeOperationError(ctx.getNode(), 'Assignment Ladder must be a JSON array', {
        itemIndex: i,
      });
    }
    assignmentLadder = parsed;
  }

  const maxIterations = opts.maxIterations as number | undefined;
  const actions = ctx.getNodeParameter('actions', i, []) as string[];

  const body = buildReviewBody({
    template: ctx.getNodeParameter('template', i) as string,
    payload: parseJson(ctx, ctx.getNodeParameter('payload', i), 'Payload', i) as Record<
      string,
      unknown
    >,
    callbackUrl: withCallback ? ctx.getSignedResumeUrl() : undefined,
    priority: (ctx.getNodeParameter('priority', i, '') as string) || undefined,
    actions: actions.length > 0 ? actions : undefined,
    confidence: opts.confidence as number | undefined,
    irreversibility: opts.irreversibility as string | undefined,
    assignee: opts.assignee as string | undefined,
    metadata: opts.metadata
      ? (parseJson(ctx, opts.metadata, 'Metadata', i) as Record<string, unknown>)
      : undefined,
    timeoutAction: timeoutAction || undefined,
    timeoutSeconds: ctx.getNodeParameter('timeoutSeconds', i, 3600) as number,
    oversight: opts.oversight as string | undefined,
    assignmentLadder,
    idempotencyKey: opts.idempotencyKey as string | undefined,
    traceUrl: opts.traceUrl as string | undefined,
    // 0 means "use the template default", so it is not sent.
    maxIterations: maxIterations && maxIterations > 0 ? maxIterations : undefined,
  });

  const response = (await gatewerkApiRequest.call(
    ctx,
    'POST',
    '/api/v1/reviews',
    body,
    undefined,
    i,
  )) as IDataObject;

  if (withCallback) {
    const creds = (await ctx.getCredentials('gatewerkApi')) as ICredentialDataDecryptedObject;
    const verification = (creds.callbackVerification as string) || 'auto';
    // Surfaced in the n8n UI rather than a console.warn nobody reads. Only
    // meaningful when verification is not already mandatory.
    if (verification !== 'require' && !creds.webhookSecret) {
      ctx.addExecutionHints({
        message:
          'This review will resume on an unsigned callback. Set a Webhook Secret on the Gatewerk credential and set Callback Verification to "Require" to authenticate the sender.',
        location: 'outputPane',
      });
    }
  }
  return response;
}

/**
 * Unwrap `{object:"list", items:[...], total, has_more}` into one n8n item per
 * row; return a single-element array for a bare object.
 *
 * `_total` and `_hasMore` are copied onto EVERY row rather than only the last,
 * so the items stay homogeneous and a paging loop can still tell whether
 * another page exists. Discarding the envelope entirely would make
 * limit/offset paging unusable.
 */
function unwrap(response: unknown): IDataObject[] {
  const record = response as { items?: unknown; total?: unknown; has_more?: unknown } | null;
  if (!record || !Array.isArray(record.items)) return [response as IDataObject];
  const meta: IDataObject = {};
  if (typeof record.total === 'number') meta._total = record.total;
  if (typeof record.has_more === 'boolean') meta._hasMore = record.has_more;
  return (record.items as IDataObject[]).map((row) => ({ ...row, ...meta }));
}

/** Dispatch one non-waiting operation for one item. */
export async function runOperation(
  ctx: IExecuteFunctions,
  resource: string,
  operation: string,
  i: number,
): Promise<IDataObject[]> {
  const call = (
    method: 'GET' | 'POST',
    endpoint: string,
    body?: Record<string, unknown>,
    query?: Record<string, string | number>,
  ) => gatewerkApiRequest.call(ctx, method, endpoint, body, query, i);

  const paging = () =>
    qs({
      limit: ctx.getNodeParameter('limit', i, 50) as number,
      offset: ctx.getNodeParameter('offset', i, 0) as number,
    });

  if (resource === 'review') {
    if (operation === 'create') return [await createReview(ctx, i, false)];
    if (operation === 'get') {
      const id = ctx.getNodeParameter('reviewId', i) as string;
      return [(await call('GET', `/api/v1/reviews/${encodeURIComponent(id)}`)) as IDataObject];
    }
    if (operation === 'getAll') {
      const filters = ctx.getNodeParameter('reviewFilters', i, {}) as IDataObject;
      return unwrap(await call('GET', '/api/v1/reviews', undefined, { ...qs(filters), ...paging() }));
    }
    /**
     * Resubmit after a reviewer asked for changes. This closes the iteration
     * loop: the node can receive `review.retried` / `review.action_taken`, and
     * without this operation a workflow could see the request and never answer
     * it, leaving the review parked in `awaiting_iteration` until it timed out.
     */
    if (operation === 'update') {
      const id = ctx.getNodeParameter('reviewId', i) as string;
      const body = {
        payload: parseJson(ctx, ctx.getNodeParameter('revisedPayload', i), 'Revised Payload', i),
        version: ctx.getNodeParameter('revisionVersion', i) as number,
      };
      return [
        (await gatewerkApiRequest.call(
          ctx,
          'PUT',
          `/api/v1/reviews/${encodeURIComponent(id)}`,
          body,
          undefined,
          i,
        )) as IDataObject,
      ];
    }
    if (operation === 'getVersions') {
      const id = ctx.getNodeParameter('reviewId', i) as string;
      return unwrap(await call('GET', `/api/v1/reviews/${encodeURIComponent(id)}/versions`));
    }
    if (operation === 'createToken') {
      const id = ctx.getNodeParameter('reviewId', i) as string;
      const expiryHours = ctx.getNodeParameter('expiryHours', i, 72) as number;
      return [
        (await call('POST', `/api/v1/reviews/${encodeURIComponent(id)}/token`, {
          expiryHours,
        })) as IDataObject,
      ];
    }
    if (operation === 'act') {
      const id = ctx.getNodeParameter('reviewId', i) as string;
      const opts = ctx.getNodeParameter('actionOptions', i, {}) as IDataObject;
      const body: Record<string, unknown> = {
        action_id: ctx.getNodeParameter('actionId', i) as string,
      };
      if (opts.feedback) body.feedback = opts.feedback;
      if (opts.editedPayload && opts.editedPayload !== '{}')
        body.edited_payload = parseJson(ctx, opts.editedPayload, 'Edited Payload', i);
      if (opts.version !== undefined) {
        const v = opts.version as number;
        if (!Number.isInteger(v) || v <= 0) {
          throw new NodeOperationError(ctx.getNode(), 'Version must be a positive integer', {
            itemIndex: i,
          });
        }
        body.version = v;
      }
      return [
        (await call(
          'POST',
          `/api/v1/reviews/${encodeURIComponent(id)}/action`,
          body,
        )) as IDataObject,
      ];
    }
  }

  if (resource === 'note') {
    if (operation === 'create') {
      const opts = ctx.getNodeParameter('noteOptions', i, {}) as IDataObject;
      const body: Record<string, unknown> = { body: ctx.getNodeParameter('noteBody', i) as string };
      if (opts.targetKind && opts.targetKind !== 'none') {
        if (!opts.targetId) {
          throw new NodeOperationError(
            ctx.getNode(),
            `Target ID is required when Target Kind is '${String(opts.targetKind)}'`,
            { itemIndex: i },
          );
        }
        // MUST be the `attachments[]` array. CreateNoteBodySchema
        // (packages/shared/src/api/schemas/notes.ts:65) has no flat
        // target_kind/target_id, and the schema is non-strict, so sending them
        // flat means the note is created with the attachment silently dropped.
        body.attachments = [{ target_kind: opts.targetKind, target_id: opts.targetId }];
      }
      if (opts.tags)
        body.tags = String(opts.tags)
          .split(',')
          // Lower-cased here, not server-side: TagSchema is
          // /^[a-z0-9][a-z0-9_-]{0,31}$/ (schemas/notes.ts:13) and validation
          // runs BEFORE the handler's own toLowerCase (routes/notes/write.ts:59),
          // so a tag like "Follow-Up" would 422 instead of being normalised.
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
      // Always sent. The API defaults is_shared to false, and an api_key subject
      // creating a private note is rejected 422 api_key_cannot_create_private
      // (routes/notes/write.ts:43-51), so omitting it would fail out of the box.
      body.is_shared = ctx.getNodeParameter('isShared', i, true) as boolean;
      return [(await call('POST', '/api/v1/notes', body)) as IDataObject];
    }
    if (operation === 'getAll') return unwrap(await call('GET', '/api/v1/notes', undefined, paging()));
  }

  if (resource === 'chain') {
    if (operation === 'start') {
      const opts = ctx.getNodeParameter('chainOptions', i, {}) as IDataObject;
      const body: Record<string, unknown> = {
        definition: parseJson(ctx, ctx.getNodeParameter('definition', i), 'Chain Definition', i),
        initial_payload: parseJson(
          ctx,
          ctx.getNodeParameter('initialPayload', i),
          'Initial Payload',
          i,
        ),
      };
      // A chain run with no callback_url emits no webhooks at all, so its
      // progress is invisible to n8n. Optional, but usually what you want.
      if (opts.callbackUrl) body.callback_url = opts.callbackUrl;
      if (opts.metadata && opts.metadata !== '{}') {
        const metadata = parseJson(ctx, opts.metadata, 'Metadata', i) as Record<string, unknown>;
        if (Object.keys(metadata).length > 0) body.metadata = metadata;
      }
      return [(await call('POST', '/api/v1/chain-runs', body)) as IDataObject];
    }
    if (operation === 'get') {
      const id = ctx.getNodeParameter('chainRunId', i) as string;
      return [(await call('GET', `/api/v1/chain-runs/${encodeURIComponent(id)}`)) as IDataObject];
    }
    if (operation === 'abort') {
      const id = ctx.getNodeParameter('chainRunId', i) as string;
      return [
        (await call(
          'POST',
          `/api/v1/chain-runs/${encodeURIComponent(id)}/abort`,
        )) as IDataObject,
      ];
    }
    if (operation === 'getForReview') {
      const id = ctx.getNodeParameter('chainReviewId', i) as string;
      return [
        (await call('GET', `/api/v1/reviews/${encodeURIComponent(id)}/chain`)) as IDataObject,
      ];
    }
  }

  if (resource === 'feedback') {
    const filters = ctx.getNodeParameter('feedbackFilters', i, {}) as IDataObject;
    return unwrap(await call('GET', '/api/v1/feedback', undefined, { ...qs(filters), ...paging() }));
  }

  if (resource === 'template') {
    return unwrap(await call('GET', '/api/v1/templates'));
  }

  if (resource === 'audit') {
    const filters = ctx.getNodeParameter('auditFilters', i, {}) as IDataObject;
    const { reviewId, ...rest } = filters;
    // GET /api/v1/audit reads only action, resource_type, resource_id, actor,
    // from, to, limit, offset (routes/audit.ts:21-31). A `review_id` param would
    // be silently ignored and the caller would get the WHOLE project log while
    // believing it was filtered. Review rows are keyed
    // resource_type:"review" + resource_id:<id> (routes/reviews/action.ts:56).
    const scoped: Record<string, string> = reviewId
      ? { resource_type: 'review', resource_id: String(reviewId) }
      : {};
    return unwrap(
      await call('GET', '/api/v1/audit', undefined, { ...qs(rest), ...scoped, ...paging() }),
    );
  }

  if (resource === 'stat') {
    return [(await call('GET', '/api/v1/stats')) as IDataObject];
  }

  throw new NodeOperationError(
    ctx.getNode(),
    `Unsupported operation "${operation}" on resource "${resource}"`,
    { itemIndex: i },
  );
}
