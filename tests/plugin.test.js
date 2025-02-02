process.env.APOLLO_KEY = 'service:fake-id:123456789ABC-fakefake1'
process.env.APOLLO_GRAPH_ID = 'fake-id'
process.env.APOLLO_GRAPH_VARIANT = 'fake-variant'
process.env.APOLLO_SCHEMA_REPORTING = false

const { ApolloServer } = require('@apollo/server')
const { startStandaloneServer } = require('@apollo/server/standalone')
const { ApolloServerPluginCacheControl } = require('@apollo/server/plugin/cacheControl')
const responseCachePlugin = require('@apollo/server-plugin-response-cache')
const { cacheControlFromInfo } = require('@apollo/cache-control-types')
const { ApolloGateway } = require('@apollo/gateway')
const { createHash, randomUUID } = require('crypto')
const { readFileSync } = require('fs')
const { gunzipSync } = require('zlib')
const https = require('https')
const request = require('supertest')
const nock = require('nock')

const LogqlApolloPlugin = require('../')
const { compress } = require('../src/client')

const noop = () => {}
const logger = { debug: noop, info: noop, warn: noop, error: noop }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, ms = 100, timeout = 4000) => {
  for (let attempt = 0; attempt * ms < timeout; ++attempt) {
    if (predicate()) {
      return true
    }
    await sleep(ms)
  }
}
const gql = String.raw

function loadSchema(path) {
  const schema = readFileSync(path).toString().trim()
  const schemaHash = createHash('sha256').update(schema).digest('hex')
  return { schema, schemaHash }
}

function getConfiguredPlugin(config) {
  return LogqlApolloPlugin({
    apiKey: 'logql:FAKE_API_KEY',
    sendVariables: true,
    sendHeaders: true,
    runInTests: true,
    reportIntervalMs: 500,
    sampling: 0.01,
    verbose: true,
    ...config,
  })
}

function getRegularServer(typeDefs, resolvers, config = {}, plugins = []) {
  return new ApolloServer({
    logger,
    typeDefs,
    resolvers,
    plugins: [...plugins, getConfiguredPlugin(config)],
  })
}

function getFederatedServer(config = {}) {
  return new ApolloServer({
    logger,
    gateway: new ApolloGateway(),
    plugins: [getConfiguredPlugin(config)],
    allowBatchedHttpRequests: true,
  })
}

function decompress(payload) {
  const buffer = Buffer.from(payload, 'hex')
  return gunzipSync(buffer).toString('utf-8')
}

function logqlMock(endpoint = 'https://ingress.logql.io') {
  return nock(`${endpoint}/default`, {
    reqheaders: {
      'user-agent': /logql-apollo-plugin; .*; .*/,
      'content-encoding': 'gzip',
      'x-request-id': /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'x-api-key': 'logql:FAKE_API_KEY',
      'x-environment': '',
      'x-plugin-name': '@logql/apollo-plugin',
      'accept-encoding': 'gzip,deflate',
    },
  })
}

beforeAll(() => {
  nock.disableNetConnect()
  nock.enableNetConnect(/localhost|(products|pandas):4000/)

  // Since we use an Apollo Studio Key to enable federation, we need to mock the usage reporting
  // This is not critical, as we already have a nock.disableNetConnect() nothing is sent to the internet
  // But removes noisy logs
  nock('https://usage-reporting.api.apollographql.com/api').persist().post('/ingress/traces').reply(204)
})

afterAll(() => {
  //nock.cleanAll()
})

describe('Schema reporting with Apollo Federation', () => {
  const { schema, schemaHash } = loadSchema('./tests/supergraph-test.graphql')
  let graphqlServer

  beforeEach(async () => {
    nock(/uplink.api.apollographql.com/)
      .persist()
      .post('/')
      .reply(200, {
        data: {
          routerConfig: {
            __typename: 'RouterConfigResult',
            id: null,
            supergraphSdl: schema,
          },
        },
      })
  })

  afterEach(async () => {
    if (graphqlServer) {
      await graphqlServer.stop()
      graphqlServer = null
    }
    nock.abortPendingRequests()
  })

  it('Send federated schema to schema registry', async () => {
    const schemaRegistry = logqlMock()
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)

    graphqlServer = getFederatedServer()
    await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    // Leave time to plugin to send the schema
    await waitFor(() => schemaRegistry.pendingMocks().length === 0, 20, 1000)
    expect(schemaRegistry.pendingMocks()).toHaveLength(0)
  })

  it('Retry sending the schema after a timeout', async () => {
    const schemaRegistry = logqlMock()
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .delayConnection(500)
      .reply(204)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)

    graphqlServer = getFederatedServer({ timeout: 100 })
    await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    await waitFor(() => schemaRegistry.pendingMocks().length === 0) // Letting some time for the retry to occur
    expect(schemaRegistry.pendingMocks()).toHaveLength(0)
  })

  it('Retry sending the schema after a 500 error', async () => {
    const schemaRegistry = logqlMock()
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(500)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)

    graphqlServer = getFederatedServer()
    await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    await waitFor(() => schemaRegistry.pendingMocks().length === 0) // Letting some time for the retry to occur
    expect(schemaRegistry.pendingMocks()).toHaveLength(0)
  })

  it('Retry sending the schema after 3 times after 5xx errors', async () => {
    const schemaRegistry = logqlMock()
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(500)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(502)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(504)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(501)

    graphqlServer = getFederatedServer({ reportIntervalMs: 1 })
    await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    await waitFor(() => schemaRegistry.pendingMocks().length === 0)
    expect(schemaRegistry.pendingMocks()).toHaveLength(0)
  })
})

