// Endpoint que lee el panel. NO consulta Meltwater: sirve lo que dejó guardado
// el refresco diario (`pulso-refresh.js`). Así el panel se puede abrir las
// veces que haga falta sin gastar de las 50 llamadas diarias de la cuota.
//
//   GET /api/pulso                 -> feed guardado
//   GET /api/pulso?probe=<dim>     -> 1 llamada: prueba una dimensión
//   GET /api/pulso?refrescar=1     -> fuerza un refresco (gasta cuota)
//   GET /api/pulso?estado=1        -> resultado del último refresco

import { leer, leerClave, probar, presupuesto, SEARCH_ID } from './_pulso-core.js';

export default async (request) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=604800'
  };

  if (!process.env.MELTWATER_API_KEY) {
    return new Response(JSON.stringify({ error: 'Falta MELTWATER_API_KEY en las variables de entorno.' }),
      { status: 500, headers });
  }

  const url = new URL(request.url);

  // Prueba barata de una dimensión: exactamente 1 llamada.
  const probe = url.searchParams.get('probe');
  if (probe) {
    try {
      return new Response(JSON.stringify({ dimension: probe, valores: await probar(probe) }, null, 2),
        { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ dimension: probe, error: String(e.message).slice(0, 300) }, null, 2),
        { status: 200, headers });
    }
  }

  // Refresco manual: despierta la función background y vuelve enseguida.
  // Gasta cuota (~39 llamadas de Meltwater + 13 de Claude). Tarda 2-4 minutos.
  if (url.searchParams.get('refrescar')) {
    const r = await fetch(url.origin + '/.netlify/functions/pulso-refresh-background', {
      method: 'POST', headers: { 'x-pulso-secreto': process.env.PULSO_SECRETO || '' }
    });
    return new Response(JSON.stringify({ disparado: r.status === 202, estado: r.status,
      mensaje: 'Refresco en curso. Volvé a abrir /api/pulso?estado=1 en unos minutos.' }, null, 2),
      { status: 202, headers });
  }

  // Resultado del último refresco (sin gastar cuota).
  if (url.searchParams.get('estado')) {
    return new Response(JSON.stringify((await leerClave('ultimo-refresco')) || { mensaje: 'Todavía no corrió ningún refresco.' }, null, 2),
      { status: 200, headers });
  }

  // Camino normal: leer lo guardado. Cero llamadas a Meltwater.
  const feed = await leer();
  // Feeds viejos guardados con el filtro por tags (ignorado por Meltwater):
  // todos los perfiles con la misma serie. No se sirven.
  const roto = feed && feed.empresarios && feed.empresarios.length > 2 &&
    new Set(feed.empresarios.map((e) => (e.volumen || []).join(','))).size === 1;
  if (feed && !roto) {
    const edadH = Math.round((Date.now() - new Date(feed.meta.actualizado).getTime()) / 3600000);
    return new Response(JSON.stringify({
      ...feed,
      meta: { ...feed.meta, edadHoras: edadH }
    }), { status: 200, headers });
  }

  return new Response(JSON.stringify({
    error: 'Todavía no hay un feed guardado. El refresco corre una vez por día; ' +
           'para generarlo ahora abrí /api/pulso?refrescar=1 (gasta ~26 de las 50 llamadas diarias).',
    presupuesto: presupuesto(),
    searchId: SEARCH_ID
  }, null, 2), { status: 503, headers });
};
