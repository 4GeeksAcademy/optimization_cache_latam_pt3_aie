# Plan de Telemetría — Estante (Gestión de Inventario)

Documento de planificación para el instrumentado de eventos de la aplicación **Estante**: catálogo de libros con gestión de stock (React + TypeScript en frontend, FastAPI en backend, datos en `backend/books.json`).

Este plan define **qué medir, por qué, con qué estructura y con qué latencia**, y sirve de base para los esquemas formales incluidos en [`event-schemas.json`](./event-schemas.json).

---

## 1. Decisiones confirmadas con el negocio

| Decisión | Resolución | Consecuencia técnica |
| --- | --- | --- |
| Destino de los eventos | `POST /events` en FastAPI + persistencia en archivo local (JSONL) | Nuevo endpoint de ingest y archivo `backend/events.jsonl` |
| Identidad | Sesión anónima generada en `localStorage` (expira por inactividad); `user_id = null` por ahora | El envelope siempre lleva `session_id`; `user_id` reservado para login futuro |
| Batch vs. stream | **Ver datos en segundos, pero enviar por lotes** | Emisión en micro-lotes (buffer cliente con flush por tiempo/tamaño) + lectura casi en tiempo real |
| Llegada de mercancía | `goods_received` es un evento **futuro**; hoy se deriva de `book_created` | Taxonomía preparada, implementación diferida |
| Umbral de stock bajo | **≤ 3 unidades** por defecto, configurable en `properties.threshold` | El umbral viaja en el evento; el consumidor no debe hardcodearlo |
| Alcance de eventos | Negocio + técnicos + rendimiento UI | Tres dominios en la taxonomía |

---

## 2. Batch vs. stream: el concepto que define el pipeline

**La pregunta:** ¿el negocio necesita ver este dato en segundos (stream) o basta procesarlo en lotes periódicos (batch)?

**Respuesta del negocio:** *en segundos pero enviado por lote*.

Esto no es una contradicción: son **dos ejes independientes**.

- **Eje de emisión (cómo llegan los datos):** `batch`. El cliente acumula eventos en un buffer y los envía agrupados (cada ~3–5 segundos **o** al llegar a 20 eventos, lo que ocurra primero, además de flush inmediato en `session_end` o `pagehide` para no perder eventos). Esto reduce viajes de red, sobrevive a desconexiones breves y es más barato que un evento-por-request.
- **Eje de consumo (con qué latencia se usan los datos):** `stream` / casi en tiempo real. El backend persiste cada lote en **JSONL append-only**, y un lector hace *tail* del archivo para alimentar alertas (p. ej. alerta de stock bajo) con latencia de segundos.
- **Agregaciones batch:** los reportes (stock bajo por día, top de libros, tiempo medio de sesión) se calculan en lotes periódicos (cada 1–5 min) sobre el mismo JSONL. No necesitan ser en segundos.

**Decisión de diseño para los próximos días:**

```
[React: buffer + flush por tiempo/tamaño]
        │  POST /events (lote: { events: [...] })
        ▼
[FastAPI: /events → validación con envelope → append a backend/events.jsonl]
        │
        ├──▶ Lector en streaming (tail) → alertas/paneles en segundos
        └──▶ Job por lotes (1–5 min) → métricas agregadas y reportes
```

> Regla: la **emisión** es batch, la **lectura** es streaming, los **reportes** son batch. Diseñar el esquema de evento para que sea reintentable e idempotente (clave: `event_id`), porque los lotes se reenvían.

---

## 3. Event Envelope: la estructura estándar de todo evento