describe('Schema reporting with Apollo Server', () => {
  const { schema, schemaHash } = loadSchema('./tests/graph-test.graphql')
  const resolvers = { Query: { hello: () => 'World!' } }
  let graphqlServer

  afterEach(async () => {
    if (graphqlServer) {
      await graphqlServer.stop()
      graphqlServer = null
    }
    nock.abortPendingRequests()
  })

  it('Send schema to schema registry', async () => {
    const schemaRegistry = logqlMock()
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)

    graphqlServer = getRegularServer(schema, resolvers)
    await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    await waitFor(() => schemaRegistry.pendingMocks().length === 0, 20, 1000)
    expect(schemaRegistry.pendingMocks()).toHaveLength(0)
  })

  it('Accept a custom agent', async () => {
    const schemaRegistry = logqlMock()
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)

    const agent = new https.Agent({
      keepAlive: true,
      keepAliveMsec: 100,
      maxSockets: 5,
    })
    graphqlServer = getRegularServer(schema, resolvers, { agent })
    await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    await waitFor(() => schemaRegistry.pendingMocks().length === 0, 20, 1000)
    expect(schemaRegistry.pendingMocks()).toHaveLength(0)
  })
})

describe('Request handling with Apollo Federation', () => {
  const { schema, schemaHash } = loadSchema('./tests/supergraph-test.graphql')
  let graphqlServer
  let graphqlServerUrl
  let logql

  beforeEach(async () => {
    jest.spyOn(global.Math, 'random').mockReturnValue(0.2)
    nock(/uplink.api.apollographql.com/)
      .persist()
      .post('/')
      .reply(200, {
        data: {
          routerConfig: {
            __typename: 'RouterConfigResult',
            id: null,
            supergraphSdl: schema,
          },
        },
      })
    const endpoint = `https://fake-logql/${randomUUID()}`
    logql = logqlMock(endpoint)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)
    graphqlServer = getFederatedServer({ endpoint })
    const { url } = await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    graphqlServerUrl = url
    //nock.recorder.rec()
  })

  afterEach(async () => {
    jest.spyOn(global.Math, 'random').mockRestore()
    if (graphqlServer) {
      await graphqlServer.stop()
      graphqlServer = null
    }
    nock.abortPendingRequests()
    // nock.cleanAll()
    //nock.recorder.clear()
  })

  it('handle non-http requests', async () => {
    let payload

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      query Users {
        users {
          id
        }
      }
    `

    const { body } = await graphqlServer.executeOperation({
      query,
      operationName: 'Users',
      variables: {},
    })

    expect(body.kind).toBe('single')
    expect(body.singleResult).toEqual({
      errors: [
        {
          extensions: {
            code: 'GRAPHQL_VALIDATION_FAILED',
          },
          locations: [
            {
              column: 9,
              line: 3,
            },
          ],
          message: 'Cannot query field "users" on type "Query".',
        },
      ],
    })

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {},
      request: {
        headers: {},
        variables: {},
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
      },
      profile: {
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        receivedAt: expect.any(String),
        resolvers: [],
        requestEnd: expect.any(Number),
        validationEnd: expect.any(Number),
        validationStart: expect.any(Number),
      },
      metrics: {
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
      },
      errors: [
        {
          message: 'Cannot query field "users" on type "Query".',
          locations: [{ line: 3, column: 9 }],
          extensions: {
            http: { status: 400, headers: {} },
            code: 'GRAPHQL_VALIDATION_FAILED',
          },
          stackTrace: expect.stringMatching('GraphQLError: Cannot query field "users" on type "Query".'),
        },
      ],
    })
  })

  it('Send errors when query is malformed (GRAPHQL_PARSE_FAILED)', async () => {
    let payload

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      {
        syntax error {}
      }
    `
    const res = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res.status).toBe(400)
    expect(res.body.errors).toBeTruthy()

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {},
      request: {
        method: 'POST',
        search: '',
        headers: {
          host: expect.any(String),
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
          'content-length': expect.any(String),
          connection: 'close',
        },
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
      },
      profile: {
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        receivedAt: expect.any(String),
        resolvers: [],
        requestEnd: expect.any(Number),
      },
      metrics: {
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
      },
      errors: [
        {
          message: 'Syntax Error: Expected Name, found "}".',
          locations: [{ line: 3, column: 23 }],
          extensions: {
            http: { status: 400, headers: {} },
            code: 'GRAPHQL_PARSE_FAILED',
          },
          stackTrace: expect.stringMatching('GraphQLError: Syntax Error: Expected Name, found "}".'),
        },
      ],
    })
  })

  it('Send errors when field do not exists (GRAPHQL_VALIDATION_FAILED)', async () => {
    let payload

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      query GetMissingField {
        missingField
      }
    `
    const res = await request(graphqlServerUrl)
      .post('')
      .type('application/json')
      .set('graphql-client-name', 'Web')
      .set('graphql-client-version', '2.0.1')
      .set('apollographql-client-name', 'Ignored')
      .set('apollographql-client-version', 'Ignored')
      .send({ query })

    expect(res.status).toBe(400)
    expect(res.body.errors).toBeTruthy()

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {
        name: 'Web',
        version: '2.0.1',
      },
      request: {
        method: 'POST',
        search: '',
        headers: {
          host: expect.any(String),
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
          'content-length': expect.any(String),
          'graphql-client-name': 'Web',
          'graphql-client-version': '2.0.1',
          'apollographql-client-name': 'Ignored',
          'apollographql-client-version': 'Ignored',
          connection: 'close',
        },
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
      },
      profile: {
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        receivedAt: expect.any(String),
        resolvers: [],
        validationEnd: expect.any(Number),
        validationStart: expect.any(Number),
        requestEnd: expect.any(Number),
      },
      metrics: {
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
      },
      errors: [
        {
          message: 'Cannot query field "missingField" on type "Query".',
          locations: [
            {
              line: expect.any(Number),
              column: expect.any(Number),
            },
          ],
          extensions: {
            http: {
              status: 400,
              headers: {},
            },
            code: 'GRAPHQL_VALIDATION_FAILED',
          },
          stackTrace: expect.stringMatching('GraphQLError: Cannot query field "missingField" on type "Query".'),
        },
      ],
    })
  })

  it('Send error when subgraph failed to resolve (ENETUNREACH)', async () => {
    let payload

    const products = nock('http://products:4000').post('/graphql').replyWithError({ code: 'ENETUNREACH' })
    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      query GetAllProducts {
        allProducts {
          id
          sku
          createdBy {
            email
            totalProductsCreated
          }
        }
      }
    `
    const res = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeTruthy()
    expect(products.pendingMocks()).toHaveLength(0)

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {},
      request: {
        method: 'POST',
        search: '',
        headers: {
          host: expect.any(String),
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
          'content-length': expect.any(String),
          connection: 'close',
        },
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
        operationType: 'query',
        operationName: 'GetAllProducts',
      },
      profile: {
        executionEnd: expect.any(Number),
        executionStart: expect.any(Number),
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        receivedAt: expect.any(String),
        resolvers: [],
        validationEnd: expect.any(Number),
        validationStart: expect.any(Number),
        requestEnd: expect.any(Number),
      },
      metrics: {
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
        captureTraces: true,
        queryPlanTrace: {
          fetch: {
            serviceName: 'products',
            sentTimeOffset: expect.any(String),
            sentTime: {
              seconds: expect.any(String),
              nanos: expect.any(Number),
            },
          },
        },
      },
      errors: [
        {
          code: 'ENETUNREACH',
          errno: 'ENETUNREACH',
          type: 'system',
          message: 'request to http://products:4000/graphql failed, reason: undefined',
          stackTrace: expect.stringMatching('FetchError: request to http://products:4000/graphql failed, reason: undefined'),
        },
      ],
    })
  })

  it('Support query batching', async () => {
    const payloads = []

    const products = nock('http://products:4000').post('/graphql').twice().reply(401)
    const pandas = nock('http://pandas:4000').post('/graphql').twice().reply(401)
    logql
      .post('/errors', (res) => {
        payloads.push(JSON.parse(decompress(res)))
        return true
      })
      .times(4)
      .reply(204)

    const batch = [
      {
        operationName: 'GetAllPandas',
        query: gql`
          query GetAllPandas {
            allPandas {
              name
            }
          }
        `,
      },
      {
        operationName: 'GetAllProducts',
        query: gql`
          query GetAllProducts {
            allProducts {
              id
            }
          }
        `,
      },
      {
        operationName: 'GetPanda',
        query: gql`
          query GetPanda($name: ID!) {
            panda(name: $name) {
              name
            }
          }
        `,
        variables: { name: 'MingMing' },
      },
      {
        operationName: 'GetProduct',
        query: gql`
          query GetProduct($id: ID!) {
            product(id: $id) {
              id
            }
          }
        `,
        variables: { id: 'ed1bd00f-32b9-407b-bfb5-1a75e744853b' },
      },
    ]

    const res = await request(graphqlServerUrl).post('').type('application/json').send(batch)

    expect(res.status).toBe(200)
    expect(res.body[0].errors).toBeTruthy()
    expect(res.body[1].errors).toBeTruthy()
    expect(res.body[2].errors).toBeTruthy()
    expect(res.body[3].errors).toBeTruthy()
    expect(products.pendingMocks()).toHaveLength(0)
    expect(pandas.pendingMocks()).toHaveLength(0)

    const expectedData = {
      GetAllProducts: {
        serviceName: 'products',
      },
      GetAllPandas: {
        serviceName: 'pandas',
      },
      GetPanda: {
        serviceName: 'pandas',
      },
      GetProduct: {
        serviceName: 'products',
      },
    }

    await waitFor(() => payloads.length === 4)
    expect(logql.pendingMocks()).toHaveLength(0)
    for (const b of batch) {
      const payload = payloads.find((p) => p.operation.operationName === b.operationName)
      const d = expectedData[b.operationName]
      expect(payload).toEqual({
        schemaHash,
        client: {},
        request: {
          method: 'POST',
          search: '',
          headers: {
            host: expect.any(String),
            'accept-encoding': 'gzip, deflate',
            'content-type': 'application/json',
            'content-length': expect.any(String),
            connection: 'close',
          },
          variables: b.variables,
        },
        operation: {
          source: b.query,
          queryHash: createHash('sha256').update(b.query).digest('hex'),
          operationType: 'query',
          operationName: b.operationName,
        },
        profile: {
          executionEnd: expect.any(Number),
          executionStart: expect.any(Number),
          parsingEnd: expect.any(Number),
          parsingStart: expect.any(Number),
          receivedAt: expect.any(String),
          resolvers: [],
          validationEnd: expect.any(Number),
          validationStart: expect.any(Number),
          requestEnd: expect.any(Number),
        },
        metrics: {
          startHrTime: [expect.any(Number), expect.any(Number)],
          persistedQueryHit: false,
          persistedQueryRegister: false,
          captureTraces: true,
          queryPlanTrace: {
            fetch: {
              serviceName: d.serviceName,
              sentTimeOffset: expect.any(String),
              sentTime: {
                seconds: expect.any(String),
                nanos: expect.any(Number),
              },
            },
          },
        },
        errors: [
          {
            extensions: {
              code: 'UNAUTHENTICATED',
              response: {
                body: '',
                status: 401,
                statusText: 'Unauthorized',
                url: `http://${d.serviceName}:4000/graphql`,
              },
            },
            message: '401: Unauthorized',
            stackTrace: expect.stringMatching('GraphQLError: 401: Unauthorized'),
          },
        ],
      })
    }
  })

  // TODO: tests to handle failure from server, retry, timeout

  it('Send detailed report periodically', async () => {
    let operation

    const zips = 'aaa,bbb,ccc,ddd,eee,fff,ggg'.split(',')
    const users = nock('http://users:4000')
      .post('/graphql', {
        query:
          'query GetProductsAndDelivery__users__2($representations:[_Any!]!){_entities(representations:$representations){...on User{name}}}',
        variables: { representations: [{ __typename: 'User', email: 'foobar@example.com' }] },
        operationName: 'GetProductsAndDelivery__users__2',
      })
      .times(zips.length)
      .reply(200, { data: { _entities: [{ name: 'Bob' }] } })
    const inventory = nock('http://inventory:4000')

    zips.map((zip) =>
      inventory
        .post('/graphql', {
          query:
            'query GetProductsAndDelivery__inventory__1($representations:[_Any!]!$zip:String!){_entities(representations:$representations){...on Product{delivery(zip:$zip){fastestDelivery}}}}',
          variables: {
            zip,
            representations: [
              {
                __typename: 'Product',
                id: '8f9d2329-0ce2-4449-9cf2-c497fe38c4d2',
                dimensions: { size: 'large', weight: 3.14 },
              },
            ],
          },
          operationName: 'GetProductsAndDelivery__inventory__1',
        })
        .reply(200, { data: { _entities: [{ delivery: { fastestDelivery: 'Horse' } }] } })
    )

    const products = nock('http://products:4000')
      .post('/graphql', {
        query:
          'query GetProductsAndDelivery__products__0{allProducts{__typename id sku dimensions{size weight}createdBy{__typename email totalProductsCreated}}}',
        variables: {},
        operationName: 'GetProductsAndDelivery__products__0',
      })
      .times(zips.length)
      .reply(200, {
        data: {
          allProducts: [
            {
              __typename: 'Product',
              id: '8f9d2329-0ce2-4449-9cf2-c497fe38c4d2',
              sku: 'UGG-BB-PUR-06',
              dimensions: {
                size: 'large',
                weight: 3.14,
              },
              createdBy: { __typename: 'User', email: 'foobar@example.com', totalProductsCreated: 1 },
            },
          ],
        },
      })

    logql

      .post('/operations', (res) => {
        operation = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      query GetProductsAndDelivery($zip: String!) {
        allProducts {
          id
          sku
          delivery(zip: $zip) {
            fastestDelivery
          }
          createdBy {
            email
            name
            totalProductsCreated
          }
        }
      }
    `

    const results = await Promise.all(
      zips.map((zip) => request(graphqlServerUrl).post('').type('application/json').send({ query, variables: { zip } }))
    )

    expect(products.pendingMocks()).toHaveLength(0)
    expect(inventory.pendingMocks()).toHaveLength(0)
    expect(users.pendingMocks()).toHaveLength(0)
    for (const res of results) {
      expect(res.status).toBe(200)
      expect(res.body.errors).toBeFalsy()
      expect(res.body.data).toEqual({
        allProducts: [
          {
            createdBy: {
              email: 'foobar@example.com',
              name: 'Bob',
              totalProductsCreated: 1,
            },
            delivery: {
              fastestDelivery: 'Horse',
            },
            id: '8f9d2329-0ce2-4449-9cf2-c497fe38c4d2',
            sku: 'UGG-BB-PUR-06',
          },
        ],
      })
    }

    await waitFor(() => logql.activeMocks().length === 0)
    expect(logql.activeMocks()).toHaveLength(0)
    expect(operation).toEqual({
      schemaHash,
      operations: [
        {
          queryHash: createHash('sha256').update(query).digest('hex'),
          source: query,
          operationName: 'GetProductsAndDelivery',
          operationType: 'query',
          paths: [],
        },
      ],
    })
  })

  it('do not send an operation body twice if it succeeded first time', async () => {
    let operation

    const pandas = nock('http://pandas:4000')
      .post('/graphql', {
        query: 'query AllPandas__pandas__0{allPandas{name favoriteFood}}',
        variables: {},
        operationName: 'AllPandas__pandas__0',
      })
      .twice()
      .reply(200, {
        data: {
          allPandas: [
            {
              name: 'ling ling',
              favoriteFood: 'bamboo',
            },
          ],
        },
      })

    logql

      .post('/operations', (res) => {
        operation = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      query AllPandas {
        allPandas {
          name
          favoriteFood
        }
      }
    `

    const res1 = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res1.status).toBe(200)
    expect(res1.body.errors).toBeFalsy()
    expect(res1.body.data).toEqual({
      allPandas: [
        {
          name: 'ling ling',
          favoriteFood: 'bamboo',
        },
      ],
    })

    const res2 = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res2.status).toBe(200)
    expect(res2.body.errors).toBeFalsy()
    expect(res2.body.data).toEqual({
      allPandas: [
        {
          name: 'ling ling',
          favoriteFood: 'bamboo',
        },
      ],
    })

    expect(pandas.pendingMocks()).toHaveLength(0)
    await waitFor(() => logql.activeMocks().length === 0)
    expect(logql.activeMocks()).toHaveLength(0)
    expect(operation).toEqual({
      schemaHash,
      operations: [
        {
          queryHash: createHash('sha256').update(query).digest('hex'),
          source: query,
          operationName: 'AllPandas',
          operationType: 'query',
          paths: [],
        },
      ],
    })
  })

  it.each([400, 500])('do send an operation body twice if it failed with status %p', async (status) => {
    let operation

    const pandas = nock('http://pandas:4000')
      .post('/graphql', {
        query: 'query AllPandas__pandas__0{allPandas{name favoriteFood}}',
        variables: {},
        operationName: 'AllPandas__pandas__0',
      })
      .twice()
      .reply(200, {
        data: {
          allPandas: [
            {
              name: 'ling ling',
              favoriteFood: 'bamboo',
            },
          ],
        },
      })

    logql

      .post('/operations', (res) => {
        operation = JSON.parse(decompress(res))
        return true
      })
      .times(4) // Fail 4 times (initial + 3 retry) so that the operation is sent with the next request
      .reply(status)

    const query = gql`
      query AllPandas {
        allPandas {
          name
          favoriteFood
        }
      }
    `

    const res1 = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res1.status).toBe(200)
    expect(res1.body.errors).toBeFalsy()
    expect(res1.body.data).toEqual({
      allPandas: [
        {
          name: 'ling ling',
          favoriteFood: 'bamboo',
        },
      ],
    })

    await waitFor(() => logql.pendingMocks().length === 0)

    logql
      .post('/operations', (res) => {
        operation = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const res2 = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res2.status).toBe(200)
    expect(res2.body.errors).toBeFalsy()
    expect(res2.body.data).toEqual({
      allPandas: [
        {
          name: 'ling ling',
          favoriteFood: 'bamboo',
        },
      ],
    })

    expect(pandas.pendingMocks()).toHaveLength(0)
    await waitFor(() => logql.activeMocks().length === 0)
    expect(logql.activeMocks()).toHaveLength(0)
    expect(operation).toEqual({
      schemaHash,
      operations: [
        {
          queryHash: createHash('sha256').update(query).digest('hex'),
          source: query,
          operationName: 'AllPandas',
          operationType: 'query',
          paths: [],
        },
      ],
    })
  })

  it.each([401, 403, 413])('do not send an operation body twice if it failed with status %p', async (status) => {
    let operation

    const pandas = nock('http://pandas:4000')
      .post('/graphql', {
        query: 'query AllPandas__pandas__0{allPandas{name favoriteFood}}',
        variables: {},
        operationName: 'AllPandas__pandas__0',
      })
      .reply(200, {
        data: {
          allPandas: [
            {
              name: 'ling ling',
              favoriteFood: 'bamboo',
            },
          ],
        },
      })

    logql

      .post('/operations', (res) => {
        operation = JSON.parse(decompress(res))
        return true
      })
      .reply(status)

    const query = gql`
      query AllPandas {
        allPandas {
          name
          favoriteFood
        }
      }
    `

    const res1 = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res1.status).toBe(200)
    expect(res1.body.errors).toBeFalsy()
    expect(res1.body.data).toEqual({
      allPandas: [
        {
          name: 'ling ling',
          favoriteFood: 'bamboo',
        },
      ],
    })

    await waitFor(() => logql.pendingMocks().length === 0)
    expect(logql.activeMocks()).toHaveLength(0)
    expect(operation).toEqual({
      schemaHash,
      operations: [
        {
          queryHash: createHash('sha256').update(query).digest('hex'),
          source: query,
          operationName: 'AllPandas',
          operationType: 'query',
          paths: [],
        },
      ],
    })
  })

  it('when request ingestion fail, send operation source again', async () => {
    let payload = []

    const pandas = nock('http://pandas:4000').post('/graphql').twice().replyWithError({ code: 'ENETUNREACH' })

    logql
      .post('/errors', (res) => {
        payload.push(JSON.parse(decompress(res)))
        return true
      })
      .reply(503)

    const query = gql`
      query AllPandas {
        allPandas {
          name
          favoriteFood
        }
      }
    `

    const res1 = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res1.status).toBe(200)
    expect(res1.body.errors).toEqual([
      {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
        message: 'request to http://pandas:4000/graphql failed, reason: undefined',
      },
    ])

    await waitFor(() => logql.activeMocks().length === 0)
    expect(logql.activeMocks()).toHaveLength(0)

    logql
      .post('/errors', (res) => {
        payload.push(JSON.parse(decompress(res)))
        return true
      })
      .reply(204)

    const res2 = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res2.status).toBe(200)
    expect(res2.body.errors).toEqual([
      {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
        message: 'request to http://pandas:4000/graphql failed, reason: undefined',
      },
    ])

    expect(pandas.pendingMocks()).toHaveLength(0)

    await waitFor(() => logql.activeMocks().length === 0)
    expect(logql.activeMocks()).toHaveLength(0)

    expect(payload).toHaveLength(2)
    expect(payload[0]).toMatchObject({
      schemaHash,
      client: {},
      operation: {
        queryHash: createHash('sha256').update(query).digest('hex'),
        source: query,
        operationName: 'AllPandas',
        operationType: 'query',
      },
    })
    expect(payload[1]).toMatchObject({
      schemaHash,
      client: {},
      operation: {
        queryHash: createHash('sha256').update(query).digest('hex'),
        source: query,
        operationName: 'AllPandas',
        operationType: 'query',
      },
    })
  })

  it('when request ingestion works, do not send operation source again', async () => {
    let payload = []

    const pandas = nock('http://pandas:4000').post('/graphql').twice().replyWithError({ code: 'ENETUNREACH' })

    logql
      .post('/errors', (res) => {
        payload.push(JSON.parse(decompress(res)))
        return true
      })
      .reply(204)

    const query = gql`
      query AllPandas {
        allPandas {
          name
          favoriteFood
        }
      }
    `

    const res1 = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res1.status).toBe(200)
    expect(res1.body.errors).toEqual([
      {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
        message: 'request to http://pandas:4000/graphql failed, reason: undefined',
      },
    ])

    await waitFor(() => logql.activeMocks().length === 0)
    expect(logql.activeMocks()).toHaveLength(0)

    logql
      .post('/errors', (res) => {
        payload.push(JSON.parse(decompress(res)))
        return true
      })
      .reply(204)

    const res2 = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res2.status).toBe(200)
    expect(res2.body.errors).toEqual([
      {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
        message: 'request to http://pandas:4000/graphql failed, reason: undefined',
      },
    ])

    expect(pandas.pendingMocks()).toHaveLength(0)

    await waitFor(() => logql.activeMocks().length === 0)
    expect(logql.activeMocks()).toHaveLength(0)

    expect(payload).toHaveLength(2)
    expect(payload[0]).toMatchObject({
      schemaHash,
      client: {},
      operation: {
        queryHash: createHash('sha256').update(query).digest('hex'),
        source: query,
        operationName: 'AllPandas',
        operationType: 'query',
      },
    })
    expect(payload[1]).toMatchObject({
      schemaHash,
      client: {},
      operation: {
        queryHash: createHash('sha256').update(query).digest('hex'),
        source: null,
        operationName: 'AllPandas',
        operationType: 'query',
      },
    })
  })
})

