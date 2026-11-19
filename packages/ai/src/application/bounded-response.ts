/** Assemble bytes before decoding: network chunks may split UTF-8 characters.
 * HTTP status, JSON shape and protocol-specific errors belong to the caller. */
export async function readBoundedResponse(
  response: Response,
  maximum: number,
  failure: (kind: 'missing' | 'limit', bytes: number) => Error = kind =>
    Error(kind === 'missing' ? 'Missing response' : 'Response too large'),
): Promise<string> {
  if (!response.body) throw failure('missing', 0);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) throw failure('limit', bytes);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    // Cancellation must not hide the original read or protocol failure.
    try { await reader.cancel(); } catch { /* The stream may already have failed. */ }
    reader.releaseLock();
  }
}
