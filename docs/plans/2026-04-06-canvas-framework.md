# Canvas Framework — двусторонний WebSocket UI для агентов

**Дата:** 2026-04-06
**Статус:** Draft — на ревью

## Цель

Агент может создать интерактивную веб-страницу (canvas), пользователь взаимодействует с ней в браузере, агент получает события и обновляет UI в реальном времени. Двусторонний канал через WebSocket.

## Тестовый кейс: крестики-нолики

Пользователь пишет в Telegram: "давай сыграем в крестики-нолики". Агент:
1. Генерирует React-компонент (доска 3x3)
2. Отправляет ссылку в чат: `https://ark.nikitin.me/telegram_main/canvas/tictactoe`
3. Пользователь открывает, кликает на клетку
4. Агент получает событие `{type: "move", cell: 4}`, думает, отвечает `{type: "update", board: [...], move: 6}`
5. UI обновляется в реальном времени

## Архитектура

```
Browser (React)                    NanoClaw Host                    Agent Container
     |                                  |                                |
     |--- WS connect ----------------->|                                |
     |    (auth token + canvas_id)     |                                |
     |                                  |                                |
     |--- user event ----------------->|                                |
     |    {type: "move", cell: 4}      |-- inject as message --------->|
     |                                  |   <canvas-event>              |
     |                                  |                                |
     |                                  |<-- IPC: canvas_update --------|
     |<-- WS push --------------------|   {canvas_id, components}      |
     |    {type: "update", ...}        |                                |
```

## Подход: прямой React от агента

Агент генерирует React-код как строку. Браузер компилирует на лету через Sucrase (легковесный JSX-компилятор, ~30KB) и рендерит. Никакого фиксированного набора компонентов — агент может создать любой UI.

Пример того что агент отправляет:

```jsx
function App({ state, send }) {
  const cells = state.board || Array(9).fill('');
  const handleClick = (i) => {
    if (!cells[i] && state.status === 'playing') {
      send({ type: 'move', cell: i });
    }
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 80px)', gap: 4 }}>
      {cells.map((c, i) => (
        <button key={i} onClick={() => handleClick(i)}
          style={{ width: 80, height: 80, fontSize: 32 }}>
          {c}
        </button>
      ))}
      <div style={{ gridColumn: '1/4', textAlign: 'center', marginTop: 16 }}>
        {state.status === 'won' ? `${state.winner} wins!` : `Turn: ${state.turn}`}
      </div>
    </div>
  );
}
```

Браузер получает этот код, компилирует JSX → JS, рендерит. Агент имеет полную свободу.

## Компоненты

### 1. Canvas Server (расширение существующего)

**Файл:** `src/canvas-server.ts`

Текущий HTTP-сервер расширяется WebSocket поддержкой:

- `WS /api/canvas/ws?token=xxx&canvas_id=yyy` — подключение браузера
- Сессии: `Map<canvas_id, Set<WebSocket>>` — какие браузеры смотрят какой canvas
- При получении WS-сообщения от браузера → `storeMessageDirect()` (как сейчас POST)
- При получении IPC canvas_update от агента → broadcast в подписанные WS

HTTP endpoints:
- `GET /api/canvas/:group/:canvas_id` — отдаёт React shell (index.html с Sucrase + WS клиент)
- `GET /api/canvas/:group/:canvas_id/state` — текущее состояние canvas (для reconnect)

### 2. IPC: новый тип сообщения `canvas`

**Файл:** `src/ipc.ts`

Агент пишет в `/workspace/ipc/canvas/` JSON-файлы:

```json
{
  "canvas_id": "tictactoe-abc123",
  "action": "create|update|close",
  "title": "Крестики-нолики",
  "jsx": "function App({ state, send }) { ... }",
  "state": {"board": ["","","","","","","","",""], "turn": "X", "status": "playing"}
}
```

- `action: "create"` — первый рендер, включает JSX + начальное состояние
- `action: "update"` — обновление состояния (JSX опционален — если не передан, используется текущий)
- `action: "close"` — закрытие canvas

IPC watcher подхватывает → пушит через canvas-server WS → браузер.

### 3. React Shell (фронт)

**Файл:** `src/canvas-ui/index.html` — единственный статический файл

Минимальный shell (~50 строк):
1. Подключает React + ReactDOM (из бандла)
2. Подключает Sucrase (JSX → JS компиляция в браузере)
3. Устанавливает WebSocket соединение
4. При получении `create/update`:
   - Компилирует JSX через Sucrase
   - Рендерит компонент `App({ state, send })` через React
   - `send(data)` отправляет событие через WS обратно агенту
5. Auto-reconnect при обрыве

Агенту доступен глобальный контекст:
- `state` — текущее состояние (обновляется сервером)
- `send(event)` — отправить событие агенту
- Весь React API — useState, useEffect, useRef и т.д.

