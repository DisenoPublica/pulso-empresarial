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

// CRITERIO: cada perfil se mide con su Custom Category de Explore (la misma
// que se ve en "Categorías personalizadas" del Benchmark Pulso Empresarial),
// así los números coinciden con Meltwater. Los ids se resuelven solos por
// nombre al refrescar; también se pueden fijar con la variable de entorno
// PULSO_CATEGORIAS = {"Marcos Galperin": 123, "Eduardo Elsztain": 456, ...}.
// Las keywords quedan solo como respaldo si no se encuentra la categoría.
//
// IMPORTANTE: el endpoint /custom de Meltwater NO acepta filtro por tags
// (lo ignora en silencio y devuelve el total de la búsqueda). Por eso cada
// perfil se separa con `keywords` (términos del nombre, OR entre ellos).
// Si preferís usar una Custom Category de Explore, poné su id en `cat` y
// tiene prioridad sobre las keywords.
const PERFILES = [
  { nombre: 'Marcos Galperin', sector: 'Tecnología · Mercado Libre', kw: ["Galperin"], cat: null, activo: true },
  { nombre: 'Martín Migoya', sector: 'Tecnología · Globant', kw: ["Migoya"], cat: null, activo: true },
  { nombre: 'Eduardo Elsztain', sector: 'Real estate y finanzas · IRSA / Cresud', kw: ["Eduardo Elsztain","Elsztain","Elsztein","elstain","Elstein"], cat: null, activo: true },
  { nombre: 'Paolo Rocca', sector: 'Industria · Grupo Techint', kw: ["Paolo Rocca"], cat: null, activo: true },
  { nombre: 'Manuel Santos Uribelarrea', sector: 'Agro y energía · Grupo MSU', kw: ["Santos Uribelarrea","Uribelarrea"], cat: null, activo: true },
  { nombre: 'Eduardo Bastitta', sector: 'Logística · Plaza Logística', kw: ["Eduardo Bastitta","Eduardo Bastita"], cat: null, activo: true },
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

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Lista las Custom Categories de la cuenta. Prueba los endpoints conocidos
// (cada intento gasta 1 llamada; se corta en el primero que responde).
const RUTAS_CATEGORIAS = ['/explore_plus/custom_categories', '/explore/custom_categories', '/custom_categories', '/searches/' + SEARCH_ID];
export async function listarCategorias() {
  const errores = [];
  for (const ruta of RUTAS_CATEGORIAS) {
    try {
      const r = await mw(ruta, null, 0);
      const out = [];
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        const id = n.id ?? n.category_id ?? n.custom_category_id;
        const name = n.name ?? n.title ?? n.label;
        if (id != null && typeof name === 'string' && /categor/i.test(JSON.stringify(Object.keys(n)) + ruta + (n.type || ''))) out.push({ id, nombre: name });
        Object.values(n).forEach(walk);
      };
      walk(r);
      if (out.length) return { ruta, categorias: out };
      errores.push(ruta + ': sin categorías en la respuesta');
    } catch (e) { errores.push(String(e.message).slice(0, 160)); }
  }
  return { ruta: null, categorias: [], errores };
}

let catsResueltas = false;
export async function resolverCategorias() {
  if (catsResueltas) return ACTIVOS.map((p) => ({ nombre: p.nombre, cat: p.cat }));
  let fijas = {};
  try { fijas = JSON.parse(process.env.PULSO_CATEGORIAS || '{}'); } catch (_) { /* mal formado */ }
  const fijasN = Object.fromEntries(Object.entries(fijas).map(([k, v]) => [norm(k), v]));
  for (const p of ACTIVOS) if (!p.cat && fijasN[norm(p.nombre)]) p.cat = fijasN[norm(p.nombre)];
  if (ACTIVOS.some((p) => !p.cat)) {
    const { categorias } = await listarCategorias();
    for (const p of ACTIVOS) {
      if (p.cat) continue;
      const hit = categorias.find((c) => norm(c.nombre) === norm(p.nombre)) ||
                  categorias.find((c) => norm(c.nombre).includes(norm(p.nombre)));
      if (hit) p.cat = hit.id;
    }
  }
  catsResueltas = true;
  return ACTIVOS.map((p) => ({ nombre: p.nombre, cat: p.cat }));
}

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
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 220);
    // Si Meltwater rechaza el formato de custom_categories, prueba el siguiente
    // formato y, si ninguno sirve, cae a keywords del perfil.
    if (res.status === 400 && body && body.custom_categories && /custom_categories/.test(txt)) {
      const sig = siguienteFormato(body);
      if (sig) return mw(path, sig, reintentos);
    }
    throw new Error('Meltwater ' + res.status + ' en ' + path + ': ' + txt);
  }
  return res.json();
}

const KW = Symbol('kw');
const FORMATO = Symbol('fmt');
const FORMATOS = [
  (id) => [Number(id)],
  (id) => [String(id)],
  (id) => String(id),
  (id) => Number(id)
];
export const avisosFormato = new Set();
function siguienteFormato(body) {
  const i = (body[FORMATO] ?? 0) + 1;
  const id = body.__catId;
  const { custom_categories, __catId, ...resto } = body;
  if (i < FORMATOS.length) {
    const v = FORMATOS[i](id);
    if (typeof v === 'number' && !Number.isFinite(v)) return siguienteFormato({ ...body, [FORMATO]: i });
    const nb = { ...resto, custom_categories: v };
    Object.defineProperty(nb, '__catId', { value: id, enumerable: false });
    nb[FORMATO] = i; nb[KW] = body[KW];
    return nb;
  }
  const kw = body[KW];
  if (!kw || !kw.length) return null;
  avisosFormato.add('Meltwater rechazó la Custom Category ' + id + '; ese perfil se midió por keywords.');
  return { ...resto, keywords: kw };
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
  if (perfil.cat) {
    const n = Number(perfil.cat);
    const b = { ...base, custom_categories: Number.isFinite(n) ? [n] : [String(perfil.cat)] };
    Object.defineProperty(b, '__catId', { value: perfil.cat, enumerable: false });
    b[FORMATO] = Number.isFinite(n) ? 0 : 1;
    b[KW] = perfil.kw;
    return b;
  }
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
    searchName: (perfil.cat ? 'Custom Category ' + perfil.cat : 'keywords ' + perfil.kw.join(' / ')) + ' en búsqueda ' + SEARCH_ID,
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

  const cats = await resolverCategorias();
  const sinCat = cats.filter((c) => !c.cat).map((c) => c.nombre);

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
  avisos.push(...avisosFormato);
  if (sinCat.length) avisos.unshift('Sin Custom Category (medidos por keywords, no comparables con Meltwater): ' + sinCat.join(', '));
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
      categorias: cats,
      nota: 'Fuentes 100% digitales. El mes en curso está cargado parcialmente. ' +
            'Tono: clasificación nativa de Meltwater, no auditada editorialmente. ' +
            'Volumen por Custom Category de cada empresario dentro de la búsqueda ' + SEARCH_ID + ' (mismo criterio que Explore). ' +
            'Se actualiza una vez por semana, los lunes a las 9 AM, para cuidar la cuota de la API de Meltwater.'
    },
    empresarios
  };
}
