import { PlaywrightWorker } from './worker.js';
import {
  VALID_COLORS,
  getPackageVersion,
  redactSecrets,
  sanitizeSessionName,
} from './config.js';
import { jsonRpcError, jsonRpcResult } from './jsonrpc.js';

export class PlaywrightMcpRouter {
  constructor(config, { logger = () => {} } = {}) {
    this.config = config;
    this.logger = logger;

    this.protocolVersion = '2024-11-05';
    this.sessions = new Map(); // sessionKey -> PlaywrightWorker
    this.pendingStarts = new Map(); // sessionKey -> Promise<PlaywrightWorker>
    this.colorCounters = new Map(); // accountKey -> number
    this.cachedTools = null;
    this.discoveryPromise = null;
    this.shuttingDown = false;

    this.gcTimer = null;
    if (this.config.idleTimeoutMs > 0) {
      const intervalMs = Math.min(60_000, Math.max(5_000, Math.floor(this.config.idleTimeoutMs / 3)));
      this.gcTimer = setInterval(() => {
        void this.evictIdleSessions();
      }, intervalMs);
      this.gcTimer.unref?.();
    }
  }

  _sessionKey(accountKey, sessionName) {
    return `${accountKey}::${sessionName}`;
  }

  _accountSummaryText() {
    return Object.values(this.config.accounts)
      .map((a) => `'${a.key}' (${a.label})`)
      .join(', ');
  }

  _nextColor(account, requestedColor) {
    if (requestedColor && VALID_COLORS.includes(requestedColor)) {
      return requestedColor;
    }
    const palette = account.colors?.length ? account.colors : ['blue'];
    const idx = this.colorCounters.get(account.key) || 0;
    this.colorCounters.set(account.key, idx + 1);
    return palette[idx % palette.length];
  }

  _augmentToolSchema(rawTool) {
    const accountKeys = Object.keys(this.config.accounts);
    const origSchema = rawTool.inputSchema && typeof rawTool.inputSchema === 'object'
      ? rawTool.inputSchema
      : { type: 'object', properties: {} };

    const origProps = origSchema.properties && typeof origSchema.properties === 'object'
      ? origSchema.properties
      : {};
    const origRequired = Array.isArray(origSchema.required) ? origSchema.required : [];

    const properties = {
      session: {
        type: 'string',
        description:
          'Required isolated session name (also displayed as the Chrome tab group title), e.g. "T1867-api-debug" or "home-css". Use a unique, descriptive task name per conversation so concurrent agents never hijack each other\'s active tab.',
      },
      account: {
        type: 'string',
        enum: accountKeys,
        default: this.config.defaultAccount,
        description: `Chrome account profile to use (defaults to '${this.config.defaultAccount}'). Configured accounts: ${this._accountSummaryText()}.`,
      },
      color: {
        type: 'string',
        enum: VALID_COLORS,
        description: 'Optional Chrome tab group color override for a newly created session.',
      },
      ...origProps,
    };

    const required = ['session', ...origRequired.filter((r) => r !== 'session')];

    return {
      ...rawTool,
      inputSchema: {
        ...origSchema,
        type: 'object',
        properties,
        required,
      },
    };
  }

