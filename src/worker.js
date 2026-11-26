import { spawn } from 'node:child_process';
import { attachLineJsonReader, writeJsonRpc, jsonRpcResult } from './jsonrpc.js';
import { redactSecrets } from './config.js';

export function buildWorkerArgs(config, account, sessionName, color) {
  const baseArgs = [...config.playwrightArgs];
  const wantsExtension = account.extension && (baseArgs.includes('--extension') || Boolean(account.token));

  // Filter out conflicting flags when non-extension mode is requested for a specific account
  const args = wantsExtension
    ? [...baseArgs]
    : baseArgs.filter((a) => a !== '--extension' && a !== '--background' && !a.startsWith('--profile-dir-name'));

  if (wantsExtension && !args.includes('--extension')) {
    args.push('--extension');
  }

  if (wantsExtension && account.profileDirName) {
    const hasProfileFlag = args.some((a) => a === '--profile-dir-name' || a.startsWith('--profile-dir-name='));
    if (!hasProfileFlag) {
      args.push(`--profile-dir-name=${account.profileDirName}`);
    }
  }

  if (sessionName) {
    args.push(`--session-name=${sessionName}`);
  }
  if (color) {
    args.push(`--session-color=${color}`);
  }

  if (!args.includes('--ignore-roots')) {
    args.push('--ignore-roots');
  }

  for (const extra of account.extraArgs || []) {
    args.push(extra);
  }

  return args;
}

export class PlaywrightWorker {
  constructor({ config, account, sessionName, color, isDiscovery = false }) {
    this.config = config;
    this.account = account;
    this.sessionName = sessionName;
    this.color = color;
    this.isDiscovery = isDiscovery;

    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrChunks = [];
    this.alive = false;
    this.closed = false;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.callCount = 0;
    this.onExitCallback = null;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  getRecentStderr() {
    const text = this.stderrChunks.join('').trim();
    return redactSecrets(text.slice(-1500), this.config);
  }

  async start(protocolVersion = '2024-11-05') {
    const workerArgs = this.isDiscovery
      ? [...this.config.playwrightArgs, '--ignore-roots']
      : buildWorkerArgs(this.config, this.account, this.sessionName, this.color);

    const fullArgs = [...this.config.launcher.prefixArgs, ...workerArgs];
    const env = { ...process.env };
    if (!this.isDiscovery && this.account.token) {
      env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = this.account.token;
    } else {
      delete env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    }

    this.child = spawn(this.config.launcher.command, fullArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.alive = true;

    attachLineJsonReader(
      this.child.stdout,
      (msg) => this._handleMessage(msg),
      () => {}
    );

    this.child.stderr.on('data', (chunk) => {
      this.stderrChunks.push(chunk.toString('utf8'));
      if (this.stderrChunks.length > 40) {
        this.stderrChunks.shift();
      }
    });

    this.child.on('error', (err) => {
      this._failAllPending(new Error(`Worker process error: ${err.message}`));
    });

    this.child.on('exit', (code, signal) => {
      this.alive = false;
      const detail = this.getRecentStderr();
      const reason = `Worker exited (code=${code}, signal=${signal})${detail ? `: ${detail}` : ''}`;
      this._failAllPending(new Error(reason));
      if (this.onExitCallback) {
        const cb = this.onExitCallback;
        this.onExitCallback = null;
        cb(code, signal);
      }
    });

    await this.request(
      'initialize',
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'playwright-mcp-router', version: '0.1.0' },
      },
      this.config.startupTimeoutMs
    );
    writeJsonRpc(this.child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  _handleMessage(msg) {
    // Handle reverse server->client requests so workers never stall
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'roots/list') {
        writeJsonRpc(this.child.stdin, jsonRpcResult(msg.id, { roots: [] }));
      } else if (msg.method === 'ping') {
        writeJsonRpc(this.child.stdin, jsonRpcResult(msg.id, {}));
      } else {
        writeJsonRpc(this.child.stdin, {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
        });
      }
      return;
    }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(redactSecrets(msg.error.message || 'Worker RPC error', this.config));
        err.code = msg.error.code;
        err.data = msg.error.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  _failAllPending(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  request(method, params = {}, timeoutMs = this.config.callTimeoutMs) {
    if (!this.alive || !this.child?.stdin?.writable) {
      return Promise.reject(new Error('Playwright worker is not running.'));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for worker method "${method}".`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      const ok = writeJsonRpc(this.child.stdin, { jsonrpc: '2.0', id, method, params });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Failed to write JSON-RPC message to worker stdin.'));
      }
    });
  }

  async listTools() {
    const res = await this.request('tools/list', {}, this.config.startupTimeoutMs);
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(name, args = {}) {
    this.lastUsedAt = Date.now();
    this.callCount += 1;
    const res = await this.request('tools/call', { name, arguments: args }, this.config.callTimeoutMs);
    this.lastUsedAt = Date.now();
    return res;
  }

  async close({ callBrowserClose = true } = {}) {
    if (this.closed) return;
    this.closed = true;

    if (callBrowserClose && this.alive && !this.isDiscovery && this.callCount > 0) {
      try {
        await this.request('tools/call', { name: 'browser_close', arguments: {} }, 4000);
      } catch {
        // Best-effort tab group cleanup
      }
    }

    const child = this.child;
    if (!child) return;

    await new Promise((resolve) => {
      if (!this.alive) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
      killTimer.unref?.();

      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }
}