Todo evento —sin excepción— sigue este sobre estándar (especificación completa en `event-schemas.json`). **Todas las claves usan `snake_case`** (convención declarada en `naming_convention`), incluidas las de los payload de cada evento.

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `event_id` | string (UUID v4) | Identificador único del evento; clave de idempotencia (evita duplicados al reenviar lotes). |
| `timestamp` | string (ISO 8601, con offset) | Momento de ocurrencia del evento en el cliente, ej. `2026-10-30T14:23:05.123Z`. |
| `session_id` | string (UUID v4) | Sesión anónima en `localStorage`, expira tras inactividad; permite agrupar la acción y calcular tiempo en la aplicación. |
| `user_id` | string \| null | Identificador de usuario autenticado. `null` hoy (sin login); listo para el futuro. |
| `event_type` | string | Taxonomía consistente `entidad_acción` en snake_case, ej. `book_detail_viewed`, `stock_low_detected`. |
| `schema_version` | string | Versión del esquema del evento, ej. `"1.0.0"`. Permite evolucionar sin romper consumidores. |
| `request_id` | string (UUID v4) | Identificador de correlación que viaja del frontend al backend y a los logs: el mismo valor en el evento, la cabecera `X-Request-Id` de la API y el log del servidor. |
| `source` | enum | `frontend` o `backend` — quién emitió el evento. |
| `context` | object | Entorno donde ocurrió el evento (ver §3.1). |
| `metadata` | object | Metadatos de entrega e instrumentación del propio evento (ver §3.2). |
| `properties` | object | Payload específico de cada `event_type` (definido en `event-schemas.json`). |

**Taxonomía `entidad_acción`:** `entidad` = sustantivo en snake_case (`book`, `stock`, `session`, `catalog`, `api`, `cache`, `app`, `goods`); `acción` = verbo en pasado o estado (`created`, `viewed`, `consulted`, `detected`, `failed`).

### 3.1 `context` — entorno del evento

Estable durante la página/sesión; no cambia evento a evento salvo navegación.

| Campo | Requerido | Descripción |
| --- | --- | --- |
| `app_version` | ✅ | Versión de la aplicación desplegada, ej. `1.0.0`. |
| `page_path` | ✅ | Ruta activa donde ocurrió el evento, ej. `/books/7`. |
| `referrer` | opcional | Ruta o URL de procedencia. |
| `viewport_width` | opcional | Ancho del viewport en píxeles. |
| `os` | opcional | SO/navegador derivado de user_agent, ej. `macOS / Chrome 130`. |
| `language` | opcional | Idioma del navegador, ej. `es-ES`. |

### 3.2 `metadata` — entrega e instrumentación

| Campo | Requerido | Descripción |
| --- | --- | --- |
| `sequence` | ✅ | Número correlativo del evento dentro de la sesión (orden de emisión). |
| `batch_id` | ✅ (UUID) | Agrupa todos los eventos enviados en el mismo `POST /events`; útil para debug de lotes. |
| `sent_at` | ✅ (ISO 8601) | Momento en que el emisor envió el lote (puede diferir de `timestamp` por el buffer). |
| `emitter` | ✅ | Librería/versión que emitió el evento, ej. `estante-telemetry/1.0.0`. |
| `locale` | opcional | Locale usado por el emisor, ej. `es-ES`. |

> `timestamp` (cuándo ocurrió) vs. `sent_at` (cuándo se envió) son deliberadamente distintos: el buffer de lote puede retrasar la entrega varios segundos.

---

## 4. Catálogo de oportunidades (fundamentado)

Cada oportunidad responde a una pregunta de negocio, indica la métrica que habilita, el evento que la produce y su latencia de consumo.

### 4.1 Dominio: Negocio / Inventario

#### OP-01 · Llegada de mercancía
- **Pregunta de negocio:** ¿Cuántas unidades entraron al inventario y cuándo? ¿Qué títulos se reponen con más frecuencia?
- **Evento hoy:** `book_created` (el alta de un libro con `stock` es la única recepción posible en la versión actual).
- **Evento futuro:** `goods_received` — flujo explícito de recepción de mercancía cuando exista. Hasta entonces, las oportunidades de "llegada de mercancía" se calculan a partir de `book_created`.
- **Métricas:** unidades recibidas por día/semana; recepciones por `stock_id`; títulos con reposición frecuente; frecuencia de llegadas.
- **Latencia:** batch (reportes), no requiere segundos.
- **Fundamento:** sin este dato no se puede distinguir "crecimiento de catálogo" de "reposición de inventario", ni medir rotación real.

