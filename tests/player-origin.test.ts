import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePlayerPublicOrigin} from '../packages/server/src/player-origin.js';

test('public player origin accepts only an explicit HTTPS origin',()=>{
  assert.equal(parsePlayerPublicOrigin(undefined),undefined);
  assert.equal(parsePlayerPublicOrigin('https://play.example/'),'https://play.example');
  for(const value of ['', 'null', '*', 'http://play.example', 'https://u:p@play.example', 'https://play.example/path', 'https://play.example/?q=x', 'https://play.example/#x'])
    assert.throws(()=>parsePlayerPublicOrigin(value));
});
