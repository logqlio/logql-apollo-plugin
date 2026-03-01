// @ts-check
const { createHash } = require('crypto')
const { printSchema, responsePathAsArray } = require('graphql')
const { LRUCache } = require('lru-cache')

const { getConfig, loadEnv } = require('./config')
const { json, text, sendWithRetry } = require('./client')

/**
 * @typedef {import('./config').Config} Config
 * @typedef {import('@apollo/utils.logger').Logger} Logger
 * @typedef {import('@apollo/server').GraphQLRequestContextWillSendResponse<*>} RequestContext
 * @typedef {import('graphql').GraphQLError} GraphQLError
 *
 * @typedef {(string | number)[]} Path
 * @typedef {{ path: Path; start: number; end: number; error: boolean }} Resolver
 * @typedef {'synced' | 'pending'} SyncStatuses
 *
 * @typedef {Object} Profile
 * @property {string} receivedAt
 * @property {Resolver[]} resolvers
 * @property {number} [parsingStart]
 * @property {number} [parsingEnd]
 * @property {number} [validationStart]
 * @property {number} [validationEnd]
 * @property {number} [executionStart]
 * @property {number} [executionEnd]
 * @property {number} [requestEnd]
 */

/**
 * @param {string} schema
 * @param {string} schemaHash
 * @param {Config} config
 * @param {Logger} logger
 */
async function sendSchema(schema, schemaHash, config, logger) {
  return await sendWithRetry(`schemas/${schemaHash}`, text(schema), config, logger)
}

/**
 * @param {import('@apollo/server').HeaderMap | undefined} headers
 */
function getClient(headers) {
  if (!headers) {
    return {}
  }
  const name = headers.has('graphql-client-name')
    ? headers.get('graphql-client-name')
    : headers.get('apollographql-client-name')
  const version = headers.get('graphql-client-version')
    ? headers.get('graphql-client-version')
    : headers.get('apollographql-client-version')
  return { name, version }
}

/**
 * @param {Function} extractUserId
 * @param {RequestContext} requestContext
 * @param {Config} config
 * @param {Logger} logger
 */
async function getUserId(extractUserId, requestContext, config, logger) {
  try {
    const headers = requestContext.request.http?.headers
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('extractUserId timed out')), config.timeout)
      timer.unref()
    })
    const userId = await Promise.race([extractUserId(requestContext.contextValue, headers, requestContext), timeoutPromise])
    switch (typeof userId) {
      case 'string':
      case 'number':
      case 'bigint':
        return String(userId)
      default:
        return ''
    }
  } catch (err) {
    if (config.verbose) {
      logger.error(`[logql-plugin][ERROR][config] Cannot get userId from context - error: ${err}`)
    }
    return ''
  }
}

/**
 * @param {LRUCache<string, SyncStatuses>} syncedQueries
 * @param {readonly GraphQLError[] | undefined} errors
 * @param {string} schemaHash
 * @param {Profile} profile
 * @param {RequestContext} requestContext
 * @param {Config} config
 * @param {Logger} logger
 */
async function sendError(syncedQueries, errors, schemaHash, profile, requestContext, config, logger) {
  const { sendVariables, sendHeaders } = config
  const { source, queryHash, request, metrics, operationName, operation } = requestContext
  const { http } = request
  const variables = sendVariables ? request.variables : Object.create(null)
  const headers = sendHeaders && http?.headers ? Object.fromEntries(http.headers) : Object.create(null)
  const payload = {
    schemaHash,
    client: getClient(http?.headers),
    request: {
      headers,
      method: http?.method,
      search: http?.search,
      variables,
    },
    operation: {
      source: syncedQueries.get(queryHash) === 'synced' ? null : source,
      queryHash,
      operationName,
      operationType: operation && operation.operation,
    },
    profile,
    metrics,
    errors:
      errors &&
      errors.map((err) => ({
        ...err,
        message: err.message,
        stackTrace: err.stack,
        path: err.path,
      })),
  }

  if (config.userId) {
    payload.userId = await getUserId(config.userId, requestContext, config, logger)
  }

  const success = await sendWithRetry('errors', json(payload), config, logger)
  if (success) {
    syncedQueries.set(queryHash, 'synced')
  } else {
    syncedQueries.delete(queryHash)
  }
}

/**
 * @param {LRUCache<string, SyncStatuses>} syncedQueries
 * @param {string} schemaHash
 * @param {Profile} profile
 * @param {RequestContext} requestContext
 * @param {Config} config
 * @param {Logger} logger
 */
