// --- Диагностика: что реально определилось после выполнения встроенных библиотек ---
// Этот блок исполняется ДО основного IIFE, сразу после тел трёх библиотек,
// и сохраняет ПРЯМЫЕ ссылки на библиотеки, не полагаясь на глобальные имена.
window.__AISD2P_EMBEDDED__ = {
    mammoth: typeof window.mammoth,
    html2canvas: typeof window.html2canvas,
    jsPDF: typeof (window.jspdf && window.jspdf.jsPDF),
    mammothRef: (typeof window.mammoth !== 'undefined') ? window.mammoth : null,
    html2canvasRef: (typeof window.html2canvas !== 'undefined') ? window.html2canvas : null,
    jsPDFRef: (typeof window.jspdf !== 'undefined' && window.jspdf.jsPDF) ? window.jspdf.jsPDF : null,
    loadedAt: Date.now(),
};

// Резервный поиск ссылок, если глобалы определились не на window (UMD обёртки
// могут использовать self/globalThis). Особенно важно для jsPDF, чья UMD-обёртка
// долго привязывалась к this/self, а не к window.
(function () {
    'use strict';
    if (window.__AISD2P_EMBEDDED__ && !window.__AISD2P_EMBEDDED__.jsPDFRef) {
        var cand = null;
        try {
            if (typeof self !== 'undefined' && self && self.jspdf && self.jspdf.jsPDF) {
                cand = self.jspdf.jsPDF;
            } else if (typeof globalThis !== 'undefined' && globalThis && globalThis.jspdf && globalThis.jspdf.jsPDF) {
                cand = globalThis.jspdf.jsPDF;
            }
        } catch (err) { /* зона изолирована — игнорируем */ }
        if (cand) { window.__AISD2P_EMBEDDED__.jsPDFRef = cand; }
    }
}());
if (!window.__AISD2P_LIBS__) {
    window.__AISD2P_LIBS__ = {
        mammoth: window.__AISD2P_EMBEDDED__.mammothRef,
        html2canvas: window.__AISD2P_EMBEDDED__.html2canvasRef,
        jsPDF: window.__AISD2P_EMBEDDED__.jsPDFRef,
    };
}

