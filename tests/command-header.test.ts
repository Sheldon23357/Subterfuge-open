import test from 'node:test';
import assert from 'node:assert/strict';
import { aiHeaderSummary, headerClockState } from '../packages/client/src/header-state.js';
const base={offset:0,playing:false,pending:false,realtime:false,ready:true};
test('header distinguishes viewing time from actual clock controls',()=>{
 assert.equal(headerClockState(base).stepReason,'');
 for(const offset of [-10,10]) {
  const value=headerClockState({...base,offset});
  assert.equal(value.stepReason,'回到现在后可单步推进');
  assert.equal(value.autoReason,''); // Stopping live auto-advance remains reachable while previewing.
  assert.equal(value.timeLabel,offset<0?'历史回看':'未来预览');
 }
});
test('header explains realtime, pending, unloaded and automatic advance constraints',()=>{
 assert.match(headerClockState({...base,realtime:true}).stepReason,/服务器/);
 assert.match(headerClockState({...base,realtime:true}).autoReason,/服务器/);
 assert.match(headerClockState({...base,pending:true}).autoReason,/提交/);
 assert.match(headerClockState({...base,ready:false}).stepReason,/加载/);
 assert.match(headerClockState({...base,playing:true}).stepReason,/暂停/);
 assert.equal(headerClockState({...base,playing:true}).autoReason,'');
 assert.equal(headerClockState({...base,playing:true}).clockLabel,'自动推进中');
});

test('seat refresh gives a reason instead of silently ignoring clock actions',()=>{
 const state=headerClockState({...base,refreshing:true});
 assert.match(state.stepReason,/同步/);assert.equal(state.autoReason,'');
});

test('collapsed AI summary surfaces errors and recovery before idle counts',()=>{
 const seats=[{enabled:true,status:'error',recovering:true,error:'temporary'},{enabled:true,status:'thinking',error:null}];
 assert.equal(aiHeaderSummary(seats,false).label,'1 需关注');
 assert.match(aiHeaderSummary(seats,false).detail,/1 席思考中/);
 assert.equal(aiHeaderSummary(seats,true).label,'不可用');
 assert.equal(aiHeaderSummary([],false).label,'读取中');
 assert.equal(aiHeaderSummary([],false,true).label,'未启用');
});
