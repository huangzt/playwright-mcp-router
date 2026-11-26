import { getPackageVersion, loadConfig, parseCliArgs } from './config.js';
import { attachLineJsonReader, jsonRpcError, writeJsonRpc } from './jsonrpc.js';
import { PlaywrightMcpRouter } from './router.js';

function printHelp() {
  process.stdout.write(`playwright-mcp-router v${getPackageVersion()}

Session-isolated, multi-account MCP router for @playwright/mcp.

Usage:
  playwright-mcp-router [options]

Options:
  --config <path>           Path to accounts.json (default: ~/.config/playwright-mcp-router/accounts.json)
  --playwright-bin <path>   Path to @playwright/mcp cli.js or binary (auto-detected if omitted)
  --default-account <key>   Override default account key from config
  --idle-timeout <ms>       Idle session auto-close timeout in ms (default: 900000; 0 disables)
  --max-sessions <n>        Maximum concurrent isolated sessions (default: 12)
  -v, --version             Print version
  -h, --help                Print this help

Environment variables:
  PLAYWRIGHT_ROUTER_CONFIG       Same as --config
  PLAYWRIGHT_MCP_BIN             Same as --playwright-bin
  PLAYWRIGHT_MCP_EXTENSION_TOKEN Zero-config fallback token when no accounts.json exists
`);
}

export async function main(argv = []) {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    printHelp();
    return;
  }
  if (cli.version) {
    process.stdout.write(`${getPackageVersion()}\n`);
    return;
  }

  const config = loadConfig(argv, process.env);
  const log = (line) => {
    process.stderr.write(`[playwright-mcp-router] ${line}\n`);
  };

  const router = new PlaywrightMcpRouter(config, { logger: log });

  let exitScheduled = false;
  const gracefulExit = async (signal) => {
    if (exitScheduled) return;
    exitScheduled = true;
    if (signal) log(`received ${signal}, closing active sessions...`);
    await router.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void gracefulExit('SIGINT'));
  process.on('SIGTERM', () => void gracefulExit('SIGTERM'));

  process.stdin.on('end', () => void gracefulExit());
  process.stdin.on('close', () => void gracefulExit());

  attachLineJsonReader(
    process.stdin,
    async (msg) => {
      const response = await router.handleMessage(msg);
      if (response) {
        writeJsonRpc(process.stdout, response);
      }
    },
    (err) => {
      writeJsonRpc(process.stdout, jsonRpcError(null, -32700, `Parse error: ${err.message}`));
    }
  );
}