(function () {
    'use strict';

    // Trusted Types (страница AI Studio требует TrustedHTML для innerHTML и других
    // sink'ов). Устанавливаем default policy, через которую могут проходить любые
    // строковые присваивания — этого требует код html2canvas (измерение шрифтов
    // пишет innerHTML во временный элемент) и другие встроенные библиотеки.
    // Обёрнуто в try/catch: если страница уже задала default policy или запретила
    // создание — просто игнорируем (точечные патчи сработают и так).
    try {
        if (window.trustedTypes && window.trustedTypes.createPolicy) {
            const ttPolicy = window.trustedTypes.createPolicy('default', {
                createHTML: (s) => s,
                createScript: (s) => s,
                createScriptURL: (s) => s,
            });
            window.__AISD2P_TT_POLICY__ = ttPolicy;
        }
    } catch (e) { /* ignore */ }

    // ============================================================
    // НАСТРОЙКИ
    // ============================================================
    const DEBUG = false; // true — подробные технические логи в консоли (без содержимого документа)
    const VERSION = '1.2.6';

    const LOG_TAG = '[AI Studio DOCX]';
    const DIAG_TAG = LOG_TAG + ' [DIAG]';

    const FILE_INPUT_SELECTOR = 'input[type="file"][data-test-upload-file-input]';
    const FILE_INPUT_FALLBACK = 'ms-add-media-button input[type="file"]';

    // A4 при 96 dpi: 210 x 297 мм
    const A4_W_PX = 794;
    const A4_H_PX = 1123;
    const A4_W_PT = 595.28;
    const A4_H_PT = 841.89;
    const IMG_SCALE = 2; // базовое качество растеризации страницы
    const MAX_CANVAS_H = 12000; // защита от падения браузера на очень больших документах

    const MESSAGES = {
        read: 'Не удалось прочитать DOCX-файл.',
        convert: 'Не удалось конвертировать DOCX в PDF.',
        structure: 'Неподдерживаемая структура документа.',
        inject: 'PDF создан, но AI Studio не удалось принять файл.',
        libs: 'Библиотеки конвертации не загружены. Проверьте целостность установки скрипта.',
    };

// ============================================================
    // УТИЛИТЫ
    // ============================================================
    function log(...args) {
        if (DEBUG) console.log(LOG_TAG, ...args);
    }
    function diag(...args) {
        try { console.info(DIAG_TAG, new Date().toISOString(), ...args); } catch (e) {}
    }
    function diagErr(...args) {
        try { console.error(DIAG_TAG, new Date().toISOString(), ...args); } catch (e) {}
    }
    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }
    function nextFrame() {
        return new Promise((r) => requestAnimationFrame(r));
    }
    function isDocx(file) {
        return /\.docx$/i.test(file.name);
    }
    function makeError(code) {
        const e = new Error(MESSAGES[code] || code);
        e.code = code;
        return e;
    }
    function readFileAsArrayBuffer(file) {
        if (typeof file.arrayBuffer === 'function') {
            return file.arrayBuffer();
        }
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
        });
    }

    function findFileInput() {
        const primary = document.querySelectorAll(FILE_INPUT_SELECTOR);
        for (const el of primary) {
            if (el.isConnected && !el.disabled) return el;
        }
const fallback = document.querySelector(FILE_INPUT_FALLBACK);
        if (fallback && fallback.isConnected && !fallback.disabled) return fallback;
        return primary[0] || null;
    }

    // ============================================================
    // ДИАГНОСТИКА БИБЛИОТЕК (всегда пишет в консоль, не зависит от DEBUG)
    // ============================================================
    function libsFromRefs() {
        // Ссылки, захваченные сразу после встраивания библиотек (см. блок
        // window.__AISD2P_EMBEDDED__ в начале файла). Это первичный источник:
        // он не зависит от того, перезаписали ли глобалы страница/фреймворки.
        const refs = (window.__AISD2P_LIBS__ && typeof window.__AISD2P_LIBS__ === 'object') ? window.__AISD2P_LIBS__ : null;
        return refs || {};
    }
    function librariesReady() {
        const refs = libsFromRefs();
        const embedded = (typeof window.__AISD2P_EMBEDDED__ === 'object' && window.__AISD2P_EMBEDDED__) || null;
        const fromGlobals = !!(window.mammoth && window.html2canvas && window.jspdf && window.jspdf.jsPDF);
        const fromRefs = !!(refs.mammoth && refs.html2canvas && refs.jsPDF);
        return fromRefs || (!!embedded && fromGlobals);
    }
    function inspectLibraries() {
        const embedded = (typeof window.__AISD2P_EMBEDDED__ === 'object' && window.__AISD2P_EMBEDDED__) || null;
        const refs = libsFromRefs();
        const probe = {
            mammoth: typeof window.mammoth,
            mammothKey: Object.keys(window).filter((k) => /mammoth/i.test(k)),
            html2canvas: typeof window.html2canvas,
            html2canvasKey: Object.keys(window).filter((k) => /html2canvas/i.test(k)),
            jspdf: typeof window.jspdf,
            jspdfKeys: typeof window.jspdf === 'object' && window.jspdf ? Object.keys(window.jspdf) : null,
            jspdfWindowKeys: Object.keys(window).filter((k) => /jspdf/i.test(k)),
            embeddedFlag: embedded,
            refs: {
                mammoth: typeof refs.mammoth,
                html2canvas: typeof refs.html2canvas,
                jsPDF: typeof refs.jsPDF,
            },
            gmMammoth: typeof GM !== 'undefined' && GM && typeof GM.mammoth,
        };
        diag('версия скрипта:', VERSION);
        diag('embedded-флаг из файла:', embedded);
        diag('ссылки из встраивания:', refs);
        diag('проба библиотек:', probe);
        try {
            console.log(DIAG_TAG, 'ИТОГОВАЯ ДИАГНОСТИКА (скопируй эти строки целиком):', JSON.stringify({
                version: VERSION,
                ok: librariesReady(),
                embedded: !!embedded,
                embeddedFlag: embedded,
                globals: { mammoth: typeof window.mammoth, html2canvas: typeof window.html2canvas, jspdf: typeof window.jspdf },
                refs: { mammoth: typeof refs.mammoth, html2canvas: typeof refs.html2canvas, jsPDF: typeof refs.jsPDF },
            }, null, 2));
        } catch (e) { /* ignore */ }
        return {
            ok: librariesReady(),
            embedded,
            probe,
        };
    }

    // Глобальный помощник для сброса диагностики в консоль в любой момент:
    //   window.__AISD2P_DIAG__()
    if (typeof window.__AISD2P_DIAG__ !== 'function') {
        window.__AISD2P_DIAG__ = () => inspectLibraries();
    }

    // Лёгкая версия диагностики без печати в лог (для периодической проверки).
    function inspectProbe() {
        const refs = libsFromRefs();
        const embedded = (typeof window.__AISD2P_EMBEDDED__ === 'object' && window.__AISD2P_EMBEDDED__) || null;
        return {
            version: VERSION,
            ok: librariesReady(),
            embedded: !!embedded,
            embeddedFlag: embedded,
            globals: { mammoth: typeof window.mammoth, html2canvas: typeof window.html2canvas, jspdf: typeof window.jspdf },
            refs: { mammoth: typeof refs.mammoth, html2canvas: typeof refs.html2canvas, jsPDF: typeof refs.jsPDF },
        };
    }

    // ============================================================
    // СТАТУС-ИНДИКАТОР (маленькая панель в углу)
    // ============================================================
    const STATUS_CSS = `
#aisd2p-status{position:fixed;top:12px;right:12px;z-index:2147483647;max-width:340px;
 background:rgba(20,20,24,.92);color:#fff;font:12px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
 padding:8px 12px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.28);
 opacity:0;transform:translateY(-4px);transition:opacity .18s ease,transform .18s ease;
 pointer-events:none;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;}
#aisd2p-status.visible{opacity:1;transform:none;}
#aisd2p-status.error{background:rgba(176,32,32,.94);}
#aisd2p-status.warn{background:rgba(200,120,20,.94);}
#aisd2p-status.ok{background:rgba(0,120,70,.94);}`;

    let statusEl = null;
    let statusTimer = null;

    function ensureStatusEl() {
        if (statusEl && statusEl.isConnected) return statusEl;
        statusEl = document.createElement('div');
        statusEl.id = 'aisd2p-status';
        document.documentElement.appendChild(statusEl);
        return statusEl;
    }

    function showStatus(text, kind, ms) {
        const el = ensureStatusEl();
        el.textContent = text;
        el.className = 'visible ' + (kind || '');
        clearTimeout(statusTimer);
        if (ms && ms > 0) {
            statusTimer = setTimeout(() => { el.className = ''; }, ms);
        }
    }

    // ============================================================
    // СКРЫТЫЙ КОНТЕЙНЕР ДЛЯ РЕНДЕРИНГА HTML -> PDF
    // ============================================================
    const RENDER_CSS = `
#aisd2p-root{position:fixed;left:-99999px;top:0;z-index:-1;pointer-events:none;}
#aisd2p-content{box-sizing:border-box;width:${A4_W_PX}px;padding:48px 56px 64px;
 color:#000;background:#fff;font-family:"Segoe UI","Helvetica Neue",Roboto,Arial,sans-serif;
 font-size:11pt;line-height:1.5;word-wrap:break-word;word-break:break-word;}
#aisd2p-content p{margin:0 0 .6em;}
#aisd2p-content h1,h2,h3,h4,h5,h6{font-weight:700;margin:0 0 .5em;line-height:1.3;}
#aisd2p-content h1{font-size:20pt;} #aisd2p-content h2{font-size:16pt;} #aisd2p-content h3{font-size:13.5pt;}
#aisd2p-content h4{font-size:12pt;} #aisd2p-content h5{font-size:11pt;} #aisd2p-content h6{font-size:10pt;}
#aisd2p-content ul,#aisd2p-content ol{margin:0 0 .6em;padding-left:28px;}
#aisd2p-content li{margin:0 0 .2em;}
#aisd2p-content table{border-collapse:collapse;width:100%;margin:0 0 .6em;}
#aisd2p-content td,#aisd2p-content th{border:1px solid #666;padding:4px 6px;vertical-align:top;text-align:left;}
#aisd2p-content img{max-width:100%;height:auto;}
#aisd2p-content a{color:#0645ad;text-decoration:underline;}
#aisd2p-content sup{font-size:0.7em;}`;

    function injectStyle(css, id) {
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    // ============================================================
    // КОНВЕРТАЦИЯ: DOCX -> HTML -> PDF (Blob)
    // ============================================================
    async function renderHtmlToPdf(html) {
        let root = document.getElementById('aisd2p-root');
        if (!root || !root.isConnected) {
            root = document.createElement('div');
            root.id = 'aisd2p-root';
            document.documentElement.appendChild(root);
        }
        let contentEl = root.querySelector('#aisd2p-content');
        if (!contentEl) {
            contentEl = document.createElement('div');
            contentEl.id = 'aisd2p-content';
            root.appendChild(contentEl);
        }

        // Trusted Types (страница AI Studio) блокирует innerHTML — используем
        // DOMParser + вставку DOM-узлов (не HTML sink) и default policy выше.
        contentEl.replaceChildren();
        if (html) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            contentEl.append(...doc.body.childNodes);
        }
        await nextFrame();
        await nextFrame();
        if (document.fonts && document.fonts.ready) {
            try { await document.fonts.ready; } catch (e) { /* ignore */ }
        }

        // Адаптивный масштаб: не даём canvas стать слишком высоким.
        // Браузеры обычно поддерживают одну сторону canvas до ~32767px — держим запас.
        const naturalH = Math.max(1, contentEl.getBoundingClientRect().height);
        let scale = IMG_SCALE;
        if (naturalH * scale > MAX_CANVAS_H) {
            scale = Math.max(0.2, MAX_CANVAS_H / naturalH);
        }
        scale = Math.round(scale * 100) / 100;

const html2canvasLib = libsFromRefs().html2canvas || window.html2canvas;
        const canvas = await html2canvasLib(contentEl, {
            scale: scale,
            useCORS: true,
            allowTaint: false,
            backgroundColor: '#ffffff',
            logging: false,
        });
        log('render canvas:', canvas.width, 'x', canvas.height, 'scale', scale);

        const jsPDFCtor = libsFromRefs().jsPDF || (window.jspdf && window.jspdf.jsPDF);
        const pdf = new jsPDFCtor({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });

        const sliceH = Math.round(A4_H_PX * scale); // высота одного A4-кадра в px canvas
        const pages = Math.max(1, Math.ceil(canvas.height / sliceH));
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = sliceH;
        const ctx = pageCanvas.getContext('2d');

        for (let i = 0; i < pages; i++) {
            if (i > 0) pdf.addPage('a4', 'portrait');
            const srcY = i * sliceH;
            const srcH = Math.min(sliceH, canvas.height - srcY);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
            ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, pageCanvas.width, srcH);

            const imgH = A4_W_PT * (srcH / canvas.width);
            pdf.addImage(pageCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, A4_W_PT, imgH, undefined, 'FAST');

            pdf.setTextColor(90);
            pdf.setFontSize(8);
            pdf.setFont('helvetica', 'normal');
            pdf.text(String(i + 1), A4_W_PT / 2, Math.min(A4_H_PT - 16, imgH + 12), { align: 'center' });
        }

        pageCanvas.width = 0;
        pageCanvas.height = 0;
        contentEl.replaceChildren();
        const blob = pdf.output('blob');
        log('pdf blob bytes:', blob && blob.size, 'pages:', pages);
        return blob;
    }

    async function convertDocxToPdf(file) {
        let arrayBuffer;
        try {
            arrayBuffer = await readFileAsArrayBuffer(file);
        } catch (e) {
            throw makeError('read');
        }

const mammothLib = libsFromRefs().mammoth || window.mammoth;
        let result;
        try {
            result = await mammothLib.convertToHtml({ arrayBuffer: arrayBuffer }, {
                convertImage: mammothLib.images.imgElement(function (image) {
                    return image.read('base64').then(function (imageBuffer) {
                        return { src: 'data:' + image.contentType + ';base64,' + imageBuffer };
                    });
                }),
            });
        } catch (e) {
            log('mammoth error:', e && e.message);
            const m = (e && e.message) || '';
            throw makeError(/(parse|zip|corrupt|unzip|invalid)/i.test(m) ? 'read' : 'convert');
        }

        if (!result || typeof result.value !== 'string') {
            const errs = (result && result.messages || []).filter((m) => m.type === 'error');
            throw makeError(errs.length ? 'structure' : 'convert');
        }

        let blob;
        try {
            blob = await renderHtmlToPdf(result.value);
        } catch (e) {
            log('render error:', e && e.message);
            throw makeError('convert');
        }

        const pdfName = file.name.replace(/\.docx$/i, '') + '.pdf';
        return new File([blob], pdfName, { type: 'application/pdf' });
    }

    // ============================================================
    // ОСНОВНОЙ ПРОЦЕСС ОБРАБОТКИ ВЫБРАННЫХ ФАЙЛОВ
    // ============================================================
    let processing = false;

    function resetInput(input) {
        try { input.value = ''; } catch (e) { /* ignore */ }
    }

    function getLiveInput(preferred) {
        if (preferred && preferred.isConnected) return preferred;
        return findFileInput();
    }

    async function injectFiles(input, files) {
        if (typeof DataTransfer === 'undefined') {
            throw makeError('inject');
        }
        const dt = new DataTransfer();
        for (const f of files) {
            dt.items.add(f);
        }
        const target = getLiveInput(input);
        if (!target) {
            throw makeError('inject');
        }
        target.files = dt.files;
        target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        await nextFrame();
    }

    async function processFiles(input, files) {
        if (processing) return;
        processing = true;
        try {
            // Немедленно очищаем DOCX из input: копии File уже сняты в `files`,
            // AI Studio не должна получить доступ к исходному DOCX.
            resetInput(input);

if (!librariesReady()) {
                diagErr('Библиотеки НЕ найдены при конвертации. Полная диагностика:');
                const r = inspectLibraries();
                let detail = 'Ошибка конвертации: библиотеки не найдены. ';
                if (!r.embedded) {
                    detail += 'Встраивание не сработало — скрипт, возможно, старая версия или файл повреждён. ';
                }
                if (r.probe && r.probe.embeddedFlag) {
                    detail += 'embedded-флаг: ' + JSON.stringify(r.probe.embeddedFlag) + '; ';
                }
                if (r.probe) {
                    detail += 'typeof: mammoth=' + r.probe.mammoth
                        + ', html2canvas=' + r.probe.html2canvas
                        + ', jspdf=' + r.probe.jspdf
                        + '; в window найдены: ' + [].concat(r.probe.mammothKey, r.probe.html2canvasKey, r.probe.jspdfWindowKeys).filter(Boolean).join(', ') || '—';
                }
                showStatus(MESSAGES.libs, 'error', 6000);
                if (DEBUG) showStatus(detail, 'error', 8000);
                resetInput(input);
                return;
            }

            const tasks = Array.from(files || []).map((file) => ({ file, docx: isDocx(file) }));
            const docxCount = tasks.filter((t) => t.docx).length;
            let done = 0;
            let errors = 0;
            let lastErr = null;
            const outFiles = [];

            for (const task of tasks) {
                if (!task.docx) {
                    outFiles.push(task.file);
                    continue;
                }
                done++;
                showStatus(
                    docxCount > 1 ? 'Конвертация DOCX → PDF (' + done + '/' + docxCount + ')…' : 'Конвертация DOCX → PDF…',
                    'info'
                );
                try {
                    const pdfFile = await convertDocxToPdf(task.file);
                    outFiles.push(pdfFile);
                } catch (e) {
                    errors++;
                    lastErr = e;
                    console.error(LOG_TAG, 'docx -> pdf failed:', e && (e.code || e.message));
                }
            }

            if (outFiles.length === 0) {
                resetInput(input);
                showStatus(lastErr ? MESSAGES[lastErr.code] || MESSAGES.convert : MESSAGES.convert, 'error', 5000);
                return;
            }

            showStatus('Загрузка PDF…', 'info');
            try {
                await injectFiles(input, outFiles);
            } catch (e) {
                console.error(LOG_TAG, 'inject failed:', e && e.message);
                showStatus(MESSAGES.inject, 'error', 6000);
                return;
            }

            if (errors > 0) {
                showStatus('Готово (ошибок: ' + errors + ')', 'warn', 3500);
            } else {
                showStatus('Готово', 'ok', 1800);
            }
        } finally {
            processing = false;
        }
    }

    // ============================================================
    // ПЕРЕХВАТ: change (выбор через диалог) и drop (drag & drop)
    // ============================================================
    function onChangeCapture(event) {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
        if (!needsInterception(input)) return;

        const files = Array.from(input.files || []);
        if (!files.some(isDocx)) return; // нет DOCX — пропускаем штатное поведение полностью

        if (processing) {
            showStatus('Подождите: предыдущий файл ещё конвертируется…', 'warn', 2500);
            return;
        }

        log('DOCX detected');
        event.preventDefault();
        event.stopPropagation();
        showStatus('DOCX → PDF…', 'info');
        processFiles(input, files);
    }

