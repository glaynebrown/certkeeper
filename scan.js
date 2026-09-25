/* "Scan my card": reads a card photo, screenshot or PDF right on this device
   and guesses the cert type, number and dates. The image is never sent
   anywhere to be read -- the reading tools (pdf.js for PDFs, Tesseract for
   photos) are downloaded once from a CDN and run in the browser. Results only
   ever go into the form for the person to check; nothing saves on its own. */
const Scan = (() => {
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  function load(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { s.remove(); reject(new Error('Couldn’t load the card reader. Scanning needs an internet connection the first time.')); };
      document.head.appendChild(s);
    });
  }

  // ---------- getting text out of the file ----------

  // PDF text comes in pieces; put pieces that share a line back together.
  function linesFromItems(items) {
    const rows = new Map();
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(it);
    }
    return [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, row]) => row.sort((a, b) => a.transform[4] - b.transform[4]).map(it => it.str.trim()).join(' '))
      .join('\n');
  }

  // Returns a list of texts (one for a real PDF, two readings for a scanned one).
  async function pdfText(file, onProgress) {
    await load(PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 2); i++) {
      const page = await pdf.getPage(i);
      text += linesFromItems((await page.getTextContent()).items) + '\n';
    }
    if (text.replace(/\s/g, '').length > 20) return [text];

    // A scanned PDF is just a picture: draw page 1 and read it like a photo.
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return photoTexts(canvas, onProgress);
  }

  // Sized for the reader (small screenshots scaled up, huge photos down) and
  // turned grayscale, which reads more reliably than color.
  async function imageCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('That image couldn’t be opened. Try a JPG or PNG, or a screenshot of the card.'));
        i.src = url;
      });
      const scale = Math.min(2.5, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high'; // sharper resizing: fewer misread digits
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = px.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] = d[i + 1] = d[i + 2] = g;
      }
      ctx.putImageData(px, 0, 0);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // A pure black-and-white copy (Otsu's threshold). It reads digits more
  // accurately -- in testing it fixed an 8 read as a 3 -- but can lose text in
  // shadows, so both versions get read and combined.
  function blackAndWhite(gray) {
    const canvas = document.createElement('canvas');
    canvas.width = gray.width;
    canvas.height = gray.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(gray, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = px.data;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
    const total = d.length / 4;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
      if (between > best) { best = between; threshold = t; }
    }
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i] > threshold ? 255 : 0;
    ctx.putImageData(px, 0, 0);
    return canvas;
  }

  // Reads each image with one reader; returns their texts in order.
  async function ocr(canvases, onProgress) {
    await load(TESSERACT);
    let pass = 0;
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress((pass + m.progress) / canvases.length); },
    });
    try {
      const texts = [];
      for (; pass < canvases.length; pass++) texts.push((await worker.recognize(canvases[pass])).data.text);
      return texts;
    } finally {
      await worker.terminate();
    }
  }
  const photoTexts = (gray, onProgress) => ocr([blackAndWhite(gray), gray], onProgress);

  // ---------- making sense of the text ----------

  // Which template it is. Order matters: instructor before provider, EC before
  // EMT, paramedic before EMT.
  const TEMPLATE_RULES = [
    ['aha-bls-instructor', t => /instructor/.test(t) && /(basic life support|\bbls\b|heartsaver|american heart)/.test(t)],
    ['aap-nrp', t => /neonatal resuscitation/.test(t)],
    ['aha-acls', t => /(advanced cardiovascular life support|\bacls\b)/.test(t)],
    ['aha-pals', t => /(pediatric advanced life support|\bpals\b)/.test(t)],
    ['arc-cpr', t => /red cross/.test(t)],
    ['aha-bls', t => /(basic life support|\bbls\b)/.test(t)],
    ['va-ec', t => /education coordinator/.test(t)],
    ['nremt-paramedic', t => /national registry/.test(t) && /paramedic/.test(t)],
    ['nremt-emt', t => /national registry/.test(t)],
    ['va-emt', t => /virginia/.test(t) && /(emergency medical|\bemt\b|office of ems)/.test(t)],
    ['rn', t => /(registered nurse|board of nursing|\brn\b)/.test(t)],
  ];

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
  const monthNum = s => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;
  const pad = n => String(n).padStart(2, '0');

  function findDates(text) {
    const found = [];
    const taken = [];
    const overlaps = (a, b) => taken.some(([s, e]) => a < e && b > s);
    const add = (m, y, mo, d, monthOnly) => {
      const start = m.index, end = m.index + m[0].length;
      if (overlaps(start, end)) return;
      y = Number(y);
      if (y < 100) y += 2000;
      const iso = `${y}-${pad(mo)}-${pad(monthOnly ? 1 : d)}`;
      if (y < 1950 || y > 2100 || !Dates.isValid(iso)) return;
      taken.push([start, end]);
      found.push({ iso, index: start, monthOnly });
    };
    const each = (re, fn) => { for (const m of text.matchAll(re)) fn(m); };
    // Full dates first, so "01/2025" inside "01/20/2025" isn't counted twice.
    each(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, m => add(m, m[1], m[2], m[3]));
    each(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/g, m => add(m, m[3], m[1], m[2]));
    each(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), m => add(m, m[3], monthNum(m[1]), m[2]));
    each(new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE},?\\s+(\\d{4})\\b`, 'gi'), m => add(m, m[3], monthNum(m[2]), m[1]));
    // Month and year only, e.g. AHA's "Recommended Renewal Date: 01/2027".
    // Photos often turn the "/" into "1", "l", "|", "[" or a space ("01 12027").
    each(/\b(\d{1,2})\s*[/\-|lI1[\]]?\s*((?:19|20)\d{2})\b/g, m => add(m, m[2], m[1], 1, true));
    each(new RegExp(`\\b${MONTH_RE},?\\s+(\\d{4})\\b`, 'gi'), m => add(m, m[2], monthNum(m[1]), 1, true));
    return found.sort((a, b) => a.index - b.index);
  }

  // What the words just before a date say it is (the label may be on the
  // line above, so look back a little way).
  const EXPIRES = /(expir|\bexp\b|exp\.|valid (?:thru|through|until|to)|good (?:thru|through|until)|renew)/g;
  const ISSUED = /(issue|complet|course date|date of course|certified|effective|original|granted|awarded|class date)/g;
  const IGNORE = /(birth|\bdob\b|born)/g;
  function dateKind(text, index) {
    const before = text.slice(Math.max(0, index - 70), index).toLowerCase();
    const last = re => { let pos = -1; for (const m of before.matchAll(re)) pos = m.index; return pos; };
    const e = last(EXPIRES), i = last(ISSUED), x = last(IGNORE);
    const best = Math.max(e, i, x);
    if (best < 0) return null;
    return best === x ? 'ignore' : best === e ? 'expires' : 'issued';
  }

  const NUMBER_LABELS = [
    /e-?card\s*code/,
    /(?:certificate|certification|cert|license|licence|registry|registration|card)\s*(?:id|no\.?|number|num|#)?/,
    /\b(?:id|no\.?|number|#)/,
  ];
  // Dates and phone numbers look a lot like cert numbers; skip them.
  const notANumber = t => /^\d{4}-\d{1,2}-\d{1,2}$/.test(t) || /^\d{1,2}-\d{1,2}-\d{2,4}$/.test(t) || /^\d{3}-\d{3}-\d{4}$/.test(t);
  function findNumber(text) {
    const token = '([A-Z0-9][A-Z0-9-]{3,24})';
    for (const label of NUMBER_LABELS) {
      const re = new RegExp(`${label.source}\\s*[:#.]?\\s*${token}`, 'gi');
      for (const m of text.matchAll(re)) {
        const t = m[m.length - 1].replace(/-+$/, '');
        if (t.replace(/\D/g, '').length >= 3 && !notANumber(t)) return t.toUpperCase();
      }
    }
    // No label: a long run of mostly digits is usually the number.
    const bare = /\b([A-Z]{0,3}\d{6,15})\b/i.exec(text);
    return bare ? bare[1].toUpperCase() : '';
  }

  function parse(raw) {
    const text = raw.replace(/[|]/g, ' ').replace(/[ \t]+/g, ' ');
    const lower = text.toLowerCase();
    const result = { templateId: '', stateCode: '', certNumber: '', issuedOn: '', expiresOn: '', validityMonths: null };

    const rule = TEMPLATE_RULES.find(([, test]) => test(lower));
    if (rule) result.templateId = rule[0];

    for (const [code, name] of Object.entries(US_STATES)) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(text)) { result.stateCode = code; break; }
    }

    const dates = findDates(text);
    const today = Dates.today();
    const expiring = [], issued = [], unlabeled = [];
    for (const d of dates) {
      const kind = dateKind(text, d.index);
      if (kind === 'ignore') continue;
      if (kind === 'expires') expiring.push(d.monthOnly ? Dates.endOfMonth(d.iso) : d.iso);
      else if (kind === 'issued') issued.push(d.iso);
      else unlabeled.push(d.monthOnly ? null : d.iso);
    }
    result.expiresOn = expiring.sort().pop() || '';
    result.issuedOn = issued.sort()[0] || '';
    // Nothing labeled: the earlier date is when it was issued, the later one
    // is when it expires.
    const loose = unlabeled.filter(Boolean).sort();
    if (!result.issuedOn && loose.length && (loose[0] <= today || loose.length > 1)) result.issuedOn = loose[0];
    if (!result.expiresOn && loose.length) {
      const last = loose[loose.length - 1];
      if (last > (result.issuedOn || today)) result.expiresOn = last;
    }

    const valid = /valid(?:\s+for)?\s*:?\s*(\d{1,2})\s*(year|yr|month|mo)/i.exec(text);
    if (valid) result.validityMonths = Number(valid[1]) * (/^y/i.test(valid[2]) ? 12 : 1);

    result.certNumber = findNumber(text);
    return result;
  }

  // Each reading fills in what the earlier ones missed.
  async function read(file, onProgress) {
    const texts = file.type === 'application/pdf'
      ? await pdfText(file, onProgress)
      : await photoTexts(await imageCanvas(file), onProgress);
    const result = {};
    for (const r of texts.map(parse)) {
      for (const [k, v] of Object.entries(r)) if (!result[k] && v) result[k] = v;
    }
    for (const k of Object.keys(parse(''))) if (!(k in result)) result[k] = parse('')[k];
    return { ...result, text: texts.join('\n----\n') };
  }

  return { read, parse };
})();
