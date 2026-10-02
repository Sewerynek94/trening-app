// Podgląd konspektów: PDF, DOCX, Markdown, TXT, HTML i obrazy.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdf.min.mjs').then(lib => {
      lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

const scriptCache = {};
function loadScript(src) {
  if (!scriptCache[src]) {
    scriptCache[src] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Nie udało się wczytać ' + src));
      document.head.appendChild(el);
    });
  }
  return scriptCache[src];
}

export const ACCEPT = '.pdf,.docx,.md,.markdown,.txt,.html,.htm,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/*';

export function detectKind(name, mime = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || mime.includes('wordprocessingml')) return 'docx';
  if (ext === 'md' || ext === 'markdown' || mime === 'text/markdown') return 'md';
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') return 'html';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  if (ext === 'txt' || mime.startsWith('text/')) return 'txt';
  return null;
}

// Usuwa skrypty i atrybuty zdarzeń z HTML pochodzącego z plików.
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,link,meta,style,form,base').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = attr.value.trim().toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(attr.name);
      else if ((n === 'href' || n === 'src') && v.startsWith('javascript:')) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
  });
  return doc.body.innerHTML;
}

export async function renderOutline(outline, container) {
  container.innerHTML = '<p class="muted center">Wczytywanie…</p>';
  const kind = outline.kind || detectKind(outline.name, outline.type);
  const blob = outline.blob;
  try {
    if (kind === 'pdf') return await renderPdf(blob, container);
    if (kind === 'docx') {
      await loadScript('./vendor/mammoth.browser.min.js');
      const res = await window.mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
      container.innerHTML = `<article class="doc">${sanitize(res.value)}</article>`;
      return;
    }
    if (kind === 'md') {
      await loadScript('./vendor/marked.umd.js');
      const html = window.marked.parse(await blob.text());
      container.innerHTML = `<article class="doc">${sanitize(html)}</article>`;
      return;
    }
    if (kind === 'html') {
      container.innerHTML = `<article class="doc">${sanitize(await blob.text())}</article>`;
      return;
    }
    if (kind === 'image') {
      const url = URL.createObjectURL(blob);
      container.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'doc-img';
      img.alt = outline.name;
      img.src = url;
      container.appendChild(img);
      return;
    }
    if (kind === 'txt') {
      const pre = document.createElement('pre');
      pre.className = 'doc doc-txt';
      pre.textContent = await blob.text();
      container.innerHTML = '';
      container.appendChild(pre);
      return;
    }
    container.innerHTML = '<p class="muted center">Nieobsługiwany format pliku.</p>';
  } catch (err) {
    console.error(err);
    container.innerHTML = `<p class="error center">Nie udało się otworzyć pliku: ${String(err.message || err).replace(/</g, '&lt;')}</p>`;
  }
}

async function renderPdf(blob, container) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  container.innerHTML = '';
  const width = Math.min(container.clientWidth || window.innerWidth, 1000);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = '100%';
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}
