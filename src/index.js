const { createHash } = require('crypto')
const { printSchema, responsePathAsArray } = require('graphql')
const LRUCache = require('lru-cache')

const { getConfig } = require('./config')
const { json, text, sendWithRetry } = require('./client')

async function sendSchema(schema, schemaHash, config, logger) {
  return await sendWithRetry(`schemas/${schemaHash}`, text(schema), config, logger)
}

async function sendError(errors, schemaHash, requestContext, config, logger) {
  const { sendVariables, sendHeaders } = config
  const { source, queryHash, request, metrics, operationName, operation } = requestContext
  const { http } = request
  const variables = sendVariables ? request.variables : Object.create(null)
  const headers = sendHeaders ? Object.fromEntries(http.headers) : Object.create(null)
  const payload = {
    schemaHash,
    client: {
      name: http.headers.get('apollographql-client-name'),
      version: http.headers.get('apollographql-client-version'),
    },
    request: {
      headers,
      method: http.method,
      search: http.search,
    },
    operation: {
      source,
      queryHash,
      operationName,
      operationType: operation && operation.operation,
      variables,
    },
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

async function sendReport(report, config, logger) {
  // Don't send anything if the report is empty
  if (!Object.keys(report.operations).length) {
    return
  }
  return await sendWithRetry('metrics', json(report), config, logger)
}

async function sendOperation(syncedQueries, schemaHash, profile, requestContext, config, logger) {
  const { source, queryHash, operationName, operation } = requestContext
  if (!syncedQueries.has(queryHash)) {
    syncedQueries.add(queryHash)
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

function getDuration(startTime) {
  const [seconds, nanos] = process.hrtime(startTime)
  return seconds * 1e9 + nanos
}

function pathAsString(resolver) {
  return resolver.path.map((field) => (typeof field === 'number' ? 0 : field)).join('.')
}

function LogqlApolloPlugin(options = Object.create(null)) {
  // Do nothing when plugin is disabled
  if (options.disable) {
    return {}
  }

  const config = getConfig(options)
  const syncedQueries = new Set()

  let schemaHash
  let report
  let reportTimer
  let reportEntriesCount = 0

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

  function sendReportAndResetTimer(logger) {
    sendReportAndStopTimer(logger)
    report = { schemaHash, operations: Object.create(null) }
    reportTimer = setInterval(() => {
      if (report) {
        sendReport(report, config, logger).catch((err) => logger.error(`logql-plugin: Failed to send metrics: ${err}`))
        report = { schemaHash, operations: Object.create(null) }
        reportEntriesCount = 0
      }
    }, config.reportIntervalMs)
  }

  return {
    serverWillStart({ logger }) {
      return {
        schemaDidLoadOrUpdate({ apiSchema, coreSupergraphSdl }) {
          const schema = coreSupergraphSdl ? coreSupergraphSdl : printSchema(apiSchema)
          schemaHash = createHash('sha256').update(schema).digest('hex')
          sendReportAndResetTimer(logger)
          sendSchema(schema, schemaHash, config, logger)
        },
        serverWillStop() {
          sendReportAndStopTimer(logger)
        },
      }
    },

    requestDidStart({ logger }) {
      // See https://stackoverflow.com/questions/18031839/how-to-use-process-hrtime-to-get-execution-time-of-async-function
      const requestStartTime = process.hrtime()
      const profile = {
        receivedAt: new Date().toISOString(),
        resolvers: [],
      }

      function requestWillBeSent(requestContext) {
        if (!report) {
          // Added in case a request is processed after the server stopped - should never happen
          /* istanbul ignore next */
          return
        }

        const { queryHash } = requestContext
        if (queryHash) {
          const duration = getDuration(requestStartTime)
          const hasError = !!requestContext.errors
          if (!(queryHash in report.operations)) {
            report.operations[`${queryHash}`] = { count: 0, duration: 0, errors: 0, resolvers: {} }
            reportEntriesCount++
          }
          const operation = report.operations[`${queryHash}`]
          operation.count++
          operation.errors += hasError ? 1 : 0
          operation.duration += Math.round((duration - operation.duration) / operation.count)

          for (const resolver of profile.resolvers) {
            const key = pathAsString(resolver)
            const duration = resolver.end - resolver.start
            if (!(key in operation.resolvers)) {
              operation.resolvers[`${key}`] = { count: 0, duration: 0, errors: 0 }
              reportEntriesCount++
            }
            const rs = operation.resolvers[`${key}`]
            rs.count++
            rs.errors += resolver.error ? 1 : 0
            rs.duration += Math.round((duration - rs.duration) / rs.count)
          }

          if (reportEntriesCount > config.reportEntriesThreshold) {
            sendReportAndResetTimer(logger)
          }
        }
      }

      return {
        parsingDidStart() {
          profile.parsingStart = getDuration(requestStartTime)
          return () => {
            profile.parsingEnd = getDuration(requestStartTime)
          }
        },
        validationDidStart() {
          profile.validationStart = getDuration(requestStartTime)
          return () => {
            profile.validationEnd = getDuration(requestStartTime)
          }
        },
        executionDidStart() {
          profile.executionStart = getDuration(requestStartTime)
          return {
            executionDidEnd() {
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
        willSendResponse(requestContext) {
          if (requestContext.errors) {
            sendError(requestContext.errors, schemaHash, requestContext, config, logger)
          } else {
            sendOperation(syncedQueries, schemaHash, profile, requestContext, config, logger)
          }
          requestWillBeSent(requestContext)
        },
      }
    },
  }
}

module.exports = LogqlApolloPlugin
