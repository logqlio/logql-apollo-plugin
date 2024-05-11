const initPlugin = require('../')
const { getConfig, loadEnv } = require('../src/config')

describe('Config Validation', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'development'
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterAll(() => {
    process.env.NODE_ENV = 'test'
    console.error.mockRestore()
  })

  afterEach(() => {
    console.error.mockClear()
  })

  it('log an error when no config is given', () => {
    expect(initPlugin()).toEqual({})
    expect(console.error).toHaveBeenCalledWith('[logql-plugin][ERROR][init] Invalid options: Required at "apiKey"')
  })

  it('log an error when config is empty', () => {
    expect(initPlugin({})).toEqual({})
    expect(console.error).toHaveBeenCalledWith('[logql-plugin][ERROR][init] Invalid options: Required at "apiKey"')
  })

  it('work with valid minimal config', () => {
    const config = { apiKey: 'logql:FAKE_API_KEY' }
    expect(initPlugin(config)).not.toEqual({})
  })

  it('ignore env by default', () => {
    process.env.LOGQL_API_KEY = 'logql:FAKE_API_KEY'
    expect(initPlugin({})).toEqual({})
    expect(console.error).toHaveBeenCalledWith('[logql-plugin][ERROR][init] Invalid options: Required at "apiKey"')
  })

  it('load config from env', () => {
    process.env.LOGQL_API_KEY = 'logql:FAKE_API_KEY'
    process.env.LOGQL_ENVIRONMENT = 'dev'
    process.env.LOGQL_ENDPOINT = ''
    process.env.LOGQL_SEND_VARIABLES = 'true'
    process.env.LOGQL_SEND_HEADERS = 't'
    process.env.LOGQL_RUN_IN_TESTS = '0'
    process.env.LOGQL_VERBOSE = '1'
    process.env.LOGQL_TIMEOUT = '33'
    process.env.LOGQL_REPORT_INTERVAL_MS = '10000'
    process.env.LOGQL_REPORT_ENTRIES_THRESHOLD = '3'
    process.env.LOGQL_CACHE_SIZE = ''
    process.env.LOGQL_SAMPLING = '0.9'
    const plugin = initPlugin.fromEnv()

    expect(console.error).not.toHaveBeenCalled()
    expect(plugin).not.toEqual({})
  })

  it('generate correct config from env', () => {
    process.env.LOGQL_API_KEY = 'logql:FAKE_API_KEY'
    process.env.LOGQL_ENVIRONMENT = 'dev'
    process.env.LOGQL_ENDPOINT = ''
    process.env.LOGQL_SEND_VARIABLES = 'true'
    process.env.LOGQL_SEND_HEADERS = 't'
    process.env.LOGQL_RUN_IN_TESTS = '0'
    process.env.LOGQL_VERBOSE = '1'
    process.env.LOGQL_TIMEOUT = '33'
    process.env.LOGQL_REPORT_INTERVAL_MS = '10000'
    process.env.LOGQL_REPORT_ENTRIES_THRESHOLD = '3'
    process.env.LOGQL_CACHE_SIZE = ''
    process.env.LOGQL_SAMPLING = '0.9'

    const config = getConfig(loadEnv())

    expect(config).toEqual({
      apiKey: process.env.LOGQL_API_KEY,
      environment: process.env.LOGQL_ENVIRONMENT,
      endpoint: 'https://ingress.logql.io',

      sendVariables: true,
      sendHeaders: true,
      runInTests: false,
      verbose: true,

      timeout: Number(process.env.LOGQL_TIMEOUT),
      reportIntervalMs: 10000,
      reportEntriesThreshold: 3,
      cacheSize: 16384,

      sampling: 0.9,

      agent: null,
    })
  })

  it('log an error when passed a non-object', () => {
    expect(initPlugin('banana')).toEqual({})
    expect(console.error).toHaveBeenCalledWith(
      '[logql-plugin][ERROR][init] Invalid options type: Expected an object, got string'
    )
  })

  it('log a warning when env variables are not matching types', () => {
    process.env.LOGQL_API_KEY = 'logql:FAKE_API_KEY'
    process.env.LOGQL_TIMEOUT = 'NOT_A_NUMBER!'
    const plugin = initPlugin.fromEnv()
    expect(console.error).toHaveBeenCalledWith(
      '[logql-plugin][ERROR][init] Invalid environment value for LOGQL_TIMEOUT: Expected a number, got "NOT_A_NUMBER!"'
    )
    expect(plugin).toEqual({})
  })

  it('does nothing in tests by default', () => {
    process.env.NODE_ENV = 'test'
    expect(initPlugin({ apiKey: 'logql:FAKE_API_KEY' })).toEqual({})
    expect(console.error).not.toHaveBeenCalled()
  })

  it('can run in test when configured', () => {
    process.env.NODE_ENV = 'test'
    expect(initPlugin({ apiKey: 'logql:FAKE_API_KEY', runInTests: true })).not.toEqual({})
    expect(console.error).not.toHaveBeenCalled()
  })
})
