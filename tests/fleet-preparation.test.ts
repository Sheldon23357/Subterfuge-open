import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchLocked,preparingFleet} from '../packages/client/src/fleet-preparation.js';

test('server commitment state controls waiting-fleet preparation',()=>{
  const fleet={state:'waiting',departureCommitted:true};
  assert.equal(launchLocked(fleet),true);assert.equal(preparingFleet(fleet),false);
  assert.equal(preparingFleet({...fleet,departureCommitted:false}),true);
});
test('public commitment distinguishes foreign waiting fleets with unknown private countdowns',()=>{
  const fleet={state:'waiting',departureCommitted:false};
  assert.equal(preparingFleet(fleet),true);
  assert.equal(preparingFleet({...fleet,departureCommitted:true}),false);
  assert.equal(launchLocked({...fleet,departureCommitted:true}),true);
  assert.equal(preparingFleet({...fleet,state:'moving',departureCommitted:true}),false);
});
