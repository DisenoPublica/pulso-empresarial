# Pulso Empresarial — conexión a Meltwater

El dashboard (`Pulso Empresarial.dc.html`) no habla con Meltwater directamente: la
API pide un token que no puede vivir en el navegador. La función de Netlify hace
de intermediaria — guarda el token del lado del servidor, consulta la búsqueda
**29111241** y devuelve el JSON que el panel ya sabe leer.

```
navegador  →  /api/pulso  →  función Netlify  →  api.meltwater.com
              (sin token)     (token en env)
```

## Cadena de fuentes

El panel intenta en orden y se queda con la primera que responda:

| Orden | Fuente | Estado que muestra |
|---|---|---|
| 1 | `/api/pulso` (Meltwater en vivo) | **Meltwater en vivo** (verde) |
| 2 | `./pulso-data.json` (archivo curado) | **Archivo curado** (azul) |
| 3 | datos embebidos en el componente | **Snapshot local** (ámbar) |

Nunca queda en blanco. En el preview de diseño, donde no hay función, cae al
archivo curado — eso es lo esperado.

## La cuota manda: 50 llamadas de análisis por día

Este es el número que define toda la arquitectura. Cada consulta de analytics a
Meltwater cuenta, y hay **50 por día**. Por eso el feed **no** se arma cuando
alguien abre el panel — eso gastaría cuota en cada visita.

En su lugar:

```
1×/día  pulso-refresh  →  Meltwater (13 llamadas)  →  guarda el feed
∞       /api/pulso     →  lee lo guardado (0 llamadas)
```

El panel se puede abrir las veces que haga falta sin tocar la cuota.

### Costo por corrida

| Modo | Llamadas | Qué trae en vivo |
|---|---|---|
| `volumen` (default) | 13 | Volumen mensual. Tono y plataformas del archivo curado |
| `completo` | 39 | Volumen, tono y plataformas |

`completo` deja solo 11 llamadas de margen en el día: usalo únicamente si no
vas a refrescar a mano.

### Cuándo corre

Todos los días a las 10:00 AM (Argentina). El cron se define en UTC dentro de
`netlify/functions/pulso-refresh.js`:

```js
export const config = { schedule: '0 13 * * *' };  // 13:00 UTC = 10:00 AR
```

Argentina no tiene horario de verano, así que la conversión es fija (UTC-3).
Para forzarlo:

```
https://TU-SITIO.netlify.app/api/pulso?refrescar=1
```

Eso gasta 13 llamadas. El panel muestra la antigüedad del dato, así que se nota
si el refresco falló.

---

## Deploy

1. Subí el proyecto a Netlify (arrastrar la carpeta o conectar el repo).
2. **Site settings → Environment variables**, agregá:

   | Variable | Valor |
   |---|---|
   | `MELTWATER_API_KEY` | tu token (Account → Meltwater API → Create Token) |
   | `MELTWATER_SEARCH_ID` | `29111241` *(opcional, ya es el default)* |
   | `PULSO_TZ` | `America/Argentina/Buenos_Aires` *(opcional)* |
   | `PULSO_MESES` | `6` *(opcional: cuántos meses traer)* |

3. Redeploy. Verificá en `https://TU-SITIO.netlify.app/api/pulso`.

El token nunca se expone: vive solo en las variables de entorno de Netlify.

## Ajustar los filtros por empresario

La separación dentro de la 29111241 es **por tags**, uno por empresario. El mapa
`PERFILES` en `netlify/functions/pulso.js` los lista con el nombre exacto del
tag, y `activo` controla quién entra al panel:

```js
{ tag: 'Marcos Galperin', nombre: 'Marcos Galperin', sector: 'Tecnología · Mercado Libre', activo: true },
{ tag: 'Marcelo Mindlin', nombre: 'Marcelo Mindlin', sector: 'Energía · Pampa Energía', activo: true },
```

Los 13 perfiles del roster están activos. `activo: false` saca a alguno del
panel sin borrarlo del mapa.

```js
{ tag: 'Marcos Galperin', nombre: 'Marcos Galperin', sector: 'Tecnología · Mercado Libre', activo: true },
```

El panel se adapta solo: colores, ejes, títulos y el contador "N de N" salen del
feed.

**El tag tiene que coincidir exacto**, con tildes y mayúsculas, porque se manda
tal cual en la consulta. Los 5 activos (incluidos *Eduardo Elsztain* y
*Paolo Rocca*) están confirmados contra la búsqueda.

Para ver la lista completa de tags y detectar alguno que falte en el mapa:

```
https://TU-SITIO.netlify.app/api/pulso?debug=1
```

## Narrativas

`pulso-narrativas.json` es editorial y **no** sale de la API: son las 3 narrativas
por empresario, con fuente, fecha y link. La función las pega al feed por nombre.
Para actualizarlas se edita ese archivo — el resto del panel sigue viniendo de
Meltwater.

## Qué trae la API y qué no

| Dato | Origen |
|---|---|
| Volumen mensual | Meltwater (`date_histogram` por tag) |
| Tono neg/neu/pos | Meltwater (`top_terms` sobre `sentiment`) |
| Mix de plataformas | Meltwater (`top_terms` sobre `source_type`) |
| Narrativas y fuentes | Editorial (`pulso-narrativas.json`) |
| Sector de cada perfil | Fijo en `PERFILES` |

El mes en curso se marca solo como parcial, con los días efectivamente cargados,
así el cálculo de ritmo diario del panel sigue siendo válido sin tocar nada.
