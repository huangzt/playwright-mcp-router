import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightMcpRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = path.resolve(__dirname, 'mock-playwright-mcp.js');

function makeConfig(overrides = {}) {
  const base = loadConfig(['--playwright-bin', MOCK_BIN], {});
  return {
    ...base,
    defaultAccount: '1',
    idleTimeoutMs: 60_000,
    maxSessions: 4,
    playwrightArgs: ['--extension', '--background', '--caps=devtools'],
    accounts: {
      '1': {
        key: '1',
        label: 'Work Account',
        profileDirName: 'Default',
        token: 'SECRET_TOKEN_ACCOUNT_ONE_12345',
        extension: true,
        colors: ['blue', 'cyan'],
        extraArgs: [],
      },
      '2': {
        key: '2',
        label: 'Backup Account',
        profileDirName: 'Profile 1',
        token: 'SECRET_TOKEN_ACCOUNT_TWO_67890',
        extension: true,
        colors: ['green'],
        extraArgs: [],
      },
    },
    ...overrides,
  };
}

function parseToolJson(res) {
  assert.ok(!res.result.isError, `Expected tool success, got error: ${JSON.stringify(res.result)}`);
  return JSON.parse(res.result.content[0].text);
}

test('tools/list augments Playwright tools with required session + account enum and adds router tools', async () => {
  const router = new PlaywrightMcpRouter(makeConfig());
  try {
    const init = await router.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'playwright-mcp-router');

    const list = await router.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = list.result.tools;
    const names = tools.map((t) => t.name);

    assert.ok(names.includes('router_list_sessions'));
    assert.ok(names.includes('router_close_session'));
    assert.ok(names.includes('router_close_all_sessions'));
    assert.ok(names.includes('browser_navigate'));

    const nav = tools.find((t) => t.name === 'browser_navigate');
    assert.ok(nav.inputSchema.required.includes('session'));
    assert.ok(nav.inputSchema.required.includes('url'));
    assert.deepEqual(nav.inputSchema.properties.account.enum, ['1', '2']);
    assert.equal(nav.inputSchema.properties.account.default, '1');
  } finally {
    await router.shutdown();
  }
});

test('concurrent sessions on the same account are isolated with distinct PIDs, tab groups, and colors', async () => {
  const router = new PlaywrightMcpRouter(makeConfig());
  try {
    const [r1, r2] = await Promise.all([
      router.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { session: 'T1867-抓包', url: 'https://example.com/a' },
        },
      }),
      router.handleMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { session: 'CSS-排查', url: 'https://example.com/b' },
        },
      }),
    ]);

    const p1 = parseToolJson(r1);
    const p2 = parseToolJson(r2);

    assert.notEqual(p1.pid, p2.pid);
    assert.equal(p1.sessionName, 'T1867-抓包');
    assert.equal(p2.sessionName, 'CSS-排查');
    assert.equal(p1.profileDirName, 'Default');
    assert.equal(p2.profileDirName, 'Default');
    assert.notEqual(p1.sessionColor, p2.sessionColor);
    assert.equal(p1.currentUrl, 'https://example.com/a');
    assert.equal(p2.currentUrl, 'https://example.com/b');
    // Router-only params must be stripped before forwarding
    assert.deepEqual(p1.forwardedArgs, { url: 'https://example.com/a' });
    assert.deepEqual(p2.forwardedArgs, { url: 'https://example.com/b' });

    // Subsequent calls stay pinned to each session's own worker
    const t1 = parseToolJson(
      await router.handleMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'browser_tabs', arguments: { session: 'T1867-抓包', action: 'list' } },
      })
    );
    const t2 = parseToolJson(
      await router.handleMessage({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'browser_tabs', arguments: { session: 'CSS-排查', action: 'list' } },
      })
    );
    assert.equal(t1.pid, p1.pid);
    assert.equal(t1.currentUrl, 'https://example.com/a');
    assert.equal(t2.pid, p2.pid);
    assert.equal(t2.currentUrl, 'https://example.com/b');
  } finally {
    await router.shutdown();
  }
});

