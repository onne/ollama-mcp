/**
 * MCP Server creation and configuration
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Ollama } from 'ollama';
import { discoverTools } from './autoloader.js';
import { ResponseFormat } from './types.js';

/**
 * Create and configure the MCP server with tool handlers
 */
export function createServer(ollamaInstance?: Ollama): Server {
  // Initialize Ollama client
  const ollamaConfig: {
    host: string;
    headers?: Record<string, string>;
  } = {
    host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  };

  // Add API key header if OLLAMA_API_KEY is set
  if (process.env.OLLAMA_API_KEY) {
    ollamaConfig.headers = {
      Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
    };
  }

  const ollama = ollamaInstance || new Ollama(ollamaConfig);

  // Cache discovered tools
  let cachedTools: any[] | null = null;
  const getTools = async () => {
    if (!cachedTools) {
      cachedTools = await discoverTools();
    }
    return cachedTools;
  };

  // Create MCP server
  const server = new Server(
    {
      name: 'ollama-mcp',
      version: '2.0.2',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await getTools();

    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const { name, arguments: args } = request.params;

      // Use cached tools
      const tools = await getTools();

      // Find the matching tool
      const tool = tools.find((t) => t.name === name);

      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      // Determine format from args
      const formatArg = (args as Record<string, unknown>).format;
      const format =
        formatArg === 'markdown' ? ResponseFormat.MARKDOWN : ResponseFormat.JSON;

      // Create a scoped Ollama client for this request that respects the AbortSignal
      const requestOllamaConfig: any = { ...ollamaConfig };
      if (extra?.signal) {
        // Inject a custom fetch that merges the MCP abort signal
        requestOllamaConfig.fetch = (input: any, init?: any) => {
          // If the MCP client aborts, the signal will trigger and cancel the fetch
          return fetch(input, { ...init, signal: extra.signal });
        };
      }
      
      const scopedOllama = new Ollama(requestOllamaConfig);

      // Call the tool handler
      const result = await tool.handler(
        scopedOllama,
        args as Record<string, unknown>,
        format
      );

      // Parse the result to extract structured data
      let structuredData: unknown = undefined;
      try {
        // Attempt to parse the result as JSON
        structuredData = JSON.parse(result);
      } catch {
        // If parsing fails, leave structuredData as undefined
        // This handles cases where the result is markdown or plain text
      }

      return {
        structuredContent: structuredData,
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
