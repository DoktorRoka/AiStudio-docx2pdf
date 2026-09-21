# ANALYSIS.md — Анализ эталонной реализации (Tampermonkey)

> Источник истины: `reference/ai-studio-docx2pdf.user.js` v1.2.6 (рабочий userscript).
> Дополнительный материал: `reference/pages/*.html`, `reference/pages/*.htm` — сохранённые страницы Google AI Studio.
> Приоритет (по ТЗ §3): фактически работающий скрипт > ТЗ > HTML/HTM.

---

## 1. Общая картина

Userscript решает задачу **целиком в page context** браузера:

```
выбор .docx (input / drag&drop)
   ↓  document-level capture: change / drop
перехват (preventDefault, stopPropagation)
   ↓
resetInput (input.value = '' — AI Studio не видит исходный DOCX)
   ↓
mammoth: DOCX (ArrayBuffer) → HTML
   ↓
renderHtmlToPdf: HTML → скрытый DOM → html2canvas → canvas
   ↓
jsPDF: canvas → страницы A4 → Blob application/pdf
   ↓
new File([blob], имя.pdf)
   ↓
DataTransfer → input.files = dt.files → dispatchEvent('change')
   ↓
AI Studio upload pipeline (Angular)
   ↓
PDF появляется во вложениях чата
```

---

## 2. Метаданные userscript

| Поле            | Значение | Значение для миграции |
| --------------- | -------- | --------------------- |
| `@name`         | AI Studio DOCX to PDF | — |
| `@version`      | 1.2.6 | — |
| `@match`        | `https://aistudio.google.com/*`, `https://makersuite.google.com/*` | → `content_scripts.matches` |
| `@grant`        | `none` | **Критично**: скрипт выполняется в page context (MAIN world), как обычный сценарий страницы |
| `@run-at`       | `document-start` | → `run_at: "document_start"` |
| `@noframes`     | включён | → `all_frames: false` (по умолчанию) |
| `@require`      | **отсутствует** | Библиотеки встроены прямо в файл |

Вывод: **ни одного `GM_*` / `GM.*` API не используется.** Проверка `typeof GM` есть только в диагностическом пробнике (строка 693), результат не используется в логике. `@grant none` + `@match` + `@run-at document-start` + `@noframes` = четыре параметра, которые полностью отображаются на манифест MV3.

---

## 3. Структура файла скрипта (1190 строк)

| Строки  | Содержимое |
| ------- | ---------- |
| 1–13    | Метаданные `==UserScript==` |
| 15–73   | Документация: инструкция, библиотеки, ограничения |
| 81–101  | **mammoth 1.12.1** (UMD, встроен, ~100 КБ) |
| 103–123 | **html2canvas 1.4.1** (UMD, встроен) |
| 125–523 | **jsPDF 2.5.1** (UMD, встроен, со всеми плагинами) |
| 525–561 | Пролог: кэш ссылок на встроенные библиотеки (`window.__AISD2P_EMBEDDED__`, `window.__AISD2P_LIBS__`) + Trusted Types policy |
| 563–1190| Вся рабочая логика в IIFE `(function(){ 'use strict'; ... })()` |

**`@require` не используется и CDN не нужен** — три библиотеки физически вшиты в файл. Скрипт полностью автономен (это подтверждает и документация в шапке файла, строки 50–56).

---

## 4. Библиотеки

| Библиотека | Версия | Лицензия | Назначение |
| ---------- | ------ | -------- | ---------- |
| mammoth | 1.12.1 | BSD-2-Clause | DOCX (ZIP+XML) → HTML. Standalone-сборка, включает свой unzip. |
| html2canvas | 1.4.1 | MIT | HTML (с реальными системными шрифтами) → canvas, постраничная нарезка под A4. |
| jsPDF | 2.5.1 | MIT | canvas-страницы → многостраничный PDF, номера страниц, экспорт в Blob. |

Для миграции: файлы библиотек извлекаются из reference скрипта **байт-в-байт** (границы см. ниже в ARCHITECTURE.md). Новые зависимости не вводятся.

---

## 5. Логика шаг за шагом

