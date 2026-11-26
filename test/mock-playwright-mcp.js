#!/usr/bin/env node
/**
 * Deterministic mock of @playwright/mcp for unit & concurrency tests.
 * Tracks per-process active URL, received CLI args, and env token without launching a browser.
 */
import { attachLineJsonReader, jsonRpcResult, writeJsonRpc } from '../src/jsonrpc.js';

const argv = process.argv.slice(2);
function getFlag(name) {
  const prefix = `${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const sessionName = getFlag('--session-name');
const sessionColor = getFlag('--session-color');
const profileDirName = getFlag('--profile-dir-name');
const tokenPresent = Boolean(process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN);
const tokenValue = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || '';

let currentUrl = 'about:blank';
let closed = false;

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_tabs',
    description: 'List or select tabs',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_close',
    description: 'Close the page',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_debug_crash',
    description: 'Simulate unexpected worker crash',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_debug_leak_token',
    description: 'Simulate an upstream error containing a secret token',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

attachLineJsonReader(process.stdin, (msg) => {
  if (msg.id === undefined || msg.id === null) return;

  if (msg.method === 'initialize') {
    writeJsonRpc(
      process.stdout,
      jsonRpcResult(msg.id, {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-playwright-mcp', version: '0.0.0' },
      })
    );
    return;
  }

  if (msg.method === 'tools/list') {
    writeJsonRpc(process.stdout, jsonRpcResult(msg.id, { tools: TOOLS }));
    return;
  }

  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    if (name === 'browser_debug_crash') {
      process.stderr.write('simulated fatal crash\n');
      process.exit(42);
    }
    if (name === 'browser_debug_leak_token') {
      writeJsonRpc(process.stdout, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: `Auth failed for token=${tokenValue}` },
      });
      return;
    }
    if (name === 'browser_navigate') {
      currentUrl = args.url;
    }
    if (name === 'browser_close') {
      closed = true;
    }
    const payload = {
      pid: process.pid,
      tool: name,
      forwardedArgs: args,
      sessionName,
      sessionColor,
      profileDirName,
      tokenPresent,
      currentUrl,
      closed,
    };
    writeJsonRpc(
      process.stdout,
      jsonRpcResult(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      })
    );
  }
});