async function sendOperation(syncedQueries, schemaHash, profile, requestContext, config, logger) {
  const { source, queryHash, operationName, operation } = requestContext
  if (!syncedQueries.has(queryHash)) {
    syncedQueries.set(queryHash, 'pending')
    /** @type {Set<string>} */
    const pathsSet = new Set()
    for (const resolver of profile.resolvers) {
      pathsSet.add(pathAsString(resolver))
    }
    const data = {
      schemaHash,
      operations: [
        {
          queryHash,
          source,
          operationName,
          operationType: operation && operation.operation,
          paths: [...pathsSet],
        },
      ],
    }
    const success = await sendWithRetry('operations', json(data), config, logger)
    if (success) {
      syncedQueries.set(queryHash, 'synced')
    } else {
      syncedQueries.delete(queryHash)
    }
  }
}

/**
 * @param {Error} err
 * @param {string} action
 * @param {Config} config
 * @param {Logger} logger
 */
function handleError(err, action, config, logger) {
  if (config.verbose) {
    logger.error(`[logql-plugin][ERROR][collection] Failed to collect: ${action} - error: ${err}`)
  }
}

/**
 * @param {bigint} startTime
 */
function getDuration(startTime) {
  const endTime = process.hrtime.bigint()
  return Number((endTime - startTime) / 1000n)
}

/**
 * @param {Resolver} resolver
 */
function pathAsString(resolver) {
  return resolver.path.filter((item) => typeof item === 'string').join('.')
}

/**
 * @param {RequestContext} requestContext
 */
function isPersistedQueryNotFound({ request, source, errors }) {
  return errors && !source && request.http?.method === 'GET'
}

/**
 * @param {Partial<Config>} options
 * @returns {import('@apollo/server').ApolloServerPlugin<*>}
 */
function LogqlApolloPlugin(options = Object.create(null)) {
  const config = getConfig(options)

  // Disable if config was not loaded
  if (config == null) {
    return {}
  }

  // Disable in tests by default
  if (process.env.NODE_ENV === 'test' && !config.runInTests) {
    return {}
  }

  /** @type {LRUCache<string, SyncStatuses>} */
  const syncedQueries = new LRUCache({ max: config.cacheSize })

  /** @type {string} */
  let schemaHash

  return {
    async serverWillStart({ logger }) {
      return {
        schemaDidLoadOrUpdate({ apiSchema, coreSupergraphSdl }) {
          const schema = coreSupergraphSdl ? coreSupergraphSdl : printSchema(apiSchema)
          schemaHash = createHash('sha256').update(schema).digest('hex')
          sendSchema(schema, schemaHash, config, logger).catch((err) => handleError(err, 'schema', config, logger))
        },
      }
    },

    async requestDidStart({ logger }) {
      // See https://stackoverflow.com/questions/18031839/how-to-use-process-hrtime-to-get-execution-time-of-async-function
      const requestStartTime = process.hrtime.bigint()
      /** @type {Profile} */
      const profile = {
        receivedAt: new Date().toISOString(),
        resolvers: [],
      }

      /**
       * @param {RequestContext} requestContext
       */
      // eslint-disable-next-line no-unused-vars
      function requestWillBeSent(requestContext) {
        const duration = getDuration(requestStartTime)
        profile.requestEnd = duration
      }

      return {
        async parsingDidStart() {
          profile.parsingStart = getDuration(requestStartTime)
          return async () => {
            profile.parsingEnd = getDuration(requestStartTime)
          }
        },
        async validationDidStart() {
          profile.validationStart = getDuration(requestStartTime)
          return async () => {
            profile.validationEnd = getDuration(requestStartTime)
          }
        },
        async executionDidStart() {
          profile.executionStart = getDuration(requestStartTime)
          return {
            async executionDidEnd() {
              profile.executionEnd = getDuration(requestStartTime)
            },
            willResolveField({ info }) {
              const start = getDuration(requestStartTime)

              return function didResolveField(error) {
                const end = getDuration(requestStartTime)
                profile.resolvers.push({
                  path: responsePathAsArray(info.path),
                  error: !!error,
                  start,
                  end,
                })
              }
            },
          }
        },
        async willSendResponse(requestContext) {
          if (isPersistedQueryNotFound(requestContext)) {
            return
          }
          requestWillBeSent(requestContext)
          if (requestContext.errors || Math.random() < config.sampling) {
            sendError(syncedQueries, requestContext.errors, schemaHash, profile, requestContext, config, logger).catch(
              (err) => handleError(err, 'error', config, logger)
            )
          } else {
            sendOperation(syncedQueries, schemaHash, profile, requestContext, config, logger).catch((err) =>
              handleError(err, 'operation', config, logger)
            )
          }
        },
      }
    },
  }
}

LogqlApolloPlugin.fromEnv = function fromEnv() {
  return LogqlApolloPlugin(loadEnv())
}

module.exports = LogqlApolloPlugin
