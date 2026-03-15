import type { ApolloServerPlugin, BaseContext } from '@apollo/server'

/** A fetch-compatible function. Defaults to `globalThis.fetch`. */
export type FetchFunction = (url: string, init?: RequestInit) => Promise<Pick<Response, 'status'>>

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

  fetchFn?: FetchFunction

  userId?: ((context: TContext, headers: unknown, requestContext: unknown) => unknown) | null
}

declare function LogqlApolloPlugin<TContext extends BaseContext = BaseContext>(
  options?: LogqlOptions<TContext>
): ApolloServerPlugin<BaseContext>

declare namespace LogqlApolloPlugin {
  function fromEnv(): ApolloServerPlugin<BaseContext>
}

export = LogqlApolloPlugin
