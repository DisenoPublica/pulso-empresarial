// Analista IA: lee las notas de mayor alcance de cada empresario en Meltwater
// y le pide a Claude que redacte las narrativas del período. Corre dentro del
// refresco diario (función background), nunca cuando alguien abre el panel.
//
// Requiere ANTHROPIC_API_KEY. Sin esa variable se saltea y quedan las
// narrativas de pulso-narrativas.json.

import { mw, SEARCH_ID } from './_pulso-core.js';

const TZ = process.env.PULSO_TZ || 'America/Argentina/Buenos_Aires';
const MODELO = process.env.PULSO_MODELO || 'claude-sonnet-4-5';
const DIAS = Number(process.env.PULSO_DIAS_NARRATIVA || 45);
const DOCS = Number(process.env.PULSO_DOCS_POR_PERFIL || 15);
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const iaActiva = () => !!process.env.ANTHROPIC_API_KEY;

function iso(d) { return d.toISOString().slice(0, 19); }
function fechaCorta(s) {
  const d = new Date(s);
  return isNaN(d) ? '' : d.getUTCDate() + ' ' + MESES[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}
const pick = (o, ...paths) => {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    if (v != null && v !== '') return v;
  }
  return '';
};

// 1 llamada a /v3/search por perfil: las notas con más alcance de la ventana.
async function notas(perfil) {
  const fin = new Date();
  const ini = new Date(fin.getTime() - DIAS * 86400000);
  const body = {
    tz: TZ, start: iso(ini), end: iso(fin),
    sort_by: 'reach', sort_order: 'desc', page_size: DOCS,
    template: { name: 'api.json' }
  };
  if (perfil.cat) body.custom_categories = [String(perfil.cat)];
  else body.keywords = perfil.kw;
  const r = await mw('/search/' + SEARCH_ID, body);
  const docs = (r && r.result && r.result.documents) || r.documents || [];
  return docs.map((d) => ({
    titulo: String(pick(d, 'content.title', 'title')).slice(0, 220),
    texto: String(pick(d, 'content.opening_text', 'opening_text', 'content.byline', 'content.text')).slice(0, 500),
    medio: String(pick(d, 'source.name', 'source_name', 'author.name', 'source.url')),
    fecha: fechaCorta(pick(d, 'published_date', 'date', 'indexed_date')),
    url: String(pick(d, 'url', 'content.url')),
    tono: String(pick(d, 'enrichments.sentiment', 'sentiment'))
  })).filter((d) => d.titulo || d.texto);
}

const SISTEMA = `Sos analista de reputación de la consultora Pública (Argentina).
Recibís notas reales de medios y redes sobre un empresario argentino, ordenadas por alcance.
Escribí las 3 narrativas que dominaron la conversación sobre esa persona en el período.

Reglas:
- Usá SOLO hechos que estén en las notas. No inventes cifras, cargos, fechas ni fuentes.
- Cada narrativa: una o dos oraciones, máximo 45 palabras, español rioplatense neutro, tono informativo (no editorialices).
- Agrupá notas que cuenten la misma historia en una sola narrativa.
- Descartá notas que no traten sobre esta persona o sus empresas (homónimos, menciones al pasar).
- Para cada narrativa elegí la nota más representativa y copiá su medio, fecha y url tal cual.
- Si hay menos de 3 historias distintas, devolvé menos.
- Respondé únicamente un array JSON: [{"t": "...", "fuente": "...", "fecha": "7 ago 2026", "url": "https://..."}]`;

async function claude(perfil, docs) {
  const lista = docs.map((d, i) =>
    `[${i + 1}] ${d.medio} · ${d.fecha}${d.tono ? ' · tono ' + d.tono : ''}\n${d.titulo}\n${d.texto}\n${d.url}`
  ).join('\n\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: 1200,
      system: SISTEMA,
      messages: [{ role: 'user', content: `Empresario: ${perfil.nombre} (${perfil.sector})\n\nNotas:\n\n${lista}` }]
    })
  });
  if (!res.ok) throw new Error('Claude ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const txt = (j.content || []).map((c) => c.text || '').join('');
  const m = txt.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Claude no devolvió JSON');
  const arr = JSON.parse(m[0]);
  const urls = new Set(docs.map((d) => d.url));
  return arr
    .filter((n) => n && n.t)
    .slice(0, 3)
    .map((n) => ({
      t: String(n.t).trim(),
      fuente: String(n.fuente || '').trim(),
      fecha: String(n.fecha || '').trim(),
      url: urls.has(n.url) ? n.url : '',
      origen: 'ia'
    }));
}

// Devuelve { [nombre]: narrativas[] } solo para los perfiles que salieron bien.
export async function generarNarrativas(perfiles) {
  const out = {};
  const avisos = [];
  for (const p of perfiles) {
    try {
      const docs = await notas(p);
      if (docs.length < 2) { avisos.push('IA ' + p.nombre + ': menos de 2 notas en ' + DIAS + ' días'); continue; }
      const temas = await claude(p, docs);
      if (temas.length) out[p.nombre] = temas;
    } catch (e) {
      avisos.push('IA ' + p.nombre + ': ' + String(e.message).slice(0, 140));
      if (/Tope de llamadas|429/.test(e.message)) break;
    }
  }
  return { narrativas: out, avisos, modelo: MODELO, generado: new Date().toISOString() };
}
