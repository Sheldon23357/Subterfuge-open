export const AGENT_PROVIDER_PRESETS = {
  gemini:{label:'Gemini · 原生',baseUrl:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-4-argon',apiStyle:'chat',responseFormat:'json_schema'},
  deepseek:{label:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',apiStyle:'chat',responseFormat:'json_object'},
  openrouter:{label:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',model:'deepseek/deepseek-v4.1-flash',apiStyle:'chat',responseFormat:'json_object'},
  minimax:{label:'MiniMax',baseUrl:'https://api.minimaxi.com/v1',model:'MiniMax-M3.1-Flash',apiStyle:'chat',responseFormat:'json_object'},
} as const;
export type AgentProviderPreset = keyof typeof AGENT_PROVIDER_PRESETS;
