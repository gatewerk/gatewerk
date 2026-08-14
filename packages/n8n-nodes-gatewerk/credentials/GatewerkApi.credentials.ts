import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class GatewerkApi implements ICredentialType {
  name = 'gatewerkApi';
  displayName = 'Gatewerk API';
  documentationUrl = 'https://github.com/gatewerk/gatewerk';
  // Shares the node icon. The path is relative to this file's location in
  // dist/, where dist/credentials/ and dist/nodes/Gatewerk/ are siblings.
  icon = 'file:../nodes/Gatewerk/gatewerk.svg' as const;

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'Your Gatewerk API key (starts with gwk_)',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'http://localhost:3100',
      required: true,
      description: 'The base URL of your Gatewerk instance (e.g. https://api.gatewerk.com or http://localhost:3100)',
    },
    {
      displayName: 'Webhook Secret',
      name: 'webhookSecret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: false,
      description:
        'Recommended. HMAC secret used to verify callbacks Gatewerk posts to waiting nodes. ' +
        'Without it, anyone who learns the callback URL can forge a decision. ' +
        'Set this to the project webhook secret from Gatewerk Settings.',
    },
    {
      displayName: 'Callback Verification',
      name: 'callbackVerification',
      type: 'options',
      default: 'auto',
      options: [
        {
          name: 'Automatic',
          value: 'auto',
          description: 'Verify when a webhook secret is set, otherwise accept unsigned callbacks',
        },
        {
          name: 'Require',
          value: 'require',
          description:
            'Reject any callback that is not correctly signed. Recommended for production.',
        },
        {
          name: 'Off',
          value: 'off',
          description: 'Never verify. Only appropriate on a trusted private network.',
        },
      ],
      description:
        'How strictly to authenticate callbacks from Gatewerk. Resume URLs are already unguessable because n8n signs them, so Automatic is safe to start with, but Require is what proves the sender is genuinely your Gatewerk instance and that the payload was not altered.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
      },
    },
  };

  /**
   * Credential test.
   *
   * This MUST NOT hit a scoped endpoint. It previously called
   * `GET /api/v1/stats`, which requires the `stats:read` scope
   * (apps/api/src/routes/stats.ts:20) that neither the `agent` nor the
   * `reviewer` key preset carries (packages/shared/src/index.ts:312-313). The
   * natural key for these nodes therefore failed the credential test while
   * every node it powers worked. Only an admin key passed.
   *
   * `GET /api/v1/auth/key-info` is gated by `apiKeyAuth` alone with no
   * `requireScope` (apps/api/src/app.ts:305, routes/key-info.ts:7-13), runs zero
   * database queries, and echoes back the key's scopes. So it validates exactly
   * what a credential test should validate: that the key is real and accepted.
   */
  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl}}',
      url: '/api/v1/auth/key-info',
      method: 'GET',
    },
  };
}