#### OP-02 · Alerta de stock bajo
- **Pregunta de negocio:** ¿Qué títulos están a punto de agotarse y hay que reponer ya?
- **Evento:** `stock_low_detected` (disparado al crear/actualizar un libro con `stock ≤ 3`, umbral configurable).
- **Métricas:** número de títulos en riesgo; valor del stock en riesgo; tiempo hasta reposición (detección → siguiente `book_created`/`goods_received` del mismo `stock_id`); recurrencia de quiebres por título.
- **Latencia:** **segundos** (stream de lectura) — es la única oportunidad que justifica la lectura en tiempo real: una alerta que llega tarde no sirve.
- **Fundamento:** el stock es el activo del negocio; un título agotado es venta perdida y la app ya muestra el estado de existencias en tarjeta y detalle.

#### OP-03 · Catálogo y demanda (libro más popular)
- **Pregunta de negocio:** ¿Qué libros interesan más? ¿Qué conviene destacar o reponer primero?
- **Eventos:** `book_detail_viewed` (click a "ver detalle"), `catalog_search`, `stock_consulted`.
- **Métricas:** libro más popular (top N por vistas de detalle); vistas de detalle por `genre`; tasa de detalle sobre visitas de catálogo; consultas de stock que terminan en vista de detalle; búsquedas sin resultados (oportunidad de gap de catálogo).
- **Latencia:** batch (análisis); no exige segundos.
- **Fundamento:** la demanda expresada por clics es la señal más barata para decisiones de compra/reposición y para descubrir títulos "con demanda pero sin stock" (intersección `book_detail_viewed` + `stock ≤ 3`).

### 4.2 Dominio: Rendimiento UI

#### OP-04 · Tiempo en la aplicación
- **Pregunta de negocio:** ¿Cuánto tiempo dedican los usuarios a la app y en qué momentos abandonan?
- **Eventos:** `session_started`, `session_ended` (con `durationMs` y `end_reason`: `idle_timeout`, `pagehide`, `logout`).
- **Métricas:** duración media/mediana de sesión; sesiones por día; tasa de sesiones < 10 s (posible error de carga); distribución horaria; abandono (sesiones que terminan sin acción de negocio).
- **Latencia:** batch.
- **Fundamento:** sin duración de sesión no hay base para comparar cambios de UI ni detectar regresiones de experiencia.

#### OP-05 · Carga inicial y errores de la interfaz
- **Pregunta de negocio:** ¿La app carga rápido y sin errores para el usuario?
- **Eventos:** `app_loaded` (tiempo hasta catálogo pintado), `app_error` (errores de render/ruta), `page_viewed`.
- **Métricas:** tiempo de carga inicial (p50/p95); tasa de sesiones con error; páginas vistas por sesión.
- **Latencia:** batch (pueden escalar a stream si hay alertas de caída).
- **Fundamento:** una app de inventario lenta o rota paraliza la operación diaria del usuario.

### 4.3 Dominio: Técnico / API y caché

#### OP-06 · Salud de la API
- **Pregunta técnica:** ¿La API responde bien y qué endpoints fallan?
- **Eventos (emisión backend):** `api_request_completed` (ruta, método, status, duración), `api_request_failed` (status, detalle).
- **Métricas:** tasa de error por ruta; latencia p50/p95/p99 por endpoint (`GET /books`, `GET /book/{id}`, `POST /book`, `GET /book/stock/{stock_id}`); volumen de requests.
- **Latencia:** batch con lectura casi en tiempo real para alertas de caída (tasa de error > umbral).
- **Fundamento:** el caché de 60 s (backend `fastapi-cache` + frontend) hace que los fallos sean ocasionales pero críticos: deben detectarse aunque el tráfico sea bajo.

#### OP-07 · Efectividad del caché
- **Pregunta técnica:** ¿El caché de 60 s está ahorrando llamadas o sirviendo datos viejos?
- **Eventos:** `cache_hit` / `cache_miss` (capa: `frontend_memory` o `backend_inmemory`, recurso).
- **Métricas:** hit rate por capa y recurso; ahorro de llamadas a la API; invalidaciones del caché (tras `POST /book`).
- **Latencia:** batch.
- **Fundamento:** el proyecto invierte esfuerzo en doble caché; sin medición no se sabe si el TTL de 60 s es adecuado (demasiado viejo vs. demasiado corto).

