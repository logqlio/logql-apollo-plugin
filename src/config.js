const { z } = require('zod')
const { fromZodError } = require('zod-validation-error')

const Config = z.object({
  apiKey: z.string().startsWith('logql:'),
  projectId: z.string().uuid(),
  timeout: z.number().min(0).default(15000),
  sendVariables: z.boolean().default(false),
  sendHeaders: z.boolean().default(false),
  reportIntervalMs: z.number().min(0).default(10000),
  reportEntriesThreshold: z.number().min(1).default(1024),
  sampling: z.number().min(0).max(1).default(1),
  endpoint: z.string().url().default('https://ingress.logql.io'),
})

function getConfig(options) {
  try {
    return Config.parse(options)
  } catch (err) {
    const validationError = fromZodError(err, {
      prefix: 'Failed to initialize logql plugin due to invalid options',
    })
    if (process.env.NODE_ENV !== 'test') {
      console.error(`logql-plugin: ${validationError.message}`)
    }
    throw Error(`LogQLPluginInitError: ${validationError.message}`, { cause: err })
  }
}

module.exports = { getConfig }
