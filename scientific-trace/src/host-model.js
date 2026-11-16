export function harnessModel(llm, selection, {maxTokens = 16384, sessionId, requestTimeoutMs = 300000} = {}) {
  if (!selection?.provider || !selection?.model) throw new Error('No model selected; configure a provider and model in the host');
  return async ({prompt, signal}) => {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)].filter(Boolean));
    const prepared = await llm.prepareCall({...selection, maxTokens}, requestSignal);
    const blocks = new Map();
    let usage = {}, finishReason;
    for await (const chunk of prepared.stream({...prepared.config,
      messages: [{role: 'user', content: [{type: 'text', text: prompt}]}],
      signal: requestSignal, ...(sessionId ? {sessionId} : {})})) {
      requestSignal.throwIfAborted();
      if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text);
      if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text);
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') {
        finishReason = chunk.reason.kind;
        if (['error', 'aborted'].includes(finishReason)) {
          const error = new Error(chunk.reason.failure?.message ?? finishReason);
          error.code = chunk.reason.failure?.code;
          throw error;
        }
      }
    }
    requestSignal.throwIfAborted();
    if (!finishReason) throw new Error('Model stream ended without a terminal finish');
    return {text: [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(''), usage, finishReason};
  };
}