### 5.1. Константы и утилиты

- Селекторы (строки 592–593):
  - основной: `input[type="file"][data-test-upload-file-input]`
  - запасной: `ms-add-media-button input[type="file"]`
- `isDocx(file)` — `/\.docx$/i.test(file.name)` — **регистронезависимая** проверка по имени (ТЗ §19 выполнено).
- `readFileAsArrayBuffer` — через `file.arrayBuffer()`, fallback на `FileReader`.
- `findFileInput()` — ищет живой (isConnected, не disabled) input по основному, затем по запасному селектору.
- Ошибки кодируются через `makeError(code)` с кодом из `MESSAGES`.

### 5.2. Перехват выбора DOCX

**Оба слушателя — на `document` в capture-фазе** (срабатывают раньше, чем target-обработчики Angular):

- `change` (строка 1179): `onChangeCapture`:
  1. `event.target` должен быть `HTMLInputElement` c `type === 'file'`;
  2. `needsInterception(input)` — input подходит под основной селектор **или** лежит внутри `ms-add-media-button` (`closest`). **Запасной селектор в `needsInterception` не участвует — проверка только по главному селектору и по `ms-add-media-button`**;
  3. `files.some(isDocx)` — есть хотя бы один DOCX? Нет → `return` (событие уходит в AI Studio без изменений — PDF/PNG/TXT и т.д. не трогаются, ТЗ §20);
  4. есть → `event.preventDefault()`, `event.stopPropagation()`, статус «DOCX → PDF:», `processFiles(input, files)`.

  `stopPropagation` на capture-фазе блокирует target/bubble-обработчики Angular — AI Studio не получает событие с DOCX.

- `drop` (строка 1180): `onDropCapture`:
  1. `dataTransfer.files` непусты;
  2. `files.some(isDocx)`? Нет → `return`;
  3. `preventDefault()` + `stopPropagation()`, `resetDragOverlay()`, `input = findFileInput()`, `processFiles(input, files)`.

- `needsInterception` (строка 1088):
  ```javascript
  function needsInterception(input) {
      if (input.matches(FILE_INPUT_SELECTOR)) return true;
      try { return !!input.closest('ms-add-media-button'); } catch (e) { return false; }
  }
  ```

- `watchForFileInput` (строка 1101): `MutationObserver` на `document.documentElement` — только диагностика (лог «file input appeared»). На работу не влияет.

### 5.3. Конвейер обработки файлов — `processFiles(input, files)` (строка 955)

1. `resetInput(input)` — `input.value = ''`. **Исходный DOCX стирается из input до конвертации** — AI Studio никогда не видит неподдерживаемый DOCX.
2. Проверка `librariesReady()` — библиотеки на месте? Нет → диагностика, статус-ошибка, `return`.
3. Задачи: каждый файл метится `{file, docx: isDocx(file)}`.
4. Не-DOCX файлы **проходят без изменений** в `outFiles`.
5. Каждый DOCX конвертируется последовательно:
   - статус «Конвертация DOCX → PDF» (+ счётчик `(n/m)` при нескольких);
   - `convertDocxToPdf(file)` → PDF File;
   - ошибка одного файла **не роняет весь батч** — `errors++`, файл пропускается.
6. `outFiles.length === 0` → resetInput + статус ошибки, `return`.
7. `showStatus('Загрузка PDF:')` → `injectFiles(input, outFiles)`.
8. Итоговый статус: «Готово (ошибок: N)» (`warn`) или «Готово» (`ok`).
9. `processing` флаг защищает от повторного входа (строка 927).

### 5.4. Конвертация DOCX → PDF — `convertDocxToPdf(file)` (строка 883)

```javascript
arrayBuffer = await readFileAsArrayBuffer(file);        // DOCX → ArrayBuffer
result = await mammoth.convertToHtml({ arrayBuffer }, {
    convertImage: mammoth.images.imgElement(function (image) {
        return image.read('base64').then(function (imageBuffer) {
            return { src: 'data:' + image.contentType + ';base64,' + imageBuffer };  // изображения → dataURL
        });
    }),
});                                                      // DOCX → HTML
blob = await renderHtmlToPdf(result.value);              // HTML → Blob(PDF)
return new File([blob], file.name.replace(/\.docx$/i, '') + '.pdf', { type: 'application/pdf' });
```

