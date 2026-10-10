import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_KEY = process.env.GEMINI_KEY;
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/' +
  'gemini-2.5-flash:generateContent';

async function askGemini(prompt, schema = null) {
  if (!GEMINI_KEY) throw new Error('GEMINI_KEY belum di-set');

  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (schema) {
    body.generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: schema
    };
  }

  try {
    const { data } = await axios.post(GEMINI_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': GEMINI_KEY
      },
      timeout: 25000
    });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return schema ? JSON.parse(text) : text;
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message;
    const code = e.response?.status || 'ERR';
    throw new Error(`Gemini [${code}]: ${detail}`);
  }
}

/* ===================== DETECT GOOGLE FORM ===================== */
function isGoogleForm(url) {
  return /docs\.google\.com\/forms|forms\.gle/.test(url);
}

/* ===================== PARSE GOOGLE FORM ===================== */
function parseGoogleForm(html) {
  const $ = cheerio.load(html);
  const questions = [];

  // Google Forms render via JS, tapi ada data di script FB_PUBLIC_LOAD_DATA_
  const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      const items = data[1]?.[1] || [];

      for (const item of items) {
        const title = item[1];
        const type = item[3];
        const entryId = item[4]?.[0]?.[0];
        const optionsRaw = item[4]?.[0]?.[1] || [];

        if (!title || !entryId) continue;

        const options = optionsRaw
          .map(o => Array.isArray(o) ? o[0] : o)
          .filter(Boolean);

        questions.push({
          title: String(title).trim(),
          entryId: `entry.${entryId}`,
          options: options.map(String),
          type: type // 0=short, 1=long, 2=radio, 3=checkbox, 4=dropdown
        });
      }
    } catch (e) {
      console.error('Parse FB data gagal:', e.message);
    }
  }

  return questions;
}

/* ===================== FETCH ===================== */
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL kosong' });

  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8'
      },
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
      maxContentLength: 10 * 1024 * 1024
    });

    const rawHtml = typeof r.data === 'string' ? r.data : String(r.data);

    // ==== GOOGLE FORM ====
    if (isGoogleForm(url) || /FB_PUBLIC_LOAD_DATA_/.test(rawHtml)) {
      const questions = parseGoogleForm(rawHtml);
      return res.json({
        type: 'google-form',
        originalUrl: url,
        finalUrl: r.request.res.responseUrl || url,
        questions
      });
    }

    // ==== WEBSITE BIASA (proxy + iframe) ====
    const $ = cheerio.load(rawHtml);
    if (!$('base').length) $('head').prepend(`<base href="${url}">`);
    $('meta[http-equiv="X-Frame-Options"]').remove();
    $('meta[http-equiv="Content-Security-Policy"]').remove();

    const fields = [];
    $('input, select, textarea').each((i, el) => {
      fields.push({
        index: i,
        tag: el.tagName,
        name: $(el).attr('name') || '',
        id: $(el).attr('id') || '',
        type: $(el).attr('type') || 'text',
        placeholder: $(el).attr('placeholder') || '',
        value: $(el).attr('value') || '',
        label:
          $(el).closest('label').text().trim() ||
          $(el).prev('label').text().trim()
      });
    });

    $('script, style, noscript').remove();
    const textContent = $('body')
      .text()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);

    res.json({
      type: 'website',
      html: $.html(),
      fields,
      textContent,
      finalUrl: r.request.res.responseUrl || url
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== SOLVE GOOGLE FORM ===================== */
app.post('/api/solve-google', async (req, res) => {
  const { questions } = req.body || {};
  if (!questions?.length) {
    return res.status(400).json({ error: 'Tidak ada soal' });
  }

  const soalText = questions.map((q, i) => {
    let s = `Soal ${i + 1}: ${q.title}\nEntry: ${q.entryId}`;
    if (q.options?.length) {
      s += `\nPilihan:\n${q.options.map(o => `  - ${o}`).join('\n')}`;
    }
    return s;
  }).join('\n\n');

  const prompt = `Kamu asisten yang mengerjakan soal di Google Form.
Untuk setiap soal, tentukan jawaban yang PALING BENAR.

${soalText}

Tugas:
1. Baca tiap soal.
2. Tentukan jawaban (HARUS persis sama dengan salah satu pilihan kalau ada pilihan).
3. Kasih alasan singkat.

Balikin JSON sesuai schema.`;

  try {
    const out = await askGemini(prompt, {
      type: 'object',
      properties: {
        jawaban: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entryId: { type: 'string' },
              title: { type: 'string' },
              jawaban: { type: 'string' },
              alasan: { type: 'string' }
            },
            required: ['entryId', 'jawaban']
          }
        }
      },
      required: ['jawaban']
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== SOLVE WEBSITE BIASA ===================== */
app.post('/api/solve', async (req, res) => {
  const { textContent, fields, html } = req.body || {};

  const prompt = `Kamu asisten yang MENGERJAKAN soal di halaman web.
Tugasmu: tentukan JAWABAN, lalu tentukan AKSI yang harus dilakukan.

KONTEN SOAL:
${textContent}

FIELD & ELEMEN:
${JSON.stringify(fields, null, 2)}

FRAGMEN HTML:
${(html || '').slice(0, 3000)}

Tugas:
1. Baca soal, tentukan jawaban.
2. Tentukan AKSI (urutan):
   - "fill" = isi input/textarea
   - "click" = klik radio/checkbox/label/button
   - "select" = pilih dropdown
   - "submit" = submit form
3. Target berdasarkan name/id/label.

Balikin JSON sesuai schema.`;

  try {
    const out = await askGemini(prompt, {
      type: 'object',
      properties: {
        soal: { type: 'string' },
        jawaban: { type: 'string' },
        alasan: { type: 'string' },
        aksi: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['fill', 'click', 'select', 'submit']
              },
              target: { type: 'string' },
              value: { type: 'string' },
              description: { type: 'string' }
            },
            required: ['type', 'target', 'description']
          }
        }
      },
      required: ['soal', 'jawaban', 'aksi']
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== HINT ===================== */
app.post('/api/hint', async (req, res) => {
  const { textContent } = req.body || {};

  const prompt = `Kamu tutor. Berikan PETUNJUK (bukan jawaban final).

SOAL:
${textContent}

Balikin JSON sesuai schema.`;

  try {
    const out = await askGemini(prompt, {
      type: 'object',
      properties: {
        konsep: { type: 'string' },
        petunjuk: { type: 'array', items: { type: 'string' } }
      },
      required: ['konsep', 'petunjuk']
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== CHAT ===================== */
app.post('/api/chat', async (req, res) => {
  const { message, context, history = [] } = req.body || {};

  const ctx = context ? `Konteks halaman:\n${context}\n\n` : '';
  const hist = history.map(h => `${h.role}: ${h.content}`).join('\n');
  const prompt = `${ctx}${hist}\nuser: ${message}\nassistant:`;

  try {
    const reply = await askGemini(prompt);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== HEALTH ===================== */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    hasKey: !!GEMINI_KEY
  });
});

/* ===================== START ===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔥 Zerozx running on port ${PORT}`);
});