  _routerManagementTools() {
    const accountKeys = Object.keys(this.config.accounts);
    return [
      {
        name: 'router_list_sessions',
        description:
          'List all active isolated browser sessions managed by playwright-mcp-router, along with configured Chrome accounts (without exposing secrets).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'router_close_session',
        description:
          'Gracefully close a specific isolated browser session (closes its Chrome tab group and terminates its worker process). Always close your session when finished.',
        inputSchema: {
          type: 'object',
          properties: {
            session: {
              type: 'string',
              description: 'The session name to close.',
            },
            account: {
              type: 'string',
              enum: accountKeys,
              default: this.config.defaultAccount,
              description: `Account owning the session (defaults to '${this.config.defaultAccount}').`,
            },
          },
          required: ['session'],
        },
      },
      {
        name: 'router_close_all_sessions',
        description: 'Gracefully close all active browser sessions managed by playwright-mcp-router.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async _discoverTools() {
    if (this.cachedTools) return this.cachedTools;
    if (this.discoveryPromise) return this.discoveryPromise;

    this.discoveryPromise = (async () => {
      const defaultAcc = this.config.accounts[this.config.defaultAccount];
      const probe = new PlaywrightWorker({
        config: this.config,
        account: defaultAcc,
        sessionName: '',
        color: undefined,
        isDiscovery: true,
      });

      try {
        await probe.start(this.protocolVersion);
        const rawTools = await probe.listTools();
        const augmented = rawTools.map((t) => this._augmentToolSchema(t));
        this.cachedTools = [...this._routerManagementTools(), ...augmented];
        return this.cachedTools;
      } finally {
        await probe.close({ callBrowserClose: false });
        this.discoveryPromise = null;
      }
    })();

    return this.discoveryPromise;
  }

  _resolveAccount(accountKey) {
    const key = accountKey ?? this.config.defaultAccount;
    const acc = this.config.accounts[key];
    if (!acc) {
      throw new Error(
        `Unknown account "${key}". Available accounts: ${this._accountSummaryText()}.`
      );
    }
    return acc;
  }

  async _getOrCreateWorker(account, sessionName, requestedColor) {
    const key = this._sessionKey(account.key, sessionName);

    const existing = this.sessions.get(key);
    if (existing && existing.alive) {
      return existing;
    }
    if (existing && !existing.alive) {
      this.sessions.delete(key);
    }

    if (this.pendingStarts.has(key)) {
      return this.pendingStarts.get(key);
    }

    if (this.sessions.size + this.pendingStarts.size >= this.config.maxSessions) {
      const activeNames = [...this.sessions.keys()].join(', ');
      throw new Error(
        `Max concurrent sessions (${this.config.maxSessions}) reached. Active sessions: [${activeNames}]. Close an unused session via router_close_session or browser_close first.`
      );
    }

    const color = this._nextColor(account, requestedColor);
    const startPromise = (async () => {
      const worker = new PlaywrightWorker({
        config: this.config,
        account,
        sessionName,
        color,
      });
      worker.onExitCallback = () => {
        if (this.sessions.get(key) === worker) {
          this.sessions.delete(key);
        }
      };

      await worker.start(this.protocolVersion);
      if (this.shuttingDown) {
        await worker.close({ callBrowserClose: false });
        throw new Error('Router is shutting down.');
      }
      this.sessions.set(key, worker);
      this.logger(`started session "${sessionName}" on account "${account.key}" (pid=${worker.pid}, color=${color})`);
      return worker;
    })();

    this.pendingStarts.set(key, startPromise);
    try {
      return await startPromise;
    } finally {
      this.pendingStarts.delete(key);
    }
  }

  _handleListSessions() {
    const now = Date.now();
    const sessions = [];
    for (const [key, worker] of this.sessions.entries()) {
      sessions.push({
        key,
        account: worker.account.key,
        accountLabel: worker.account.label,
        session: worker.sessionName,
        color: worker.color,
        pid: worker.pid,
        alive: worker.alive,
        callCount: worker.callCount,
        createdAt: new Date(worker.createdAt).toISOString(),
        lastUsedAt: new Date(worker.lastUsedAt).toISOString(),
        idleSeconds: Math.max(0, Math.round((now - worker.lastUsedAt) / 1000)),
      });
    }

    const accounts = Object.values(this.config.accounts).map((a) => ({
      account: a.key,
      label: a.label,
      profileDirName: a.profileDirName || null,
      isDefault: a.key === this.config.defaultAccount,
      mode: a.extension ? 'extension' : 'standalone',
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              activeSessionCount: sessions.length,
              maxSessions: this.config.maxSessions,
              idleTimeoutMs: this.config.idleTimeoutMs,
              accounts,
              sessions,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  async _handleCloseSession(args = {}) {
    const account = this._resolveAccount(args.account);
    const sessionName = sanitizeSessionName(args.session);
    const key = this._sessionKey(account.key, sessionName);

    const worker = this.sessions.get(key);
    if (!worker) {
      return {
        content: [
          {
            type: 'text',
            text: `Session "${sessionName}" (account "${account.key}") is not active.`,
          },
        ],
      };
    }

    this.sessions.delete(key);
    await worker.close({ callBrowserClose: true });
    this.logger(`closed session "${sessionName}" on account "${account.key}"`);
    return {
      content: [
        {
          type: 'text',
          text: `Closed session "${sessionName}" on account "${account.key}".`,
        },
      ],
    };
  }

  async _handleCloseAllSessions() {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(entries.map(([, w]) => w.close({ callBrowserClose: true })));
    return {
      content: [
        {
          type: 'text',
          text: `Closed ${entries.length} active session(s).`,
        },
      ],
    };
  }

  async _handleToolCall(params = {}) {
    const { name, arguments: rawArgs } = params;
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

    if (name === 'router_list_sessions') {
      return this._handleListSessions();
    }
    if (name === 'router_close_session') {
      return this._handleCloseSession(args);
    }
    if (name === 'router_close_all_sessions') {
      return this._handleCloseAllSessions();
    }

    const account = this._resolveAccount(args.account);
    const sessionName = sanitizeSessionName(args.session);
    const requestedColor = args.color;

    const forwardedArgs = { ...args };
    delete forwardedArgs.session;
    delete forwardedArgs.account;
    delete forwardedArgs.color;

    const key = this._sessionKey(account.key, sessionName);

    // If caller closes an already non-existent session via browser_close, no need to spawn one
    if (name === 'browser_close' && !this.sessions.has(key) && !this.pendingStarts.has(key)) {
      return {
        content: [
          {
            type: 'text',
            text: `Session "${sessionName}" (account "${account.key}") is already closed.`,
          },
        ],
      };
    }

    const worker = await this._getOrCreateWorker(account, sessionName, requestedColor);
    const result = await worker.callTool(name, forwardedArgs);

    // Cleanly evict worker after browser_close so no idle orphan process lingers
    if (name === 'browser_close') {
      this.sessions.delete(key);
      await worker.close({ callBrowserClose: false });
      this.logger(`evicted session "${sessionName}" after browser_close`);
    }

    return result;
  }

  async evictIdleSessions(now = Date.now()) {
    if (this.config.idleTimeoutMs <= 0) return 0;
    const expired = [];
    for (const [key, worker] of this.sessions.entries()) {
      if (now - worker.lastUsedAt >= this.config.idleTimeoutMs) {
        expired.push([key, worker]);
      }
    }
    for (const [key] of expired) {
      this.sessions.delete(key);
    }
    await Promise.all(
      expired.map(async ([key, worker]) => {
        this.logger(`evicting idle session "${key}"`);
        await worker.close({ callBrowserClose: true });
      })
    );
    return expired.length;
  }

  async handleMessage(msg) {
    // Notifications have no id and expect no reply
    if (msg.id === undefined || msg.id === null) {
      return null;
    }

    try {
      switch (msg.method) {
        case 'initialize': {
          if (msg.params?.protocolVersion) {
            this.protocolVersion = msg.params.protocolVersion;
          }
          return jsonRpcResult(msg.id, {
            protocolVersion: this.protocolVersion,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'playwright-mcp-router',
              version: getPackageVersion(),
            },
          });
        }
        case 'ping':
          return jsonRpcResult(msg.id, {});
        case 'tools/list': {
          const tools = await this._discoverTools();
          return jsonRpcResult(msg.id, { tools });
        }
        case 'tools/call': {
          try {
            const result = await this._handleToolCall(msg.params);
            return jsonRpcResult(msg.id, result);
          } catch (err) {
            const text = redactSecrets(err?.message || String(err), this.config);
            return jsonRpcResult(msg.id, {
              isError: true,
              content: [{ type: 'text', text }],
            });
          }
        }
        case 'resources/list':
          return jsonRpcResult(msg.id, { resources: [] });
        case 'prompts/list':
          return jsonRpcResult(msg.id, { prompts: [] });
        default:
          return jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      const text = redactSecrets(err?.message || String(err), this.config);
      return jsonRpcError(msg.id, -32603, text);
    }
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(entries.map(([, w]) => w.close({ callBrowserClose: true })));
  }
}
