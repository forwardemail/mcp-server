#!/usr/bin/env node
const {McpServer} = require('../lib/index.js');

const server = new McpServer();
server.listen().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
