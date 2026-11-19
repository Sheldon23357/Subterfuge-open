export function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Expected object");
  return raw as Record<string, unknown>;
}
export function keys(
  o: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((k) => !Object.hasOwn(o, k)) ||
    Object.keys(o).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw Error(JSON.stringify({code:'INVALID_TOOL_FIELDS',message:'Invalid tool fields',path:'$',missingFields:required.filter(k=>!Object.hasOwn(o,k)),unknownFields:Object.keys(o).filter(k=>!required.includes(k)&&!optional.includes(k)),correction:'Supply required fields and remove or correct unknown field names; no writes saved'}));
}
