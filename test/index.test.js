const test = require('node:test');
const assert = require('node:assert');
const {spawn} = require('node:child_process');
const path = require('node:path');
const axios = require('axios');
const {getTools} = require('../lib/tools.js');

const cliPath = path.resolve(__dirname, '../bin/mcp-server.js');

// Spawn a child process for the MCP server CLI
const runCli = (env = {}) =>
  spawn(cliPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env, ...env},
  });

// Properly kill and clean up a child process to prevent hanging
const killChild = (child) => {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.kill('SIGKILL');
};

// Send a JSON-RPC request to the child and wait for a response.
// Buffers stdout data until a complete newline-delimited JSON line
// is received, which handles large responses that arrive in multiple
// chunks (e.g. macOS 16 KB pipe buffer vs ~25 KB listTools response).
const sendRequest = (child, request) => {
  const responsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('CLI response timed out'));
    }, 30_000);

    let buffer = '';

    const onData = (chunk) => {
      buffer += chunk.toString();
      // Check if we have a complete line (newline-delimited JSON)
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return; // Keep buffering

      clearTimeout(timer);
      child.stdout.removeListener('data', onData);

      const line = buffer.slice(0, newlineIndex);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`Failed to parse: ${line.slice(0, 200)}...`));
      }
    };

    child.stdout.on('data', onData);
  });

  child.stdin.write(JSON.stringify(request) + '\n');
  return responsePromise;
};

// Initialize the MCP server with the standard handshake.
// Returns the initialize response for verification if needed.
const initializeServer = async (child) => {
  const response = await sendRequest(child, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {name: 'test', version: '1.0.0'},
    },
  });

  // Send initialized notification (no response expected)
  child.stdin.write(
    JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) +
      '\n',
  );

  return response;
};

// Send a tools/list request
const listTools = async (child) => {
  const response = await sendRequest(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });

  return response.result;
};

// Send a tools/call request
const callTool = async (child, name, arguments_ = {}) => {
  const response = await sendRequest(child, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {name, arguments: arguments_},
  });

  return response.result;
};

