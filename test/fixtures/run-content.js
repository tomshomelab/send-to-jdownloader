// Runs extension/content.js against the current fixture page and prints what it found.
fetch('/extension/detect.js').then((r) => r.text()).then((d) => { (0, eval)(d); return fetch('/extension/content.js'); }).then((r) => r.text()).then((src) => {
  const out = (0, eval)(src);
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify({ items: out.items.length, first: out.items.slice(0, 3), candidates: out.candidates.map((c) => c.kind + ' ' + c.url) }, null, 1);
  document.body.prepend(pre);
});
