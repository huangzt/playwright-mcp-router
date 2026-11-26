import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VALID_COLORS = [
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, '..', 'package.json');

export function getPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function expandHome(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function interpolateEnv(value, env = process.env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => env[key] ?? '');
}

export function parseCliArgs(argv) {
  const opts = {
    configPath: undefined,
    playwrightBin: undefined,
    idleTimeoutMs: undefined,
    maxSessions: undefined,
    defaultAccount: undefined,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-v' || arg === '--version') {
      opts.version = true;
    } else if (arg === '--config' && argv[i + 1]) {
      opts.configPath = argv[++i];
    } else if (arg.startsWith('--config=')) {
      opts.configPath = arg.slice('--config='.length);
    } else if (arg === '--playwright-bin' && argv[i + 1]) {
      opts.playwrightBin = argv[++i];
    } else if (arg.startsWith('--playwright-bin=')) {
      opts.playwrightBin = arg.slice('--playwright-bin='.length);
    } else if (arg === '--idle-timeout' && argv[i + 1]) {
      opts.idleTimeoutMs = Number(argv[++i]);
    } else if (arg.startsWith('--idle-timeout=')) {
      opts.idleTimeoutMs = Number(arg.slice('--idle-timeout='.length));
    } else if (arg === '--max-sessions' && argv[i + 1]) {
      opts.maxSessions = Number(argv[++i]);
    } else if (arg.startsWith('--max-sessions=')) {
      opts.maxSessions = Number(arg.slice('--max-sessions='.length));
    } else if (arg === '--default-account' && argv[i + 1]) {
      opts.defaultAccount = argv[++i];
    } else if (arg.startsWith('--default-account=')) {
      opts.defaultAccount = arg.slice('--default-account='.length);
    }
  }

  return opts;
}

export function resolvePlaywrightLauncher(explicitBin, env = process.env) {
  const candidate = explicitBin || env.PLAYWRIGHT_MCP_BIN;
  if (candidate) {
    const resolved = expandHome(candidate);
    if (/\.(c|m)?js$/i.test(resolved)) {
      return { command: process.execPath, prefixArgs: [resolved] };
    }
    return { command: resolved, prefixArgs: [] };
  }

  // Try locating globally installed @playwright/mcp alongside current Node binary
  const nodeDir = path.dirname(process.execPath);
  const globalCliCandidates = [
    path.resolve(nodeDir, '..', 'lib', 'node_modules', '@playwright', 'mcp', 'cli.js'),
    path.resolve(nodeDir, 'node_modules', '@playwright', 'mcp', 'cli.js'),
  ];
  for (const cliPath of globalCliCandidates) {
    if (fs.existsSync(cliPath)) {
      return { command: process.execPath, prefixArgs: [cliPath] };
    }
  }

  // Fallback to npx
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { command: npxBin, prefixArgs: ['-y', '@playwright/mcp@latest'] };
}

export function loadConfig(argv = [], env = process.env) {
  const cli = parseCliArgs(argv);
  const defaultConfigPath = path.join(os.homedir(), '.config', 'playwright-mcp-router', 'accounts.json');
  const explicitConfigPath = cli.configPath || env.PLAYWRIGHT_ROUTER_CONFIG;

  let fileConfig = {};
  let loadedConfigPath = null;

  if (explicitConfigPath) {
    const resolved = expandHome(explicitConfigPath);
    const raw = fs.readFileSync(resolved, 'utf8');
    fileConfig = JSON.parse(raw);
    loadedConfigPath = resolved;
  } else if (fs.existsSync(defaultConfigPath)) {
    const raw = fs.readFileSync(defaultConfigPath, 'utf8');
    fileConfig = JSON.parse(raw);
    loadedConfigPath = defaultConfigPath;
  }

  const rawAccounts = fileConfig.accounts || {};
  const accounts = {};

  for (const [key, acc] of Object.entries(rawAccounts)) {
    if (!acc || typeof acc !== 'object') continue;
    const colors = Array.isArray(acc.colors)
      ? acc.colors.filter((c) => VALID_COLORS.includes(c))
      : acc.color && VALID_COLORS.includes(acc.color)
        ? [acc.color]
        : ['blue', 'cyan', 'purple'];

    accounts[key] = {
      key,
      label: acc.label || `Account ${key}`,
      profileDirName: acc.profileDirName ? interpolateEnv(acc.profileDirName, env) : undefined,
      token: acc.token ? interpolateEnv(acc.token, env) : undefined,
      extension: acc.extension !== false,
      colors: colors.length > 0 ? colors : ['blue'],
      extraArgs: Array.isArray(acc.extraArgs) ? acc.extraArgs.map((a) => interpolateEnv(String(a), env)) : [],
    };
  }

  // Allow zero-config quickstart via environment variables
  if (Object.keys(accounts).length === 0) {
    const token = env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    accounts['default'] = {
      key: 'default',
      label: token ? 'Default Chrome Profile (Extension)' : 'Isolated Browser',
      profileDirName: env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME || undefined,
      token: token || undefined,
      extension: Boolean(token),
      colors: ['blue', 'cyan', 'purple', 'green', 'orange'],
      extraArgs: [],
    };
  }

  const accountKeys = Object.keys(accounts);
  const defaultAccount = cli.defaultAccount || fileConfig.defaultAccount || accountKeys[0];
  if (!accounts[defaultAccount]) {
    throw new Error(
      `Configured defaultAccount "${defaultAccount}" does not exist in accounts (${accountKeys.join(', ')})`
    );
  }

  const idleTimeoutMs =
    Number.isFinite(cli.idleTimeoutMs)
      ? cli.idleTimeoutMs
      : Number.isFinite(fileConfig.idleTimeoutMs)
        ? fileConfig.idleTimeoutMs
        : 15 * 60 * 1000;

  const maxSessions =
    Number.isFinite(cli.maxSessions) && cli.maxSessions > 0
      ? cli.maxSessions
      : Number.isFinite(fileConfig.maxSessions) && fileConfig.maxSessions > 0
        ? fileConfig.maxSessions
        : 12;

  const playwrightArgs = Array.isArray(fileConfig.playwrightArgs)
    ? fileConfig.playwrightArgs.map(String)
    : ['--extension', '--background', '--caps=devtools'];

  const launcher = resolvePlaywrightLauncher(cli.playwrightBin || fileConfig.playwrightBin, env);

  return {
    cli,
    loadedConfigPath,
    defaultAccount,
    accounts,
    idleTimeoutMs,
    maxSessions,
    playwrightArgs,
    launcher,
    callTimeoutMs: Number.isFinite(fileConfig.callTimeoutMs) ? fileConfig.callTimeoutMs : 120_000,
    startupTimeoutMs: Number.isFinite(fileConfig.startupTimeoutMs) ? fileConfig.startupTimeoutMs : 30_000,
  };
}

export function redactSecrets(text, config) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const acc of Object.values(config?.accounts || {})) {
    if (acc.token && acc.token.length >= 8) {
      out = out.split(acc.token).join('<redacted>');
    }
  }
  return out;
}

export function sanitizeSessionName(rawName) {
  if (typeof rawName !== 'string') {
    throw new Error('Parameter "session" is required and must be a non-empty string (e.g. "T1867-api-debug").');
  }
  // Remove ASCII control characters and normalize whitespace
  const cleaned = rawName.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    throw new Error('Parameter "session" must not be blank. Provide a short descriptive task name.');
  }
  return cleaned.slice(0, 40);
}
