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
const Logql = require('@logql/apollo-plugin')

// ...

const apolloServer = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [
    Logql({
      apiKey: 'logql:your-api-key,
    }),
  ],
})
```

Or using environment variables:

```sh
LOGQL_API_KEY=logql:your-api-key node .
```
