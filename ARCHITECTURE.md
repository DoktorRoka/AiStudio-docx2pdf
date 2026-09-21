# ARCHITECTURE.md — Архитектура Chrome Extension (Manifest V3)

> План переноса рабочего Tampermonkey-скрипта `reference/ai-studio-docx2pdf.user.js` v1.2.6.
> Принцип: **существующая рабочая логика сохраняется как есть** — меняется только способ доставки кода в page context. Никакого переписывания бизнес-логики (ТЗ §18, §32).

---

## 1. Ключевое архитектурное решение

### Content script в MAIN world (`world: "MAIN"`)

В MV3 (Chrome 111+) content script можно декларировать с `"world": "MAIN"` — тогда он выполняется **в page context**, как обычный скрипт страницы. Это **точный аналог `@grant none` в Tampermonkey**, под которым скрипт и написан.

| Tampermonkey | Chrome Extension MV3 |
| ------------ | -------------------- |
| `@grant none` | `"world": "MAIN"` в `content_scripts` |
| `@match …` | `"matches": ["https://aistudio.google.com/*", "https://makersuite.google.com/*"]` |
| `@run-at document-start` | `"run_at": "document_start"` |
| `@noframes` | `"all_frames": false` (значение по умолчанию) |

**Почему именно MAIN world, а не «маленький content script + script injection»:**

1. Скрипт использует page-глобалы `window.mammoth`, `window.html2canvas`, `window.jspdf`, `window.trustedTypes` — в MAIN world они доступны напрямую.
2. `DataTransfer`, подмена `input.files`, диспатч событий, чтение реального DOM — работают идентично изолированному миру, но страница в MAIN world получает **те же объекты событий и то же окружение**, что и при работе под Tampermonkey. Ноль отличий поведений.
3. **Конвейер загрузки библиотек уже продуман в скрипте** (`libsFromRefs()` → `window.__AISD2P_LIBS__`, проигрывающий UMD-экспорты в `window/self/globalThis`). Библиотеки загружаются отдельными файлами в том же массиве `js` **до** файла логики — скрипт подхватывает их без единого изменения.
4. Строгая CSP (в сохранёнке — `<script nonce="">`) не блокирует content scripts ни в одном из миров; сценарную инъекцию `<script>` для этого обходить не требуется.
5. Одно расширение = один content script. Без background, popup, storage, messaging, `chrome.*` API (см. §6).

Изолированный мир не нужен: скрипт не вызывает ни одного chrome-API и ничего не шарит между мирами.

### Fallback (если потребуется Chrome < 111)

Классическая схема «isolated content script → инъекция `<script>` с кодом в page context». Код библиотек и логики остаётся тем же самым файлом/строкой; меняется лишь способ вставки: содержимое склеенного `app.js` вставляется как `document.head.appendChild(script)` с `textContent`. Тот же результат, хуже по надёжности (чувствительнее к эвристикам Chrome). Использовать только при реальной необходимости.

---

## 2. Поток данных (без изменений относительно reference)

```
AI Studio (aistudio.google.com / makersuite.google.com)
   │
   ▼
Content script (MAIN world, document_start)
   │
   ├── DOCX detection
   │      document capture: 'change' + 'drop'
   │      isDocx = /\.docx$/i ; needsInterception = input[data-test-upload-file-input]
   │      или closest('ms-add-media-button')
   │      (не-DOCX → пропуск, AI Studio обрабатывает сама)
   │
   ▼
Converter (локально, в браузере)
   │   mammoth  → DOCX(ArrayBuffer) → HTML
   │   html2canvas → HTML → canvas (A4, адаптивный scale, MAX_CANVAS_H=12000)
   │   jsPDF    → canvas → страницы A4 → Blob application/pdf
   │
   ▼
PDF File
   │   new File([blob], '<имя>.pdf', { type: 'application/pdf' })
   │
   ▼
Page context / Upload pipeline
   │   DataTransfer → input.files = dt.files
   │   input.dispatchEvent(new Event('change', {bubbles:true}))
   │
   ▼
AI Studio
   PDF появляется во вложениях чата (штатный upload pipeline Angular)
```

