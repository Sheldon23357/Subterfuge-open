import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenAICompatibleProvider} from '../packages/ai/src/application/providers/openai-compatible.js';
import {GeminiProvider} from '../packages/ai/src/application/providers/gemini.js';
import {encodePromptSections} from '../packages/contracts/src/index.js';

const schema={type:'object',additionalProperties:false,required:['summary','tasks'],properties:{summary:{type:'string'},tasks:{type:'array',items:{type:'string'}}}};
const framed=(facts:string,rules='Only use authorized current facts. Return JSON.')=>encodePromptSections([
 {id:'instructions.output',label:'Fixed rules',format:'text',text:rules},
 {id:'brief.global',label:'Current facts',format:'json',text:JSON.stringify({facts})},
]);
const schemaBlock='\nRequired output JSON Schema:\n'+JSON.stringify(schema);

for(const apiStyle of ['chat','responses'] as const)for(const responseFormat of ['json_schema','json_object','none'] as const)
test(`${apiStyle}/${responseFormat} preserves the original request layout with one independent current material`,async()=>{
 const bodies:any[]=[],source=structuredClone(schema);
 const provider=new OpenAICompatibleProvider({apiKey:'synthetic',baseUrl:'https://example.test/v1',apiStyle,responseFormat,
  fetchImpl:async(_url,init)=>{
   const body=JSON.parse(String(init?.body));bodies.push(body);
   const text=JSON.stringify({summary:'PREVIOUS_MODEL_OUTPUT_'+bodies.length,tasks:[]});
   return Response.json(apiStyle==='chat'?{choices:[{finish_reason:'stop',message:{content:text}}],usage:{prompt_tokens:1000,completion_tokens:10,prompt_tokens_details:{cached_tokens:300}}}
    :{status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text}]}],usage:{input_tokens:1000,output_tokens:10,input_tokens_details:{cached_tokens:300}}});
  }});
 for(let round=0;round<3;round++){
  const prompt=framed('CURRENT_'+round);
  const result=await provider.step({model:'synthetic',prompt,responseSchema:schema,providerSessionKey:'same-bot',providerSessionScope:{kind:'strategy',task:'overview'},signal:new AbortController().signal});
  assert.equal(result.usage!.cachedInputTokens,300);
  const body=bodies.at(-1),text=apiStyle==='chat'?body.messages.at(-1).content:body.input;
  assert.equal(text,responseFormat==='json_schema'?prompt:prompt+schemaBlock);
  if(apiStyle==='chat')assert.deepEqual(body.messages,[{role:'user',content:text}]);
  assert.equal(body.instructions,undefined);
  assert.equal(body.previous_response_id,undefined);assert.equal(body.conversation,undefined);
  assert.equal(text.includes('PREVIOUS_MODEL_OUTPUT_'),false,'no prior model output is appended');
  assert.equal(text.includes('CURRENT_'+round),true);
  for(let old=0;old<round;old++)assert.equal(text.includes('CURRENT_'+old),false,'old world snapshots are not appended');
  if(responseFormat==='json_schema'){
   assert.deepEqual(apiStyle==='chat'?body.response_format.json_schema.schema:body.text.format.schema,schema);
   assert.equal(text.includes('Required output JSON Schema:'),false);
  }else{
   assert.equal(text.slice(0,-schemaBlock.length),prompt,'all current material remains exact and occurs once');
   assert.equal(text.split('Required output JSON Schema:').length,2);
  }
 }
 assert.equal(new Set(bodies.map(b=>JSON.stringify(b).length)).size,1,'fixed-size current facts keep request size constant across rounds');
 assert.deepEqual(schema,source,'transport cannot modify the output contract');
});

test('framed, unframed, malformed and large prompts stay intact before the text schema suffix',async()=>{
 for(const prompt of ['unframed current text',framed('broken').slice(0,-1),encodePromptSections([
  {id:'brief.global',label:'Facts',format:'json',text:'{}'},
  {id:'instructions.output',label:'Late rules',format:'text',text:'not a fixed leading block'},
 ]),framed('current','x'.repeat(13000))]){
  let messages:any[]=[];const provider=new OpenAICompatibleProvider({apiKey:'synthetic',baseUrl:'https://example.test/v1',apiStyle:'chat',responseFormat:'json_object',fetchImpl:async(_url,init)=>{
   messages=JSON.parse(String(init?.body)).messages;return Response.json({choices:[{finish_reason:'stop',message:{content:'{"summary":"","tasks":[]}'}}]});
  }});
  await provider.step({model:'synthetic',prompt,responseSchema:schema,signal:new AbortController().signal});
  assert.deepEqual(messages,[{role:'user',content:prompt+schemaBlock}]);
 }
});

test('native Gemini keeps its native schema stable and sends only the current framed prompt on every call',async()=>{
 const bodies:any[]=[];
 const provider=new GeminiProvider({apiKey:'synthetic',fetchImpl:async(_url,init)=>{
  bodies.push(JSON.parse(String(init?.body)));
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"summary":"PREVIOUS_GEMINI_OUTPUT","tasks":[]}'}]}}]});
 }});
 for(let round=0;round<3;round++){
  const prompt=framed('CURRENT_'+round);
  await provider.step({model:'gemini-4-argon',prompt,responseSchema:schema,signal:new AbortController().signal});
  assert.deepEqual(bodies.at(-1).contents,[{role:'user',parts:[{text:prompt}]}]);
  assert.equal(bodies.at(-1).systemInstruction.parts[0].text.includes('[instructions.output'),false);
  assert.deepEqual(bodies.at(-1).systemInstruction,bodies[0].systemInstruction);
  assert.equal(JSON.stringify(bodies.at(-1)).includes('PREVIOUS_GEMINI_OUTPUT'),false);
  assert.deepEqual(bodies.at(-1).generationConfig,bodies[0].generationConfig);
 }
 assert.equal(new Set(bodies.map(b=>JSON.stringify(b).length)).size,1);
});

test('a failed reply and interleaved calls cannot attach a prior turn to another request',async()=>{
 for(const apiStyle of ['chat','responses'] as const){
  const bodies:any[]=[];
  const provider=new OpenAICompatibleProvider({apiKey:'synthetic',baseUrl:'https://example.test/v1',apiStyle,responseFormat:'json_object',fetchImpl:async(_url,init)=>{
   const body=JSON.parse(String(init?.body));bodies.push(body);
   const input=apiStyle==='chat'?body.messages.at(-1).content:body.input;
   const text=input.includes('FAILED_00')?'invalid JSON':'{"summary":"MODEL_REPLY_NOT_REPLAYED","tasks":[]}';
   await Promise.resolve();
   return Response.json(apiStyle==='chat'?{choices:[{finish_reason:'stop',message:{content:text}}]}:{status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text}]}]});
  }});
  const call=(text:string)=>provider.step({model:'synthetic',prompt:framed(text),responseSchema:schema,signal:new AbortController().signal});
  await assert.rejects(call('FAILED_00'));
  await Promise.all([call('CURRENT_1'),call('CURRENT_2')]);
  for(const [index,body]of bodies.entries()){
   const material=['FAILED_00','CURRENT_1','CURRENT_2'][index]!,expected=framed(material)+schemaBlock;
   if(apiStyle==='chat')assert.deepEqual(body.messages,[{role:'user',content:expected}]);
   else {assert.equal(body.instructions,undefined);assert.equal(body.input,expected);}
   assert.equal(JSON.stringify(body).includes('MODEL_REPLY_NOT_REPLAYED'),false);
  }
 }
});
