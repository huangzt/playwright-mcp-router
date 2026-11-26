#!/usr/bin/env node
/**
 * Live end-to-end concurrency test against real Chrome + Playwright MCP Bridge extension.
 * Spawns 2 concurrent sessions on Account 1 and 1 concurrent session on Account 2,
 * verifies complete URL/tab isolation, and cleans up all sessions.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachLineJsonReader, writeJsonRpc } from '../src/jsonrpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'playwright-mcp-router.js');

const child = spawn(process.execPath, [BIN, ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stderr.on('data', (d) => process.stderr.write(d));

const waiters = new Map();
let nextId = 1;

attachLineJsonReader(child.stdout, (msg) => {
  if (msg.id !== undefined && waiters.has(msg.id)) {
    const { resolve, timer } = waiters.get(msg.id);
    clearTimeout(timer);
    waiters.delete(msg.id);
    resolve(msg);
  }
});

function rpc(method, params = {}, timeoutMs = 30_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`Timeout waiting for ${method}`));
    }, timeoutMs);
    waiters.set(id, { resolve, timer });
    writeJsonRpc(child.stdin, { jsonrpc: '2.0', id, method, params });
  });
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) throw new Error(res.error.message);
  if (res.result?.isError) throw new Error(res.result.content?.[0]?.text || 'Tool error');
  return res.result.content?.[0]?.text || '';
}

try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'live-concurrency-test', version: '1.0.0' },
  });
  writeJsonRpc(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await rpc('tools/list', {});
  console.log(`Discovered ${list.result.tools.length} tools.`);

  // Open 3 concurrent sessions simultaneously: 2 on Account 1, 1 on Account 2
  const sessions = [
    { session: '并发测试-A', account: '1', url: 'https://example.com/?session=acc1-A' },
    { session: '并发测试-B', account: '1', url: 'https://example.com/?session=acc1-B' },
    { session: '并发测试-账号2', account: '2', url: 'https://example.com/?session=acc2' },
  ];

  await Promise.all(
    sessions.map((s) =>
      callTool('browser_navigate', { session: s.session, account: s.account, url: s.url })
    )
  );

  // Verify each session's active tab still points to its own URL (zero cross-talk)
  const tabOutputs = await Promise.all(
    sessions.map((s) =>
      callTool('browser_tabs', { session: s.session, account: s.account, action: 'list' })
    )
  );

  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i];
    const text = tabOutputs[i];
    console.log(`[account=${s.account} session=${s.session}]\n${text}`);
    assert.ok(text.includes(s.url), `Expected ${s.session} to stay on ${s.url}, got:\n${text}`);
  }

  const activeJson = JSON.parse(await callTool('router_list_sessions', {}));
  console.log(`Active sessions count: ${activeJson.activeSessionCount}`);
  assert.equal(activeJson.activeSessionCount, 3);

  console.log('Closing all live test sessions...');
  const closeMsg = await callTool('router_close_all_sessions', {});
  console.log(closeMsg);
  console.log('LIVE CONCURRENCY TEST PASSED!');
} finally {
  child.kill('SIGTERM');
}
