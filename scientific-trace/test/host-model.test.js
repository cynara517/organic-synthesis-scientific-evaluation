import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harnessModel} from '../src/host-model.js';

test('host model bridge uses prepared route and does not duplicate streamed text', async () => {
  let request;
  const complete = harnessModel({async prepareCall(config) {
    return {config, async *stream(options) {
      request = options;
      yield {type: 'text-delta', index: 0, text: '{"x":'};
      yield {type: 'text-delta', index: 0, text: '42}'};
      yield {type: 'block-end', index: 0, block: {type: 'text', text: '{"x":42}'}};
      yield {type: 'usage', usage: {inputTokens: 4, outputTokens: 2, cacheReadTokens: 8}};
      yield {type: 'finish', reason: {kind: 'stop'}};
    }};
  }}, {provider: 'p', model: 'm'});
  const value = await complete({prompt: 'test'});
  assert.equal(value.text, '{"x":42}'); assert.equal(value.usage.cacheReadTokens, 8);
  assert.equal(request.provider, 'p'); assert.equal(request.messages[0].content[0].text, 'test');
});

test('host model bridge rejects incomplete streams and provider errors', async () => {
  for (const chunks of [[], [{type: 'finish', reason: {kind: 'error', failure: {code: 'AUTH', message: 'No key'}}}]]) {
    const complete = harnessModel({async prepareCall(config) { return {config, async *stream() { yield* chunks; }}; }}, {provider: 'p', model: 'm'});
    await assert.rejects(complete({prompt: 'test'}), /terminal finish|No key/);
  }
});