Сборка: esbuild бандлит React + Sucrase + WS-клиент в один файл `canvas-runtime.js`. Shell просто `<script src="canvas-runtime.js">`.

### 4. Canvas State Store

**Файл:** `src/canvas-store.ts`

- In-memory хранилище: `Map<canvas_id, { jsx, state, group, title, createdAt }>`
- При `create`: сохраняем JSX + начальное состояние
- При `update`: мержим новый state, опционально обновляем JSX
- При reconnect браузера: отдаём текущий JSX + state через HTTP
- TTL: canvas автоматически закрывается через 1 час неактивности

### 5. Хостинг

Nginx reverse proxy для WebSocket + HTTP:

```
location /canvas/ {
    proxy_pass http://127.0.0.1:3002/api/canvas/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

URL: `https://ark.nikitin.me/canvas/{group}/{canvas_id}`

## Этапы реализации

### Phase 1: Backend — WebSocket + IPC + State Store
1. Добавить `ws` library в canvas-server.ts — WS upgrade на `/api/canvas/ws`
2. Canvas state store (in-memory Map)
3. Добавить canvas IPC тип в ipc.ts — обработка `/workspace/ipc/canvas/*.json`
4. HTTP endpoint для shell + state
5. Тесты

### Phase 2: Frontend — React Shell + Runtime
1. `canvas-runtime.js` — бандл React + Sucrase + WS клиент (esbuild)
2. `index.html` shell — загружает runtime, рендерит агентский JSX
3. WS клиент с auto-reconnect и state sync
4. Build script

### Phase 3: Tic-tac-toe — end-to-end демо
1. Nginx конфиг для /canvas/
2. Инструкция агенту: как создавать canvas через IPC
3. Игра в крестики-нолики как тестовый сценарий
4. Запуск из Telegram: "сыграем в крестики-нолики" → ссылка → играем

## Протокол сообщений (WS)

**Browser → Server:**
```json
{"type": "event", "canvas_id": "xxx", "event": "move", "data": {"cell": 4}}
{"type": "ping"}
```

**Server → Browser:**
```json
{"type": "create", "canvas_id": "xxx", "jsx": "function App...", "state": {...}}
{"type": "update", "canvas_id": "xxx", "state": {...}}
{"type": "update", "canvas_id": "xxx", "jsx": "...", "state": {...}}
{"type": "close", "canvas_id": "xxx"}
{"type": "pong"}
```

**Agent → IPC (файл в /workspace/ipc/canvas/):**
```json
{"canvas_id": "xxx", "action": "create", "jsx": "function App...", "state": {...}, "title": "..."}
{"canvas_id": "xxx", "action": "update", "state": {"board": [...]}}
{"canvas_id": "xxx", "action": "update", "jsx": "new code...", "state": {...}}
{"canvas_id": "xxx", "action": "close"}
```

## Что агент видит

Когда пользователь взаимодействует с canvas, агент получает сообщение:

```
<canvas-event canvas_id="tictactoe-abc123" type="move">
{"cell": 4}
</canvas-event>
```

Агент создаёт/обновляет canvas через IPC — пишет JSON-файл в `/workspace/ipc/canvas/`.

## Зависимости

**Runtime (бандлится в canvas-runtime.js):**
- `react` + `react-dom` — рендеринг (~40KB gzipped)
- `sucrase` — JSX компиляция в браузере (~30KB gzipped)

**Build-time:**
- `esbuild` — сборка бандла

**Server:**
- `ws` — WebSocket для Node.js

Итого bundle: ~70KB gzipped. Без CDN, всё локально.

## Безопасность

- Canvas доступен по токену в URL (генерируется при создании)
- Агентский JSX выполняется в браузере владельца — аналогично просмотру агентских HTML-файлов
- Canvas изолирован по группе — агент одной группы не может обновить canvas другой
- CSP headers для ограничения fetch/eval если нужно

---

## Migration: AG-UI protocol (2026-04-17)

**Решение:** WebSocket wire format мигрирован на [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui). Hard swap, без backward compatibility.

**Почему:** стандартный event-based контракт → можно подключать off-the-shelf AG-UI клиентов (CopilotKit и т.п.), внешние дашборды, мобильные приложения без переизобретения протокола.

**Область миграции:**
- ✅ `src/canvas-server.ts` — emit AG-UI events на WebSocket
- ✅ `canvas-ui/src/canvas-runtime.tsx` — parse AG-UI events
- ✅ `container/skills/canvas-view/SKILL.md` + `groups/telegram_main/skills/canvas-tasks/canvas-tasks/SKILL.md` — документация
- ❌ IPC agent↔host (`publish.py`, `publish-tasks.py`, `ipc.ts`) — **не трогаем**, внутренний канал

