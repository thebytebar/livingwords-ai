#!/usr/bin/env node
/**
 * Server + Web Chat UI for LivingWords LLM
 * Provides:
 *  - POST /api/generate  { prompt: string, maxTokens?: number } -> { text: string }
 *  - GET /  -> single-file web chat interface (vanilla HTML/JS)
 *
 * Usage:
 *   npx lw serve --port 3000
 */

import express from 'express';
import { LivingWordsLLM } from '../core/model.js';
import { configs } from '../core/config.js';

export async function startServer(port: number = 3000, loadDir: string = 'weights'): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const model = new LivingWordsLLM(configs.theoSmall);
  await model.load(loadDir);

  // API for generation (used by web UI and external clients)
  app.post('/api/generate', async (req, res) => {
    try {
      const prompt = (req.body?.prompt ?? '').toString();
      const maxTokens = Math.max(1, Math.min(512, parseInt(req.body?.maxTokens) || 120));
      if (!prompt || prompt.trim().length === 0) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      const text = await model.generate(prompt, maxTokens);
      res.json({ text, prompt });
    } catch (err: any) {
      console.error('API /generate error:', err);
      res.status(500).json({ error: 'generation failed', message: String(err?.message || err) });
    }
  });

  // Simple health
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, model: 'livingwords-llm', loaded: true });
  });

  // Single-file web chat UI (God-centered, minimal, accessible)
  const webUI = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>LivingWords • Chat</title>
  <style>
    :root { --bg:#0f172a; --panel:#111c2e; --accent:#c9a227; --text:#e2e8f0; --muted:#64748b; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: linear-gradient(180deg, #0b1224, #0f172a); color:var(--text); }
    .header { display:flex; align-items:center; gap:12px; padding:16px 20px; border-bottom:1px solid #1e2937; background:#0b1224; }
    .header .logo { width:28px; height:28px; border:2px solid var(--accent); border-radius:999px; display:flex; align-items:center; justify-content:center; font-weight:700; color:var(--accent); }
    .header h1 { margin:0; font-size:18px; letter-spacing:.3px; }
    .header .tag { margin-left:auto; font-size:12px; color:var(--muted); background:#1e2937; padding:2px 8px; border-radius:999px; }
    .chat { max-width: 860px; margin: 24px auto; padding: 0 16px; }
    .messages { background: var(--panel); border:1px solid #1e2937; border-radius:12px; min-height:420px; max-height:62vh; overflow:auto; padding:18px; display:flex; flex-direction:column; gap:12px; }
    .msg { display:flex; gap:10px; }
    .msg.user { justify-content:flex-end; }
    .bubble { max-width:78%; padding:10px 14px; border-radius:12px; line-height:1.35; white-space:pre-wrap; word-break:break-word; }
    .msg.user .bubble { background:#1e3a5f; border-bottom-right-radius:4px; }
    .msg.ai .bubble { background:#1f2937; border-bottom-left-radius:4px; }
    .label { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:var(--muted); margin-bottom:4px; }
    .inputbar { margin-top:12px; display:flex; gap:8px; }
    textarea { flex:1; resize:vertical; min-height:52px; max-height:160px; background:#0b1224; color:var(--text); border:1px solid #334155; border-radius:10px; padding:12px 14px; font:inherit; }
    button { background:var(--accent); color:#111; border:none; padding:0 18px; border-radius:10px; font-weight:600; cursor:pointer; }
    button:disabled { opacity:.6; cursor:default; }
    .footer { text-align:center; margin:16px 0 40px; color:var(--muted); font-size:12px; }
    .verse { font-size:12px; font-style:italic; opacity:.75; margin-top:6px; }
    .empty { color:var(--muted); text-align:center; padding:40px 10px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">✝︎</div>
    <h1>LivingWords LLM</h1>
    <div class="tag">God-centered • Lightweight</div>
  </div>

  <div class="chat">
    <div id="messages" class="messages">
      <div class="empty">Ask a question or share a prompt. Responses are generated from a small transformer trained to be faithful to Scripture.</div>
    </div>

    <div class="inputbar">
      <textarea id="prompt" placeholder="Ask anything... (e.g. Explain John 3:16 or Tell me about the Trinity)"></textarea>
      <button id="send">Send</button>
    </div>
    <div class="verse">"Trust in the Lord with all your heart, and lean not on your own understanding." — Proverbs 3:5</div>
    <div class="footer">Responses are AI-generated for reflection. Always compare with Scripture.</div>
  </div>

  <script>
    const messages = document.getElementById('messages');
    const ta = document.getElementById('prompt');
    const sendBtn = document.getElementById('send');

    function addMsg(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
      div.innerHTML = '<div><div class="label">' + (role==='user'?'You':'LivingWords') + '</div><div class="bubble">' + escapeHtml(text) + '</div></div>';
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }
    function escapeHtml(s){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

    async function send() {
      const prompt = (ta.value || '').trim();
      if (!prompt) return;
      addMsg('user', prompt);
      ta.value = '';
      sendBtn.disabled = true;
      const thinking = addMsg('ai', '…');

      try {
        const r = await fetch('/api/generate', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ prompt, maxTokens: 140 })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || 'Request failed');
        const out = data.text || '';
        thinking.querySelector('.bubble').textContent = out;
      } catch (e) {
        thinking.querySelector('.bubble').textContent = 'Error: ' + (e?.message || e);
      } finally {
        sendBtn.disabled = false;
        ta.focus();
      }
    }

    sendBtn.addEventListener('click', send);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    // Focus input on load
    setTimeout(() => ta.focus(), 50);
  </script>
</body>
</html>`;

  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(webUI);
  });

  const server = app.listen(port, () => {
    console.log(`\n🙏 LivingWords LLM server running`);
    console.log(`   Web UI:   http://localhost:${port}/`);
    console.log(`   API:      POST http://localhost:${port}/api/generate`);
    console.log(`   Health:   GET  http://localhost:${port}/api/health\n`);
    console.log('   Press Ctrl+C to stop.\n');
  });

  // graceful
  const shutdown = () => {
    console.log('\nShutting down server...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Direct run support
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('serve.ts')) {
  const port = parseInt(process.argv[2] || '3000', 10);
  const load = process.argv[3] || 'weights';
  startServer(port, load).catch((e) => { console.error(e); process.exit(1); });
}
