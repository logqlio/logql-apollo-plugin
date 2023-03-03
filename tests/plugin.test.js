/* eslint-disable security/detect-object-injection */
process.env.APOLLO_KEY = 'service:fake-id:123456789ABC-fakefake1'
process.env.APOLLO_GRAPH_ID = 'fake-id'
process.env.APOLLO_GRAPH_VARIANT = 'fake-variant'
process.env.APOLLO_SCHEMA_REPORTING = false

const { ApolloServer } = require('@apollo/server')
const { startStandaloneServer } = require('@apollo/server/standalone')
const { ApolloGateway } = require('@apollo/gateway')
const { createHash, randomUUID } = require('crypto')
const { readFileSync } = require('fs')
const { gzip, gunzipSync } = require('zlib')
const request = require('supertest')
const nock = require('nock')

const LogqlApolloPlugin = require('../')

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
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
    projectId: '00000000-0000-4000-0000-000000000000',
    sendVariables: true,
    sendHeaders: true,
    reportIntervalMs: 500,
    ...config,
  })
}

function getRegularServer(typeDefs, resolvers, config = {}) {
  return new ApolloServer({
    logger,
    typeDefs,
    resolvers,
    plugins: [getConfiguredPlugin(config)],
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

async function compress(payload) {
  return new Promise((resolve, reject) => {
    gzip(payload, (error, res) => (error ? reject(error) : resolve(res)))
  })
}

function decompress(payload) {
  const buffer = Buffer.from(payload, 'hex')
  return gunzipSync(buffer).toString('utf-8')
}

function logqlMock(projectId) {
  return nock(`https://ingress.logql.io/${projectId}`, {
    reqheaders: {
      'user-agent': /logql-apollo-plugin; .*; .*/,
      'content-encoding': 'gzip',
      'x-request-id': /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'x-api-key': 'logql:FAKE_API_KEY',
      'accept-encoding': 'gzip,deflate',
    },
  })
}

beforeAll(() => {
  nock.disableNetConnect()
  nock.enableNetConnect(/localhost|(products|pandas):4000/)

  // Since we use an Apollo Studio Key to enable federation, we need to mock the usage reporting
  // This is not critical, as we already have a nock.disableNetConnect() nothing is sent to the internet
  // But this preventing noisy logs
  nock('https://usage-reporting.api.apollographql.com/api').persist().post('/ingress/traces').reply(204)
})

afterAll(() => {
  //nock.cleanAll()
})

describe('Config Validation', () => {
  const initPlugin = (config) => () => LogqlApolloPlugin(config)

  it('fail when given no config', () => {
    expect(initPlugin()).toThrow('logql-plugin: Error: Validation error: Required at "apiKey"; Required at "projectId"')
  })

  it('fail when given config is null', () => {
    expect(initPlugin()).toThrow('logql-plugin: Error: Validation error: Required at "apiKey"; Required at "projectId"')
  })

  it('fail when apiKey is missing', () => {
    expect(initPlugin({ projectId: randomUUID() })).toThrow('logql-plugin: Error: Validation error: Required at "apiKey"')
  })

  it('fail when projectId is missing', () => {
    expect(initPlugin({ apiKey: 'logql:FAKE' })).toThrow('logql-plugin: Error: Validation error: Required at "projectId"')
  })

  it('work with valid minimal config', () => {
    const config = { apiKey: 'logql:FAKE_API_KEY', projectId: randomUUID() }
    expect(initPlugin(config)).not.toThrow()
  })

  it('do not run validation of option when disable is truthy', () => {
    expect(initPlugin({ disable: true })).not.toThrow()
  })
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
    const projectId = randomUUID()
    const schemaRegistry = logqlMock(projectId)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)

    graphqlServer = getFederatedServer({ projectId })
    await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    // Leave time to plugin to send the schema
    await waitFor(() => schemaRegistry.pendingMocks().length === 0, 20, 1000)
    expect(schemaRegistry.pendingMocks()).toHaveLength(0)
  })

  it('Retry sending the schema after a timeout', async () => {
    const projectId = randomUUID()
    const schemaRegistry = logqlMock(projectId)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .delayConnection(500)
      .reply(204)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)

    graphqlServer = getFederatedServer({ projectId, timeout: 100 })
    await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    await waitFor(() => schemaRegistry.pendingMocks().length === 0) // Letting some time for the retry to occur
    expect(schemaRegistry.pendingMocks()).toHaveLength(0)
  })

  it('Retry sending the schema after a 500 error', async () => {
    const projectId = randomUUID()
    const schemaRegistry = logqlMock(projectId)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(500)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)

    graphqlServer = getFederatedServer({ projectId })
    await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    await waitFor(() => schemaRegistry.pendingMocks().length === 0) // Letting some time for the retry to occur
    expect(schemaRegistry.pendingMocks()).toHaveLength(0)
  })

  it('Retry sending the schema after 3 times after 5xx errors', async () => {
    const projectId = randomUUID()
    const schemaRegistry = logqlMock(projectId)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(500)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(502)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(504)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(501)

    graphqlServer = getFederatedServer({ projectId, reportIntervalMs: 1 })
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
    const projectId = randomUUID()
    const schemaRegistry = logqlMock(projectId)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)

    graphqlServer = getRegularServer(schema, resolvers, { projectId })
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
    const projectId = randomUUID()
    logql = logqlMock(projectId)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)
    graphqlServer = getFederatedServer({ projectId })
    const { url } = await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    graphqlServerUrl = url
    //nock.recorder.rec()
  })

  afterEach(async () => {
    if (graphqlServer) {
      await graphqlServer.stop()
      graphqlServer = null
    }
    nock.abortPendingRequests()
    //nock.cleanAll()
    //nock.recorder.clear()
  })

  it('Send errors when query is malformed (GRAPHQL_PARSE_FAILED)', async () => {
    let payload, report

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
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

    await waitFor(() => payload && report)
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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 1,
          resolvers: {},
        },
      },
    })
  })

  it('Send errors when field do not exists (GRAPHQL_VALIDATION_FAILED)', async () => {
    let payload, report

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
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
      .set('apollographql-client-name', 'Web')
      .set('apollographql-client-version', '2.0.1')
      .send({ query })

    expect(res.status).toBe(400)
    expect(res.body.errors).toBeTruthy()

    await waitFor(() => payload && report)
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
          'apollographql-client-name': 'Web',
          'apollographql-client-version': '2.0.1',
          connection: 'close',
        },
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 1,
          resolvers: {},
        },
      },
    })
  })

  it('Send error when subgraph failed to resolve (ENETUNREACH)', async () => {
    let payload, report

    const products = nock('http://products:4000').post('/graphql').replyWithError({ code: 'ENETUNREACH' })
    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
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

    await waitFor(() => payload && report)
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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 1,
          resolvers: {},
        },
      },
    })
  })

  it('Support query batching', async () => {
    const payloads = []
    let report

    const products = nock('http://products:4000').post('/graphql').twice().reply(401)
    const pandas = nock('http://pandas:4000').post('/graphql').twice().reply(401)
    logql
      .post('/errors', (res) => {
        payloads.push(JSON.parse(decompress(res)))
        return true
      })
      .times(4)
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
        return true
      })
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

    await waitFor(() => payloads.length === 4 && report)
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
        },
        operation: {
          source: b.query,
          queryHash: createHash('sha256').update(b.query).digest('hex'),
          operationType: 'query',
          operationName: b.operationName,
          variables: b.variables,
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
    expect(report).toEqual({
      schemaHash,
      operations: Object.fromEntries(
        batch.map((b) => [
          createHash('sha256').update(b.query).digest('hex'),
          { count: 1, duration: expect.any(Number), errors: 1, resolvers: {} },
        ])
      ),
    })
  })

  // TODO: tests to handle failure from server, retry, timeout

  it('Send detailed report periodically', async () => {
    let report
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
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 7,
          duration: expect.any(Number),
          errors: 0,
          resolvers: {},
        },
      },
    })
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
    let report
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
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 2,
          duration: expect.any(Number),
          errors: 0,
          resolvers: {},
        },
      },
    })
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

  it('do send an operation body twice if it failed first time', async () => {
    let report
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
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/operations', (res) => {
        operation = JSON.parse(decompress(res))
        return true
      })
      .times(4) // Fail 4 times (initial + 3 retry) so that the operation is sent with the next request
      .reply(500)

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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 0,
          resolvers: {},
        },
      },
    })
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

  it('do not send an operation body twice if it failed with 401', async () => {
    let report
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
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/operations', (res) => {
        operation = JSON.parse(decompress(res))
        return true
      })
      .reply(401)

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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 0,
          resolvers: {},
        },
      },
    })
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
})

