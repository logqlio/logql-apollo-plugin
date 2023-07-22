// @ts-check
const { cleanEnv, str, num, bool, url } = require('envalid')
const { z } = require('zod')
const { fromZodError } = require('zod-validation-error')

const ConfigSchema = z.object({
  apiKey: z.string().startsWith('logql:'),
  environment: z.string().trim().toLowerCase().max(128),
  timeout: z.number().min(0),
  sendVariables: z.boolean(),
  sendHeaders: z.boolean(),
  reportIntervalMs: z.number().min(0),
  reportEntriesThreshold: z.number().min(1),
  endpoint: z.string().url(),
})

/**
 * @typedef {z.infer<typeof ConfigSchema>} Config
 */

/**
 * @param {unknown} options
 */
function getConfig(options) {
  if (typeof options !== 'object') {
    throw Error(`LogQLPluginInitError: Invalid options: Expected an object, got ${typeof options}`)
  }
  try {
    const env = cleanEnv(
      {
        apiKey: process.env.LOGQL_API_KEY,
        environment: process.env.LOGQL_ENVIRONMENT,
        timeout: process.env.LOGQL_TIMEOUT,
        sendVariables: process.env.LOGQL_SEND_VARIABLES,
        sendHeaders: process.env.LOGQL_SEND_HEADERS,
        reportIntervalMs: process.env.LOGQL_REPORT_INTERVAL_MS,
        reportEntriesThreshold: process.env.LOGQL_REPORT_ENTRIES_THRESHOLD,
        endpoint: process.env.LOGQL_ENDPOINT,
      },
      {
        apiKey: str({ default: undefined }),
        environment: str({ default: '' }),
        timeout: num({ default: 15000 }),
        sendVariables: bool({ default: false }),
        sendHeaders: bool({ default: false }),
        reportIntervalMs: num({ default: 10000 }),
        reportEntriesThreshold: num({ default: 1024 }),
        endpoint: url({ default: 'https://ingress.logql.io' }),
      },
      {
        // Mute the errors
        reporter: () => {},
      }
    )
    return ConfigSchema.parse({ ...env, ...options })
  } catch (err) {
    const validationError = fromZodError(err, {
      prefix: 'Failed to initialize logql plugin due to invalid options',
    })
    /* istanbul ignore if */
    if (process.env.NODE_ENV !== 'test') {
      console.error(`logql-plugin: ${validationError.message}`)
    }
    throw Error(`LogQLPluginInitError: ${validationError.message}`)
  }
}

module.exports = { getConfig }
