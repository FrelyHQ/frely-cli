/** Largest piece sent as one `stream_chunk`; a base64url string of this many bytes stays below the 1 MiB `data` limit. */
export const STREAM_PIECE_BYTES = 256 * 1024;
/** Buffered bytes that trigger an immediate flush. */
export const COALESCE_MAX_BYTES = 16 * 1024;
/** Longest a buffered byte waits before it is flushed. */
export const COALESCE_WINDOW_MS = 20;

export interface CoalesceOptions {
  maxBytes?: number;
  windowMs?: number;
}

/**
 * Pumps `reader` into `send`, merging small reads so a token-by-token Provider stream does not become one relay frame per token.
 * The first read is sent at once (time to first token is unchanged); later reads wait up to `windowMs` or `maxBytes`.
 * Returns true when the stream ended, false when `cancelled` stopped it; buffered bytes are dropped on cancel and flushed before a read error is rethrown.
 */
export async function forwardCoalesced(
  reader: { read(): Promise<ReadableStreamReadResult<Uint8Array>> },
  send: (piece: Uint8Array) => Promise<void>,
  cancelled: () => boolean,
  options: CoalesceOptions = {},
): Promise<boolean> {
  const maxBytes = options.maxBytes ?? COALESCE_MAX_BYTES;
  const windowMs = options.windowMs ?? COALESCE_WINDOW_MS;
  let pending: Uint8Array[] = [];
  let size = 0;
  let deadline = 0;
  let first = true;

  const emit = async (data: Uint8Array) => {
    for (let offset = 0; offset < data.byteLength; offset += STREAM_PIECE_BYTES) {
      if (cancelled()) return;
      await send(data.subarray(offset, Math.min(offset + STREAM_PIECE_BYTES, data.byteLength)));
    }
  };
  const flush = async () => {
    if (size === 0) return;
    const merged = pending.length === 1 ? pending[0]! : concat(pending, size);
    pending = []; size = 0;
    await emit(merged);
  };

  const next = () => { const promise = reader.read(); promise.catch(() => undefined); return promise; };
  let read = next();
  while (!cancelled()) {
    let part: ReadableStreamReadResult<Uint8Array>;
    try {
      if (size === 0) part = await read;
      else {
        const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
        const expired = new Promise<"timeout">((resolve) => { timer.id = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now())); });
        try {
          const winner = await Promise.race([read, expired]);
          if (winner === "timeout") { await flush(); continue; }
          part = winner;
        } finally { clearTimeout(timer.id); }
      }
    } catch (error) {
      if (!cancelled()) await flush().catch(() => undefined);
      throw error;
    }
    if (part.done) {
      if (!cancelled()) await flush();
      return !cancelled();
    }
    const value = part.value;
    read = next();
    if (value.byteLength === 0) continue;
    if (first) { first = false; await emit(value); continue; }
    if (size === 0) deadline = Date.now() + windowMs;
    pending.push(value); size += value.byteLength;
    if (size >= maxBytes) await flush();
  }
  return false;
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}