test('MCP Server', async (t) => {
  await t.test('listTools returns all tools', async () => {
    const child = runCli();
    try {
      await initializeServer(child);
      const result = await listTools(child);

      assert(Array.isArray(result.tools));

      const names = new Set(result.tools.map((tool) => tool.name));

      // Should have 68 tools (all API endpoints except WebSocket)
      assert(
        result.tools.length >= 60,
        `Expected >= 60 tools, got ${result.tools.length}`,
      );

      // Spot-check key tools from each resource
      const expected = [
        'getAccount',
        'updateAccount',
        'downloadLogs',
        'listContacts',
        'createContact',
        'getContact',
        'listCalendars',
        'createCalendar',
        'listCalendarEvents',
        'createCalendarEvent',
        'listDomains',
        'createDomain',
        'getDomain',
        'updateDomain',
        'deleteDomain',
        'verifyDomainRecords',
        'verifySmtpRecords',
        'testS3Connection',
        'listCatchAllPasswords',
        'createCatchAllPassword',
        'deleteCatchAllPassword',
        'acceptDomainInvite',
        'createDomainInvite',
        'removeDomainInvite',
        'updateDomainMember',
        'removeDomainMember',
        'listAliases',
        'createAlias',
        'getAlias',
        'updateAlias',
        'deleteAlias',
        'generateAliasPassword',
        'listSieveScripts',
        'createSieveScript',
        'getSieveScript',
        'updateSieveScript',
        'deleteSieveScript',
        'activateSieveScript',
        'listSieveScriptsAliasAuth',
        'createSieveScriptAliasAuth',
        'listEmails',
        'sendEmail',
        'getEmailLimit',
        'getEmail',
        'deleteEmail',
        'listMessages',
        'createMessage',
        'getMessage',
        'updateMessage',
        'deleteMessage',
        'listFolders',
        'createFolder',
        'getFolder',
        'updateFolder',
        'deleteFolder',
        'encryptRecord',
      ];

      for (const name of expected) {
        assert(names.has(name), `Missing tool: ${name}`);
      }
    } finally {
      killChild(child);
    }
  });

  await t.test('unknown tool returns error', async () => {
    const child = runCli();
    try {
      await initializeServer(child);
      const result = await callTool(child, 'unknownTool', {});

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.content[0].text, 'Tool not found: unknownTool');
    } finally {
      killChild(child);
    }
  });

  await t.test('unknown method returns JSON-RPC error', async () => {
    const child = runCli();
    try {
      await initializeServer(child);
      const response = await sendRequest(child, {
        jsonrpc: '2.0',
        id: 3,
        method: 'unknownMethod',
        params: {},
      });

      assert(response.error, 'Expected JSON-RPC error response');
      assert(typeof response.error.message === 'string');
    } finally {
      killChild(child);
    }
  });

  //
  // Auth type verification
  //
  await t.test(
    'alias-auth tools expose alias_username and alias_password inputs',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);

        const aliasAuthTools = [
          'listContacts',
          'createContact',
          'getContact',
          'updateContact',
          'deleteContact',
          'listCalendars',
          'createCalendar',
          'getCalendar',
          'updateCalendar',
          'deleteCalendar',
          'listCalendarEvents',
          'createCalendarEvent',
          'getCalendarEvent',
          'updateCalendarEvent',
          'deleteCalendarEvent',
          'listMessages',
          'createMessage',
          'getMessage',
          'updateMessage',
          'deleteMessage',
          'listFolders',
          'createFolder',
          'getFolder',
          'updateFolder',
          'deleteFolder',
          'listSieveScriptsAliasAuth',
          'createSieveScriptAliasAuth',
          'getSieveScriptAliasAuth',
          'updateSieveScriptAliasAuth',
          'deleteSieveScriptAliasAuth',
          'activateSieveScriptAliasAuth',
        ];

        for (const toolName of aliasAuthTools) {
          const tool = result.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);
          assert(
            tool.inputSchema.properties.alias_username,
            `${toolName} missing alias_username input`,
          );
          assert(
            tool.inputSchema.properties.alias_password,
            `${toolName} missing alias_password input`,
          );
        }
      } finally {
        killChild(child);
      }
    },
  );

  await t.test(
    'both-auth tools expose alias_username and alias_password inputs',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);

        const bothAuthTools = ['getAccount', 'updateAccount', 'sendEmail'];

        for (const toolName of bothAuthTools) {
          const tool = result.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);
          assert(
            tool.inputSchema.properties.alias_username,
            `${toolName} missing alias_username input`,
          );
          assert(
            tool.inputSchema.properties.alias_password,
            `${toolName} missing alias_password input`,
          );
        }
      } finally {
        killChild(child);
      }
    },
  );

  await t.test(
    'apiKey-only tools do NOT expose alias credential inputs',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);

        const apiKeyOnlyTools = [
          'downloadLogs',
          'listDomains',
          'createDomain',
          'getDomain',
          'listAliases',
          'createAlias',
          'generateAliasPassword',
          'listSieveScripts',
          'listEmails',
          'getEmailLimit',
          'getEmail',
          'deleteEmail',
        ];

        for (const toolName of apiKeyOnlyTools) {
          const tool = result.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);
          assert(
            !tool.inputSchema.properties.alias_username,
            `${toolName} should NOT have alias_username input`,
          );
          assert(
            !tool.inputSchema.properties.alias_password,
            `${toolName} should NOT have alias_password input`,
          );
        }
      } finally {
        killChild(child);
      }
    },
  );

  // Helper for testing API calls that should fail with auth errors
  const testApiCall = async (name, toolName, arguments_) => {
    await t.test(`${name} returns API error with invalid key`, async () => {
      const child = runCli({FORWARD_EMAIL_API_KEY: 'test-key'});
      try {
        await initializeServer(child);
        const result = await callTool(child, toolName, arguments_);

        assert.strictEqual(result.isError, true);
        assert(typeof result.content[0].text === 'string');
        assert(result.content[0].text.length > 0);
      } finally {
        killChild(child);
      }
    });
  };

  // Test a representative tool from each resource group (API key auth)
  await testApiCall('account', 'getAccount', {});
  await testApiCall('domains', 'listDomains', {});
  await testApiCall('aliases', 'listAliases', {
    domain_id: 'example.com',
  });
  await testApiCall('emails', 'listEmails', {});

  // Test alias-auth tools with fake alias credentials
  await testApiCall('messages', 'listMessages', {
    folder: 'INBOX',
    alias_username: 'test@example.com',
    alias_password: 'fake-password',
  });
  await testApiCall('folders', 'listFolders', {
    alias_username: 'test@example.com',
    alias_password: 'fake-password',
  });
  await testApiCall('contacts', 'listContacts', {
    alias_username: 'test@example.com',
    alias_password: 'fake-password',
  });
  await testApiCall('calendars', 'listCalendars', {
    alias_username: 'test@example.com',
    alias_password: 'fake-password',
  });
  await testApiCall('calendar-events', 'listCalendarEvents', {
    alias_username: 'test@example.com',
    alias_password: 'fake-password',
  });

  // Test alias-auth tools via env var fallback
  await t.test(
    'alias-auth tools use FORWARD_EMAIL_ALIAS_USER env var',
    async () => {
      const child = runCli({
        FORWARD_EMAIL_ALIAS_USER: 'envtest@example.com',
        FORWARD_EMAIL_ALIAS_PASSWORD: 'env-fake-password',
      });
      try {
        await initializeServer(child);
        const result = await callTool(child, 'listMessages', {
          folder: 'INBOX',
        });

        // Should get an auth error (not a "Basic authentication required" error)
        assert.strictEqual(result.isError, true);
        assert(typeof result.content[0].text === 'string');
        assert(result.content[0].text.length > 0);
        // The error should NOT be "Basic authentication required" since we sent Basic auth
        assert(
          !result.content[0].text.includes('Basic authentication required'),
          'Should use Basic auth from env vars, not Bearer',
        );
      } finally {
        killChild(child);
      }
    },
  );

  //
  // Input schema verification
  //
  await t.test(
    'every tool has an inputSchema with type object and properties',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);

        for (const tool of result.tools) {
          assert(tool.inputSchema, `${tool.name} missing inputSchema`);
          assert.strictEqual(
            tool.inputSchema.type,
            'object',
            `${tool.name} inputSchema.type should be "object"`,
          );
          assert(
            tool.inputSchema.properties &&
              typeof tool.inputSchema.properties === 'object',
            `${tool.name} missing inputSchema.properties`,
          );
        }
      } finally {
        killChild(child);
      }
    },
  );

  await t.test('every tool has a required array in inputSchema', async () => {
    const child = runCli();
    try {
      await initializeServer(child);
      const result = await listTools(child);

      for (const tool of result.tools) {
        assert(
          Array.isArray(tool.inputSchema.required),
          `${tool.name} missing or non-array inputSchema.required`,
        );
      }
    } finally {
      killChild(child);
    }
  });

  await t.test(
    'tools with path params have those params in required',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);

        // Tools with known path params and their expected required path params
        const toolsWithPathParameters = {
          getDomain: ['domain_id'],
          updateDomain: ['domain_id'],
          deleteDomain: ['domain_id'],
          verifyDomainRecords: ['domain_id'],
          verifySmtpRecords: ['domain_id'],
          testS3Connection: ['domain_id'],
          listCatchAllPasswords: ['domain_id'],
          createCatchAllPassword: ['domain_id'],
          deleteCatchAllPassword: ['domain_id', 'token_id'],
          updateDomainMember: ['domain_id', 'member_id'],
          removeDomainMember: ['domain_id', 'member_id'],
          listAliases: ['domain_id'],
          createAlias: ['domain_id'],
          getAlias: ['domain_id', 'alias_id'],
          updateAlias: ['domain_id', 'alias_id'],
          deleteAlias: ['domain_id', 'alias_id'],
          generateAliasPassword: ['domain_id', 'alias_id'],
          listSieveScripts: ['domain_id', 'alias_id'],
          createSieveScript: ['domain_id', 'alias_id'],
          getSieveScript: ['domain_id', 'alias_id', 'script_id'],
          updateSieveScript: ['domain_id', 'alias_id', 'script_id'],
          deleteSieveScript: ['domain_id', 'alias_id', 'script_id'],
          activateSieveScript: ['domain_id', 'alias_id', 'script_id'],
          getContact: ['id'],
          updateContact: ['id'],
          deleteContact: ['id'],
          getCalendar: ['id'],
          updateCalendar: ['id'],
          deleteCalendar: ['id'],
          getCalendarEvent: ['id'],
          updateCalendarEvent: ['id'],
          deleteCalendarEvent: ['id'],
          getEmail: ['id'],
          deleteEmail: ['id'],
          getMessage: ['id'],
          updateMessage: ['id'],
          deleteMessage: ['id'],
          getFolder: ['id'],
          updateFolder: ['id'],
          deleteFolder: ['id'],
          getSieveScriptAliasAuth: ['script_id'],
          updateSieveScriptAliasAuth: ['script_id'],
          deleteSieveScriptAliasAuth: ['script_id'],
          activateSieveScriptAliasAuth: ['script_id'],
        };

        for (const [toolName, expectedParameters] of Object.entries(
          toolsWithPathParameters,
        )) {
          const tool = result.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);

          for (const parameter of expectedParameters) {
            assert(
              tool.inputSchema.properties[parameter],
              `${toolName} missing property definition for path param "${parameter}"`,
            );
            assert(
              tool.inputSchema.required.includes(parameter),
              `${toolName} should have "${parameter}" in required array`,
            );
          }
        }
      } finally {
        killChild(child);
      }
    },
  );

  await t.test(
    'tools with query params have those params in properties',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);

        // Spot-check: tools that have query params should have them as properties
        const toolsWithQueryParameters = {
          downloadLogs: ['domain', 'q'],
          listDomains: ['sort', 'page', 'limit'],
          listAliases: ['sort', 'page', 'limit'],
          listEmails: ['q', 'domain', 'sort', 'page', 'limit'],
          listMessages: ['folder', 'subject', 'q', 'metadata_only'],
          getMessage: ['eml', 'attachments'],
          listFolders: ['subscribed'],
        };

        for (const [toolName, expectedParameters] of Object.entries(
          toolsWithQueryParameters,
        )) {
          const tool = result.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);

          for (const parameter of expectedParameters) {
            assert(
              tool.inputSchema.properties[parameter],
              `${toolName} missing property definition for query param "${parameter}"`,
            );
          }
        }
      } finally {
        killChild(child);
      }
    },
  );

  await t.test(
    'listMessages exposes Anthropic result-size metadata and metadata_only input',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);
        const listMessagesTool = result.tools.find(
          (tool) => tool.name === 'listMessages',
        );

        assert(listMessagesTool, 'Tool listMessages not found');
        assert.strictEqual(
          listMessagesTool._meta['anthropic/maxResultSizeChars'],
          500_000,
        );
        assert.strictEqual(
          listMessagesTool.inputSchema.properties.metadata_only.type,
          'boolean',
        );
      } finally {
        killChild(child);
      }
    },
  );

  await t.test(
    'listMessages metadata_only strips body and attachment content',
    async () => {
      const originalCreate = axios.create;
      axios.create = () => ({
        get: async () => ({
          data: {
            results: [
              {
                id: 'msg_1',
                uid: 123,
                subject: 'Hello',
                from: [{address: 'sender@example.com'}],
                to: [{address: 'user@example.com'}],
                date: '2026-04-08T00:00:00.000Z',
                size: 42,
                has_attachment: true,
                flags: ['\\Seen'],
                folder: 'INBOX',
                text: 'hidden body',
                html: '<p>hidden body</p>',
                attachments: [{filename: 'secret.txt', content: 'hidden'}],
              },
            ],
          },
        }),
      });

      try {
        const tools = getTools();
        const result = await tools.listMessages.invoke({
          folder: 'INBOX',
          alias_username: 'test@example.com',
          alias_password: 'fake-password',
          metadata_only: true,
        });

        assert.deepStrictEqual(result, {
          results: [
            {
              id: 'msg_1',
              uid: 123,
              subject: 'Hello',
              from: [{address: 'sender@example.com'}],
              to: [{address: 'user@example.com'}],
              date: '2026-04-08T00:00:00.000Z',
              size: 42,
              has_attachment: true,
              flags: ['\\Seen'],
              folder: 'INBOX',
            },
          ],
        });
      } finally {
        axios.create = originalCreate;
      }
    },
  );

  await t.test(
    'listMessages automatically trims oversized results to metadata-only output',
    async () => {
      const originalCreate = axios.create;
      axios.create = () => ({
        get: async () => ({
          data: {
            results: [
              {
                id: 'msg_1',
                uid: 123,
                subject: 'Hello',
                from: [{address: 'sender@example.com'}],
                to: [{address: 'user@example.com'}],
                date: '2026-04-08T00:00:00.000Z',
                size: 42,
                has_attachment: true,
                flags: ['\\Seen'],
                folder: 'INBOX',
                text: 'x'.repeat(600_000),
                attachments: [
                  {
                    filename: 'secret.txt',
                    content: 'y'.repeat(10_000),
                  },
                ],
              },
            ],
          },
        }),
      });

      try {
        const tools = getTools();
        const result = await tools.listMessages.invoke({
          folder: 'INBOX',
          alias_username: 'test@example.com',
          alias_password: 'fake-password',
        });

        assert.deepStrictEqual(result, {
          results: [
            {
              id: 'msg_1',
              uid: 123,
              subject: 'Hello',
              from: [{address: 'sender@example.com'}],
              to: [{address: 'user@example.com'}],
              date: '2026-04-08T00:00:00.000Z',
              size: 42,
              has_attachment: true,
              flags: ['\\Seen'],
              folder: 'INBOX',
            },
          ],
        });
      } finally {
        axios.create = originalCreate;
      }
    },
  );

  await t.test('every property has a type and description', async () => {
    const child = runCli();
    try {
      await initializeServer(child);
      const result = await listTools(child);

      for (const tool of result.tools) {
        for (const [propertyName, propertyDefinition] of Object.entries(
          tool.inputSchema.properties,
        )) {
          assert(
            propertyDefinition.type,
            `${tool.name}.${propertyName} missing type`,
          );
          assert(
            propertyDefinition.description &&
              propertyDefinition.description.length > 0,
            `${tool.name}.${propertyName} missing or empty description`,
          );
        }
      }
    } finally {
      killChild(child);
    }
  });

  //
  // Body parameter schema verification for POST/PUT tools
  //
  await t.test(
    'POST/PUT tools have body parameter properties in their schemas',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);

        // Map of tool name -> expected body parameter names (at minimum)
        // Only includes tools whose body params are documented in the official API docs.
        const expectedBodyParameters = {
          // Account
          updateAccount: ['given_name', 'family_name'],

          // Domains
          createDomain: ['domain', 'plan'],
          updateDomain: ['smtp_port', 'has_adult_content_protection'],

          // Catch-all passwords
          createCatchAllPassword: ['new_password'],

          // Domain invites
          createDomainInvite: ['email', 'group'],

          // Domain members
          updateDomainMember: ['group'],

          // Aliases
          createAlias: ['name', 'recipients', 'description'],
          updateAlias: ['name', 'recipients', 'description'],

          // Alias password
          generateAliasPassword: ['new_password'],

          // Emails (SMTP)
          sendEmail: ['from', 'to', 'subject', 'text', 'html'],

          // Encrypt
          encryptRecord: ['input'],

          // Activate sieve scripts (alias auth) — POST but no body expected
          // activateSieveScript / activateSieveScriptAliasAuth — activation is path-only

          // Test S3 connection — POST but body params are domain-config level
          testS3Connection: [],
        };

        for (const [toolName, expectedParameters] of Object.entries(
          expectedBodyParameters,
        )) {
          const tool = result.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);

          for (const parameter of expectedParameters) {
            assert(
              tool.inputSchema.properties[parameter],
              `${toolName} missing body parameter "${parameter}" in inputSchema.properties`,
            );
            // Body params should have type and description
            assert(
              tool.inputSchema.properties[parameter].type,
              `${toolName}.${parameter} missing type`,
            );
            assert(
              tool.inputSchema.properties[parameter].description &&
                tool.inputSchema.properties[parameter].description.length > 0,
              `${toolName}.${parameter} missing or empty description`,
            );
          }
        }
      } finally {
        killChild(child);
      }
    },
  );

  await t.test(
    'tools with required body params include them in required array',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);

        // Tools where certain body params should be required
        const toolsWithRequiredBodyParameters = {
          createDomain: ['domain'],
          createDomainInvite: ['email', 'group'],
          updateDomainMember: ['group'],
          encryptRecord: ['input'],
        };

        for (const [toolName, requiredParameters] of Object.entries(
          toolsWithRequiredBodyParameters,
        )) {
          const tool = result.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);

          for (const parameter of requiredParameters) {
            assert(
              tool.inputSchema.required.includes(parameter),
              `${toolName} should have "${parameter}" in required array`,
            );
          }
        }
      } finally {
        killChild(child);
      }
    },
  );

  await t.test(
    'sendEmail has comprehensive email composition properties',
    async () => {
      const child = runCli();
      try {
        await initializeServer(child);
        const result = await listTools(child);

        const tool = result.tools.find((t) => t.name === 'sendEmail');
        assert(tool, 'sendEmail tool not found');

        const emailProperties = [
          'from',
          'to',
          'cc',
          'bcc',
          'subject',
          'text',
          'html',
          'attachments',
          'replyTo',
          'inReplyTo',
          'references',
        ];

        for (const property of emailProperties) {
          assert(
            tool.inputSchema.properties[property],
            `sendEmail missing "${property}" property`,
          );
        }
      } finally {
        killChild(child);
      }
    },
  );

  await t.test('createAlias has vacation responder properties', async () => {
    const child = runCli();
    try {
      await initializeServer(child);
      const result = await listTools(child);

      const tool = result.tools.find((t) => t.name === 'createAlias');
      assert(tool, 'createAlias tool not found');

      const vacationProperties = [
        'vacation_responder_is_enabled',
        'vacation_responder_message',
      ];

      for (const property of vacationProperties) {
        assert(
          tool.inputSchema.properties[property],
          `createAlias missing "${property}" property`,
        );
      }
    } finally {
      killChild(child);
    }
  });

  // Encrypt endpoint doesn't require auth, so test for success
  await t.test('encryptRecord returns a result', async () => {
    const child = runCli({FORWARD_EMAIL_API_KEY: 'test-key'});
    try {
      await initializeServer(child);
      const result = await callTool(child, 'encryptRecord', {input: 'test'});

      assert.strictEqual(result.isError, undefined);
      const {text} = result.content[0];
      assert(typeof text === 'string');
      assert(text.startsWith('forward-email='));
    } finally {
      killChild(child);
    }
  });

  // Test that API key auth uses Basic auth (not Bearer)
  await t.test(
    'API key auth sends Basic auth (not Bearer) for account endpoint',
    async () => {
      const child = runCli({FORWARD_EMAIL_API_KEY: 'test-basic-key'});
      try {
        await initializeServer(child);
        const result = await callTool(child, 'getAccount', {});

        // Should get "Invalid API token" (meaning Basic auth was accepted)
        // NOT "Authentication is required" (which means Bearer was sent)
        assert.strictEqual(result.isError, true);
        assert(
          result.content[0].text.includes('Invalid API token'),
          `Expected "Invalid API token" error from Basic auth, got: "${result.content[0].text}"`,
        );
      } finally {
        killChild(child);
      }
    },
  );
});