### 4.4 Resumen del catálogo

| ID | Oportunidad | Evento(s) | Métrica principal | Latencia |
| --- | --- | --- | --- | --- |
| OP-01 | Llegada de mercancía | `book_created` → futuro `goods_received` | Unidades recibidas / periodo | Batch |
| OP-02 | Stock bajo | `stock_low_detected` | Títulos en riesgo (≤ 3) | **Stream (segundos)** |
| OP-03 | Demanda / libro popular | `book_detail_viewed`, `catalog_search`, `stock_consulted` | Top libros por vistas de detalle | Batch |
| OP-04 | Tiempo en la app | `session_started`, `session_ended` | Duración media de sesión | Batch |
| OP-05 | Carga y errores UI | `app_loaded`, `app_error`, `page_viewed` | Tiempo de carga, tasa de error | Batch |
| OP-06 | Salud API | `api_request_completed`, `api_request_failed` | Latencia p95, tasa de error | Batch + alerta stream |
| OP-07 | Efectividad caché | `cache_hit`, `cache_miss` | Hit rate por capa | Batch |

---

## 5. Definiciones operativas de las métricas pedidas

1. **Llegada de mercancía** — `unidades_recibidas(periodo) = Σ properties.units` sobre `book_created` (hoy) y `goods_received` (futuro), agrupado por día y `stock_id`.
2. **Stock bajo** — `titulos_en_riesgo = COUNT(eventos únicos stock_id en stock_low_detected del día)`; se emite con `threshold = 3` y `stock` al momento de la detección.
3. **Click a "ver detalle" / libro más popular** — `libro_mas_popular = TOP_N(GROUP BY properties.book_id COUNT(book_detail_viewed))` en la ventana analizada (7 días por defecto).
4. **Tiempo en la aplicación** — `duracion_ms = session_ended.properties.durationMs`; métrica = media y mediana por día. El cierre de sesión ocurre en `pagehide`/`beforeunload` (flush inmediato) o por inactividad (15 min por defecto).

---

## 6. Gobernanza y buenas prácticas

- **Idempotencia:** los lotes se pueden reenviar; los consumidores deduplican por `event_id`.
- **Correlación:** el mismo `request_id` en evento, cabecera `X-Request-Id` y log de FastAPI permite unir frontend → backend → logs.
- **Evolución de esquemas:** cambios compatibles → patch (`1.0.1`); campos nuevos → minor (`1.1.0`); cambios incompatibles → major (`2.0.0`). Nunca eliminar campos sin versión mayor.
- **Privacidad:** sin login no hay datos personales; `session_id` es anónimo y aleatorio, `user_id = null`. No registrar títulos de búsqueda con PII ni valores de formulario libres fuera de los campos permitidos en `properties`.
- **Volumen:** micro-lotes (≤ 20 eventos o ≤ 5 s) mantienen el JSONL pequeño y la red eficiente.
- **Validación:** el backend valida el envelope completo contra `event-schemas.json` antes de persistir; los eventos inválidos se descartan con log (no rompen el lote).

---

## 7. Próximos pasos (pipeline de los próximos días)

1. **Día 1 — Emisor frontend:** módulo `src/telemetry.ts` con buffer, `flush()` por tiempo/tamaño y eventos de sesión (`session_started`/`session_ended`, `app_loaded`).
2. **Día 2 — Ingest backend:** `POST /events` con validación de envelope + idempotencia por `event_id` → append a `backend/events.jsonl`; emisión backend de `api_request_*`.
3. **Día 3 — Lector stream:** proceso que hace *tail* de `events.jsonl` → alerta `stock_low_detected` en segundos.
4. **Día 4 — Agregaciones batch:** job cada 1–5 min que calcula top de libros, duración de sesión, hit rate de caché y stock en riesgo.
5. **Día 5 — Panel:** vista de métricas derivadas de las agregaciones.

