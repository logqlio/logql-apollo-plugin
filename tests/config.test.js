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

  it('load config from env', () => {
    process.env.LOGQL_API_KEY = 'logql:FAKE_API_KEY'
    expect(initPlugin({})).not.toEqual({})
  })

  it('log an error when passed a non-object', () => {
    expect(initPlugin('banana')).toEqual({})
    expect(console.error).toHaveBeenCalledWith(
      '[logql-plugin][ERROR][init] Invalid options type: Expected an object, got string'
    )
  })

  it('log a warning when env variables are not matching types', () => {
    process.env.LOGQL_TIMEOUT = 'NOT_A_NUMBER!'
    expect(initPlugin({ apiKey: 'logql:FAKE_API_KEY' })).not.toEqual({})
    expect(console.error).toHaveBeenCalledWith(
      '[logql-plugin][WARNING][init] Invalid values supplied as environment variables, ignoring: timeout: Invalid number input: "NOT_A_NUMBER!"'
    )
  })

  it('does nothing in tests by default', () => {
    process.env.NODE_ENV = 'test'
    expect(initPlugin({ runInTests: false })).toEqual({})
    expect(console.error).not.toHaveBeenCalled()
  })
})
