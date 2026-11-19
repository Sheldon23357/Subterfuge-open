export const codexDisabledFeatures=['shell_tool','unified_exec','multi_agent','multi_agent_v2','apps','plugins','memories','skill_search','view_image','code_mode','code_mode_host','in_app_browser','workspace_dependencies','hooks'] as const;
export function codexIsolationArguments(effort:'low'|'medium'|'high'='low',serviceTier=process.env.AI_CODEX_SERVICE_TIER){
 if(serviceTier!==undefined&&serviceTier!=='fast'&&serviceTier!=='default')throw Error('AI_CODEX_SERVICE_TIER must be default or fast when set');
 const args:string[]=[];
 for(const feature of codexDisabledFeatures)args.push('--disable',feature);
 args.push('--enable','skip_host_skill_discovery');
 if(serviceTier==='fast')args.push('--enable','fast_mode','-c','service_tier="fast"');
 for(const setting of ['web_search="disabled"','project_doc_max_bytes=0','mcp_servers={}','apps._default.enabled=false',`model_reasoning_effort="${effort}"`])args.push('-c',setting);
 return args;
}
