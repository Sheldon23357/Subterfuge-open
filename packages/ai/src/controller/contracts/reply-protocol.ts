import {parseModelJson} from './model-json.js';
import {commanderReplySchema,type CommanderMode} from './commander-protocol.js';
import {STRUCTURED_ARGUMENT_DEFINITIONS,STRUCTURED_ARGUMENT_SCHEMA_BY_TOOL,STRUCTURED_TOOLS,normalizeStructuredArguments} from './structured-arguments.js';
import {toolNamesWhere} from './tool-metadata.js';
import type {AgentReply} from './types.js';
const STRING_TOOLS=toolNamesWhere(tool=>tool.wireShape==='json-string');
export const AGENT_REPLY_SCHEMA = {
  $defs:STRUCTURED_ARGUMENT_DEFINITIONS,
  type: "object",
  additionalProperties: false,
  required: ["request", "summary", "nextContext"],
  properties: {
    request:{anyOf:[
      ...STRUCTURED_TOOLS.map(tool=>({type:'object',additionalProperties:false,required:['tool','arguments'],properties:{tool:{type:'string',enum:[tool]},arguments:STRUCTURED_ARGUMENT_SCHEMA_BY_TOOL[tool]}})),
      {type:'object',additionalProperties:false,required:['tool','arguments'],properties:{tool:{type:'string',enum:STRING_TOOLS},arguments:{type:'string'}}},
    ]},
    summary: { type: "string" },
    nextContext: {type:'null'},
  },
};

export function agentReplySchema(mode?:CommanderMode){return mode===undefined?AGENT_REPLY_SCHEMA:commanderReplySchema(mode);}

/** Parse the provider-independent JSON envelope returned by a model. */
export function parseAgentReply(text: string,commanderMode?:CommanderMode): AgentReply {
  const wire = parseModelJson(text) as any;
  if(!wire||!Object.hasOwn(wire,'summary')||Object.keys(wire).some(k=>!['request','summary','nextContext'].includes(k))||!wire.request||Object.keys(wire.request).sort().join(',')!=='arguments,tool')throw Error('Invalid Codex reply');
  const reply = {...wire.request,summary:wire.summary} as AgentReply;
  if (
    !reply ||
    Object.keys(reply).sort().join(",") !== "arguments,summary,tool" ||
    !(STRUCTURED_TOOLS.includes(reply.tool)
      ? reply.arguments && typeof reply.arguments === 'object' && !Array.isArray(reply.arguments)
      : typeof reply.arguments === 'string' || !!reply.arguments && typeof reply.arguments === 'object' && !Array.isArray(reply.arguments)) ||
    (typeof reply.arguments==='string'?reply.arguments.length:JSON.stringify(reply.arguments).length) > 55000 ||
    typeof reply.summary !== "string" ||
    reply.summary.length > 2000 ||
    ![...STRING_TOOLS,...STRUCTURED_TOOLS].includes(reply.tool)
  )
    throw Error("Invalid Codex reply");
  // Keep commander arguments intact for capture and the isolated host validator.
  // Ordinary decisions retain their existing normalization and execution path.
  if(commanderMode===undefined&&STRUCTURED_TOOLS.includes(reply.tool)&&typeof reply.arguments!=='string')reply.arguments=normalizeStructuredArguments(reply.arguments,reply.tool);
  if(wire.nextContext!==undefined&&wire.nextContext!==null)throw Error('nextContext must be null: context is managed for the whole round');
  reply.nextContext=null;
  return reply;
}
