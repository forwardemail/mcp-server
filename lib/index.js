const {Server} = require('@modelcontextprotocol/sdk/server/index.js');
const {
  StdioServerTransport,
} = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const {name, version} = require('../package.json');
const {getTools} = require('./tools.js');

class McpServer {
  constructor(options = {}) {
    this.tools = getTools(options);
    this.server = new Server({name, version}, {capabilities: {tools: {}}});

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.values(this.tools).map((tool) => ({
        name: tool.toolSpec.name,
        description: tool.toolSpec.description,
        inputSchema: {
          type: 'object',
          properties: tool.toolSpec.input?.properties ?? {},
          required: tool.toolSpec.input?.required ?? [],
        },
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params?.name;
      const tool = this.tools[toolName];
      if (!tool) {
        return {
          content: [{type: 'text', text: `Tool not found: ${toolName}`}],
          isError: true,
        };
      }

      try {
        const result = await tool.invoke(request.params?.arguments ?? {});
        return {
          content: [
            {
              type: 'text',
              text:
                typeof result === 'string'
                  ? result
                  : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error.response?.data?.message || error.message;
        return {
          content: [{type: 'text', text: errorMessage}],
          isError: true,
        };
      }
    });
  }

  async listen() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

module.exports = {McpServer};