---

## 8. Objetivo, alcance y entregables

### 8.1 Objetivo

Instrumentar Estante con telemetría de eventos que responda, con evidencia, a las siete oportunidades del catálogo (OP-01 a OP-07): llegar de mercancía, alerta de stock bajo, demanda real del catálogo, tiempo en la aplicación, calidad de la interfaz, salud de la API y efectividad del caché — con un pipeline de emisión en lote y lectura en segundos.

### 8.2 Alcance

**Incluido:**
- Event Envelope estándar y taxonomía `entidad_acción` (sección 3).
- Los 15 `event_types` de `event-schemas.json` (14 activos + `goods_received` futuro).
- Emisor frontend (`src/telemetry.ts`: buffer, flush por tiempo/tamaño, sesión anónima).
- Ingest backend (`POST /events` → validación → `backend/events.jsonl`).
- Lector stream para alerta de stock bajo (único caso en segundos).
- Agregaciones batch cada 1–5 min y panel de métricas derivadas.

**Fuera de alcance (esta fase):**
- Login/identidad real (`user_id` permanece `null`; solo se reserva el campo).
- Flujo explícito de recepción de mercancía (`goods_received` se define, no se implementa).
- Almacenamiento analítico (data warehouse, ClickHouse, etc.): por ahora solo JSONL + agregados derivados.
- Atribución multi-dispositivo, perfiles de usuario y cookies de terceros.
- Telemetría de terceros (PostHog, GA4…): el destino es endpoint propio + archivo local.
- Actualización de stock (`stock` modificado sobre un libro existente): la API actual solo crea libros, por lo que los cambios de existencias fuera de `POST /book` no se capturan.

### 8.3 Entregables

| # | Entregable | Formato | Sección de referencia |
| --- | --- | --- | --- |
| E1 | Catálogo de oportunidades fundamentado | `telemetry-plan.md` §4 | Este documento |
| E2 | Esquemas de evento (envelope + properties) | `event-schemas.json` | Especificación formal |
| E3 | Definiciones operativas de métricas | `telemetry-plan.md` §5 | Acuerdos de cálculo |
| E4 | Módulo emisor frontend | `src/telemetry.ts` | §7 día 1 |
| E5 | Endpoint de ingest + validación | `backend/main.py` (`POST /events`) | §7 día 2, §11 |
| E6 | Lector stream + alerta de stock bajo | proceso backend | §7 día 3 |
| E7 | Jobs de agregación batch | script backend | §7 día 4 |
| E8 | Panel de métricas derivadas | vista frontend/backend | §7 día 5 |

---

## 9. Captura, entrega, duplicados y fallos

### 9.1 Captura

- **Dónde se captura:** en el momento de ocurrencia, nunca al final (salvo `session_ended`, que se calcula al cierre). El `timestamp` se toma en el cliente al generar el evento; los eventos de backend usan su propio reloj.
- **Qué se captura:** solo los campos permitidos en `properties` de cada esquema. Sin datos libres fuera del esquema, sin PII.
- **Buffer:** máximo 20 eventos o 5 s (`transport.flushPolicy`), con flush inmediato en `session_end`/`pagehide`.

### 9.2 Entrega

- **Transporte:** `POST /events` con cuerpo `{ events: [...] }` (máx. 50 eventos/lote), `Content-Type: application/json`.
- **Orden:** los lotes pueden llegar fuera de orden (reenvíos, errores de red); los consumidores ordenan por `timestamp` cuando el orden importe.
- **Reintentos:** ante fallo de red o 5xx, el lote se reenvía con backoff (p. ej. 1 s, 5 s, 25 s) y se conserva en el buffer. Ante 4xx, el lote NO se reenvía: se descarta con log (error de esquema, reintentar no ayuda).
- **Pérdida aceptada:** si el navegador mata la pestaña antes del flush final, se pierden como máximo los eventos del buffer sin enviar. Es el coste aceptado del diseño batch (documentado como riesgo R-01 en §10).

### 9.3 Duplicados

