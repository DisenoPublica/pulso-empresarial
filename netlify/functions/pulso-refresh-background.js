// Refresco completo en segundo plano (hasta 15 min, sin el límite de 30 s
// de las funciones programadas). Lo dispara pulso-refresh.js todos los días
// y también /api/pulso?refrescar=1.
//
// 1) Números: volumen, tono y plataformas por empresario (26 llamadas).
// 2) Analista IA: notas de mayor alcance + Claude → narrativas (13 llamadas
//    a Meltwater + 13 a Claude). Se saltea si falta ANTHROPIC_API_KEY.
// 3) Guarda el feed y las narrativas; el panel lee eso sin gastar cuota.

import { construirFeed, guardar, guardarClave, leerClave, perfilesActivos } from './_pulso-core.js';
import { generarNarrativas, iaActiva } from './_pulso-ia.js';

export default async (request) => {
  const secreto = process.env.PULSO_SECRETO;
  if (secreto && request.headers.get('x-pulso-secreto') !== secreto) {
    return new Response('no autorizado', { status: 401 });
  }
  const origin = new URL(request.url).origin;
  const log = { inicio: new Date().toISOString() };
  try {
    let ia = null;
    if (iaActiva()) {
      ia = await generarNarrativas(perfilesActivos());
      const previo = (await leerClave('narrativas-ia')) || { narrativas: {} };
      // Si un perfil falló hoy, conserva lo de ayer en vez de dejarlo vacío.
      ia.narrativas = { ...previo.narrativas, ...ia.narrativas };
      await guardarClave('narrativas-ia', ia);
    }
    const feed = await construirFeed(origin);
    feed.meta.narrativasIA = ia
      ? { generado: ia.generado, modelo: ia.modelo, perfiles: Object.keys(ia.narrativas).length }
      : null;
    if (ia && ia.avisos.length) feed.meta.avisos = [...(feed.meta.avisos || []), ...ia.avisos];
    await guardar(feed);
    log.ok = true; log.empresarios = feed.empresarios.length; log.llamadas = feed.meta.llamadasUsadas;
  } catch (e) {
    log.ok = false; log.error = String(e.message).slice(0, 400);
  }
  log.fin = new Date().toISOString();
  await guardarClave('ultimo-refresco', log);
  console.log(JSON.stringify(log));
};
