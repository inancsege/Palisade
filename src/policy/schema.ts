// We define a loose schema object since ajv's JSONSchemaType is strict.
// The actual validation happens at runtime via ajv.compile().
export const policySchema = {
  type: 'object' as const,
  required: ['version'],
  properties: {
    version: { type: 'string', enum: ['1'] },
    defaults: {
      type: 'object',
      properties: {
        network_egress: { type: 'string', enum: ['allow', 'deny'] },
        filesystem: { type: 'string', enum: ['none', 'read_only', 'read_write'] },
        shell_exec: { type: 'string', enum: ['allow', 'deny'] },
      },
      additionalProperties: false,
    },
    tools: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          network_egress: {
            oneOf: [
              { type: 'string', enum: ['allow', 'deny'] },
              {
                type: 'object',
                properties: { allow: { type: 'array', items: { type: 'string' } } },
                required: ['allow'],
                additionalProperties: false,
              },
            ],
          },
          filesystem: {
            oneOf: [
              { type: 'string', enum: ['none'] },
              {
                type: 'object',
                properties: { read_only: { type: 'array', items: { type: 'string' } } },
                required: ['read_only'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { read_write: { type: 'array', items: { type: 'string' } } },
                required: ['read_write'],
                additionalProperties: false,
              },
            ],
          },
          shell_exec: {
            oneOf: [
              { type: 'string', enum: ['allow', 'deny'] },
              {
                type: 'object',
                properties: {
                  allow: { type: 'array', items: { type: 'string' } },
                  deny: { type: 'array', items: { type: 'string' } },
                },
                required: ['allow'],
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      },
    },
    detection: {
      type: 'object',
      properties: {
        tier1: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            action: { type: 'string', enum: ['allow', 'warn', 'block'] },
            block_threshold: { type: 'number', minimum: 0, maximum: 1 },
            warn_threshold: { type: 'number', minimum: 0, maximum: 1 },
            max_input_length: { type: 'integer', minimum: 100, maximum: 1000000 },
          },
          additionalProperties: false,
        },
        tier2: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            threshold: { type: 'number', minimum: 0, maximum: 1 },
            action: { type: 'string', enum: ['allow', 'warn', 'block'] },
          },
          additionalProperties: false,
        },
        canary: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            rotate_interval: { type: 'number', minimum: 60 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;