**Принцип ТЗ §32 соблюдён:** каждый из этих шагов — это существующая функция userscript (`onChangeCapture`, `onDropCapture`, `processFiles`, `convertDocxToPdf`, `renderHtmlToPdf`, `injectFiles`), а не новая реализация.

---

## 3. Структура проекта

```
aistudio-docx-extension/                 (или корень проекта, см. §7)
│
├── manifest.json                        ← единственный конфиг, MV3
│
├── src/
│   └── content/
│       └── content.js                   ← рабочая логика userscript (строки 525–1190), как есть
│
├── lib/                                 ← встроенные библиотеки, извлечены из reference байт-в-байт
│   ├── mammoth.js                       (reference строки 82–101)
│   ├── html2canvas.js                   (reference строки 109–123)
│   └── jspdf.js                         (reference строки 128–523)
│
├── icons/                               ← необязательно (§5)
│
├── reference/
│   ├── ai-studio-docx2pdf.user.js       ← эталон (не трогать)
│   └── pages/…                          ← сохранённые страницы AI Studio
│
├── ANALYSIS.md                          ← анализ эталонной реализации
├── ARCHITECTURE.md                      ← этот документ
└── README.md                            ← на финальном этапе (ТЗ §30)
```

### Что вырезать при извлечении (границы строк reference-файла)

| Извлекаемое        | Строки reference | Примечание |
| ------------------ | ---------------- | ---------- |
| `lib/mammoth.js`   | 82–101           | UMD-код; комментарий `// --- mammoth ---` на строке 81 — опционально оставить |
| `lib/html2canvas.js`| 109–123          | UMD-код; баннер лицензии (104–108) — оставить |
| `lib/jspdf.js`     | 128–523          | UMD-код + все плагины; `//# sourceMappingURL=jspdf.umd.min.js.map` (523) — оставить |
| `src/content/content.js` | 525–1190  | вся логика после встроенных библиотек |

Извлечение — механическое копирование, без правок содержимого. Лицензии MIT и BSD-2 сохраняются вместе с файлами.

---

## 4. manifest.json

```json
{
  "manifest_version": 3,
  "name": "AI Studio DOCX to PDF",
  "version": "1.2.6",
  "description": "Автоматически конвертирует .docx в .pdf при загрузке в Google AI Studio (локально, в браузере).",
  "content_scripts": [
    {
      "matches": [
        "https://aistudio.google.com/*",
        "https://makersuite.google.com/*"
      ],
      "run_at": "document_start",
      "world": "MAIN",
      "all_frames": false,
      "js": [
        "lib/mammoth.js",
        "lib/html2canvas.js",
        "lib/jspdf.js",
        "src/content/content.js"
      ]
    }
  ]
}
```

Порядок файлов в `"js"` имеет значение и повторяет структуру reference-файла: сначала три библиотеки (кладут UMD-глобалы в page context), затем логика, которая их забирает через `libsFromRefs()`.

### Почему этого достаточно

- **Нет `permissions` / `host_permissions`**: регистрация `content_scripts` на конкретные origin (`matches`) не требует host permissions. Разрешения минимальны (ТЗ §14), `<all_urls>` нет.
- **Нет `background`**: скрипт на всё время жизни страницы живёт в content script; конвертация локальна и не требует кросс-оригинных запросов (ТЗ §16).
- **Нет `action`/popup/options**: пользователю не нужен UI расширения — toast-индикатор уже есть в самом скрипте (ТЗ §22).
- **Нет `storage`**: скрипт не хранит состояние.
- **Конвертация остаётся локальной**: `DOCX → browser → PDF`, никакого внешнего API (ТЗ §13 выполняется по построению — логика одна и та же).

---

## 5. Иконки

Технически расширению доступен значок по умолчанию (головоломка Chrome). По ТЗ §29 в финальный результат входят `icons/`. Минимально: положить один `icons/icon128.png` и добавить `"icons": { "128": "icons/icon128.png" }` в манифест. Это чисто косметический шаг, не влияющий на работу.

---

## 6. Что изменять в логике не нужно

Возможные правки `src/content/content.js` — **только опциональная чистка**, не влияющая на поведение:

