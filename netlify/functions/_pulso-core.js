// Núcleo compartido: consulta a Meltwater, armado del feed y persistencia.
// Lo usan `pulso.js` (lectura) y `pulso-refresh.js` (escritura programada).
//
// CUOTA: 50 llamadas de análisis por día. Todo acá está diseñado alrededor de
// ese número — por eso el feed se arma una vez por día y se guarda, en vez de
// consultarse en cada visita.

const API = 'https://api.meltwater.com/v3';
export const SEARCH_ID = process.env.MELTWATER_SEARCH_ID || '29111241';
const TZ = process.env.PULSO_TZ || 'America/Argentina/Buenos_Aires';
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Por defecto (completo) son 2 llamadas por perfil: volumen mensual con
// plataformas anidadas + tono. 13 perfiles = 26 de las 50 diarias.
// PULSO_LIVE=volumen baja a 1 llamada por perfil (sin tono).
const LIVE_COMPLETO = (process.env.PULSO_LIVE || 'completo') === 'completo';
const TOPE = Number(process.env.PULSO_TOPE_LLAMADAS || 45);

export function presupuesto() {
  return { topePorCorrida: TOPE, cuotaDiariaMeltwater: 50, modo: LIVE_COMPLETO ? 'completo' : 'volumen' };
}

// Dimensiones confirmadas contra la 29111241.
const DIM_PLATAFORMA = 'media_type';
const DIM_TONO = 'sentiment';
const GRANULARIDAD = 'month';

// IMPORTANTE: el endpoint /custom de Meltwater NO acepta filtro por tags
// (lo ignora en silencio y devuelve el total de la búsqueda). Por eso cada
// perfil se separa con `keywords` (términos del nombre, OR entre ellos).
// Si preferís usar una Custom Category de Explore, poné su id en `cat` y
// tiene prioridad sobre las keywords.
const PERFILES = [
  { nombre: 'Marcos Galperin', sector: 'Tecnología · Mercado Libre', kw: ["Galperin"], cat: null, activo: true },
  { nombre: 'Martín Migoya', sector: 'Tecnología · Globant', kw: ["Migoya"], cat: null, activo: true },
  { nombre: 'Eduardo Elsztain', sector: 'Real estate y finanzas · IRSA / Cresud', kw: ["Elsztain"], cat: null, activo: true },
  { nombre: 'Paolo Rocca', sector: 'Industria · Grupo Techint', kw: ["Paolo Rocca"], cat: null, activo: true },
  { nombre: 'Manuel Santos Uribelarrea', sector: 'Agro y energía · Grupo MSU', kw: ["Santos Uribelarrea","Uribelarrea"], cat: null, activo: true },
  { nombre: 'Eduardo Bastitta', sector: 'Logística · Plaza Logística', kw: ["Bastitta"], cat: null, activo: true },
  { nombre: 'Eduardo Costantini', sector: 'Real estate · Consultatio', kw: ["Eduardo Costantini"], cat: null, activo: true },
  { nombre: 'Eduardo Eurnekian', sector: 'Infraestructura · Corporación América', kw: ["Eurnekian"], cat: null, activo: true },
  { nombre: 'Federico Braun', sector: 'Retail · La Anónima', kw: ["Federico Braun"], cat: null, activo: true },
  { nombre: 'José Luis Manzano', sector: 'Energía y medios · Integra Capital', kw: ["José Luis Manzano","Jose Luis Manzano"], cat: null, activo: true },
  { nombre: 'Luis Pérez Companc', sector: 'Agro y alimentos · Molinos', kw: ["Pérez Companc","Perez Companc"], cat: null, activo: true },
  { nombre: 'Marcelo Mindlin', sector: 'Energía · Pampa Energía', kw: ["Mindlin"], cat: null, activo: true },
  { nombre: 'Marcos Bulgheroni', sector: 'Energía · Pan American Energy', kw: ["Marcos Bulgheroni"], cat: null, activo: true }
];
const ACTIVOS = PERFILES.filter((p) => p.activo !== false);
export const perfilesActivos = () => ACTIVOS;

