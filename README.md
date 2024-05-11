# Logql plugin for apollo-server

Collect and send metrics, errors and schema changes to logql.io.

## Installation

```sh
npm i @logql/apollo-plugin
```

OR

```sh
yarn add @logql/apollo-plugin
```

## Usage

```js
const logql = require('@logql/apollo-plugin')

// ...

const logqlPlugin = logql({ apiKey: 'logql:your-api-key' })

// or using environment variables for config:

const logqlPlugin = logql.fromEnv()

const apolloServer = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [logqlPlugin],
})
```
