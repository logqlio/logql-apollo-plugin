// @ts-check
const { createHash } = require('crypto')
const { printSchema, responsePathAsArray } = require('graphql')
const { LRUCache } = require('lru-cache')

const { getConfig } = require('./config')
const { json, text, sendWithRetry } = require('./client')

/**
 * @typedef {import('./config').Config} Config
 * @typedef {import('@apollo/utils.logger').Logger} Logger
 * @typedef {import('@apollo/server').GraphQLRequestContextWillSendResponse<*>} RequestContext
 *
 * @typedef {Object} Resolver
 * @property {(string | number)[]} path
 * @property {number} start
 * @property {number} [end]
 * @property {boolean} [error]
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
 * @param {*} errors
 * @param {string} schemaHash
 * @param {Profile} profile
 * @param {RequestContext} requestContext
 * @param {Config} config
 * @param {Logger} logger
 */
async function sendError(errors, schemaHash, profile, requestContext, config, logger) {
  const { sendVariables, sendHeaders } = config
  const { source, queryHash, request, metrics, operationName, operation } = requestContext
  const { http } = request
  const variables = sendVariables ? request.variables : Object.create(null)
  const headers = sendHeaders && http?.headers ? Object.fromEntries(http.headers) : Object.create(null)
  const payload = {
    schemaHash,
    client: {
      name: http?.headers.get('apollographql-client-name'),
      version: http?.headers.get('apollographql-client-version'),
    },
    request: {
      headers,
      method: http?.method,
      search: http?.search,
      variables,
    },
    operation: {
      source,
      queryHash,
      operationName,
      operationType: operation && operation.operation,
    },
    profile,
    metrics,
    errors: errors.map((err) => ({
      ...err,
      message: err.message,
      stackTrace: err.stack,
      path: err.path,
    })),
  }

  return await sendWithRetry('errors', json(payload), config, logger)
}

/**
 * @param {*} reportMap
 * @param {Config} config
 * @param {Logger} logger
 */
async function sendReport(reportMap, config, logger) {
  const operationEntries = Object.entries(reportMap.operations)

  // Don't send anything if the report is empty
  if (operationEntries.length === 0) {
    return
  }

  // Transform the report from a key/value format to array
  const report = {
    ...reportMap,
    operations: operationEntries.map(([queryHash, operation]) => ({
      ...operation,
      queryHash,
      resolvers: Object.entries(operation.resolvers).map(([path, resolver]) => ({ ...resolver, path })),
      clients: Object.entries(operation.clients).map(([name, client]) => ({ ...client, name })),
    })),
  }
  return await sendWithRetry('metrics', json(report), config, logger)
}

/**
 * @param {LRUCache<string, string>} syncedQueries
 * @param {string} schemaHash
 * @param {*} profile
 * @param {RequestContext} requestContext
 * @param {Config} config
 * @param {Logger} logger
 */
