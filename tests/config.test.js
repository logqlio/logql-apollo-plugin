const initPlugin = require('../')

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
    process.env.LOGQL_TIMEOUT = '33'
    process.env.LOGQL_SEND_VARIABLES = 'true'
    process.env.LOGQL_SEND_HEADERS = 't'
    process.env.LOGQL_RUN_IN_TESTS = '0'
    process.env.LOGQL_VERBOSE = '1'
    process.env.LOGQL_REPORT_INTERVAL_MS = '10000'
    process.env.LOGQL_REPORT_ENTRIES_THRESHOLD = '3'
    process.env.LOGQL_CACHE_SIZE = '33'
    process.env.LOGQL_SAMPLING = '0.9'
    process.env.LOGQL_ENDPOINT = 'http://localhost'
    const plugin = initPlugin.fromEnv()

    expect(console.error).not.toHaveBeenCalled()
    expect(plugin).not.toEqual({})
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
      '[logql-plugin][ERROR][init] Invalid environment variable: Expected a number, got NOT_A_NUMBER!'
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