function resetDragOverlay() {
        try {
            const host = document.querySelector('ms-prompt-box');
            if (host) {
                host.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
            }
        } catch (e) { /* ignore */ }
        document.querySelectorAll('.dragging-overlay.dragging').forEach((el) => el.classList.remove('dragging'));
    }

    function onDropCapture(event) {
        if (!event.dataTransfer || !event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
        const files = Array.from(event.dataTransfer.files);
        if (!files.some(isDocx)) return;

        log('DOCX drop detected');
        event.preventDefault();
        event.stopPropagation();
        resetDragOverlay();
        const input = findFileInput();
        if (!input) {
            showStatus(MESSAGES.inject, 'error', 6000);
            return;
        }
        processFiles(input, files);
    }

    // Проверка, что инпут относится к загрузке файлов в чат).
    function needsInterception(input) {
        if (input.matches(FILE_INPUT_SELECTOR)) return true;
        try {
            return !!input.closest('ms-add-media-button');
        } catch (e) {
            return false;
        }
    }

    // MutationObserver: следим за появлением инпута и компонента.
    // Обработчики вешаются на document один раз и работают для любых
    // динамически создаваемых инпутов, поэтому лёгкий наблюдатель нужен
    // в основном для диагностики в DEBUG-режиме.
    function watchForFileInput() {
        const observer = new MutationObserver((mutations) => {
            let saw = false;
            for (const m of mutations) {
                if (m.type !== 'childList') continue;
                for (const node of m.addedNodes) {
                    if (!(node instanceof Element)) continue;
                    if (node.matches && (node.matches(FILE_INPUT_SELECTOR) || node.matches(FILE_INPUT_FALLBACK))) {
                        saw = true;
                    } else if (node.querySelector) {
                        if (node.querySelector(FILE_INPUT_SELECTOR) || node.querySelector(FILE_INPUT_FALLBACK)) {
                            saw = true;
                        }
                    }
                }
            }
            if (saw) log('file input appeared');
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

// ============================================================
    // ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function installErrorCapture() {
        window.addEventListener('error', (event) => {
            const src = event.filename || '';
            if (src.indexOf('ai-studio-docx2pdf') !== -1 || /mammoth|html2canvas|jspdf/.test(src)) {
                diagErr('Перехвачена ошибка скрипта:',
                    'msg=', event.message || '',
                    'file=', (event.filename || '').slice(-80),
                    'line=', event.lineno, 'col=', event.colno,
                    'stack=', (event.error && event.error.stack) || '');
            }
        }, true);
        window.addEventListener('unhandledrejection', (event) => {
            const reason = event.reason;
            if (reason && (reason.stack || '').indexOf('ai-studio-docx2pdf') !== -1) {
                diagErr('Необработанный reject:', (reason && reason.stack) || reason);
            }
        }, true);
        diag('Перехват ошибок установлен');
    }

    function init() {
        injectStyle(STATUS_CSS, 'aisd2p-style-status');
        injectStyle(RENDER_CSS, 'aisd2p-style-render');
        installErrorCapture();
        diag('init: скрипт запущен, версия', VERSION);
        const libs = inspectLibraries();
        if (!libs.ok) {
            diagErr('При старте библиотеки НЕ найдены (embedded-флаг:', !!libs.embedded, ')');
            showStatus('AI Studio DOCX: библиотеки не загружены (см. консоль, [AI Studio DOCX] [DIAG])', 'error', 6000);
        } else {
            diag('Библиотеки найдены на старте:', {
                mammoth: typeof window.mammoth,
                html2canvas: typeof window.html2canvas,
                jspdf: !!(window.jspdf && window.jspdf.jsPDF),
            });
            showStatus('AI Studio DOCX v' + VERSION + ' готов', 'ok', 2500);
        }
        // Периодически перепроверяем готовность библиотек (без спама в лог:
        // полный JSON печатается только при возникновении проблемы).
        let okState = libs.ok;
        setInterval(() => {
            const now = librariesReady();
            if (!now) {
                if (okState !== false) {
                    diagErr('Периодическая проверка: библиотеки пропали/не найдены');
                    try { console.log(DIAG_TAG, 'ПЕРИОДИЧЕСКАЯ ДИАГНОСТИКА:', JSON.stringify(inspectProbe())); } catch (e) { /* ignore */ }
                }
                okState = false;
            } else {
                okState = true;
            }
        }, 5000);
        // Перехват события выбора файла гарантированно ДО обработчиков AI Studio:
        // capture-фаза на document срабатывает раньше target-фазы Angular-компонента.
        document.addEventListener('change', onChangeCapture, true);
        document.addEventListener('drop', onDropCapture, true);
        watchForFileInput();
        log('initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();