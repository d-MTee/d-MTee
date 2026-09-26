import test from 'node:test';import assert from 'node:assert/strict';import {checkRoute} from '../src/risk/policy.js';
test('risk policy rejects excessive slippage',()=>{const r:any={inputAmount:1,slippageBps:999,priceImpactBps:0,expiresAt:Date.now()+1000};assert.equal(checkRoute(r).allowed,false)});
test('risk policy accepts normal route',()=>{const r:any={inputAmount:1,slippageBps:50,priceImpactBps:10,expiresAt:Date.now()+1000};assert.equal(checkRoute(r).allowed,true)});
