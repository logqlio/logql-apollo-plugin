// @ts-check
const { promisify } = require('util')
const { gzip } = require('zlib')
const { randomUUID } = require('crypto')
const os = require('os')
const retry = require('async-retry')
const fetch = require('node-fetch')

const plugin = require('../package.json')

const compress = promisify(gzip)

const userAgent = `logql-apollo-plugin; node ${process.version}; ${os.platform()} ${os.release()}`

/**
 * @typedef {{contentType: string; body: string}} Data
 */

/**
 * @param {Record<string, unknown>} input
 * @returns {Data}
 */
function json(input) {
  return {
    contentType: 'application/json',
    body: JSON.stringify(input),
  }
}

/**
 * @param {string} input
 * @returns {Data}
 */
function text(input) {
  return {
    contentType: 'text/plain',
    body: input,
  }
}

/**
 * @param {string} path
 * @param {Data} data
 * @param {import('./config').Config} config
 * @param {import('@apollo/utils.logger').Logger} logger
 */
async function sendWithRetry(path, data, config, logger) {
  const { endpoint, apiKey, timeout, environment } = config
  const url = `${endpoint}/default/${path}`
  const requestId = randomUUID()

  try {
    const compressed = await compress(data.body)

    await retry(
      async (bail, attempt) => {
        const controller = new AbortController()
        const abortTimeout = setTimeout(() => controller.abort(), timeout)

        try {
          // @ts-ignore
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'user-agent': userAgent,
              'content-encoding': 'gzip',
              'content-type': data.contentType,
              'x-request-id': requestId,
              'x-attempt-count': attempt,
              'x-api-key': apiKey,
              'x-environment': environment,
              'x-plugin-name': plugin.name,
              'x-plugin-version': plugin.version,
            },
            body: compressed,
            signal: controller.signal,
          })

          if (res.status === 401 || res.status === 403) {
            bail(Error(`Failed to authenticate with status ${res.status} - path: ${path}`))
            return res
          }

          if (res.status === 413) {
            bail(Error(`Content too large: ${compressed.length} (${data.body.length}) uncompressed - path: ${path}`))
            return res
          }

          if (res.status >= 400 && res.status < 500) {
            throw Error(`Client error with status ${res.status} - path: ${path}`)
          }

          if (res.status >= 500 && res.status < 600) {
            throw Error(`Server error with status ${res.status} - path: ${path}`)
          }

          return res
        } finally {
          clearTimeout(abortTimeout)
        }
      },
      {
        retries: 3,
        minTimeout: 0,
        onRetry: (err) => {
          if (config.verbose) {
            logger.error(
              `[logql-plugin][ERROR][client] Retrying request url: ${url} - requestId: ${requestId} - error: ${err}`
            )
          }
        },
      }
    )
    return true
  } catch (err) {
    logger.error(`[logql-plugin][ERROR][client] request failed ${url}: ${err}`)
    return false
  }
}

module.exports = { json, text, sendWithRetry, compress }