- **Clave:** `event_id` (UUID v4) genera unicidad en origen; los reenvíos de lote producen duplicados legítimos.
- **Estrategia:** los consumidores de agregación deduplican por `event_id` antes de contar (los contadores deben ser insensibles a duplicados, p. ej. sets de `event_id`, no `COUNT(*)` ciego).
- **Sin dedupe en ingest, de momento:** no hay índice de `event_id` vistos; se asume que el dedupe ocurre en el análisis. Si el volumen lo exige, se añadirá un índice persistente (ver R-04 en §10).

### 9.4 Fallos

| Fallo | Comportamiento esperado |
| --- | --- |
| Error de validación de un evento | El evento se rechaza y se loguea; el resto del lote se acepta (no se rompe el lote por uno malo). |
| Lote inválido a nivel de envoltorio (`events` ausente/malformado) | `400` + log; el emisor no reintenta indefinidamente. |
| Backend de ingest caído | El emisor retiene el buffer con backoff; al recuperarse, envía lo acumulado (los eventos con `timestamp` viejo se aceptan). |
| Fallo del lector stream | La alerta de stock se retrasa, no se pierde: el JSONL es la fuente de verdad y el lector puede reanudar tail desde su posición. |
| Caída del proceso backend | Lo no flushado en memoria se pierde (buffer backend); lo ya persistido en JSONL sobrevive. |

---

## 10. Riesgos y exclusiones

### 10.1 Riesgos

| ID | Riesgo | Impacto | Mitigation |
| --- | --- | --- | --- |
| R-01 | Pérdida de eventos al cerrar pestaña antes del flush final | Bajo: como máximo el buffer sin enviar (≤ 20 eventos o 5 s) | Flush en `pagehide`/`beforeunload`; aceptar la pérdida residual como coste del batch |
| R-02 | Duplicados por reenvío de lotes | Medio: métricas infladas si se cuenta sin dedupe | Dedupe por `event_id` obligatorio en todos los consumidores |
| R-03 | `events.jsonl` crece sin límite | Medio: disco lleno, lecturas lentas | Rotación por tamaño/tiempo y retención (§11); monitorizar tamaño |
| R-04 | Sin índice de `event_id`, el dedupe depende de cada lectura | Medio: coste creciente con el volumen | Dedupe por ventana en agregaciones; si escala, índice persistente |
| R-05 | Escritura concurrente en el JSONL (`uvicorn --workers N`) | Alto: archivos entrelazados o líneas corruptas | **Decisión pendiente**: buffer interno con writer único, archivo por worker, o locking. Definir en el día 2 |
| R-06 | Eventos de backend sin `session_id` (jobs sin request) violan el envelope (campo obligatorio UUID) | Medio: validación falla | **Decisión pendiente**: permitir `null` en `source: backend` sin request o sintetizar un `session_id` de sistema. Definir en el día 2 |
| R-07 | Esquema y realidad divergen (p. ej. `stock` actualizado sin evento, campos borrados sin versión mayor) | Medio: métricas incompletas o consumidores rotos | Regla de versionado (§13); revisar esquema en cada cambio de API |
| R-08 | El caché (60 s, frontend y backend) oculta tráfico real a la API | Bajo: métricas de API subestiman la demanda de usuarios | Distinción `cache`/`bypass` en `api_request_*`; OP-07 mide la brecha |
| R-09 | Alcance creciente (pedir "más métricas" sin priorizar) | Medio: pipeline a medias | Catálogo cerrado a OP-01…OP-07; cambios por revisión del plan |

### 10.2 Exclusiones

- **Identidad personal:** no hay login; `user_id = null` y `session_id` es anónimo. No se profilea personas, se analiza comportamiento agregado.
- **Datos sensibles:** no se capturan credenciales, ni contenido de formularios libre más allá de los campos de `properties` (la búsqueda sí se registra pero está limitada a 120 caracteres y no se considera PII).
- **Eventos no listados:** si un dato no está en `event-schemas.json`, no se captura. Añadir un evento = revisar plan + esquema (§13).
- **Garantías de exactly-once:** el sistema es at-least-once en entrega y dedupe en análisis; no se promete exactly-once en el transporte.
- **SLA de alerta:** la alerta de stock se emite en segundos "mejor esfuerzo"; no hay compromiso formal de latencia en esta fase.

