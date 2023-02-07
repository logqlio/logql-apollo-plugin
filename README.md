# Logql plugin for apollo-server

Collect and send metrics, errors and schema changes to logql.io.

## Installation

```sh
npm i @logql/apollo-plugin
```

OR

```sh
yarn install @logql/apollo-plugin
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
      apiKey: <Your-LogQL-API-Key>,
      projectId: <Your-LogQL-ProjectId>,
    }),
  ],
})
```