async function sendOperation(syncedQueries, schemaHash, profile, requestContext, config, logger) {
  const { source, queryHash, operationName, operation } = requestContext
  if (!syncedQueries.has(queryHash)) {
    syncedQueries.set(queryHash, queryHash)
    const data = {
      schemaHash,
      operations: [
        {
          queryHash,
          source,
          operationName,
          operationType: operation && operation.operation,
          paths: profile.resolvers.map(pathAsString),
        },
      ],
    }
    const success = await sendWithRetry('operations', json(data), config, logger)
    if (!success) {
      syncedQueries.delete(queryHash)
    }
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
 * @param {Partial<Config>} options
 * @returns {import('@apollo/server').ApolloServerPlugin}
 */

function LogqlApolloPlugin(options = Object.create(null)) {
  const config = getConfig(options)

  /** @type {LRUCache<string, string>} */
  const syncedQueries = new LRUCache({ max: config.cacheSize })

  /** @type {string} */
  let schemaHash
  let report
  let reportTimer
  let reportEntriesCount = 0

  /**
   * @param {Logger} logger
   */
  function sendReportAndStopTimer(logger) {
    if (reportTimer) {
      clearInterval(reportTimer)
      reportTimer = null
    }
    if (report) {
      sendReport(report, config, logger).catch((err) => logger.error(`logql-plugin: Failed to send metrics: ${err}`))
      report = null
      reportEntriesCount = 0
    }
  }

  /**
   * @param {Logger} logger
   */
  function sendReportAndResetTimer(logger) {
    sendReportAndStopTimer(logger)
    report = { schemaHash, operations: Object.create(null) }
    reportTimer = setInterval(() => {
      /* istanbul ignore else */
      if (report) {
        sendReport(report, config, logger).catch((err) => logger.error(`logql-plugin: Failed to send metrics: ${err}`))
        report = { schemaHash, operations: Object.create(null) }
        reportEntriesCount = 0
      }
    }, config.reportIntervalMs)
  }

  return {
    async serverWillStart({ logger }) {
      return {
        schemaDidLoadOrUpdate({ apiSchema, coreSupergraphSdl }) {
          const schema = coreSupergraphSdl ? coreSupergraphSdl : printSchema(apiSchema)
          schemaHash = createHash('sha256').update(schema).digest('hex')
          sendReportAndResetTimer(logger)
          sendSchema(schema, schemaHash, config, logger)
        },
        async serverWillStop() {
          sendReportAndStopTimer(logger)
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
      function requestWillBeSent(requestContext) {
        const duration = getDuration(requestStartTime)
        profile.requestEnd = duration

        /* istanbul ignore if */
        if (!report) {
          // Added in case a request is processed after the server stopped - should never happen
          return
        }

        const { queryHash, request } = requestContext
        /* istanbul ignore else */
        if (queryHash) {
          const hasError = !!requestContext.errors
          if (!(queryHash in report.operations)) {
            report.operations[`${queryHash}`] = { count: 0, duration: 0, errors: 0, resolvers: {}, clients: {} }
            reportEntriesCount++
          }
          const operation = report.operations[`${queryHash}`]
          operation.count++
          operation.errors += hasError ? 1 : 0
          operation.duration += Math.round((duration - operation.duration) / operation.count)

          const clientName = request.http?.headers.get('apollographql-client-name')
          if (clientName) {
            if (!(clientName in operation.clients)) {
              operation.clients[`${clientName}`] = { count: 0, duration: 0, errors: 0 }
            }
            const client = operation.clients[`${clientName}`]
            client.count++
            client.errors += hasError ? 1 : 0
            client.duration += Math.round((duration - operation.duration) / operation.count)
          }

          for (const resolver of profile.resolvers) {
            const key = pathAsString(resolver)
            const duration = (resolver.end || getDuration(requestStartTime)) - resolver.start
            if (!(key in operation.resolvers)) {
              operation.resolvers[`${key}`] = { count: 0, duration: 0, errors: 0 }
              reportEntriesCount++
            }
            const rs = operation.resolvers[`${key}`]
            rs.count++
            rs.errors += resolver.error ? 1 : 0
            rs.duration += Math.round((duration - rs.duration) / rs.count)
          }

          // istanbul ignore if
          if (reportEntriesCount > config.reportEntriesThreshold) {
            sendReportAndResetTimer(logger)
          }
        }
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
              const resolver = {
                path: responsePathAsArray(info.path),
                start: getDuration(requestStartTime),
              }
              profile.resolvers.push(resolver)

              return function didResolveField(error) {
                resolver.end = getDuration(requestStartTime)
                resolver.error = !!error
              }
            },
          }
        },
        async willSendResponse(requestContext) {
          requestWillBeSent(requestContext)
          if (requestContext.errors) {
            sendError(requestContext.errors, schemaHash, profile, requestContext, config, logger)
          } else {
            sendOperation(syncedQueries, schemaHash, profile, requestContext, config, logger)
          }
        },
      }
    },
  }
}

module.exports = LogqlApolloPlugin