Ошибки мапятся по тексту сообщения: `/(parse|zip|corrupt|unzip|invalid)/i` → `read` (Ошибка чтения DOCX), иначе → `convert` (Ошибка конвертации). Отсутствующий `result.value` → `structure` (Нарушена структура документа).

### 5.5. Рендер HTML → PDF — `renderHtmlToPdf(html)` (строка 802)

1. **Скрытый хост рендера** `#aisd2p-root` (fixed, `left:-99999px`, `z-index:-1`, `pointer-events:none`) + контейнер `#aisd2p-content` шириной `794px` (A4 @ 96 dpi = 210×297 мм), padding `48px 56px 64px`, шрифт `11pt`, оформление h1–h6, списки, таблицы, img, a (CSS в `RENDER_CSS`, строки 774–789).
2. **Trusted Types**: AI Studio включает Trusted Types, поэтому HTML вставляется НЕ через `innerHTML`, а через `DOMParser` + `contentEl.append(...doc.body.childNodes)` (строки 818–822). Дополнительно создаётся `default` policy `createHTML/createScript/createScriptURL` (строки 572–581) — нужна html2canvas, который внутри использует `innerHTML`.
3. Ожидание: 2 × `requestAnimationFrame` + `document.fonts.ready` — чтобы реальные системные шрифты (в т.ч. кириллица) отрисовались.
4. **html2canvas** на `contentEl` (`scale` адаптивный: начальный 2, при `высота×scale > 12000` — понижается до предела; ограничение `MAX_CANVAS_H`, так как Chrome не рисует canvas выше ~32767px).
5. **jsPDF** portrait, `unit: 'pt'`, `format: 'a4'`, `compress: true`.
6. Нарезка на страницы: `sliceH = 1123 * scale`; canvas режется на `pages = ceil(height / sliceH)`; каждая страница → `drawImage` на pageCanvas → `pdf.addImage(dataURL JPEG 0.92, 'FAST')` → номер страницы (helvetica 8pt, серый #5a, по центру).
7. Освобождение ресурсов: `pageCanvas` обнуляется, `contentEl.replaceChildren()`, возвращается `pdf.output('blob')`.

Результат — **растровый PDF из JPEG-страниц** (ограничение браузерной конвертации, зафиксировано в шапке скрипта, строка 72).

### 5.6. Создание PDF File

`new File([blob], pdfName, { type: 'application/pdf' })` (строка 921), где `pdfName` = имя исходного файла без `.docx` (регистронезависимо) + `.pdf`. Маленький, локальный, никаких отправок на внешние сервисы.

### 5.7. Передача PDF в upload pipeline AI Studio — `injectFiles(input, files)` (строка 938)

```javascript
if (typeof DataTransfer === 'undefined') throw makeError('inject');
const dt = new DataTransfer();
for (const f of files) dt.items.add(f);
const target = getLiveInput(input);          // живой input (или findFileInput())
if (!target) throw makeError('inject');
target.files = dt.files;                      // подмена содержимого input
target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
await nextFrame();
```

**Никаких внутренних API AI Studio не используется.** Механизм полностью «родной»: подмена `input.files` через `DataTransfer` + передиспатч события `change`. Angular-cлушатель upload pipeline получает штатное событие с уже сконвертированными PDF (и не-DOCX файлами). Множественный выбор: все файлы кладутся в один `DataTransfer` и заливаются одним событием.

### 5.8. Drag & drop

Тот же `processFiles`, но с ручным сбросом оверлея Angular: `resetDragOverlay()` (строка 1060) шлёт синтетический `dragleave` на `ms-prompt-box` и снимает `.dragging` с `.dragging-overlay` — иначе оверлей «Drop files here» завис бы на экране.

### 5.9. Статус UI — `#aisd2p-status`

- Toast-плашка справа сверху (`STATUS_CSS`, строки 739–748), опциональна для переиспользования.
- `showStatus(text, kind, ms)`: kind ∈ `info/error/warn/ok`, автопрятание по таймеру.
- Состояния: «Конвертация DOCX → PDF…», «Загрузка PDF:», «Готово», «Готово (ошибок: N)», коды ошибок.

### 5.10. Диагностика

- `DEBUG = false` (строка 586) — подробные логи только при включении;
- `installErrorCapture` (строка 1125) — `window error` + `unhandledrejection`, фильтр по имени скрипта/библиотек;
- `window.__AISD2P_DIAG__()` — ручной осмотр библиотек из консоли;
- опрос здоровья библиотек каждые 5 с.

### 5.11. Инициализация — `init()` (строка 1145)

`injectStyle(STATUS_CSS)`, `injectStyle(RENDER_CSS)`, `installErrorCapture`, `inspectLibraries()` + статус о готовности (ок или ошибка библиотек), `document.addEventListener('change', …, true)`, `document.addEventListener('drop', …, true)`, `watchForFileInput()`. Точка входа: при `document.readyState === 'loading'` — на `DOMContentLoaded`, иначе сразу (строка 1185).

---

## 6. Page context — главный вывод

`@grant none` = Tampermonkey выполняет скрипт **непосредственно в page context** (то же окно/среда, что и сама страница). Именно поэтому скрипт полагается на page-глобалы:

| Зависимость от page context | Где используется |
| --------------------------- | ---------------- |
| `window.mammoth`, `window.html2canvas`, `window.jspdf` | установка — строка 82/110/128 UMD; чтение — `libsFromRefs()` (527–561, 662) и строки 838, 848, 891 |
| `DataTransfer` + `input.files = …` | строки 938–953 |
| `window.trustedTypes`, `window.self`, `window.globalThis` | строки 546–553, 572–581 |
| `new Event('change', …)` + `dispatchEvent` | строка 951 |
| реальный DOM AI Studio (`ms-add-media-button`, `ms-prompt-box`, `.dragging-overlay`) | `findFileInput`, `resetDragOverlay`, `needsInterception` |
| `document.fonts.ready` (реальные системные шрифты) | строка 825 |

Для миграции это означает: **логику нельзя запускать в изолированном мире content script без эквивалентного механизма page context**. ТЗ §10 это прямо требует. Решение см. в ARCHITECTURE.md (content script в MAIN world — точный аналог `@grant none`).

---

## 7. AI Studio — DOM/API зависимости (из reference HTML/HTM)

Оба файла (`Google AI Studio.html` — сохранёнка Chrome, `c0d…f.htm` — SingleFile) сохранены с одной страницы `https://aistudio.google.com/prompts/new_chat` (сентябрь 2026). Это Angular-приложение (ng-c… атрибуты, zone.js, web components `ms-*`).

Зависимости, которые использует скрипт:

### 7.1. `<ms-add-media-button>` — компонент добавления файла

Содержит кнопку (`data-test="select-files"`, `data-test-id="add-media-button"`) и внутри — `<input type="file">`:

```html
<input _ngcontent-ng-c1798675790="" type="file"
       data-test-upload-file-input=""
       class="file-input sf-hidden"
       accept="text/*,application/vnd.google-apps.audio,...,application/*,.ada,...,.wav"
       multiple="">
```

- **`data-test-upload-file-input`** — якорный атрибут (основной селектор скрипта).
- **`multiple`** — множественный выбор (скрипт его поддерживает).
- **В `accept` НЕТ `.docx`** — это корневая причина задачи: пользователь выбирает DOCX через «All files» / перетаскивание, а AI Studio его не принимает. Скрипт перехватывает такой файл и превращает в PDF (который в `accept` есть: `application/*`, `application/pdf` подпадает).
- Классы `file-input`, `sf-hidden` — input невидим; клик открывает системный диалог через Angular-обработчик на `<button>`.

### 7.2. `<ms-prompt-box>` — композер промпта

- `_nghost-ng-c3675532719`, содержит `prompt-box-container`, `.buttons-row`, `ms-prompt-box-tools`, `ms-paid-api-key-button`.
- В нём живёт оверлей drag & drop:
  ```html
  <div class="dragging-overlay">… <span>add_circle</span> Drop files here …</div>
  ```
  Активен при `class="dragging-overlay dragging"`.
- `resetDragOverlay()` скрипта рассчитан именно на эту структуру.

### 7.3. Trusted Types

AI Studio использует Trusted Types (см. скрипты страницы и обход в логике: DOMParser вместо innerHTML + createPolicy). Это обязательный момент для сохранения при переносе.

### 7.4. Что скрипт НЕ использует

- Внутренние JS-API/Angular-сервисы загрузки файлов — **не используются**;
- DOM чипов вложений (`.chips-wrapper`, `.chip` в композере) — не используются напрямую;
- `fetch` / `XMLHttpRequest` — **не перехватываются и не используются**;
- Глобальные функции AI Studio (`window.*`) — не вызываются.

Вся интеграция сводится к двум «родным» точкам: подмена `input.files` + диспатч `change` (и сброс drag-оверлея).

---

## 8. Tampermonkey API → эквивалент (полная таблица)

| Используемый API | В скрипте | Эквивалент в Extension |
| ---------------- | --------- | ---------------------- |
| `GM_getValue` / `GM_setValue` | **нет** | не нужен |
| `GM_addStyle` | **нет** (свой `injectStyle`) | не нужен |
| `GM_xmlhttpRequest` | **нет** | не нужен |
| `GM_registerMenuCommand` | **нет** | не нужен |
| `@require` | **нет** (встроено в файл) | файлы библиотек в `content_scripts.js` |
| `@grant none` (page context) | да | `world: "MAIN"` |
| `@match` | да | `content_scripts.matches` |
| `@run-at document-start` | да | `run_at: "document_start"` |
| `@noframes` | да | `all_frames: false` |

**Tampermonkey API фактически отсутствует** — поэтому background, popup, options, storage и messaging в extension не нужны (ТЗ §16). Единственное, что переносится из Tampermonkey-инфраструктуры, — это режим выполнения в page context.

---

## 9. Функциональный паритет Tampermonkey (беледжек для ТЗ §8)

| Функция | Статус в userscript | Механизм |
| ------- | ------------------- | -------- |
| Обнаружение AI Studio | ✓ | `@match` + селекторы страницы |
| DOCX detection | ✓ | `/\.docx$/i` в capture-обработчиках |
| DOCX → PDF | ✓ | mammoth → html2canvas → jsPDF, в браузере |
| Создание File | ✓ | `new File([blob], …, {type:'application/pdf'})` |
| Передача PDF | ✓ | DataTransfer → `input.files` → dispatch `change` |
| PDF attachment | ✓ | штатный upload pipeline AI Studio |
| Обычный PDF | ✓ | проходит в AI Studio без изменений |
| PNG/JPG | ✓ | проходят без изменений |
| Ошибки | ✓ | коды `read/convert/structure/inject/libs` + toast |
| Повторный upload | ✓ | `processing`-флаг; input живёт и перезахватывается |
| Множественный DOCX | ✓ | последовательная конвертация, батч-инъекция |
| Drag & drop | ✓ | capture `drop` + ручной сброс оверлея |

---

## 10. Ключевые выводы для миграции

1. **Вся логика — в одном IIFE, без внешних зависимостей.** Скрипт автономен; библиотеки вшиты.
2. **Page context обязателен** (page-глобалы библиотек, DataTransfer, trustedTypes).
3. **GM API не используется** → extension не требует background/popup/storage/messaging.
4. **DOM-зависимости AI Studio минимальны и стабильны**: `input[data-test-upload-file-input]`, `ms-add-media-button`, `ms-prompt-box`, `.dragging-overlay`.
5. **Конвертация локальна**, содержимое браузер не покидает — это сохранить.
6. Миграция = перенос тела скрипта (строки 525–1190) и встроенных библиотек (81–523) «как есть», без переписывания бизнес-логики. Изменяется только способ доставки кода в page context (manifest. `world: "MAIN"`).