1. Убрать metadata-шапку (строки 1–13) и документацию (15–73) — они уже в reference;
2. Убрать статус-интро и пролог `__AISD2P_EMBEDDED__` можно оставить нетронутым — он продолжает работать (страница принадлежит основному миру, `window` тот же, `librariesReady()` вернёт `true`);

Никаких правок селекторов, обработчиков, конвертера или инъекции не требуется.

`ponytail:` — предупреждение о будущем ремонте: селекторы AI Studio (`data-test-upload-file-input`, `ms-add-media-button`, `ms-prompt-box`) — публичные якоря тестирования интерфейса Google. Если Google их переименует, запасной селектор (`ms-add-media-button input[type="file"]`) страхует `findFileInput`, но `needsInterception` и `resetDragOverlay` завязаны только на них. Апгрейд-путь — добавлять новые якоря в `FILE_INPUT_SELECTOR`/`FILE_INPUT_FALLBACK` при изменении верстки AI Studio (ровно так же, как эволюционировал сам userscript).

---

## 7. Расположение

Терминал миграции (ТЗ §15, §29): корень `AiStudioConverter` — `manifest.json`, `src/`, `lib/`, `icons/`, `reference/`, `ANALYSIS.md`, `ARCHITECTURE.md`, `README.md`. Отдельная папка `aistudio-docx-extension/` не обязательна, если корень репозитория уже является корнем расширения (решение — при реализации, влияет только на путь загрузки unpacked).

---

## 8. Перенос кода — контрольный чек-лист

1. `lib/mammoth.js`, `lib/html2canvas.js`, `lib/jspdf.js` — скопированы из reference байт-в-байт (§3).
2. `src/content/content.js` — тело IIFE из строк 525–1190 без изменений.
3. `manifest.json` — файлы в порядке: 3 библиотеки, затем content.js.
4. Синтаксис: `node --check` для `lib/*.js` и `src/content/content.js` (файлы — обычный JS, check пройдёт без окружения).
5. `chrome://extensions` → Developer mode → **Load unpacked** → корень проекта.
6. Smoke-тест поведенческого паритета: повторить тесты ТЗ §26/§27 на одних и тех же файлах сначала с Tampermonkey, затем с расширением (Tampermonkey можно не отключать — расширение вмешивается только в DOCX, конфликтов нет; чистый прогон — с отключённым TM, ТЗ §28).

---

## 9. Риски паритета (что проверить при тестах)

| Риск | Состояние | Контроль |
| ---- | --------- | -------- |
| Изолированный мир вместо MAIN (неверный `world`) | из-за этого ломаются page-глобалы библиотек | проверить `#aisd2p-status` «AI Studio DOCX v1.2.6 Готово» в момент загрузки |
| Разный порядок/отсутствие файлов в `js` | ломается `librariesReady()` | консоль `[DIAG]`, `window.__AISD2P_DIAG__()` |
| `run_at` не `document_start` | родительские элементы (`ms-add-media-button`) инициализируются позже | в логике уже есть `document.readyState`-guard и MutationObserver |
| Trusted Types включены, а policy не создана | html2canvas падает | обход уже в скрипте (DOMParser + createPolicy) |

Все защитные механизмы уже встроены в userscript; задача сводится к их доставке в правильный мир в правильный момент.

---

## 10. Диаграмма соответствия «Tampermonkey → Extension» (краткая)

```
Tampermonkey userscript                      Chrome Extension MV3
──────────────────────────────              ─────────────────────────────
@match aistudio/makersuite          ─────    content_scripts.matches
@grant none (page context)          ─────    content_scripts.world = "MAIN"
@run-at document-start              ─────    run_at = "document_start"
@noframes                           ─────    all_frames = false
встроенные lib (строки 82–523)      ─────    lib/*.js (перед content.js)
логика (строки 525–1190)            ─────    src/content/content.js (как есть)
GM_* API                             ─       не используется — ничего не переносим
```

---

## 11. Итог

Миграция не создаёт нового конвертера. Она сохраняет проверенный конвейер `DOCX → PDF → File → AI Studio` целиком и переносит его в MV3 через один content script с `world: "MAIN"`. Всё, что требуется, — три файла библиотек, тело userscript-логики без изменений и 20-строчный манифест без единого разрешения.