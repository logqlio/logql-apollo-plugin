// @ts-check
const http = require('http')
const https = require('https')
const { z } = require('zod')
const { fromZodError } = require('zod-validation-error')

const ConfigSchema = z.object({
  apiKey: z.string().startsWith('logql:'),
  environment: z.string().trim().toLowerCase().max(128).default(''),
  endpoint: z.string().url().default('https://ingress.logql.io'),

  sendVariables: z.boolean().default(false),
  sendHeaders: z.boolean().default(false),
  runInTests: z.boolean().default(false),
  verbose: z.boolean().default(false),

  timeout: z.number().int().nonnegative().default(2000),
  reportIntervalMs: z.number().int().nonnegative().default(5000),
  reportEntriesThreshold: z.number().int().positive().default(1024),
  cacheSize: z.number().int().positive().default(16384),

  sampling: z.number().min(0).max(1).default(1.0),

  agent: z.instanceof(http.Agent).or(z.instanceof(https.Agent)).nullable().default(null),
})

/** @typedef {z.infer<typeof ConfigSchema>} Config */

/** @param {string} msg */
function logInitError(msg) {
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[logql-plugin][ERROR][init] ${msg}`)
  }
}

/** @param {string} envKey */
function Str(envKey) {
  const str = process.env[envKey]
  if (str == null || str === '') return undefined
  return str
}

/** @param {string} envKey */
function Bool(envKey) {
  const str = process.env[envKey]
  if (str == null || str === '') return undefined
  const num = Number(str)
  return Number.isSafeInteger(num) ? Boolean(num) : str === 'true' || str === 't'
}

/** @param {string} envKey */
function Num(envKey) {
  const str = process.env[envKey]
  if (str == null || str === '') return undefined
  const num = Number(str)
  if (Number.isNaN(num)) {
    logInitError(`Invalid environment value for ${envKey}: Expected a number, got "${str}"`)
  }
  return num
}

function loadEnv() {
  const config = {
    apiKey: Str('LOGQL_API_KEY'),
    environment: Str('LOGQL_ENVIRONMENT'),
    endpoint: Str('LOGQL_ENDPOINT'),

    sendVariables: Bool('LOGQL_SEND_VARIABLES'),
    sendHeaders: Bool('LOGQL_SEND_HEADERS'),
    runInTests: Bool('LOGQL_RUN_IN_TESTS'),
    verbose: Bool('LOGQL_VERBOSE'),

    timeout: Num('LOGQL_TIMEOUT'),
    reportIntervalMs: Num('LOGQL_REPORT_INTERVAL_MS'),
    reportEntriesThreshold: Num('LOGQL_REPORT_ENTRIES_THRESHOLD'),
    cacheSize: Num('LOGQL_CACHE_SIZE'),
    sampling: Num('LOGQL_SAMPLING'),
  }
  return config
}

/** @param {unknown} options */
function getConfig(options) {
  if (typeof options !== 'object') {
    logInitError(`Invalid options type: Expected an object, got ${typeof options}`)
    return
  }

  const maybeConfig = ConfigSchema.safeParse(options)
  if (maybeConfig.success) {
    return maybeConfig.data
  }

  const validationError = fromZodError(maybeConfig.error, {
    prefix: 'Invalid options',
  })

  logInitError(validationError.message)
}

module.exports = { getConfig, loadEnv }
