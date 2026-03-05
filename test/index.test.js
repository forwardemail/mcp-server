const test = require('node:test');
const assert = require('node:assert');
const {spawn} = require('node:child_process');
const path = require('node:path');

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

    child.stderr.once('data', (data) => {
      clearTimeout(timer);
      reject(new Error(`CLI Error: ${data.toString()}`));
    });
  });

  child.stdin.write(JSON.stringify(request) + '\n');
  return responsePromise;
};

test('MCP Server', async (t) => {
  await t.test('listTools returns all tools', async () => {
    const child = runCli();
    try {
      const response = await sendRequest(child, {id: '1', type: 'listTools'});

      assert.strictEqual(response.type, 'toolResponse');
      assert.strictEqual(response.id, '1');
      assert(Array.isArray(response.tools));

      const names = new Set(response.tools.map((tool) => tool.name));

      // Should have 68 tools (all API endpoints except WebSocket)
      assert(
        response.tools.length >= 60,
        `Expected >= 60 tools, got ${response.tools.length}`,
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
      const response = await sendRequest(child, {
        id: '2',
        type: 'invokeTool',
        name: 'unknownTool',
        arguments: {},
      });

      assert.strictEqual(response.type, 'error');
      assert.strictEqual(response.id, '2');
      assert.strictEqual(response.message, 'Tool not found: unknownTool');
    } finally {
      killChild(child);
    }
  });

  await t.test('unknown request type returns error', async () => {
    const child = runCli();
    try {
      const response = await sendRequest(child, {
        id: '3',
        type: 'unknownType',
      });

      assert.strictEqual(response.type, 'error');
      assert.strictEqual(response.id, '3');
      assert(response.message.includes('Unknown request type'));
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
        const response = await sendRequest(child, {
          id: 'alias-inputs',
          type: 'listTools',
        });

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
          const tool = response.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);
          assert(
            tool.input.properties.alias_username,
            `${toolName} missing alias_username input`,
          );
          assert(
            tool.input.properties.alias_password,
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
        const response = await sendRequest(child, {
          id: 'both-inputs',
          type: 'listTools',
        });

        const bothAuthTools = ['getAccount', 'updateAccount', 'sendEmail'];

        for (const toolName of bothAuthTools) {
          const tool = response.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);
          assert(
            tool.input.properties.alias_username,
            `${toolName} missing alias_username input`,
          );
          assert(
            tool.input.properties.alias_password,
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
        const response = await sendRequest(child, {
          id: 'apikey-inputs',
          type: 'listTools',
        });

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
          const tool = response.tools.find((t) => t.name === toolName);
          assert(tool, `Tool ${toolName} not found`);
          assert(
            !tool.input.properties.alias_username,
            `${toolName} should NOT have alias_username input`,
          );
          assert(
            !tool.input.properties.alias_password,
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
        const response = await sendRequest(child, {
          id: name,
          type: 'invokeTool',
          name: toolName,
          arguments: arguments_,
        });

        assert.strictEqual(response.type, 'error');
        assert.strictEqual(response.id, name);
        assert(typeof response.message === 'string');
        assert(response.message.length > 0);
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
        const response = await sendRequest(child, {
          id: 'alias-env',
          type: 'invokeTool',
          name: 'listMessages',
          arguments: {folder: 'INBOX'},
        });

        // Should get an auth error (not a "Basic authentication required" error)
        assert.strictEqual(response.type, 'error');
        assert.strictEqual(response.id, 'alias-env');
        assert(typeof response.message === 'string');
        assert(response.message.length > 0);
        // The error should NOT be "Basic authentication required" since we sent Basic auth
        assert(
          !response.message.includes('Basic authentication required'),
          'Should use Basic auth from env vars, not Bearer',
        );
      } finally {
        killChild(child);
      }
    },
  );

  // Encrypt endpoint doesn't require auth, so test for success
  await t.test('encryptRecord returns a result', async () => {
    const child = runCli({FORWARD_EMAIL_API_KEY: 'test-key'});
    try {
      const response = await sendRequest(child, {
        id: 'encrypt',
        type: 'invokeTool',
        name: 'encryptRecord',
        arguments: {input: 'test'},
      });

      assert.strictEqual(response.type, 'toolResponse');
      assert.strictEqual(response.id, 'encrypt');
      assert(typeof response.result === 'string');
      assert(response.result.startsWith('forward-email='));
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
        const response = await sendRequest(child, {
          id: 'basic-auth-test',
          type: 'invokeTool',
          name: 'getAccount',
          arguments: {},
        });

        // Should get "Invalid API token" (meaning Basic auth was accepted)
        // NOT "Authentication is required" (which means Bearer was sent)
        assert.strictEqual(response.type, 'error');
        assert(
          response.message.includes('Invalid API token'),
          `Expected "Invalid API token" error from Basic auth, got: "${response.message}"`,
        );
      } finally {
        killChild(child);
      }
    },
  );
});