**Новые протокол сообщений (WS):**

Server → Browser (create/update):
```json
{"type":"RunStarted","threadId":"<chatJid>","runId":"<id>"}
{"type":"Custom","threadId":"<chatJid>","runId":"<id>","name":"nanoclaw.canvas.render","value":{"canvasId":"...","title":"...","jsx":"...","state":{...}}}
{"type":"RunFinished","threadId":"<chatJid>","runId":"<id>"}
```

Server → Browser (close):
```json
{"type":"Custom","threadId":"...","runId":"...","name":"nanoclaw.canvas.close","value":{"canvasId":"..."}}
```

Browser → Server:
```json
{"type":"Custom","name":"nanoclaw.canvas.interaction","value":{"canvasId":"...","event":"move","data":{"cell":4}}}
{"type":"Custom","name":"nanoclaw.canvas.subscribe","value":{"canvasId":"..."}}
{"type":"Custom","name":"nanoclaw.canvas.ping","value":{}}
```

**Ключевые решения:**
- **Snapshot-only** — каждый render несёт полный jsx+state; нет StateDelta. Проще для skill-авторов.
- **Custom namespace** — все nanoclaw-specific события под `nanoclaw.canvas.*`. Стандартные AG-UI events (RunStarted/Finished, Custom) — совместимы с AG-UI SDK.
- **threadId = chatJid, runId = uuid** — генерируется при каждом broadcast.
- **Что агент видит** не изменилось — всё ещё `<canvas-event canvas_id="..." type="...">data</canvas-event>`.

---

## Middleware chain (2026-04-17)

**Цель:** перехватывать canvas events до LLM — простые действия (toggle_task, save_comment) обрабатываются скриптами напрямую, сложные передаются агенту. Hot-reloadable per-group.

**Архитектура — Express-style chain:**

```
Browser → [inbound chain] → storeMessageDirect → LLM
Agent publish → [outbound chain] → WebSocket broadcast → Browser
```

Chain направлений:
- **inbound** — события от браузера (клики, ввод) к агенту
- **outbound** — события от агента (render/close) к браузеру
- **both** — handler видит оба направления

**Config per group:** `groups/{group}/canvas-middleware/config.json`

```json
{
  "middleware": [
    {
      "id": "task-toggle",
      "direction": "inbound",
      "priority": 10,
      "match": {
        "eventName": "nanoclaw.canvas.interaction",
        "eventType": "toggle_task",
        "canvasId": "task-board"
      },
      "handler": "handlers/toggle.py",
      "timeout": 3000
    }
  ]
}
```

Порядок полей `match` — все опциональны, все должны совпасть (AND-логика). `priority` — lower first; default 100.

**Handler protocol:**

Stdin (JSON):
```json
{
  "direction": "inbound",
  "group": "telegram_main",
  "canvasId": "task-board",
  "eventName": "nanoclaw.canvas.interaction",
  "eventType": "toggle_task",
  "value": { "canvasId": "task-board", "event": "toggle_task", "data": { "taskId": "S18" } },
  "threadId": "...",
  "runId": "..."
}
```

Stdout (JSON):
```json
{
  "next": false,
  "event": { "value": { "...modified": true } },
  "sideEffect": { "state": { "tasks": [...] } }
}
```

- `next: false` — остановить chain, НЕ передавать в LLM (для inbound) или НЕ broadcast (для outbound)
- `next: true` (default) — передать следующему middleware / дальше по пути
- `event.value` — заменить value события для последующей обработки
- `sideEffect.state` — merge в canvas state + триггернуть re-render (outbound chain с depth+1)

Handler может игнорировать stdout для passthrough (пустой JSON = `{next:true}`).

**Fail-open:** handler exit code ≠ 0 / timeout / invalid JSON → лог warning, продолжить chain как будто handler вернул `{next:true}`. Один сломанный middleware не должен ломать UX.

**Hot reload:** `fs.watch` на `config.json` с debounce 100ms. Добавить/изменить/удалить rule → instant pickup. Без рестарта nanoclaw.

**Recursion guard:** `MAX_CHAIN_DEPTH = 2`. Side-effect `state` → new broadcast с depth+1 → outbound chain снова → если та даёт sideEffect → depth 2 → finalize без следующего цикла middleware.

**Per-group only:** пока нет global middleware. Каждая группа сама настраивает.

**Файлы:**
- `src/canvas-middleware.ts` — registry, watcher, chain runner, handler spawn
- `src/canvas-middleware.test.ts` — unit tests (matchMiddleware, runChain, fail-open, depth guard)
- Интеграция в `src/canvas-server.ts` — hook на inbound (WS interaction) и outbound (broadcastAgUiRender/Close)
