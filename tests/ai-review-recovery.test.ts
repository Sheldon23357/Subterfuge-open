import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
import {recoveryDelay} from '../packages/ai/src/controller/runtime/recovery.js';
import {GameTransportError} from '../packages/ai/src/controller/transport/gateway.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

test('committed-write followup failures keep retrying observation with bounded backoff',()=>{
 const error=new GameTransportError({requestId:'durable-v2-receipt',method:'POST',path:'/player/v2/commands',origin:'http://127.0.0.1',timeoutMs:15000,elapsedMs:0,stage:'validate-response',failure:'accepted-write-followup-failed',outcome:'unknown'});
 assert.equal(recoveryDelay(error,1),15000);assert.equal(recoveryDelay(error,2),30000);assert.equal(recoveryDelay(error,20),300000);
 assert.equal(recoveryDelay(new GameTransportError({...error.diagnostic!,failure:'timeout'}),1),null,'an unconfirmed write must not be replayed');
});

test('permanent classifications and unclassified non-model exceptions remain non-retryable',()=>{
 for(const code of ['authentication','quota','unavailable','native-tool','cancelled'] as const)assert.equal(recoveryDelay(new ProviderError(code),1),null);
 for(const reason of ['model-not-supported','context-limit','unsupported-cli-option','executor-permission-denied'])assert.equal(recoveryDelay(new ProviderError('unknown',undefined,{stage:'process-exit',reason}),1),null);
 assert.equal(recoveryDelay(new ProviderError('unknown'),1),null);assert.equal(recoveryDelay(new Error('unknown write outcome'),1),null);
});
