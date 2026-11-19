/** Decode only after assembling the bounded byte stream. A transport chunk
 * may end in the middle of a UTF-8 codepoint (including snapshot IDs). */
export async function readJsonBody(parts: AsyncIterable<Uint8Array>, limit = 20_000_000): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const part of parts) {
    size += part.byteLength;
    if (size > limit) throw Error('文件过大');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}
