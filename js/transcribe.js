/* Pluggable transcription: OpenAI / Gemini vision LLMs, with Tesseract.js (no key) fallback.
   Every provider returns {header, company, address, items[], provider, raw}. */
(function (root) {
  'use strict';
  const P = root.PLParse;

  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  function buildPrompt(hints) {
    let p = 'This is a photo of a handwritten construction punch list. ' +
      'The FIRST line is written as "[company name] @ [address or address nickname]". ' +
      'Every following line (or bullet / numbered entry) is one task to be done. ' +
      'Transcribe exactly what is written, fixing only obvious spelling of common construction terms. ' +
      'Merge a task that wraps onto a second line into one item. Ignore crossed-out text, page doodles and checkmarks. ' +
      'Respond ONLY with JSON of the form {"header": string, "company": string, "address": string, "items": [string]}. ' +
      'If there is no header line, use empty strings for header/company/address.';
    if (hints && (hints.companies.length || hints.addresses.length)) {
      p += '\nKnown company names (use one if the handwriting clearly refers to it): ' + JSON.stringify(hints.companies) +
        '\nKnown addresses and nicknames (use the written form; these only help you read the handwriting): ' + JSON.stringify(hints.addresses);
    }
    return p;
  }

  /** Downscale + JPEG encode to keep uploads small. Returns {dataUrl, base64, mime}. */
  async function prepareImage(file, maxDim = 1600) {
    const bmp = await loadBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    return { dataUrl, base64: dataUrl.split(',')[1], mime: 'image/jpeg', canvas: c };
  }
  async function loadBitmap(file) {
    if (root.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ }
    }
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Could not read that image.'));
      img.src = URL.createObjectURL(file);
    });
  }

  function parseJsonLoose(text) {
    if (!text) throw new Error('Empty response from the model.');
    const t = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) {
      const m = t.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Model did not return JSON.');
    }
  }

  function normalizeResult(obj, provider, raw) {
    let header = String(obj.header || '').trim();
    let company = String(obj.company || '').trim();
    let address = String(obj.address || '').trim();
    if ((!company || !address) && header) {
      const h = P.parseHeader(header);
      if (h) { company = company || h.company; address = address || h.address; }
    }
    if (!header && company && address) header = company + ' @ ' + address;
    const items = (Array.isArray(obj.items) ? obj.items : []).map(i => P.cleanItem(typeof i === 'string' ? i : (i && (i.text || i.item)) || '')).filter(Boolean);
    return { header, company, address, items, provider, raw };
  }

  async function openai(img, settings, hints) {
    if (!settings.openaiKey) throw new Error('Add your OpenAI API key in Settings first.');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.openaiKey },
      body: JSON.stringify({
        model: settings.openaiModel || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: buildPrompt(hints) },
          { type: 'image_url', image_url: { url: img.dataUrl, detail: 'high' } }
        ] }]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('OpenAI error: ' + ((data.error && data.error.message) || res.status));
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return normalizeResult(parseJsonLoose(text), 'OpenAI ' + (settings.openaiModel || 'gpt-4o-mini'), text);
  }

  async function gemini(img, settings, hints) {
    if (!settings.geminiKey) throw new Error('Add your Google Gemini API key in Settings first.');
    const model = settings.geminiModel || 'gemini-2.5-flash';
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(hints) }, { inline_data: { mime_type: img.mime, data: img.base64 } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Gemini error: ' + ((data.error && data.error.message) || res.status));
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const text = parts ? parts.map(p => p.text || '').join('') : '';
    return normalizeResult(parseJsonLoose(text), 'Gemini ' + model, text);
  }

  let tessLoading = null;
  function loadTesseract() {
    if (root.Tesseract) return Promise.resolve(root.Tesseract);
    if (!tessLoading) tessLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL; s.async = true;
      s.onload = () => res(root.Tesseract);
      s.onerror = () => { tessLoading = null; rej(new Error('Could not load Tesseract (needs internet the first time).')); };
      document.head.appendChild(s);
    });
    return tessLoading;
  }

  async function tesseract(img, settings, hints, onProgress) {
    const T = await loadTesseract();
    const r = await T.recognize(img.canvas || img.dataUrl, 'eng', {
      logger: m => { if (onProgress && m.status) onProgress(m.status + (m.progress ? ' ' + Math.round(m.progress * 100) + '%' : '')); }
    });
    const text = r.data.text;
    const split = P.splitTranscript(text);
    return Object.assign(split, { provider: 'Tesseract (offline OCR, low accuracy on handwriting)', raw: text });
  }

  const PROVIDERS = { openai, gemini, tesseract };

  /** Main entry. settings.provider: 'openai' | 'gemini' | 'tesseract' */
  async function transcribe(file, settings, hints, onProgress) {
    const provider = settings.provider || 'tesseract';
    const fn = PROVIDERS[provider];
    if (!fn) throw new Error('Unknown transcription provider: ' + provider);
    onProgress && onProgress('Preparing photo…');
    const img = await prepareImage(file, provider === 'tesseract' ? 2000 : 1600);
    onProgress && onProgress(provider === 'tesseract' ? 'Loading offline OCR…' : 'Reading handwriting…');
    return fn(img, settings, hints, onProgress);
  }

  root.PLTranscribe = { transcribe, buildPrompt, parseJsonLoose, normalizeResult, providers: Object.keys(PROVIDERS) };
})(typeof self !== 'undefined' ? self : this);
