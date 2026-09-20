import type {Json, PipelineDef, SampleRecord, SchemaObject} from '../shared/types';

export const seedPipeline: PipelineDef = {
  steps: [
    {
      id: 'envelope',
      title: 'Copy envelope',
      map: {'$.orderId': '$.id', '$.customer.name': '$.customer.name'},
    },
    {
      id: 'flags',
      title: 'Flatten flags',
      map: {'$.priority': '$.meta.priority'},
    },
    {
      id: 'lines',
      title: 'Map line items',
      map: {
        '$.items[*].sku': '$.lines[*].sku',
        '$.items[*].qty': '$.lines[*].quantity',
        '$.items[*].price': '$.lines[*].unitPrice',
      },
    },
    {
      id: 'channel-tag',
      title: 'Channel tag (dynamic key)',
      when: '$.channel',
      map: {'$.tags["channel_" + $.channel]': '$.channel'},
    },
    {
      id: 'party',
      title: 'Party reference (union)',
      map: {'$.party': '$.party'},
    },
  ],
};

export const seedSchema: SchemaObject = {
  type: 'object',
  required: ['orderId', 'customer', 'items'],
  properties: {
    orderId: {type: 'string'},
    priority: {type: 'string'},
    customer: {
      type: 'object',
      required: ['name'],
      properties: {name: {type: 'string'}},
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sku', 'qty'],
        properties: {
          sku: {type: 'string'},
          qty: {type: 'integer'},
          price: {type: 'number'},
        },
      },
    },
    tags: {type: 'object', additionalProperties: {type: 'string'} as SchemaObject},
    party: {
      anyOf: [
        {type: 'object', required: ['userId'], properties: {userId: {type: 'string'}}},
        {type: 'object', required: ['orgId'], properties: {orgId: {type: 'string'}}},
      ],
    },
  },
};

const epoch = new Date(0).toISOString();

export const seedSamples: SampleRecord[] = [
  {
    id: 'sample-happy',
    name: 'Happy order',
    revision: 1,
    updatedAt: epoch,
    input: {
      id: 'ORD-1',
      customer: {name: 'Ada'},
      meta: {priority: 'high'},
      channel: 'web',
      lines: [
        {sku: 'A-1', quantity: 2, unitPrice: 9.5},
        {sku: 'B-7', quantity: 1, unitPrice: 19},
      ],
      party: {userId: 'u-42'},
    } as Json,
  },
  {
    id: 'sample-bad',
    name: 'Legacy batch payload',
    revision: 1,
    updatedAt: epoch,
    input: {
      id: 404,
      customer: {name: 'Grace'},
      meta: {priority: 3},
      channel: 'pos',
      lines: [
        {sku: 'C-2', quantity: 1, unitPrice: 4},
        {quantity: 'two'},
      ],
      party: {token: 'zzz'},
    } as Json,
  },
];