---

## 11. Almacenamiento, privacidad y retención

### 11.1 Almacenamiento

| Capa | Dónde | Formato | Duración |
| --- | --- | --- | --- |
| Buffer de emisión | Memoria del navegador | Array en `src/telemetry.ts` | Segundos (flush ≤ 5 s / 20 eventos) |
| Buffer de emisión backend | Memoria del proceso FastAPI | Pendiente de decisión (R-05) | Segundos |
| Fuente de verdad | `backend/events.jsonl` | JSONL append-only, un evento por línea | Sujeto a rotación (11.3) |
| Agregados derivados | Archivo/estructura de reportes (JSON/SQLite) | Métricas precalculadas por periodo | Más largo que el crudo (11.3) |

Los eventos crudos viven en el repo de datos del backend, no en la base de datos de libros (`books.json` se mantiene intacto; telemetría no toca el inventario).

### 11.2 Privacidad

- **Sin PII por diseño:** no hay login, no hay emails, teléfonos ni identificadores personales. `session_id` es un UUID aleatorio por sesión, sin huella de dispositivo ni IP.
- **`user_id`:** `null` hasta que exista autenticación; el campo ya está en el envelope para no romper esquemas después.
- **Campos sensibles por diseño de esquema:** el esquema solo permite lo declarado (`additionalProperties: false`), lo que impide que datos accidentales (texto de error con información sensible, valores de formulario) cuelen en `properties`.
- **Búsquedas:** `catalog_search.query` se registra (máx. 120 caracteres) para detectar gaps de catálogo; se analiza en agregado, no por persona.
- **Futuro con login:** si `user_id` deja de ser `null`, revisar este documento (consentimiento, expungido, minimización) antes de emitir.

### 11.3 Retención y rotación

| Dato | Retención propuesta | Acción |
| --- | --- | --- |
| `events.jsonl` (crudo) | 30 días o 50 MB por archivo | Rotar a `backend/archive/` comprimido; eliminar archivos con > 30 días |
| Agregados diarios | 12 meses | Conservar; es lo que alimenta reportes históricos |
| Agregados por minuto | 7 días | Purgar tras consolidar al diario |
| Logs de eventos rechazados | 7 días | Solo diagnóstico de esquemas |

- **Rotación:** por tamaño (50 MB) o diaria, lo que ocurra primero; el lector stream reabre el archivo nuevo tras cada rotación (auditar el manejo de `inode` al hacer tail).
- **Borrado:** la retención se aplica también al archive; al vencer, eliminación definitiva. No se replica fuera del entorno del proyecto.
- **Responsable:** definir con el equipo quién ejecuta la purga (cron job en el día 4 del plan).

---

## 12. Reportes y agregación futura

Los reportes se calculan por lote (1–5 min para operación, diario para negocio) sobre `events.jsonl` + los agregados derivados. Ninguno requiere stream; solo la alerta de stock (OP-02) se lee en segundos.

### 12.1 Reportes inmediatos (fase 1)

| Reporte | Fuente | Frecuencia | Periodicidad |
| --- | --- | --- | --- |
| Unidades recibidas (llegada de mercancía) | `book_created` → futuro `goods_received` | Batch | Diario/semanal |
| Títulos en riesgo de stock (≤ 3) | `stock_low_detected` | **Stream** + recuento batch | Tiempo real + diario |
| Top libros por vistas de detalle | `book_detail_viewed` | Batch | Diario, ventana 7 días |
| Búsquedas sin resultados (gap de catálogo) | `catalog_search` (`resultCount = 0`) | Batch | Semanal |
| Duración media/mediana de sesión | `session_ended` | Batch | Diario |
| Carga inicial p50/p95 y tasa de error UI | `app_loaded`, `app_error` | Batch | Diario |
| Latencia p95 y tasa de error por endpoint | `api_request_*` | Batch (alerta stream futura) | Por hora |
| Hit rate de caché por capa | `cache_hit`/`cache_miss` | Batch | Por día |

