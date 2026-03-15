import type { ApolloServerPlugin, BaseContext } from '@apollo/server'
import type * as http from 'http'
import type * as https from 'https'

export interface LogqlOptions<TContext = Record<string, unknown>> {
  apiKey: string
  environment?: string
  endpoint?: string

  sendVariables?: boolean
  sendHeaders?: boolean
  runInTests?: boolean
  verbose?: boolean

  timeout?: number
  reportIntervalMs?: number
  reportEntriesThreshold?: number
  cacheSize?: number

  sampling?: number

  agent?: http.Agent | https.Agent | null

  userId?: ((context: TContext, headers: unknown, requestContext: unknown) => unknown) | null
}

declare function LogqlApolloPlugin<TContext extends BaseContext = BaseContext>(
  options?: LogqlOptions<TContext>
): ApolloServerPlugin<BaseContext>

declare namespace LogqlApolloPlugin {
  function fromEnv(): ApolloServerPlugin<BaseContext>
}

export = LogqlApolloPlugin