const PLAT_MAP = {
  news: 'prensa', online_news: 'prensa', print: 'prensa', broadcast: 'prensa',
  podcast: 'prensa', press_release: 'prensa', magazine: 'prensa', editorial: 'prensa',
  social_media: 'redes', social: 'redes',
  blog: 'foros', blogs: 'foros', forum: 'foros', forums: 'foros',
  review: 'foros', reviews: 'foros', comment: 'foros', message_board: 'foros',
  consumer_review: 'foros',
  twitter: 'x', x: 'x',
  facebook: 'redes', instagram: 'redes', tiktok: 'redes', linkedin: 'redes',
  reddit: 'redes', threads: 'redes', bluesky: 'redes', mastodon: 'redes',
  youtube: 'video', vimeo: 'video', twitch: 'video', video: 'video'
};

// ---------------------------------------------------------------------------
// Persistencia. Netlify Blobs si está disponible; si no, memoria del proceso
// (se pierde en cold start, pero el panel siempre tiene el archivo curado).
// ---------------------------------------------------------------------------
let memoria = null;

async function store() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore('pulso');
  } catch (_) { return null; }
}

export async function guardar(feed) {
  memoria = feed;
  const s = await store();
  if (s) await s.setJSON('feed', feed);
}

export async function leerClave(clave) {
  const s = await store();
  if (s) { try { return await s.get(clave, { type: 'json' }); } catch (_) { /* nada */ } }
  return null;
}
export async function guardarClave(clave, valor) {
  const s = await store();
  if (s) await s.setJSON(clave, valor);
}

export async function leer() {
  const s = await store();
  if (s) {
    try {
      const f = await s.get('feed', { type: 'json' });
      if (f) return f;
    } catch (_) { /* cae a memoria */ }
  }
  return memoria;
}

// ---------------------------------------------------------------------------

let llamadas = 0;

export async function mw(path, body, reintentos = 1) {
  if (llamadas >= TOPE) throw new Error('Tope de llamadas por corrida alcanzado (' + TOPE + ')');
  llamadas++;
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      apikey: process.env.MELTWATER_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 429 && reintentos > 0) {
    const espera = Number(res.headers.get('retry-after') || 0) * 1000 || 3000;
    await new Promise((r) => setTimeout(r, espera));
    return mw(path, body, reintentos - 1);
  }
  if (!res.ok) throw new Error('Meltwater ' + res.status + ' en ' + path + ': ' + (await res.text()).slice(0, 220));
  return res.json();
}

export async function probar(dimension) {
  const w = ventana();
  const r = await mw('/analytics/' + SEARCH_ID + '/custom', {
    start: w.start, end: w.end, tz: TZ,
    analysis: { type: 'top_terms', dimension, limit: 30 }
  }, 0);
  return pares(r).slice(0, 30);
}

// Período fijo: desde PULSO_DESDE (1 de abril) hasta hoy, un bucket por mes.
const DESDE = process.env.PULSO_DESDE || '2026-04-01';
function ventana() {
  const hoy = new Date();
  const finMes = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()));
  const d0 = new Date(DESDE + 'T00:00:00Z');
  const inicio = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1));
  const n = (hoy.getUTCFullYear() - inicio.getUTCFullYear()) * 12 + hoy.getUTCMonth() - inicio.getUTCMonth() + 1;
  const buckets = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + i, 1));
    const sig = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const esActual = i === n - 1;
    buckets.push({
      key: d.toISOString().slice(0, 7),
      label: MESES[d.getUTCMonth()] + (esActual ? '*' : ''),
      dias: esActual ? Math.max(1, hoy.getUTCDate() - 1) : Math.round((sig - d) / 86400000),
      parcial: esActual
    });
  }
  return { start: inicio.toISOString().slice(0, 19), end: finMes.toISOString().slice(0, 19), buckets };
}

function conFiltro(base, perfil) {
  if (perfil.cat) return { ...base, custom_categories: [Number(perfil.cat)] };
  if (perfil.kw && perfil.kw.length) return { ...base, keywords: perfil.kw };
  throw new Error('perfil sin filtro: ' + perfil.nombre);
}

