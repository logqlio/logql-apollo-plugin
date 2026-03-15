jest.mock('../src/client', () => ({
  json: jest.fn((input) => ({ contentType: 'application/json', body: JSON.stringify(input) })),
  text: jest.fn((input) => ({ contentType: 'text/plain', body: input })),
  sendWithRetry: jest.fn().mockResolvedValue(true),
  compress: jest.fn(),
}))

const LogqlApolloPlugin = require('../')
const { sendWithRetry } = require('../src/client')

const noop = () => {}
const logger = { debug: noop, info: noop, warn: noop, error: noop }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, ms = 10, timeout = 2000) => {
  for (let attempt = 0; attempt * ms < timeout; ++attempt) {
    if (predicate()) return true
    await sleep(ms)
  }
}

function makePlugin(options = {}) {
  return LogqlApolloPlugin({
    apiKey: 'logql:test',
    runInTests: true,
    verbose: true,
    sampling: 1,
    ...options,
  })
}

function makeRequestContext(overrides = {}) {
  return {
    request: {
      http: { headers: new Map(), method: 'POST', search: '' },
      variables: {},
    },
    queryHash: 'abc123',
    source: 'query Hello { hello }',
    operation: { operation: 'query' },
    operationName: 'Hello',
    metrics: { startHrTime: [0, 0] },
    contextValue: {},
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  sendWithRetry.mockResolvedValue(true)
})

afterEach(() => {
  jest.spyOn(global.Math, 'random').mockRestore()
})

describe('handleError on sendError rejection', () => {
  it('handles sendError rejection gracefully when verbose is true', async () => {
    jest.spyOn(global.Math, 'random').mockReturnValue(0)
    sendWithRetry.mockRejectedValueOnce(new Error('network failure'))

    const plugin = makePlugin()
    const requestHooks = await plugin.requestDidStart({ logger })
    await requestHooks.willSendResponse(
      makeRequestContext({
        errors: [{ message: 'test error', extensions: {}, stack: 'Error: test', path: ['hello'] }],
      })
    )

    await waitFor(() => sendWithRetry.mock.calls.length > 0)
    expect(sendWithRetry).toHaveBeenCalled()
  })
})

describe('handleError on sendOperation rejection', () => {
  it('handles sendOperation rejection gracefully when verbose is true', async () => {
    jest.spyOn(global.Math, 'random').mockReturnValue(1)
    sendWithRetry.mockRejectedValueOnce(new Error('network failure'))

    const plugin = makePlugin({ sampling: 0.5 })
    const requestHooks = await plugin.requestDidStart({ logger })
    await requestHooks.willSendResponse(makeRequestContext({ errors: undefined }))

    await waitFor(() => sendWithRetry.mock.calls.length > 0)
    expect(sendWithRetry).toHaveBeenCalled()
  })
})

describe('getUserId default switch case', () => {
  it('returns empty string when userId function returns a non-primitive', async () => {
    jest.spyOn(global.Math, 'random').mockReturnValue(0)

    const plugin = makePlugin({ userId: () => null })
    const requestHooks = await plugin.requestDidStart({ logger })
    await requestHooks.willSendResponse(
      makeRequestContext({
        errors: [{ message: 'test', extensions: {}, stack: 'Error: test', path: [] }],
      })
    )

    await waitFor(() => sendWithRetry.mock.calls.length > 0)
    const payload = JSON.parse(sendWithRetry.mock.calls[0][1].body)
    expect(payload.userId).toBe('')
  })
})
