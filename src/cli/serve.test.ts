import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { createApp } from './serve.js';
import { UNGROUNDED_NOTICE, type RagIndex } from '../core/rag.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('API and web UI clearly identify general answers when the index is absent', async () => {
  let systemPrompt = '';
  const app = createApp(null, async (system, question) => {
    systemPrompt = system;
    return `General reply to: ${question}`;
  });
  const server = createServer(app);
  try {
    const baseUrl = await listen(server);
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const health = await healthResponse.json() as { ragAvailable: boolean; passages: number };
    assert.equal(health.ragAvailable, false);
    assert.equal(health.passages, 0);

    const uiResponse = await fetch(baseUrl);
    const ui = await uiResponse.text();
    assert.match(ui, /No source corpus is indexed/u);
    assert.match(ui, /Ask a question\.\.\./u);
    assert.match(ui, /have no source citations/u);

    const answerResponse = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Explain rainbows.' }),
    });
    const answer = await answerResponse.json() as {
      answer: string;
      grounded: boolean;
      supported: boolean;
      sources: unknown[];
    };
    assert.match(systemPrompt, /do not invent citations/u);
    assert.ok(answer.answer.startsWith(`${UNGROUNDED_NOTICE}\n\n`));
    assert.equal(answer.grounded, false);
    assert.equal(answer.supported, false);
    assert.deepEqual(answer.sources, []);
  } finally {
    await close(server);
  }
});

test('API remains source-grounded and cites source metadata when an index exists', async () => {
  const index: RagIndex = {
    version: 1,
    createdAt: new Date(0).toISOString(),
    passages: [{
      id: 'hope-passage',
      source: 'notes/hope.md',
      chunk: 1,
      text: 'Hope gives strength during hardship.',
    }],
  };
  const app = createApp(index, async (_system, prompt) => {
    assert.match(prompt, /\[S1\] notes\/hope\.md#1/u);
    return 'The source says hope gives strength during hardship [S1].';
  });
  const server = createServer(app);
  try {
    const baseUrl = await listen(server);
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const health = await healthResponse.json() as { ragAvailable: boolean; passages: number };
    assert.equal(health.ragAvailable, true);
    assert.equal(health.passages, 1);

    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What gives strength during hardship?' }),
    });
    const result = await response.json() as {
      answer: string;
      grounded: boolean;
      supported: boolean;
      sources: Array<{ source: string; chunk: number }>;
    };
    assert.equal(result.grounded, true);
    assert.equal(result.supported, true);
    assert.deepEqual(result.sources, [{ id: 'S1', source: 'notes/hope.md', chunk: 1 }]);
    assert.match(result.answer, /Sources: \[S1\] notes\/hope\.md#1/u);
  } finally {
    await close(server);
  }
});
