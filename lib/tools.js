const axios = require('axios');

const getTools = (options = {}) => {
  const baseURL =
    options.baseURL ||
    process.env.FORWARD_EMAIL_API_URL ||
    'https://api.forwardemail.net';
  const apiKey = options.apiKey || process.env.FORWARD_EMAIL_API_KEY;

  // Create an axios client for API-key-authenticated requests
  // (Basic auth: apiKey as username, empty password)
  const apiKeyClient = axios.create({
    baseURL,
    auth: apiKey ? {username: apiKey, password: ''} : undefined,
  });

  // Create an axios client for alias-authenticated requests
  // (Basic auth: alias email as username, generated password as password)
  const createAliasClient = (username, password) =>
    axios.create({
      baseURL,
      auth: {username, password},
    });

  // Default alias credentials from options or environment
  const defaultAliasUser =
    options.aliasUser || process.env.FORWARD_EMAIL_ALIAS_USER || '';
  const defaultAliasPassword =
    options.aliasPassword || process.env.FORWARD_EMAIL_ALIAS_PASSWORD || '';

  //
  // auth types:
  //   'apiKey'    – uses API key via Basic auth (username=apiKey, password='')
  //   'aliasAuth' – uses alias credentials via Basic auth
  //                 (username=alias email, password=generated password)
  //   'both'      – accepts either; uses alias credentials if provided,
  //                 otherwise falls back to API key
  //   'none'      – no authentication required
  //
  // Descriptions for well-known path parameters
  const pathParameterDescriptions = {
    domain_id: 'Domain ID or fully qualified domain name (e.g. "example.com")',
    alias_id: 'Alias ID',
    id: 'Resource ID',
    token_id: 'Token ID for the catch-all password',
    member_id: 'Member ID',
    script_id: 'Sieve script ID',
  };

  // Descriptions for well-known query parameters
  const queryParameterDescriptions = {
    sort: 'Sort field and direction (e.g. "created_at" or "-created_at" for descending)',
    page: 'Page number for pagination (1-based)',
    limit: 'Number of results per page',
    q: 'Search query string',
    domain: 'Domain name to filter by',
    bounce_category: 'Filter by bounce category',
    response_code: 'Filter by SMTP response code',
    always_send_email:
      'Whether to always send the log download via email (boolean)',
    is_scheduled: 'Filter by scheduled status (boolean)',
    folder: 'IMAP folder name (e.g. "INBOX", "Sent", "Drafts")',
    is_unread: 'Filter by unread status (boolean)',
    is_flagged: 'Filter by flagged status (boolean)',
    is_deleted: 'Filter by deleted status (boolean)',
    is_draft: 'Filter by draft status (boolean)',
    is_junk: 'Filter by junk/spam status (boolean)',
    is_copied: 'Filter by copied status (boolean)',
    is_encrypted: 'Filter by encrypted status (boolean)',
    is_searchable: 'Filter by searchable status (boolean)',
    is_expired: 'Filter by expired status (boolean)',
    has_attachments: 'Filter messages with attachments (boolean)',
    has_attachment: 'Filter messages with attachments (boolean)',
    subject: 'Filter by message subject',
    body: 'Search within message body',
    text: 'Full text search query',
    headers: 'Search within message headers',
    message_id: 'Filter by Message-ID header',
    search: 'IMAP SEARCH query string',
    since: 'Filter messages after this date (ISO 8601)',
    before: 'Filter messages before this date (ISO 8601)',
    min_size: 'Minimum message size in bytes',
    max_size: 'Maximum message size in bytes',
    from: 'Filter by sender address',
    to: 'Filter by recipient address',
    cc: 'Filter by CC address',
    bcc: 'Filter by BCC address',
    date: 'Filter by message date',
    'reply-to': 'Filter by Reply-To address',
    eml: 'Return raw EML format (boolean)',
    nodemailer: 'Return in Nodemailer-compatible format (boolean)',
    attachments: 'Include attachments in response (boolean)',
    raw: 'Return raw message source (boolean)',
    subscribed: 'Filter by subscription status (boolean)',
  };

  const LIST_MESSAGES_MAX_RESULT_SIZE_CHARS = 500_000;
  const LIST_MESSAGES_METADATA_FIELDS = [
    'id',
    'uid',
    'subject',
    'from',
    'to',
    'date',
    'size',
    'has_attachment',
    'has_attachments',
    'flags',
    'folder',
  ];
  const LIST_MESSAGES_COLLECTION_KEYS = [
    'results',
    'messages',
    'items',
    'data',
  ];

  const isTruthyBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;

    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  };

  const getListMessagesCollection = (result) => {
    if (Array.isArray(result)) {
      return {key: null, items: result};
    }

    if (!result || typeof result !== 'object') return null;

    for (const key of LIST_MESSAGES_COLLECTION_KEYS) {
      if (Array.isArray(result[key])) {
        return {key, items: result[key]};
      }
    }

    return null;
  };

  const toListMessageMetadata = (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return message;
    }

    const metadata = {};
    for (const field of LIST_MESSAGES_METADATA_FIELDS) {
      if (message[field] !== undefined) metadata[field] = message[field];
    }

    return Object.keys(metadata).length > 0 ? metadata : message;
  };

  const replaceListMessagesCollection = (
    originalResult,
    collection,
    items,
    extraProperties = {},
  ) => {
    if (!collection) return originalResult;
    if (collection.key === null) return items;

    return {
      ...originalResult,
      ...extraProperties,
      [collection.key]: items,
    };
  };

  const toMetadataOnlyListMessagesResult = (result) => {
    const collection = getListMessagesCollection(result);
    if (!collection) return result;

    return replaceListMessagesCollection(
      result,
      collection,
      collection.items.map((item) => toListMessageMetadata(item)),
    );
  };

  const fitListMessagesResultToMaxSize = (
    result,
    maxChars = LIST_MESSAGES_MAX_RESULT_SIZE_CHARS,
  ) => {
    const metadataResult = toMetadataOnlyListMessagesResult(result);
    if (JSON.stringify(metadataResult).length <= maxChars) {
      return metadataResult;
    }

    const collection = getListMessagesCollection(metadataResult);
    if (!collection) return metadataResult;

    const extraProperties =
      collection.key === null
        ? {}
        : {
            notice:
              'Result truncated to stay within the MCP result-size limit. ' +
              'Use narrower filters or call getMessage for full message content.',
            truncated: true,
            total_count: collection.items.length,
          };

    const keptItems = [];
    for (const item of collection.items) {
      const candidateItems = [...keptItems, item];
      const candidateResult = replaceListMessagesCollection(
        metadataResult,
        collection,
        candidateItems,
        collection.key === null
          ? {}
          : {
              ...extraProperties,
              returned_count: candidateItems.length,
            },
      );

      if (JSON.stringify(candidateResult).length > maxChars) break;
      keptItems.push(item);
    }

    return replaceListMessagesCollection(
      metadataResult,
      collection,
      keptItems,
      collection.key === null
        ? {}
        : {
            ...extraProperties,
            returned_count: keptItems.length,
          },
    );
  };

  const createTool = (spec) => {
    // Auto-extract path parameter names from the URL template
    const pathParameters = (spec.path.match(/{(\w+)}/g) || []).map((match) =>
      match.slice(1, -1),
    );

    // Auto-generate property definitions for path parameters
    const pathProperties = {};
    for (const parameter of pathParameters) {
      pathProperties[parameter] = {
        type: 'string',
        description:
          pathParameterDescriptions[parameter] ||
          `${parameter.replaceAll('_', ' ')}`,
      };
    }

    // Auto-generate property definitions for query parameters
    const queryProperties = {};
    if (spec.query) {
      for (const parameter of spec.query) {
        queryProperties[parameter] = {
          type: 'string',
          description:
            queryParameterDescriptions[parameter] ||
            `${parameter.replaceAll('_', ' ')}`,
        };
      }
    }

    return {
      toolSpec: {
        name: spec.name,
        description: spec.description,
        annotations: spec.annotations,
        _meta: spec._meta,
        input: {
          type: 'object',
          properties: {
            // Path parameters first
            ...pathProperties,
            // Query parameters next
            ...queryProperties,
            // Explicit inputs override auto-generated ones
            ...spec.inputs,
            // Inject alias credential inputs for alias-auth and both-auth tools

            ...((spec.auth === 'aliasAuth' || spec.auth === 'both') && {
              alias_username: {
                type: 'string',
                description:
                  'Alias email address for authentication (e.g. user@example.com). ' +
                  'Required for alias-authenticated endpoints. ' +
                  'Falls back to FORWARD_EMAIL_ALIAS_USER env var.',
              },
              alias_password: {
                type: 'string',
                description:
                  'Generated alias password for authentication. ' +
                  'Required for alias-authenticated endpoints. ' +
                  'Falls back to FORWARD_EMAIL_ALIAS_PASSWORD env var. ' +
                  'Generate one with the generateAliasPassword tool.',
              },
            }),
          },
          // Path parameters are always required; merge with explicit requiredInputs
          required: [...pathParameters, ...(spec.requiredInputs || [])],
        },
      },
      auth: spec.auth || 'apiKey',
      async invoke(arguments_) {
        let {path} = spec;
        const pathParameters = path.match(/{(\w+)}/g) || [];
        const queryArguments = {};
        const bodyArguments = {};

        // Extract alias credentials from arguments (don't send them to the API)
        const aliasUser = arguments_.alias_username || defaultAliasUser;
        const aliasPass = arguments_.alias_password || defaultAliasPassword;

        for (const key in arguments_) {
          if (!Object.hasOwn(arguments_, key)) continue;
          // Skip credential fields
          if (key === 'alias_username' || key === 'alias_password') continue;

          if (pathParameters.includes(`{${key}}`)) {
            path = path.replace(`{${key}}`, arguments_[key]);
          } else if (spec.query && spec.query.includes(key)) {
            queryArguments[key] = arguments_[key];
          } else {
            bodyArguments[key] = arguments_[key];
          }
        }

        const config = {params: queryArguments};
        const hasBody = Object.keys(bodyArguments).length > 0;

        // Choose the right client based on auth type
        let client;
        switch (spec.auth) {
          case 'aliasAuth': {
            client = createAliasClient(aliasUser, aliasPass);

            break;
          }

          case 'both': {
            // Use alias credentials if provided, otherwise fall back to API key
            client =
              aliasUser && aliasPass
                ? createAliasClient(aliasUser, aliasPass)
                : apiKeyClient;

            break;
          }

          case 'none': {
            client = axios.create({baseURL});

            break;
          }

          default: {
            client = apiKeyClient;
          }
        }

        let response;
        if (spec.method === 'get' || spec.method === 'delete') {
          response = await client[spec.method](path, config);
        } else {
          response = await client[spec.method](
            path,
            hasBody ? bodyArguments : undefined,
            config,
          );
        }

        return typeof spec.transformResponse === 'function'
          ? spec.transformResponse(response.data, arguments_)
          : response.data;
      },
    };
  };

  const tools = {
    //
    // Account (supports both API key and alias auth)
    //
    getAccount: createTool({
      name: 'getAccount',
      description:
        'Get your account details. With API key auth returns user account info. ' +
        'With alias auth returns alias/mailbox info including storage quota.',
      method: 'get',
      path: '/v1/account',
      auth: 'both',
    }),
    updateAccount: createTool({
      name: 'updateAccount',
      description:
        'Update your account. With API key auth updates user profile. ' +
        'With alias auth updates alias-scoped settings.',
      method: 'put',
      path: '/v1/account',
      auth: 'both',
      inputs: {
        email: {
          type: 'string',
          description: 'Email address to update on the account',
        },
        given_name: {
          type: 'string',
          description: 'First name',
        },
        family_name: {
          type: 'string',
          description: 'Last name',
        },
        avatar_url: {
          type: 'string',
          description: 'Link to avatar image (URL)',
        },
      },
    }),

    //
    // Logs (API key auth)
    //
    downloadLogs: createTool({
      name: 'downloadLogs',
      description: 'Download email delivery logs',
      method: 'get',
      path: '/v1/logs/download',
      auth: 'apiKey',
      query: [
        'domain',
        'q',
        'bounce_category',
        'response_code',
        'always_send_email',
      ],
    }),

    //
    // Contacts (CardDAV) — alias auth required
    //
    listContacts: createTool({
      name: 'listContacts',
      description:
        'List all contacts for the authenticated alias. ' +
        'Requires alias credentials (alias_username and alias_password).',
      method: 'get',
      path: '/v1/contacts',
      auth: 'aliasAuth',
    }),
    createContact: createTool({
      name: 'createContact',
      description:
        'Create a contact for the authenticated alias. Requires alias credentials.',
      method: 'post',
      path: '/v1/contacts',
      auth: 'aliasAuth',
    }),
    getContact: createTool({
      name: 'getContact',
      description: 'Get a contact by ID. Requires alias credentials.',
      method: 'get',
      path: '/v1/contacts/{id}',
      auth: 'aliasAuth',
    }),
    updateContact: createTool({
      name: 'updateContact',
      description: 'Update a contact. Requires alias credentials.',
      method: 'put',
      path: '/v1/contacts/{id}',
      auth: 'aliasAuth',
    }),
    deleteContact: createTool({
      name: 'deleteContact',
      description: 'Delete a contact. Requires alias credentials.',
      method: 'delete',
      path: '/v1/contacts/{id}',
      auth: 'aliasAuth',
    }),

    //
    // Calendars (CalDAV) — alias auth required
    //
    listCalendars: createTool({
      name: 'listCalendars',
      description:
        'List all calendars for the authenticated alias. ' +
        'Requires alias credentials (alias_username and alias_password).',
      method: 'get',
      path: '/v1/calendars',
      auth: 'aliasAuth',
    }),
    createCalendar: createTool({
      name: 'createCalendar',
      description: 'Create a calendar. Requires alias credentials.',
      method: 'post',
      path: '/v1/calendars',
      auth: 'aliasAuth',
    }),
    getCalendar: createTool({
      name: 'getCalendar',
      description: 'Get a calendar by ID. Requires alias credentials.',
      method: 'get',
      path: '/v1/calendars/{id}',
      auth: 'aliasAuth',
    }),
    updateCalendar: createTool({
      name: 'updateCalendar',
      description: 'Update a calendar. Requires alias credentials.',
      method: 'put',
      path: '/v1/calendars/{id}',
      auth: 'aliasAuth',
    }),
    deleteCalendar: createTool({
      name: 'deleteCalendar',
      description: 'Delete a calendar. Requires alias credentials.',
      method: 'delete',
      path: '/v1/calendars/{id}',
      auth: 'aliasAuth',
    }),

    //
    // Calendar Events (CalDAV) — alias auth required
    //
    listCalendarEvents: createTool({
      name: 'listCalendarEvents',
      description:
        'List all calendar events for the authenticated alias. ' +
        'Requires alias credentials (alias_username and alias_password).',
      method: 'get',
      path: '/v1/calendar-events',
      auth: 'aliasAuth',
    }),
    createCalendarEvent: createTool({
      name: 'createCalendarEvent',
      description: 'Create a calendar event. Requires alias credentials.',
      method: 'post',
      path: '/v1/calendar-events',
      auth: 'aliasAuth',
    }),
    getCalendarEvent: createTool({
      name: 'getCalendarEvent',
      description: 'Get a calendar event by ID. Requires alias credentials.',
      method: 'get',
      path: '/v1/calendar-events/{id}',
      auth: 'aliasAuth',
    }),
    updateCalendarEvent: createTool({
      name: 'updateCalendarEvent',
      description: 'Update a calendar event. Requires alias credentials.',
      method: 'put',
      path: '/v1/calendar-events/{id}',
      auth: 'aliasAuth',
    }),
    deleteCalendarEvent: createTool({
      name: 'deleteCalendarEvent',
      description: 'Delete a calendar event. Requires alias credentials.',
      method: 'delete',
      path: '/v1/calendar-events/{id}',
      auth: 'aliasAuth',
    }),

    //
    // Domains (API key auth)
    //
    listDomains: createTool({
      name: 'listDomains',
      description: 'List all domains',
      method: 'get',
      path: '/v1/domains',
      auth: 'apiKey',
      query: ['sort', 'page', 'limit'],
    }),
    createDomain: createTool({
      name: 'createDomain',
      description: 'Create a new domain',
      method: 'post',
      path: '/v1/domains',
      auth: 'apiKey',
      inputs: {
        domain: {
          type: 'string',
          description:
            'Fully qualified domain name or IP address (e.g. "example.com")',
        },
        plan: {
          type: 'string',
          description: 'Plan type: "free", "enhanced_protection", or "team"',
        },
        catchall: {
          type: 'string',
          description:
            'Create a default catch-all alias (email address or "true" for default)',
        },
        has_adult_content_protection: {
          type: 'boolean',
          description: 'Enable Spam Scanner adult content protection',
        },
        has_phishing_protection: {
          type: 'boolean',
          description: 'Enable Spam Scanner phishing protection',
        },
        has_executable_protection: {
          type: 'boolean',
          description: 'Enable Spam Scanner executable protection',
        },
        has_virus_protection: {
          type: 'boolean',
          description: 'Enable Spam Scanner virus protection',
        },
        has_recipient_verification: {
          type: 'boolean',
          description:
            'Require alias recipients to click email verification link',
        },
        ignore_mx_check: {
          type: 'boolean',
          description: 'Ignore MX record check on the domain',
        },
        retention_days: {
          type: 'number',
          description:
            'Number of days to retain emails (integer between 0 and 30)',
        },
        bounce_webhook: {
          type: 'string',
          description: 'Webhook URL for bounce notifications',
        },
        max_quota_per_alias: {
          type: 'string',
          description: 'Maximum storage quota per alias (e.g. "1GB")',
        },
      },
      requiredInputs: ['domain'],
    }),
    getDomain: createTool({
      name: 'getDomain',
      description: 'Get a domain by ID or name',
      method: 'get',
      path: '/v1/domains/{domain_id}',
      auth: 'apiKey',
    }),
    updateDomain: createTool({
      name: 'updateDomain',
      description: 'Update a domain',
      method: 'put',
      path: '/v1/domains/{domain_id}',
      auth: 'apiKey',
      inputs: {
        smtp_port: {
          type: 'string',
          description: 'Custom SMTP forwarding port number',
        },
        has_adult_content_protection: {
          type: 'boolean',
          description: 'Enable Spam Scanner adult content protection',
        },
        has_phishing_protection: {
          type: 'boolean',
          description: 'Enable Spam Scanner phishing protection',
        },
        has_executable_protection: {
          type: 'boolean',
          description: 'Enable Spam Scanner executable protection',
        },
        has_virus_protection: {
          type: 'boolean',
          description: 'Enable Spam Scanner virus protection',
        },
        has_recipient_verification: {
          type: 'boolean',
          description:
            'Require alias recipients to click email verification link',
        },
        ignore_mx_check: {
          type: 'boolean',
          description: 'Ignore MX record check on the domain',
        },
        retention_days: {
          type: 'number',
          description:
            'Number of days to retain emails (integer between 0 and 30)',
        },
        bounce_webhook: {
          type: 'string',
          description: 'Webhook URL for bounce notifications',
        },
        max_quota_per_alias: {
          type: 'string',
          description: 'Maximum storage quota per alias (e.g. "1GB")',
        },
      },
    }),
    deleteDomain: createTool({
      name: 'deleteDomain',
      description: 'Delete a domain',
      method: 'delete',
      path: '/v1/domains/{domain_id}',
      auth: 'apiKey',
    }),
    verifyDomainRecords: createTool({
      name: 'verifyDomainRecords',
      description: 'Verify domain DNS records',
      method: 'get',
      path: '/v1/domains/{domain_id}/verify-records',
      auth: 'apiKey',
    }),
    verifySmtpRecords: createTool({
      name: 'verifySmtpRecords',
      description: 'Verify domain SMTP records',
      method: 'get',
      path: '/v1/domains/{domain_id}/verify-smtp',
      auth: 'apiKey',
    }),
    testS3Connection: createTool({
      name: 'testS3Connection',
      description: 'Test custom S3 connection for a domain',
      method: 'post',
      path: '/v1/domains/{domain_id}/test-s3-connection',
      auth: 'apiKey',
      inputs: {},
    }),

    //
    // Domain Catch-All Passwords (API key auth)
    //
    listCatchAllPasswords: createTool({
      name: 'listCatchAllPasswords',
      description: 'List domain-wide catch-all passwords',
      method: 'get',
      path: '/v1/domains/{domain_id}/catch-all-passwords',
      auth: 'apiKey',
    }),
    createCatchAllPassword: createTool({
      name: 'createCatchAllPassword',
      description: 'Create a domain-wide catch-all password',
      method: 'post',
      path: '/v1/domains/{domain_id}/catch-all-passwords',
      auth: 'apiKey',
      inputs: {
        new_password: {
          type: 'string',
          description:
            'Custom password to set (leave empty for auto-generated password)',
        },
        description: {
          type: 'string',
          description: 'Description for organizing this password',
        },
      },
    }),
    deleteCatchAllPassword: createTool({
      name: 'deleteCatchAllPassword',
      description: 'Remove a domain-wide catch-all password',
      method: 'delete',
      path: '/v1/domains/{domain_id}/catch-all-passwords/{token_id}',
      auth: 'apiKey',
    }),

    //
    // Domain Invites (API key auth)
    //
    acceptDomainInvite: createTool({
      name: 'acceptDomainInvite',
      description: 'Accept a domain invite',
      method: 'get',
      path: '/v1/domains/{domain_id}/invites',
      auth: 'apiKey',
    }),
    createDomainInvite: createTool({
      name: 'createDomainInvite',
      description: 'Invite a user to a domain',
      method: 'post',
      path: '/v1/domains/{domain_id}/invites',
      auth: 'apiKey',
      inputs: {
        email: {
          type: 'string',
          description: 'Email address of the user to invite',
        },
        group: {
          type: 'string',
          description:
            'Group assignment for the invited user: "admin" or "user"',
        },
      },
      requiredInputs: ['email', 'group'],
    }),
    removeDomainInvite: createTool({
      name: 'removeDomainInvite',
      description: 'Remove a domain invite',
      method: 'delete',
      path: '/v1/domains/{domain_id}/invites',
      auth: 'apiKey',
    }),

    //
    // Domain Members (API key auth)
    //
    updateDomainMember: createTool({
      name: 'updateDomainMember',
      description: 'Update a domain member role (admin or user)',
      method: 'put',
      path: '/v1/domains/{domain_id}/members/{member_id}',
      auth: 'apiKey',
      inputs: {
        group: {
          type: 'string',
          description: 'Group assignment: "admin" or "user"',
        },
      },
      requiredInputs: ['group'],
    }),
    removeDomainMember: createTool({
      name: 'removeDomainMember',
      description: 'Remove a member from a domain',
      method: 'delete',
      path: '/v1/domains/{domain_id}/members/{member_id}',
      auth: 'apiKey',
    }),

    //
    // Aliases (API key auth)
    //
    listAliases: createTool({
      name: 'listAliases',
      description: 'List aliases for a domain',
      method: 'get',
      path: '/v1/domains/{domain_id}/aliases',
      auth: 'apiKey',
      query: ['sort', 'page', 'limit'],
    }),
    createAlias: createTool({
      name: 'createAlias',
      description: 'Create a new alias',
      method: 'post',
      path: '/v1/domains/{domain_id}/aliases',
      auth: 'apiKey',
      inputs: {
        name: {
          type: 'string',
          description:
            'Alias name (the part before @). Random if not provided.',
        },
        recipients: {
          type: 'string',
          description:
            'Comma or newline separated email addresses to forward to',
        },
        description: {
          type: 'string',
          description: 'Alias description',
        },
        labels: {
          type: 'string',
          description: 'Comma separated list of labels',
        },
        has_recipient_verification: {
          type: 'boolean',
          description: 'Require recipients to click an email verification link',
        },
        is_enabled: {
          type: 'boolean',
          description: 'Whether the alias is enabled for email routing',
        },
        error_code_if_disabled: {
          type: 'number',
          description:
            'SMTP error code when alias is disabled: 250, 421, or 550',
        },
        has_imap: {
          type: 'boolean',
          description: 'Enable or disable IMAP storage for the alias',
        },
        has_pgp: {
          type: 'boolean',
          description: 'Enable OpenPGP encryption for IMAP/POP3 storage',
        },
        public_key: {
          type: 'string',
          description: 'OpenPGP public key in ASCII Armor format',
        },
        max_quota: {
          type: 'string',
          description: 'Maximum storage quota for this alias (e.g. "1GB")',
        },
        vacation_responder_is_enabled: {
          type: 'boolean',
          description: 'Enable automatic vacation responder',
        },
        vacation_responder_start_date: {
          type: 'string',
          description:
            'Vacation responder start date (MM/DD/YYYY or YYYY-MM-DD)',
        },
        vacation_responder_end_date: {
          type: 'string',
          description: 'Vacation responder end date (MM/DD/YYYY or YYYY-MM-DD)',
        },
        vacation_responder_subject: {
          type: 'string',
          description: 'Subject line for the vacation responder (plaintext)',
        },
        vacation_responder_message: {
          type: 'string',
          description: 'Message body for the vacation responder (plaintext)',
        },
      },
    }),
    getAlias: createTool({
      name: 'getAlias',
      description: 'Get an alias by ID',
      method: 'get',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}',
      auth: 'apiKey',
    }),
    updateAlias: createTool({
      name: 'updateAlias',
      description: 'Update an alias',
      method: 'put',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}',
      auth: 'apiKey',
      inputs: {
        name: {
          type: 'string',
          description: 'Alias name (the part before @)',
        },
        recipients: {
          type: 'string',
          description:
            'Comma or newline separated email addresses to forward to',
        },
        description: {
          type: 'string',
          description: 'Alias description',
        },
        labels: {
          type: 'string',
          description: 'Comma separated list of labels',
        },
        has_recipient_verification: {
          type: 'boolean',
          description: 'Require recipients to click an email verification link',
        },
        is_enabled: {
          type: 'boolean',
          description: 'Whether the alias is enabled for email routing',
        },
        error_code_if_disabled: {
          type: 'number',
          description:
            'SMTP error code when alias is disabled: 250, 421, or 550',
        },
        has_imap: {
          type: 'boolean',
          description: 'Enable or disable IMAP storage for the alias',
        },
        has_pgp: {
          type: 'boolean',
          description: 'Enable OpenPGP encryption for IMAP/POP3 storage',
        },
        public_key: {
          type: 'string',
          description: 'OpenPGP public key in ASCII Armor format',
        },
        max_quota: {
          type: 'string',
          description: 'Maximum storage quota for this alias (e.g. "1GB")',
        },
        vacation_responder_is_enabled: {
          type: 'boolean',
          description: 'Enable automatic vacation responder',
        },
        vacation_responder_start_date: {
          type: 'string',
          description:
            'Vacation responder start date (MM/DD/YYYY or YYYY-MM-DD)',
        },
        vacation_responder_end_date: {
          type: 'string',
          description: 'Vacation responder end date (MM/DD/YYYY or YYYY-MM-DD)',
        },
        vacation_responder_subject: {
          type: 'string',
          description: 'Subject line for the vacation responder (plaintext)',
        },
        vacation_responder_message: {
          type: 'string',
          description: 'Message body for the vacation responder (plaintext)',
        },
      },
    }),
    deleteAlias: createTool({
      name: 'deleteAlias',
      description: 'Delete an alias',
      method: 'delete',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}',
      auth: 'apiKey',
    }),
    generateAliasPassword: createTool({
      name: 'generateAliasPassword',
      description:
        'Generate or set a password for an alias. Returns the alias username ' +
        'and password needed for alias-authenticated endpoints (messages, ' +
        'folders, contacts, calendars, sieve scripts).',
      method: 'post',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}/generate-password',
      auth: 'apiKey',
      inputs: {
        new_password: {
          type: 'string',
          description:
            'Custom password to set (leave empty for auto-generated password)',
        },
        password: {
          type: 'string',
          description:
            'Existing password to change without deleting IMAP storage',
        },
        is_override: {
          type: 'boolean',
          description:
            'Override existing password and delete associated IMAP storage',
        },
        emailed_instructions: {
          type: 'string',
          description:
            'Email address to send the password and setup instructions to',
        },
      },
    }),

    //
    // Sieve Scripts — domain-scoped (API key auth)
    //
    listSieveScripts: createTool({
      name: 'listSieveScripts',
      description: 'List Sieve scripts for an alias (API key auth)',
      method: 'get',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}/sieve',
      auth: 'apiKey',
    }),
    createSieveScript: createTool({
      name: 'createSieveScript',
      description: 'Create a Sieve script for an alias (API key auth)',
      method: 'post',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}/sieve',
      auth: 'apiKey',
    }),
    getSieveScript: createTool({
      name: 'getSieveScript',
      description: 'Get a Sieve script by ID (API key auth)',
      method: 'get',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}/sieve/{script_id}',
      auth: 'apiKey',
    }),
    updateSieveScript: createTool({
      name: 'updateSieveScript',
      description: 'Update a Sieve script (API key auth)',
      method: 'put',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}/sieve/{script_id}',
      auth: 'apiKey',
    }),
    deleteSieveScript: createTool({
      name: 'deleteSieveScript',
      description: 'Delete a Sieve script (API key auth)',
      method: 'delete',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}/sieve/{script_id}',
      auth: 'apiKey',
    }),
    activateSieveScript: createTool({
      name: 'activateSieveScript',
      description: 'Activate a Sieve script (API key auth)',
      method: 'post',
      path: '/v1/domains/{domain_id}/aliases/{alias_id}/sieve/{script_id}/activate',
      auth: 'apiKey',
    }),

    //
    // Sieve Scripts — alias-scoped (alias auth)
    //
    listSieveScriptsAliasAuth: createTool({
      name: 'listSieveScriptsAliasAuth',
      description:
        'List Sieve scripts for the authenticated alias. ' +
        'Requires alias credentials.',
      method: 'get',
      path: '/v1/sieve-scripts',
      auth: 'aliasAuth',
    }),
    createSieveScriptAliasAuth: createTool({
      name: 'createSieveScriptAliasAuth',
      description:
        'Create a Sieve script for the authenticated alias. ' +
        'Requires alias credentials.',
      method: 'post',
      path: '/v1/sieve-scripts',
      auth: 'aliasAuth',
    }),
    getSieveScriptAliasAuth: createTool({
      name: 'getSieveScriptAliasAuth',
      description:
        'Get a Sieve script by ID (alias auth). Requires alias credentials.',
      method: 'get',
      path: '/v1/sieve-scripts/{script_id}',
      auth: 'aliasAuth',
    }),
    updateSieveScriptAliasAuth: createTool({
      name: 'updateSieveScriptAliasAuth',
      description:
        'Update a Sieve script (alias auth). Requires alias credentials.',
      method: 'put',
      path: '/v1/sieve-scripts/{script_id}',
      auth: 'aliasAuth',
    }),
    deleteSieveScriptAliasAuth: createTool({
      name: 'deleteSieveScriptAliasAuth',
      description:
        'Delete a Sieve script (alias auth). Requires alias credentials.',
      method: 'delete',
      path: '/v1/sieve-scripts/{script_id}',
      auth: 'aliasAuth',
    }),
    activateSieveScriptAliasAuth: createTool({
      name: 'activateSieveScriptAliasAuth',
      description:
        'Activate a Sieve script (alias auth). Requires alias credentials.',
      method: 'post',
      path: '/v1/sieve-scripts/{script_id}/activate',
      auth: 'aliasAuth',
    }),

    //
    // Emails — Outbound SMTP
    //
    listEmails: createTool({
      name: 'listEmails',
      description: 'List outbound SMTP emails',
      method: 'get',
      path: '/v1/emails',
      auth: 'apiKey',
      query: ['q', 'domain', 'is_scheduled', 'sort', 'page', 'limit'],
    }),
    sendEmail: createTool({
      name: 'sendEmail',
      description:
        'Send an email via outbound SMTP. ' +
        'Supports both API key and alias auth.',
      method: 'post',
      path: '/v1/emails',
      auth: 'both',
      inputs: {
        from: {
          type: 'string',
          description: 'Sender email address',
        },
        to: {
          type: 'string',
          description: 'Comma separated list of recipient email addresses',
        },
        cc: {
          type: 'string',
          description: 'Comma separated list of CC recipient email addresses',
        },
        bcc: {
          type: 'string',
          description: 'Comma separated list of BCC recipient email addresses',
        },
        subject: {
          type: 'string',
          description: 'Email subject line',
        },
        text: {
          type: 'string',
          description: 'Plaintext version of the email body',
        },
        html: {
          type: 'string',
          description: 'HTML version of the email body',
        },
        attachments: {
          type: 'string',
          description:
            'JSON array of attachment objects with filename, content, and encoding',
        },
        sender: {
          type: 'string',
          description: 'Email address for the Sender header',
        },
        replyTo: {
          type: 'string',
          description: 'Email address for the Reply-To header',
        },
        inReplyTo: {
          type: 'string',
          description: 'Message-ID that this email is replying to',
        },
        references: {
          type: 'string',
          description:
            'Space separated list of Message-IDs in the reference chain',
        },
        priority: {
          type: 'string',
          description: 'Email priority: "high", "normal" (default), or "low"',
        },
        messageId: {
          type: 'string',
          description: 'Custom Message-ID value for the email header',
        },
        date: {
          type: 'string',
          description: 'Date value for the email Date header (ISO 8601)',
        },
        raw: {
          type: 'string',
          description: 'Custom RFC822 formatted message to send as raw email',
        },
      },
    }),
    getEmailLimit: createTool({
      name: 'getEmailLimit',
      description: 'Get outbound SMTP email sending limit',
      method: 'get',
      path: '/v1/emails/limit',
      auth: 'apiKey',
    }),
    getEmail: createTool({
      name: 'getEmail',
      description: 'Get an outbound SMTP email by ID',
      method: 'get',
      path: '/v1/emails/{id}',
      auth: 'apiKey',
    }),
    deleteEmail: createTool({
      name: 'deleteEmail',
      description: 'Delete an outbound SMTP email',
      method: 'delete',
      path: '/v1/emails/{id}',
      auth: 'apiKey',
    }),

    //
    // Messages — IMAP (alias auth required)
    //
    listMessages: createTool({
      name: 'listMessages',
      description:
        'List and search messages in a folder. Supports metadata_only to ' +
        'return envelope fields only and automatically trims oversized ' +
        'results so the tool remains usable in Anthropic clients. Requires ' +
        'alias credentials (alias_username and alias_password).',
      method: 'get',
      path: '/v1/messages',
      auth: 'aliasAuth',
      _meta: {
        'anthropic/maxResultSizeChars': LIST_MESSAGES_MAX_RESULT_SIZE_CHARS,
      },
      inputs: {
        metadata_only: {
          type: 'boolean',
          description:
            'If true, only return lightweight message metadata (id, uid, ' +
            'subject, from, to, date, size, attachment flags, flags, and ' +
            'folder). Use getMessage to fetch full content for a specific ' +
            'message.',
        },
      },
      transformResponse(result, arguments_) {
        if (isTruthyBoolean(arguments_.metadata_only)) {
          return fitListMessagesResultToMaxSize(
            toMetadataOnlyListMessagesResult(result),
          );
        }

        if (
          JSON.stringify(result).length <= LIST_MESSAGES_MAX_RESULT_SIZE_CHARS
        ) {
          return result;
        }

        return fitListMessagesResultToMaxSize(result);
      },
      query: [
        'folder',
        'is_unread',
        'is_flagged',
        'is_deleted',
        'is_draft',
        'is_junk',
        'is_copied',
        'is_encrypted',
        'is_searchable',
        'is_expired',
        'has_attachments',
        'has_attachment',
        'subject',
        'body',
        'text',
        'headers',
        'message_id',
        'search',
        'q',
        'since',
        'before',
        'min_size',
        'max_size',
        'from',
        'to',
        'cc',
        'bcc',
        'date',
        'reply-to',
      ],
    }),
    createMessage: createTool({
      name: 'createMessage',
      description:
        'Create a new message (draft) in a folder. ' +
        'Requires alias credentials.',
      method: 'post',
      path: '/v1/messages',
      auth: 'aliasAuth',
    }),
    getMessage: createTool({
      name: 'getMessage',
      description: 'Get a message by ID. Requires alias credentials.',
      method: 'get',
      path: '/v1/messages/{id}',
      auth: 'aliasAuth',
      query: ['eml', 'nodemailer', 'attachments', 'raw'],
    }),
    updateMessage: createTool({
      name: 'updateMessage',
      description:
        'Update a message (flags, labels, move to folder). ' +
        'Requires alias credentials.',
      method: 'put',
      path: '/v1/messages/{id}',
      auth: 'aliasAuth',
      query: ['eml'],
    }),
    deleteMessage: createTool({
      name: 'deleteMessage',
      description: 'Delete a message permanently. Requires alias credentials.',
      method: 'delete',
      path: '/v1/messages/{id}',
      auth: 'aliasAuth',
    }),

    //
    // Folders — IMAP (alias auth required)
    //
    listFolders: createTool({
      name: 'listFolders',
      description:
        'List all IMAP folders. ' +
        'Requires alias credentials (alias_username and alias_password).',
      method: 'get',
      path: '/v1/folders',
      auth: 'aliasAuth',
      query: ['subscribed'],
    }),
    createFolder: createTool({
      name: 'createFolder',
      description: 'Create a new IMAP folder. Requires alias credentials.',
      method: 'post',
      path: '/v1/folders',
      auth: 'aliasAuth',
    }),
    getFolder: createTool({
      name: 'getFolder',
      description: 'Get a folder by ID or path. Requires alias credentials.',
      method: 'get',
      path: '/v1/folders/{id}',
      auth: 'aliasAuth',
    }),
    updateFolder: createTool({
      name: 'updateFolder',
      description: 'Rename a folder. Requires alias credentials.',
      method: 'put',
      path: '/v1/folders/{id}',
      auth: 'aliasAuth',
    }),
    deleteFolder: createTool({
      name: 'deleteFolder',
      description:
        'Delete a folder and all messages in it. ' +
        'Requires alias credentials.',
      method: 'delete',
      path: '/v1/folders/{id}',
      auth: 'aliasAuth',
    }),

    //
    // Encrypt (no auth required)
    //
    encryptRecord: createTool({
      name: 'encryptRecord',
      description: 'Encrypt a plaintext Forward Email TXT record',
      method: 'post',
      path: '/v1/encrypt',
      auth: 'none',
      inputs: {
        input: {
          type: 'string',
          description:
            'Any valid Forward Email plaintext DNS TXT record value to encrypt',
        },
      },
      requiredInputs: ['input'],
    }),
  };

  return tools;
};

module.exports = {getTools};