test('in-flight concurrent calls for the same session coalesce into a single worker', async () => {
  const router = new PlaywrightMcpRouter(makeConfig());
  try {
    const [a, b] = await Promise.all([
      router.handleMessage({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'browser_tabs', arguments: { session: 'shared-task', action: 'list' } },
      }),
      router.handleMessage({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'browser_tabs', arguments: { session: 'shared-task', action: 'list' } },
      }),
    ]);

    assert.equal(parseToolJson(a).pid, parseToolJson(b).pid);
    assert.equal(router.sessions.size, 1);
  } finally {
    await router.shutdown();
  }
});

test('routes across multiple Chrome accounts and never leaks tokens in list or errors', async () => {
  const router = new PlaywrightMcpRouter(makeConfig());
  try {
    const r2 = parseToolJson(
      await router.handleMessage({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { session: 'dual-auth', account: '2', url: 'https://example.com/acc2' },
        },
      })
    );
    assert.equal(r2.profileDirName, 'Profile 1');
    assert.equal(r2.sessionColor, 'green');
    assert.equal(r2.tokenPresent, true);

    const listRes = await router.handleMessage({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'router_list_sessions', arguments: {} },
    });
    const listText = listRes.result.content[0].text;
    assert.ok(!listText.includes('SECRET_TOKEN'));
    const listObj = JSON.parse(listText);
    assert.equal(listObj.activeSessionCount, 1);
    assert.equal(listObj.sessions[0].account, '2');

    // Secret redaction on upstream error
    const errRes = await router.handleMessage({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'browser_debug_leak_token', arguments: { session: 'dual-auth', account: '2' } },
    });
    assert.equal(errRes.result.isError, true);
    assert.ok(!errRes.result.content[0].text.includes('SECRET_TOKEN'));
    assert.ok(errRes.result.content[0].text.includes('<redacted>'));
  } finally {
    await router.shutdown();
  }
});

test('browser_close, maxSessions cap, idle eviction, and crash recovery work cleanly', async () => {
  const router = new PlaywrightMcpRouter(makeConfig({ maxSessions: 2, idleTimeoutMs: 5000 }));
  try {
    await router.handleMessage({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'browser_tabs', arguments: { session: 's1', action: 'list' } },
    });
    await router.handleMessage({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: { name: 'browser_tabs', arguments: { session: 's2', action: 'list' } },
    });

    // 3rd concurrent session rejected by maxSessions=2
    const capErr = await router.handleMessage({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: { name: 'browser_tabs', arguments: { session: 's3', action: 'list' } },
    });
    assert.equal(capErr.result.isError, true);
    assert.match(capErr.result.content[0].text, /Max concurrent sessions/);

    // browser_close evicts s1
    await router.handleMessage({
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: { name: 'browser_close', arguments: { session: 's1' } },
    });
    assert.equal(router.sessions.size, 1);

    // Crash s2 and verify recovery on next call
    const oldPid = router.sessions.get('1::s2').pid;
    const crashRes = await router.handleMessage({
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: { name: 'browser_debug_crash', arguments: { session: 's2' } },
    });
    assert.equal(crashRes.result.isError, true);
    assert.equal(router.sessions.size, 0);

    const recovered = parseToolJson(
      await router.handleMessage({
        jsonrpc: '2.0',
        id: 35,
        method: 'tools/call',
        params: { name: 'browser_tabs', arguments: { session: 's2', action: 'list' } },
      })
    );
    assert.notEqual(recovered.pid, oldPid);

    // Idle eviction
    const evicted = await router.evictIdleSessions(Date.now() + 10_000);
    assert.equal(evicted, 1);
    assert.equal(router.sessions.size, 0);
  } finally {
    await router.shutdown();
  }
});
