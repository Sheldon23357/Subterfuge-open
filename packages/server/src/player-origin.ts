/** Explicit external origin; forwarded headers never grant browser access. */
export function parsePlayerPublicOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('PLAYER_PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query or fragment');
  return url.origin;
}