// Respuesta: { result: { document_count, analysis: [{ key, document_count, analysis? }] } }
function filas(payload) {
  const a = payload && payload.result && payload.result.analysis;
  return Array.isArray(a) ? a : [];
}
function totalDe(payload) {
  return (payload && payload.result && payload.result.document_count) || 0;
}

function pares(payload) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const clave = node.key ?? node.value ?? node.name ?? node.term ?? node.date ?? node.bucket;
    const total = node.document_count ?? node.count ?? node.total ?? node.doc_count;
    if (clave != null && typeof total === 'number') out.push({ clave: String(clave), total });
    Object.values(node).forEach(walk);
  };
  walk(payload);
  return out;
}

function repartir(lista, mapa, familias) {
  const acc = Object.fromEntries(familias.map((f) => [f, 0]));
  const sinMapear = {};
  let suma = 0;
  for (const { clave, total } of lista) {
    const k = String(clave).toLowerCase().trim().replace(/[\s-]+/g, '_');
    const familia = mapa[k];
    if (!familia) { sinMapear[k] = (sinMapear[k] || 0) + total; continue; }
    acc[familia] += total;
    suma += total;
  }
  const pct = suma
    ? Object.fromEntries(familias.map((f) => [f, +((acc[f] / suma) * 100).toFixed(1)]))
    : Object.fromEntries(familias.map((f) => [f, 0]));
  return { pct, sinMapear };
}

async function perfilData(perfil, win) {
  const base = { start: win.start, end: win.end, tz: TZ };
  const aviso = [];

  // 1 llamada: volumen mensual + plataformas anidadas por mes
  const hist = await mw('/analytics/' + SEARCH_ID + '/custom', conFiltro({
    ...base,
    analysis: LIVE_COMPLETO
      ? { type: 'date_histogram', granularity: GRANULARIDAD,
          analysis: { type: 'top_terms', dimension: DIM_PLATAFORMA, limit: 30 } }
      : { type: 'date_histogram', granularity: GRANULARIDAD }
  }, perfil));

  const porMes = new Map();
  const platAcum = {};
  for (const f of filas(hist)) {
    const k = String(f.key || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(k)) porMes.set(k, (porMes.get(k) || 0) + (f.document_count || 0));
    for (const sub of (Array.isArray(f.analysis) ? f.analysis : [])) {
      const pk = String(sub.key);
      platAcum[pk] = (platAcum[pk] || 0) + (sub.document_count || 0);
    }
  }

  // 2da llamada: tono
  let sent = null;
  if (LIVE_COMPLETO) {
    try {
      sent = await mw('/analytics/' + SEARCH_ID + '/custom', conFiltro({
        ...base, analysis: { type: 'top_terms', dimension: DIM_TONO, limit: 10 }
      }, perfil));
    } catch (e) { aviso.push('tono: ' + e.message); }
  }

  const s = sent
    ? repartir(filas(sent).map((r) => ({ clave: r.key, total: r.document_count || 0 })),
        { negative: 'neg', neutral: 'neu', positive: 'pos', neg: 'neg', neu: 'neu', pos: 'pos' }, ['neg', 'neu', 'pos'])
    : { pct: { neg: 0, neu: 0, pos: 0 }, sinMapear: {} };
  const pl = Object.keys(platAcum).length
    ? repartir(Object.entries(platAcum).map(([clave, total]) => ({ clave, total })), PLAT_MAP, ['prensa', 'x', 'redes', 'video', 'foros'])
    : { pct: { prensa: 0, x: 0, redes: 0, video: 0, foros: 0 }, sinMapear: {} };

  for (const [k, v] of Object.entries(pl.sinMapear)) aviso.push('plataforma sin mapear: "' + k + '" (' + v + ' docs)');

  return {
    nombre: perfil.nombre,
    sector: perfil.sector,
    searchName: (perfil.cat ? 'categoría ' + perfil.cat : 'keywords ' + perfil.kw.join(' / ')) + ' en búsqueda ' + SEARCH_ID,
    volumen: win.buckets.map((b) => porMes.get(b.key) || 0),
    total: totalDe(hist),
    sent: s.pct,
    plat: pl.pct,
    avisos: aviso
  };
}