describe('Request handling with Apollo Server', () => {
  const { schema, schemaHash } = loadSchema('./tests/graph-test.graphql')
  const resolvers = {
    Query: {
      hello: () => 'World!',
      async user(_, { id }) {
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
    const projectId = randomUUID()
    logql = logqlMock(projectId)
      .post(`/schemas/${schemaHash}`, (data) => decompress(data) === schema)
      .reply(204)
    graphqlServer = getRegularServer(schema, resolvers, { projectId })
    const { url } = await startStandaloneServer(graphqlServer, { listen: { port: 0 } })
    graphqlServerUrl = url
    //nock.recorder.rec()
  })

  afterEach(async () => {
    if (graphqlServer) {
      await graphqlServer.stop()
      graphqlServer = null
    }
    nock.abortPendingRequests()
    //nock.cleanAll()
    //nock.recorder.clear()
  })

  it('Send errors when query is malformed (GRAPHQL_PARSE_FAILED)', async () => {
    let payload, report

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
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

    await waitFor(() => payload && report)
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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 1,
          resolvers: {},
        },
      },
    })
  })

  it('Send errors when mutation fail in resolver', async () => {
    let payload, report

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
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

    await waitFor(() => payload && report)
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
        operationType: 'mutation',
        operationName: 'JustDoIt',
        variables,
      },
      metrics: {
        captureTraces: true,
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 1,
          resolvers: {
            doSomething: {
              count: 1,
              duration: expect.any(Number),
              errors: 1,
            },
          },
        },
      },
    })
  })

  it('Send errors when variables do not match query (BAD_USER_INPUT)', async () => {
    let payload, report

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
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

    await waitFor(() => payload && report)
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
        operationType: 'mutation',
        operationName: 'JustDoIt',
        variables,
      },
      metrics: {
        captureTraces: true,
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
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
          stackTrace: expect.stringMatching(
            'GraphQLError: Variable "\\$value" got invalid value "not a number"; Int cannot represent non-integer value: "not a number"'
          ),
        },
      ],
    })
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 1,
          resolvers: {},
        },
      },
    })
  })

  it('Support compressed body', async () => {
    let payload, report

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
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

    await waitFor(() => payload && report)
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
      },
      operation: {
        source: query,
        queryHash: createHash('sha256').update(query).digest('hex'),
        variables,
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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 1,
          resolvers: {},
        },
      },
    })
  })

  it('Send field resolve time with metrics', async () => {
    let report, operation

    logql
      .post('/operations', (res) => {
        operation = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
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

    await waitFor(() => report && operation)
    expect(logql.pendingMocks()).toHaveLength(0)
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 0,
          resolvers: {
            user: {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.id': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.name': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.users': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.users.id': {
              count: 2,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.users.name': {
              count: 2,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.id': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.name': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
          },
        },
      },
    })
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
            'user.group.users.id',
            'user.group.users.name',
          ],
        },
      ],
    })
  })

  it('Send execution profile with errors', async () => {
    let payload, report

    logql
      .post('/errors', (res) => {
        payload = JSON.parse(decompress(res))
        return true
      })
      .reply(204)
      .post('/metrics', (res) => {
        report = JSON.parse(decompress(res))
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

    await waitFor(() => payload && report)
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
        operationName: 'UserTree',
        variables,
      },
      metrics: {
        captureTraces: true,
        startHrTime: [expect.any(Number), expect.any(Number)],
        persistedQueryHit: false,
        persistedQueryRegister: false,
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
    expect(report).toEqual({
      schemaHash,
      operations: {
        [createHash('sha256').update(query).digest('hex')]: {
          count: 1,
          duration: expect.any(Number),
          errors: 1,
          resolvers: {
            user: {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.id': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.name': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.users': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.users.avatar': {
              count: 2,
              duration: expect.any(Number),
              errors: 2,
            },
            'user.group.users.id': {
              count: 2,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.group.users.name': {
              count: 2,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.id': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
            'user.name': {
              count: 1,
              duration: expect.any(Number),
              errors: 0,
            },
          },
        },
      },
    })
  })

  // TODO: test for reportEntriesThreshold
})
