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

/** @param {string | undefined} str */
function Bool(str) {
  if (str == null) return undefined
  const num = Number(str)
  return Number.isSafeInteger(num) ? Boolean(num) : str === 'true' || str === 't'
}

/** @param {string | undefined} str */
function Num(str) {
  if (str == null) return undefined
  const num = Number(str)
  if (Number.isNaN(num)) {
    logInitError(`Invalid environment variable: Expected a number, got ${str}`)
  }
  return num
}

function loadEnv() {
  const config = {
    apiKey: process.env.LOGQL_API_KEY,
    environment: process.env.LOGQL_ENVIRONMENT,
    endpoint: process.env.LOGQL_ENDPOINT,

    sendVariables: Bool(process.env.LOGQL_SEND_VARIABLES),
    sendHeaders: Bool(process.env.LOGQL_SEND_HEADERS),
    runInTests: Bool(process.env.LOGQL_RUN_IN_TESTS),
    verbose: Bool(process.env.LOGQL_VERBOSE),

    timeout: Num(process.env.LOGQL_TIMEOUT),
    reportIntervalMs: Num(process.env.LOGQL_REPORT_INTERVAL_MS),
    reportEntriesThreshold: Num(process.env.LOGQL_REPORT_ENTRIES_THRESHOLD),
    cacheSize: Num(process.env.LOGQL_CACHE_SIZE),
    sampling: Num(process.env.LOGQL_SAMPLING),
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
