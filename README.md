# Pulso Empresarial

Panel de reputación de 13 empresarios argentinos. **Se actualiza solo todos los
lunes a las 9 AM (Argentina)** desde la búsqueda 29111241 de Meltwater, y un
analista IA (Claude) redacta las narrativas de cada perfil.

## Subir a GitHub

```bash
cd pulso-empresarial
git init && git add . && git commit -m "Pulso Empresarial"
git branch -M main
git remote add origin https://github.com/TU-ORG/pulso-empresarial.git
git push -u origin main
```


## Cómo funciona

```
Lunes 9 AM (cron)  pulso-refresh  ──►  pulso-refresh-background  (hasta 15 min)
                                     ├─ Meltwater analytics: volumen, tono, plataformas (26 llamadas)
                                     ├─ Meltwater search: notas de mayor alcance por perfil (13)
                                     ├─ Claude: 3 narrativas por perfil, solo con hechos de esas notas
                                     └─ guarda feed + narrativas en Netlify Blobs
Visitante        index.html  ──►  /api/pulso  (lee lo guardado, 0 llamadas)
```

Cuota: 39 llamadas de Meltwater por semana (un solo refresco, los lunes). Las visitas no consumen. Usá `?refrescar=1` solo si hace falta: cada uso gasta otras 39.

## Conectar Netlify

1. app.netlify.com → **Add new site → Import an existing project → GitHub** → elegí el repo.
2. Build command: vacío. Publish directory: `.` (ya lo define `netlify.toml`).
3. **Site configuration → Environment variables**:

| Variable | Obligatoria | Valor |
|---|---|---|
| `MELTWATER_API_KEY` | sí | token de Meltwater |
| `ANTHROPIC_API_KEY` | para la IA | clave de console.anthropic.com |
| `PULSO_SECRETO` | recomendada | cualquier texto largo; protege el refresco manual |
| `PULSO_MODELO` | no | default `claude-sonnet-4-5` |
| `PULSO_DIAS_NARRATIVA` | no | ventana de notas para la IA, default 45 |
| `MELTWATER_SEARCH_ID` | no | default 29111241 |

4. **Deploys → Trigger deploy**. Cada `git push` vuelve a publicar solo.

## Primera carga

`https://TU-SITIO.netlify.app/api/pulso?refrescar=1` → espera 2-4 minutos →
`/api/pulso?estado=1` muestra si salió bien. Después corre solo los lunes a las 9 AM.

## Editar

- **Sumar o pausar un empresario:** `PERFILES` en `netlify/functions/_pulso-core.js` (`kw` = palabras clave, `activo: false` para pausar).
- **Corregir una narrativa:** editá `pulso-narrativas.json`. La IA tiene prioridad; si querés que quede tu versión fija, borrá la variable `ANTHROPIC_API_KEY` o ajustá el prompt en `_pulso-ia.js`.
- Las narrativas generadas se marcan "redactado por IA" en la ficha.

## Si algo falla

| Síntoma | Causa |
|---|---|
| Indicador azul "Archivo curado" | no hay feed guardado todavía o falló el refresco → `?estado=1` |
| `Meltwater 401/403` | token inválido o sin permiso sobre la búsqueda |
| `Claude 401` | `ANTHROPIC_API_KEY` inválida |
| Todos con el mismo volumen | filtro ignorado; el refresco lo detecta y no guarda |
