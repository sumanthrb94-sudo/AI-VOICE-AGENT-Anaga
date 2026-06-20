// api/_lib/embeddings.js
//
// Knowledge-base RAG layer — the blueprint's "Pinecone" tier, done FREE on our
// stack with Supabase pgvector + Gemini embeddings (text-embedding-004, 768 dims).
//
// Each client (tenant) gets their own knowledge partitioned by client_id, so the
// same Anaga brain can answer from Modcon's docs, another builder's docs, etc.
//
// Fail-soft: if embeddings or Supabase are unavailable, search returns [] and the
// agent falls back to its built-in knowledge — RAG never breaks a conversation.
//
// No npm deps: global fetch + the Supabase service-role REST API.

const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'text-embedding-004';
const EMBED_DIMS = 768;

export function embeddingsConfigured() {
  return !!(process.env.GEMINI_API_KEY && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

/**
 * Embed a single string with Gemini. Returns a 768-float array. Throws on failure.
 */
export async function embed(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const clean = String(text || '').slice(0, 8000);
  if (!clean) throw new Error('embed: empty text');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text: clean }] },
    }),
  });
  if (!resp.ok) {
    let d = ''; try { d = (await resp.text()).slice(0, 160); } catch { /* ignore */ }
    throw new Error('embed_' + resp.status + (d ? ': ' + d : ''));
  }
  const data = await resp.json();
  const values = data && data.embedding && data.embedding.values;
  if (!Array.isArray(values) || values.length !== EMBED_DIMS) {
    throw new Error('embed: unexpected vector length ' + (values ? values.length : 'none'));
  }
  return values;
}

/**
 * Split long text into ~1500-char chunks on sentence/paragraph boundaries.
 */
export function chunkText(text, maxLen = 1500) {
  const clean = String(text || '').trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];
  const paras = clean.split(/\n\s*\n/);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > maxLen && buf) { chunks.push(buf.trim()); buf = ''; }
    if (p.length > maxLen) {
      // Hard-split an oversized paragraph by sentences.
      const sentences = p.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if ((buf + ' ' + s).length > maxLen && buf) { chunks.push(buf.trim()); buf = ''; }
        buf += (buf ? ' ' : '') + s;
      }
    } else {
      buf += (buf ? '\n\n' : '') + p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/**
 * Ingest a document into the knowledge base: chunk → embed each → insert rows.
 * @returns {{ ok:true, chunks:number }}
 */
export async function addKnowledge({ clientId = 'modcon', title = '', content, source = '', metadata = null }) {
  if (!embeddingsConfigured()) throw new Error('knowledge_base_not_configured');
  const chunks = chunkText(content);
  if (!chunks.length) throw new Error('addKnowledge: empty content');

  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_KB_TABLE || 'knowledge_base';

  const rows = [];
  for (const chunk of chunks) {
    const embedding = await embed(chunk);
    rows.push({ client_id: clientId, title, content: chunk, source, embedding, metadata });
  }

  const resp = await fetch(`${base}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    let d = ''; try { d = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error('kb_insert_' + resp.status + (d ? ': ' + d : ''));
  }
  return { ok: true, chunks: rows.length };
}

/**
 * Semantic search the knowledge base for a query. Fail-soft → [] on any error.
 * @returns {Array<{id,title,content,similarity}>}
 */
export async function searchKnowledge({ clientId = 'modcon', query, count = 5 }) {
  if (!embeddingsConfigured() || !query) return [];
  try {
    const queryEmbedding = await embed(query);
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_KEY;
    const resp = await fetch(`${base}/rest/v1/rpc/match_knowledge`, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_client_id: clientId,
        match_count: Math.min(Math.max(parseInt(count, 10) || 5, 1), 10),
      }),
    });
    if (!resp.ok) return [];
    const rows = await resp.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error('kb_search_failed', String(e).slice(0, 160));
    return [];
  }
}

/**
 * Count knowledge rows for a client (used by health/status).
 */
export async function knowledgeCount(clientId = 'modcon') {
  if (!embeddingsConfigured()) return 0;
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_KEY;
    const table = process.env.SUPABASE_KB_TABLE || 'knowledge_base';
    const resp = await fetch(`${base}/rest/v1/${table}?client_id=eq.${encodeURIComponent(clientId)}&select=id`, {
      method: 'HEAD',
      headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'count=exact' },
    });
    const range = resp.headers.get('content-range') || '';
    const total = range.split('/')[1];
    return total ? parseInt(total, 10) : 0;
  } catch { return 0; }
}
