/** Gemini's decoding grammar is deliberately smaller than the application
 * contract. Dynamic references, capacities, numeric bounds and conditional
 * applicability remain enforced by the existing host validators. Never trim
 * candidate lists or change the original response schema to satisfy serving. */
export function geminiGenerationSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const classifiers = new Set(["kind", "action", "tool"]);
  const visit = (raw: unknown, field = ""): any => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const s = raw as Record<string, any>,
      out: Record<string, any> = {};
    for (const key of [
      "type",
      "$ref",
      "title",
      "description",
      "additionalProperties",
    ])
      if (s[key] !== undefined)
        out[key] = typeof s[key] === "object" ? visit(s[key]) : s[key];
    if (s.properties)
      out.properties = Object.fromEntries(
        Object.entries(s.properties).map(([name, value]) => [
          name,
          visit(value, name),
        ]),
      );
    if (s.required?.length) out.required = [...s.required];
    if (s.items) out.items = visit(s.items);
    if (s.$defs)
      out.$defs = Object.fromEntries(
        Object.entries(s.$defs).map(([name, value]) => [name, visit(value)]),
      );
    // Property-only alternatives express business conditions, not alternative
    // JSON types. Applying their cross product at generation time is prohibitive.
    if (
      s.anyOf?.every(
        (branch: any) => branch.type !== undefined || branch.$ref !== undefined,
      )
    )
      out.anyOf = s.anyOf.map((branch: any) => visit(branch, field));
    // Complete, discriminated object alternatives already contain their shared
    // fields. Avoid compiling a second copy of the optional-property grammar.
    if (
      s.properties &&
      s.anyOf?.every(
        (branch: any) =>
          branch.type === "object" && branch.additionalProperties === false,
      )
    ) {
      delete out.properties;
      delete out.required;
      delete out.additionalProperties;
    }
    if (s.enum && classifiers.has(field)) out.enum = [...s.enum];
    if (s.const !== undefined && classifiers.has(field)) out.enum = [s.const];
    // Constraints omitted from the grammar remain visible to the model. This is
    // descriptive metadata, not a cropped allowlist or a new application limit.
    const guidance: string[] = [];
    if (s.enum && !classifiers.has(field))
      guidance.push("允许值仅为 " + JSON.stringify(s.enum));
    if (s.const !== undefined && !classifiers.has(field))
      guidance.push("固定值为 " + JSON.stringify(s.const));
    for (const key of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
      "uniqueItems",
    ])
      if (s[key] !== undefined)
        guidance.push(key + "=" + JSON.stringify(s[key]));
    if (s.anyOf && !out.anyOf)
      guidance.push("必须满足以下动作参数条件之一：" + JSON.stringify(s.anyOf));
    if (guidance.length)
      out.description = [out.description, ...guidance]
        .filter(Boolean)
        .join("；");
    return out;
  };
  return visit(schema);
}

export const geminiSchemaInstruction =
  "生成要求：只返回符合响应结构的JSON对象。生成侧Schema只限制结构与固定动作分类；原提示中的授权名称、引用、必填参数、字段适用范围、数量、长度、兵力及期限限制仍必须遵守。未使用的可选字段省略，不填占位值；null、0、false和空数组含义不同。生成侧未列举名称或容量不表示允许新名称或更大容量。";