describe('Request handling with Apollo Server', () => {
  const { schema, schemaHash } = loadSchema('./tests/graph-test.graphql')
  const resolvers = {
    Query: {
      hello: () => 'World!',
      async user(_, { id }, ctx, info) {
        const cacheControl = cacheControlFromInfo(info)
        cacheControl.setCacheHint({ maxAge: 6, scope: 'PUBLIC' })
        await sleep(200)
        return { id, name: 'Bob' }
      },
    },
    Mutation: {
      doSomething: () => Promise.reject(Error('Failed to do something!')),
    },
    User: {
      async group(user) {
        await sleep(300)
        return { id: '9', name: 'admin' }
      },
      async avatar(user) {
        await sleep(100)
        return Promise.reject(Error('Failed to load avatar: file does not exists'))
      },
    },
    Group: {
      async users(group) {
        await sleep(100)
        return [
          { id: '1', name: 'Jane' },
          { id: '3', name: 'Joe' },
        ]
      },
    },
  }
  let graphqlServer
  let graphqlServerUrl
  let logql

  beforeEach(async () => {
    jest.spyOn(global.Math, 'random').mockReturnValue(0.2)
    nock(/uplink.api.apollographql.com/)
      .persist()
      .post('/')
      .reply(200, {
        data: {
          routerConfig: {
            __typename: 'RouterConfigResult',
            id: null,
            supergraphSdl: schema,
          },
        },
      })
    const endpoint = `https://fake-logql/${randomUUID()}`
    logql = logqlMock(endpoint)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)
    const plugins = [
      ApolloServerPluginCacheControl({
        defaultMaxAge: 20, // seconds
        calculateHttpHeaders: true,
      }),
      responseCachePlugin.default(),
    ]
    graphqlServer = getRegularServer(schema, resolvers, { sampling: 0.1, endpoint }, plugins)
    const { url } = await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    graphqlServerUrl = url
    //nock.recorder.rec()
  })

  afterEach(async () => {
    jest.spyOn(global.Math, 'random').mockRestore()
    if (graphqlServer) {
      await graphqlServer.stop()
      graphqlServer = null
    }
    nock.abortPendingRequests()
    //nock.cleanAll()
    //nock.recorder.clear()
  })

  it('does not report error on persisted query not found', async () => {
    jest.spyOn(global.Math, 'random').mockReturnValue(0)

    const query = `query NotPersisted { hello }`
    const sha256Hash = createHash('sha256').update(query).digest('hex')
    const extensions = JSON.stringify({
      persistedQuery: {
        version: 1,
        sha256Hash,
      },
    })

    const res = await request(graphqlServerUrl).get(`?extensions=${extensions}`).type('application/json').send()

    expect(res.status).toBe(200)
    expect(res.body.errors).toEqual([
      { extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' }, message: 'PersistedQueryNotFound' },
    ])
  })

  it('send metrics for persisted queries', async () => {
    let payload

    jest.spyOn(global.Math, 'random').mockReturnValue(0)

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = `query NotPersisted { hello }`
    const sha256Hash = createHash('sha256').update(query).digest('hex')
    const extensions = JSON.stringify({
      persistedQuery: {
        version: 1,
        sha256Hash,
      },
    })

    const res = await request(graphqlServerUrl)
      .get(`?extensions=${extensions}&query=${query}`)
      .type('application/json')
      .send()

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeFalsy()
    expect(res.body.data).toEqual({ hello: 'World!' })

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload.metrics).toEqual({
      startHrTime: [expect.any(Number), expect.any(Number)],
      persistedQueryHit: false,
      persistedQueryRegister: true,
      captureTraces: true,
      responseCacheHit: false,
    })

    payload = null

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const pers = await request(graphqlServerUrl).get(`?extensions=${extensions}`).type('application/json').send()

    expect(pers.status).toBe(200)
    expect(pers.body.errors).toBeFalsy()
    expect(pers.body.data).toEqual({ hello: 'World!' })

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload.metrics).toEqual({
      startHrTime: [expect.any(Number), expect.any(Number)],
      persistedQueryHit: true,
      persistedQueryRegister: false,
      captureTraces: true,
      responseCacheHit: true,
    })
  })

  it('send request when sampled and not error', async () => {
    let payload

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      query Hello {
        hello
      }
    `
    jest.spyOn(global.Math, 'random').mockReturnValue(0.02)
    const res = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeFalsy()

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {},
      request: {
        method: 'POST',
        search: '',
        headers: {
          host: expect.any(String),
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
          'content-length': expect.any(String),
          connection: 'close',
        },
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
        operationName: 'Hello',
        operationType: 'query',
      },
      profile: {
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        validationStart: expect.any(Number),
        validationEnd: expect.any(Number),
        executionStart: expect.any(Number),
        executionEnd: expect.any(Number),
        receivedAt: expect.any(String),
        resolvers: [
          {
            path: ['hello'],
            start: expect.any(Number),
            end: expect.any(Number),
            error: false,
          },
        ],
        requestEnd: expect.any(Number),
      },
      metrics: {
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
        captureTraces: true,
        responseCacheHit: false,
      },
    })
  })

  it('send errors when query is malformed (GRAPHQL_PARSE_FAILED)', async () => {
    let payload

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      {
        syntax error {}
      }
    `
    const res = await request(graphqlServerUrl).post('').type('application/json').send({ query })

    expect(res.status).toBe(400)
    expect(res.body.errors).toBeTruthy()

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {},
      request: {
        method: 'POST',
        search: '',
        headers: {
          host: expect.any(String),
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
          'content-length': expect.any(String),
          connection: 'close',
        },
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
      },
      profile: {
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        receivedAt: expect.any(String),
        resolvers: [],
        requestEnd: expect.any(Number),
      },
      metrics: {
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
      },
      errors: [
        {
          message: 'Syntax Error: Expected Name, found "}".',
          locations: [
            {
              line: 3,
              column: 23,
            },
          ],
          extensions: {
            http: {
              status: 400,
              headers: {},
            },
            code: 'GRAPHQL_PARSE_FAILED',
          },
          stackTrace: expect.stringMatching('GraphQLError: Syntax Error: Expected Name, found "}".'),
        },
      ],
    })
  })

  it('Send errors when mutation fail in resolver', async () => {
    let payload

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      mutation JustDoIt($value: Int!) {
        doSomething(x: $value)
      }
    `
    const variables = { value: 33 }
    const res = await request(graphqlServerUrl).post('').type('application/json').send({ query, variables })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeTruthy()

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {},
      request: {
        method: 'POST',
        search: '',
        headers: {
          host: expect.any(String),
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
          'content-length': expect.any(String),
          connection: 'close',
        },
        variables,
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
        operationType: 'mutation',
        operationName: 'JustDoIt',
      },
      profile: {
        executionEnd: expect.any(Number),
        executionStart: expect.any(Number),
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        receivedAt: expect.any(String),
        resolvers: [
          {
            end: expect.any(Number),
            error: true,
            path: ['doSomething'],
            start: expect.any(Number),
          },
        ],
        validationEnd: expect.any(Number),
        validationStart: expect.any(Number),
        requestEnd: expect.any(Number),
      },
      metrics: {
        captureTraces: true,
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
        responseCacheHit: false,
      },
      errors: [
        {
          message: 'Failed to do something!',
          locations: [
            {
              line: expect.any(Number),
              column: expect.any(Number),
            },
          ],
          path: ['doSomething'],
          extensions: {},
          stackTrace: expect.stringMatching('Error: Failed to do something!'),
        },
      ],
    })
  })

  it('Send errors when variables do not match query (BAD_USER_INPUT)', async () => {
    let payload

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      mutation JustDoIt($value: Int!) {
        doSomething(x: $value)
      }
    `
    const variables = { value: 'not a number' }
    const res = await request(graphqlServerUrl).post('').type('application/json').send({ query, variables })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeTruthy()

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {},
      request: {
        method: 'POST',
        search: '',
        headers: {
          host: expect.any(String),
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
          'content-length': expect.any(String),
          connection: 'close',
        },
        variables,
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
        operationType: 'mutation',
        operationName: 'JustDoIt',
      },
      profile: {
        executionEnd: expect.any(Number),
        executionStart: expect.any(Number),
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        receivedAt: expect.any(String),
        resolvers: [],
        validationEnd: expect.any(Number),
        validationStart: expect.any(Number),
        requestEnd: expect.any(Number),
      },
      metrics: {
        captureTraces: true,
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
        responseCacheHit: false,
      },
      errors: [
        {
          message:
            'Variable "$value" got invalid value "not a number"; Int cannot represent non-integer value: "not a number"',
          locations: [
            {
              line: expect.any(Number),
              column: expect.any(Number),
            },
          ],
          extensions: {
            code: 'BAD_USER_INPUT',
          },
          stackTrace: expect.stringMatching('GraphQLError: Int cannot represent non-integer value: "not a number"'),
        },
      ],
    })
  })

  it('Support compressed body', async () => {
    let payload

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      mutation JustDoIt($value: Int!) {
        doSomething(x: $value) {
          invalidField
        }
      }
    `
    const variables = { value: 'not a number' }
    const buffer = await compress(JSON.stringify({ query, variables }))
    const r = request(graphqlServerUrl).post('').set('Content-Encoding', 'gzip').type('application/json; charset=utf-8')
    r.write(buffer)
    const res = await new Promise((resolve, reject) => r.end((err, result) => (err ? reject(err) : resolve(result))))
    expect(res.status).toBe(400)
    expect(res.body.errors).toBeTruthy()

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {},
      request: {
        method: 'POST',
        search: '',
        headers: {
          host: expect.any(String),
          'accept-encoding': 'gzip, deflate',
          'content-encoding': 'gzip',
          'content-type': 'application/json; charset=utf-8',
          'transfer-encoding': 'chunked',
          connection: 'close',
        },
        variables,
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
      },
      profile: {
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        receivedAt: expect.any(String),
        resolvers: [],
        validationEnd: expect.any(Number),
        validationStart: expect.any(Number),
        requestEnd: expect.any(Number),
      },
      metrics: {
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
      },
      errors: [
        {
          message: 'Field "doSomething" must not have a selection since type "Boolean" has no subfields.',
          locations: [
            {
              line: expect.any(Number),
              column: expect.any(Number),
            },
          ],
          extensions: {
            code: 'GRAPHQL_VALIDATION_FAILED',
            http: {
              headers: {},
              status: 400,
            },
          },
          stackTrace: expect.stringMatching(
            'GraphQLError: Field "doSomething" must not have a selection since type "Boolean" has no subfields.'
          ),
        },
      ],
    })
  })

  it('Send field resolve time with metrics', async () => {
    let operation

    logql
      .post('/operations', (res) => {
        operation = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      query UserTree($id: ID!) {
        user(id: $id) {
          id
          name
          group {
            id
            name
            users {
              id
              name
            }
          }
        }
      }
    `
    const variables = { id: '5' }
    const res = await request(graphqlServerUrl).post('').type('application/json').send({ query, variables })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeFalsy()

    await waitFor(() => operation)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(operation).toEqual({
      schemaHash,
      operations: [
        {
          queryHash: createHash('sha256').update(query).digest('hex'),
          source: query,
          operationName: 'UserTree',
          operationType: 'query',
          paths: [
            'user',
            'user.id',
            'user.name',
            'user.group',
            'user.group.id',
            'user.group.name',
            'user.group.users',
            'user.group.users.id',
            'user.group.users.name',
          ],
        },
      ],
    })
  })

  it('Send execution profile with errors', async () => {
    let payload

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)

    const query = gql`
      query UserTree($id: ID!) {
        user(id: $id) {
          id
          name
          group {
            id
            name
            users {
              id
              name
              avatar
            }
          }
        }
      }
    `
    const variables = { id: 5 }
    const res = await request(graphqlServerUrl).post('').type('application/json').send({ query, variables })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeTruthy()

    await waitFor(() => payload)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payload).toEqual({
      schemaHash,
      client: {},
      request: {
        method: 'POST',
        search: '',
        headers: {
          host: expect.any(String),
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
          'content-length': expect.any(String),
          connection: 'close',
        },
        variables,
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
        operationType: 'query',
        operationName: 'UserTree',
      },
      profile: {
        executionEnd: expect.any(Number),
        executionStart: expect.any(Number),
        parsingEnd: expect.any(Number),
        parsingStart: expect.any(Number),
        receivedAt: expect.any(String),
        requestEnd: expect.any(Number),
        resolvers: expect.any(Array),
        validationEnd: expect.any(Number),
        validationStart: expect.any(Number),
      },
      metrics: {
        captureTraces: true,
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
        responseCacheHit: false,
      },
      errors: [0, 1].map((index) => ({
        message: 'Failed to load avatar: file does not exists',
        locations: [
          {
            line: expect.any(Number),
            column: expect.any(Number),
          },
        ],
        path: ['user', 'group', 'users', index, 'avatar'],
        extensions: {},
        stackTrace: expect.stringMatching('Error: Failed to load avatar: file does not exists'),
      })),
    })
    expect(payload.profile.resolvers).toEqual(
      expect.arrayContaining([
        {
          end: expect.any(Number),
          error: false,
          path: ['user'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'id'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'name'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'group'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'group', 'id'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'group', 'name'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'group', 'users'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'group', 'users', 0, 'id'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'group', 'users', 0, 'name'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: true,
          path: ['user', 'group', 'users', 0, 'avatar'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'group', 'users', 1, 'id'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: false,
          path: ['user', 'group', 'users', 1, 'name'],
          start: expect.any(Number),
        },
        {
          end: expect.any(Number),
          error: true,
          path: ['user', 'group', 'users', 1, 'avatar'],
          start: expect.any(Number),
        },
      ])
    )
    expect(payload.profile.resolvers).toHaveLength(13)
  })

  it('Send caching info', async () => {
    const payloads = []

    logql
      .post('/errors', (res) => {
        payloads.push(JSON.parse(decompress(res)))
        return true
      })
      .twice()
      .reply(204)

    const query = gql`
      query UserTree($id: ID!) {
        user(id: $id) {
          id
          name
          group {
            id
            name
          }
        }
      }
    `

    jest.spyOn(global.Math, 'random').mockReturnValue(0.02)
    const variables = { id: 5 }

    const res = await request(graphqlServerUrl).post('').type('application/json').send({ query, variables })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeFalsy()

    await waitFor(() => payloads.length)
    expect(logql.pendingMocks()).toHaveLength(1)
    expect(payloads[0].operation.source).toEqual(query)
    expect(payloads[0].metrics).toEqual({
      captureTraces: true,
      startHrTime: [expect.any(Number), expect.any(Number)],
      persistedQueryHit: false,
      persistedQueryRegister: false,
      responseCacheHit: false,
    })

    const cached = await request(graphqlServerUrl).post('').type('application/json').send({ query, variables })
    expect(cached.status).toBe(200)
    expect(cached.body.errors).toBeFalsy()

    await waitFor(() => payloads.length > 1)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(payloads[1].metrics).toEqual({
      captureTraces: true,
      startHrTime: [expect.any(Number), expect.any(Number)],
      persistedQueryHit: false,
      persistedQueryRegister: false,
      responseCacheHit: true,
    })
  })

  // TODO: test for reportEntriesThreshold
})