### 12.2 Reportes futuros (fase 2+, cuando haya datos suficientes)

- **Demanda vs. disponibilidad:** intersección de `book_detail_viewed` con `stock ≤ 3` → "títulos con demanda y sin stock" (prioridad de compra).
- **Tiempo hasta reposición:** desde `stock_low_detected` hasta la siguiente entrada del mismo `stock_id` (hoy solo `book_created`; sólido cuando exista `goods_received`).
- **Cohortes por género:** evolución de vistas de detalle y stock por `genre` a lo largo del tiempo.
- **Correlación caché/latencia:** ¿el TTL de 60 s reduce p95 o sirve datos obsoletos? cruces entre `cache_*` y `api_request_*`.
- **Abandono temprano:** sesiones con `durationMs < 10 s` sin ninguna acción de negocio → diagnóstico de experiencia.
- **Series de stock total y agotados:** `stock = 0` por género (requiere evento de actualización de stock, hoy ausente).

### 12.3 Criterios para promover un reporte a fase 1

1. Responde a una oportunidad ya aprobada (OP-01…OP-07) o se aprueba nueva (R-09).
2. Su evento existe y está versionado en `event-schemas.json`.
3. Tiene ventana de datos suficiente (p. ej. ≥ 2 semanas para métricas de sesión).
4. Dueño definido: alguien mira el reporte y actúa sobre él.

---

## 13. Versionado, validación y entrega

### 13.1 Versionado

- **Fuente de verdad de versiones:** `schema_version` por `event_type` (semántico: `MAJOR.MINOR.PATCH`) dentro de `event-schemas.json`, cuya versión global está en `version` (hoy `1.0.0`).
- **Reglas:**
  - Campo nuevo **con default** o evento nuevo → `MINOR` (compatible).
  - Ajuste de descripción, docs o restricción más laxa → `PATCH`.
  - Campo eliminado, renombrado, tipo cambiado o restricción más estricta → `MAJOR`; requiere migración o doble emisión durante un periodo.
- **Nunca** eliminar ni redefinir un campo sin versión mayor; los consumidores toleran campos desconocidos futuros (adelantarse a `MINOR`).
- **Plan y esquemas evolucionan juntos:** todo cambio de esquema actualiza `telemetry-plan.md` (definiciones, catálogo) en el mismo PR.

### 13.2 Validación

| Nivel | Qué valida | Dónde |
| --- | --- | --- |
| Emisor | Que el evento cumple el envelope antes de ponerlo en el buffer | `src/telemetry.ts` (modo dev: falla ruidoso) |
| Ingest | Envelope completo + `properties` del `event_type` correspondiente | `POST /events` en FastAPI (modelos Pydantic derivados del esquema o `jsonschema`) |
| Persistencia | Una línea JSON válida por evento | Antes de append al JSONL |
| Consumición | `schema_version` soportada por el lector/agregador | Lector stream y jobs batch |

- Evento inválido en ingest → se rechaza individualmente con log (`event_id` + motivo); el resto del lote se procesa.
- La validación usa el propio `event-schemas.json` como referencia (single source of truth), no una copia inline.

### 13.3 Entrega (Definition of Done de telemetría)

Una iteración de telemetría se considera entregada cuando:

1. El/los eventos nuevos están en `event-schemas.json` con versión y ejemplo.
2. `telemetry-plan.md` refleja el cambio (catálogo o definiciones).
3. El emisor los genera con envelope válido (prueba unitaria de formato).
4. `POST /events` los acepta y persiste; los inválidos se rechazan sin romper el lote (prueba de ingest).
5. El agregador correspondiente produce la métrica/ reporte con dedupe por `event_id` (prueba de cálculo).
6. El JSONL resultante contiene eventos que pasan la validación del esquema (smoke test sobre archivo real).
7. Versiones actualizadas (`version` global y `schema_version` por evento) y changelog de la iteración en el plan.

> Cadena de entrega: **esquema → plan → emisor → ingest → agregación → verificación sobre datos reales.** Saltar un eslabón deja métricas que nadie puede confiar.