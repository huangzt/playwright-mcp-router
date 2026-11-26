/**
 * Lightweight newline-delimited JSON-RPC 2.0 helpers for MCP stdio transport.
 */

export function attachLineJsonReader(stream, onMessage, onError) {
  let buffer = '';

  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '').trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!rawLine) continue;
      try {
        const msg = JSON.parse(rawLine);
        onMessage(msg);
      } catch (err) {
        if (onError) onError(err, rawLine);
      }
    }
  };

  stream.on('data', onData);
  return () => {
    stream.off('data', onData);
  };
}

export function writeJsonRpc(stream, message) {
  if (!stream || stream.destroyed || !stream.writable) return false;
  try {
    stream.write(`${JSON.stringify(message)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}
