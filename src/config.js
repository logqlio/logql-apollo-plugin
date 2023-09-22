// @ts-check
const { cleanEnv, str, num, bool, url } = require('envalid')
const { z } = require('zod')
const { fromZodError } = require('zod-validation-error')

const ConfigSchema = z.object({
  apiKey: z.string().startsWith('logql:'),
  environment: z.string().trim().toLowerCase().max(128).default(''),
  timeout: z.number().min(0).default(15000),
  sendVariables: z.boolean().default(false),
  sendHeaders: z.boolean().default(false),
  runInTests: z.boolean().default(false),
  reportIntervalMs: z.number().min(0).default(10000),
  reportEntriesThreshold: z.number().min(1).default(1024),
  cacheSize: z.number().min(1).default(16384),
  endpoint: z.string().url().default('https://ingress.logql.io'),
})

/**
 * @typedef {z.infer<typeof ConfigSchema>} Config
 */

/**
 * @param {string} msg
 */
function logInitError(msg) {
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[logql-plugin][ERROR][init] ${msg}`)
  }
}

/**
 * @param {string} msg
 */
function logInitWarning(msg) {
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[logql-plugin][WARNING][init] ${msg}`)
  }
}

function loadEnv() {
  try {
    return cleanEnv(
      {
        apiKey: process.env.LOGQL_API_KEY,
        environment: process.env.LOGQL_ENVIRONMENT,
        timeout: process.env.LOGQL_TIMEOUT,
        sendVariables: process.env.LOGQL_SEND_VARIABLES,
        sendHeaders: process.env.LOGQL_SEND_HEADERS,
        runInTests: process.env.LOGQL_RUN_IN_TESTS,
        reportIntervalMs: process.env.LOGQL_REPORT_INTERVAL_MS,
        reportEntriesThreshold: process.env.LOGQL_REPORT_ENTRIES_THRESHOLD,
        cacheSize: process.env.LOGQL_CACHE_SIZE,
        endpoint: process.env.LOGQL_ENDPOINT,
      },
      {
        apiKey: str({ default: undefined }),
        environment: str({ default: undefined }),
        timeout: num({ default: undefined }),
        sendVariables: bool({ default: undefined }),
        sendHeaders: bool({ default: undefined }),
        runInTests: bool({ default: undefined }),
        reportIntervalMs: num({ default: undefined }),
        reportEntriesThreshold: num({ default: undefined }),
        cacheSize: num({ default: undefined }),
        endpoint: url({ default: undefined }),
      },
      {
        // Mute the errors
        reporter: ({ errors }) => {
          const errorKeys = Object.keys(errors)
          if (errorKeys.length) {
            logInitWarning(
              `Invalid values supplied as environment variables, ignoring: ${errorKeys
                .map((envVar) => `${envVar}: ${errors[`${envVar}`].message}`)
                .join(';')}`
            )
          }
        },
      }
    )
  } catch (err) {
    logInitError(`Failed to load config from environment variables: ${err.message}`)
  }
}

/**
 * @param {unknown} options
 */
function getConfig(options) {
  if (typeof options !== 'object') {
    logInitError(`Invalid options type: Expected an object, got ${typeof options}`)
    return
  }

  const env = loadEnv()
  if (!env) {
    return
  }

  const maybeConfig = ConfigSchema.safeParse({ ...env, ...options })
  if (maybeConfig.success) {
    return maybeConfig.data
  }

  const validationError = fromZodError(maybeConfig.error, {
    prefix: 'Invalid options',
  })

  logInitError(validationError.message)
}

module.exports = { getConfig }