export async function construirFeed(origin) {
  llamadas = 0;
  const win = ventana();

  let narrativas = {}, curado = {};
  try {
    const r = await fetch(new URL('/pulso-narrativas.json', origin));
    if (r.ok) narrativas = await r.json();
  } catch (_) { /* opcional */ }
  try {
    const r = await fetch(new URL('/pulso-data.json', origin));
    if (r.ok) for (const e of ((await r.json()).empresarios || [])) curado[e.nombre] = e;
  } catch (_) { /* opcional */ }

  const empresarios = [];
  let corte = null;
  for (const p of ACTIVOS) {
    try {
      empresarios.push(await perfilData(p, win));
    } catch (e) {
      corte = String(e.message).slice(0, 160);
      if (/429|rate limit|Tope de llamadas/i.test(corte)) break;
    }
  }
  if (!empresarios.length) throw new Error(corte || 'ningún perfil devolvió datos');
  const totales = new Set(empresarios.map((e) => e.volumen.join(',')));
  if (empresarios.length > 2 && totales.size === 1) {
    throw new Error('Todos los perfiles devolvieron el mismo volumen: el filtro por perfil no se aplicó. No se guarda el feed.');
  }

  // Completar con la copia curada lo que no vino en vivo
  for (const e of empresarios) {
    const c = curado[e.nombre];
    if (!c) continue;
    if (!e.sent.neg && !e.sent.neu && !e.sent.pos) e.sent = c.sent;
    if (!Object.values(e.plat).some(Boolean)) e.plat = c.plat;
  }
  const enVivo = empresarios.length;
  for (const p of ACTIVOS) {
    if (empresarios.some((e) => e.nombre === p.nombre)) continue;
    const c = curado[p.nombre];
    if (c) empresarios.push({ ...c, avisos: ['sin datos en vivo (' + (corte || 'no consultado') + ')'] });
  }

  const avisos = [...new Set(empresarios.flatMap((e) => e.avisos || []))];
  // Narrativas: primero las del analista IA (último refresco), si no las editoriales.
  const ia = (await leerClave('narrativas-ia')) || { narrativas: {} };
  for (const e of empresarios) {
    const deIA = ia.narrativas && ia.narrativas[e.nombre];
    e.temas = (deIA && deIA.length) ? deIA : (narrativas[e.nombre] || []);
    delete e.avisos; delete e.total;
  }

  const primero = win.buckets[0], ultimo = win.buckets[win.buckets.length - 1];
  return {
    meta: {
      fuente: 'Meltwater',
      searchId: SEARCH_ID,
      searchUrl: 'https://app.meltwater.com/analytics/search/' + SEARCH_ID,
      periodo: primero.label.replace('*', '') + '–' + ultimo.label.replace('*', '') + ' ' + new Date().getUTCFullYear(),
      anio: new Date().getUTCFullYear(),
      meses: win.buckets.map((b) => b.label),
      diasPorMes: win.buckets.map((b) => b.dias),
      mesParcialIndex: win.buckets.findIndex((b) => b.parcial),
      actualizado: new Date().toISOString(),
      matrizTotal: PERFILES.length,
      pendientes: PERFILES.filter((p) => p.activo === false).map((p) => p.nombre),
      camposEnVivo: LIVE_COMPLETO ? ['volumen', 'tono', 'plataformas'] : ['volumen'],
      perfilesEnVivo: enVivo,
      llamadasUsadas: llamadas,
      corte,
      avisos,
      nota: 'Fuentes 100% digitales. El mes en curso está cargado parcialmente. ' +
            'Tono: clasificación nativa de Meltwater, no auditada editorialmente. ' +
            'Separación por keywords de cada nombre dentro de la búsqueda ' + SEARCH_ID + '. ' +
            'Se actualiza una vez por semana, los lunes a las 9 AM, para cuidar la cuota de la API de Meltwater.'
    },
    empresarios
  };
}
