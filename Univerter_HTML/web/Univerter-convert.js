'use strict';
/* ============================================================
   Univerter — convert.js
   Поддерживаемые входные форматы: pdf, docx, txt, md, markdown,
   xls/xlsx/xlsm/csv/ods, изображения.
   Форматы doc и rtf не поддерживаются.

   Ключевые особенности:
   - convertDoc обрабатывает только docx (mammoth);
   - convertSpreadsheet поддерживает pdf и md, cellDates: true
     и raw: true (числа — числами, даты — Date-объектами);
   - sheetsToMarkdown форматирует Date через UTC-геттеры
     (без сдвига по часовому поясу);
   - retrySingleFile сбрасывает stopRequested и активирует
     stopBtn — повтор после «Остановить» работает;
   - saveAll оборачивает localStorage в try/catch;
   - stopConversion отклоняет ожидающие запросы к движку распознавания.
   ============================================================ */

/* UTF-8 с откатом на windows-1251 (частый случай для русских txt/csv) */
async function readTextSmart(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder('windows-1251').decode(buf); }
}

async function dirHasFile(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
}

function normalizeResults(result, item) {
  const arr = (Array.isArray(result) ? result : [result]).filter(r => r && r.blob && r.blob.size > 0);
  if (!arr.length) throw new Error('Конвертация не дала результата');
  const base = getBaseName(item.newName);
  return arr.map((r, i) => {
    const ext = getExtension(r.name) || item.targetExt;
    const m = /_стр(\d+)\.[^.]+$/.exec(r.name || '');
    const pageNo = m ? m[1] : i + 1; // сохраняем реальный номер страницы
    return Object.assign({}, r, {
      name: arr.length > 1 ? `${base}_стр${pageNo}.${ext}` : `${base}.${ext}`
    });
  });
}

function rebuildConvertedFiles() {
  convertedFiles = [];
  for (const item of filesToProcess) {
    if (!item.result) continue;
    for (const r of (Array.isArray(item.result) ? item.result : [item.result])) {
      if (r && r.blob) convertedFiles.push(r);
    }
  }
}

/* Fallback или статус ошибки для одного файла. Возвращает 'fallback' | 'error'. */
async function applyFallbackOrError(i, item, diagnosis) {
  const showError = () => updateFileStatus(i, 'error', '✗ Ошибка',
    `<strong>${escapeHtml(diagnosis.title)}</strong><br>${escapeHtml(diagnosis.message)}`, diagnosis);

  if (!fallbackModeCheckbox.checked || item.action !== 'convert' || diagnosis.type === 'ocr') { showError(); return 'error'; }
  try {
    updateFileStatus(i, 'processing', '🔄 Fallback',
      `<strong>${escapeHtml(diagnosis.title)}</strong><br>Пробую альтернативный метод...`);
    const fb = await createFallbackResult(item, diagnosis);
    const list = Array.isArray(fb) ? fb : [fb];             // fallback PDF → картинки возвращает массив страниц
    if (!list.length || !list.every(r => r && r.blob)) throw new Error('Fallback не вернул результат');
    item.result = list.map((r, k) => {
      const ext = getExtension(r.name) || item.targetExt;
      const m = /_стр(\d+)\.[^.]+$/.exec(r.name || '');
      const base = getBaseName(item.newName);
      return Object.assign({}, r, { name: list.length > 1 ? `${base}_стр${m ? m[1] : k + 1}.${ext}` : `${base}.${ext}` });
    });
    updateFileStatus(i, 'fallback', '⚠️ Fallback',
      `<strong>${escapeHtml(diagnosis.title)}</strong><br>${escapeHtml(list[0].fallbackReason || 'Сохранено через fallback')}`,
      diagnosis);
    updateFileProgress(i, 100, '');
    return 'fallback';
  } catch (fbErr) {
    if (stopRequested) throw fbErr;
    console.error('Fallback не удался:', fbErr);
    diagnosis.attempts.push({ method: 'Fallback', success: false, error: fbErr.message });
    showError();
    return 'error';
  }
}

async function startConversion() {
  if (isProcessing) return;
  if (!filesToProcess.length) { alert('Нет файлов для обработки'); return; }

  isProcessing = true;
  stopRequested = false;
  setModeLocked(true);
  await probeHelper(true);   // актуализируем статус локального движка
  convertBtn.disabled = true;
  stopBtn.disabled = false;
  overallProgress.classList.add('active');

  filesToProcess.forEach((item, i) => {
    item.result = null;
    item.errorDetails = null;
    updateFileProgress(i, 0, '');
    updateFileStatus(i, 'processing', '⏳ В очереди');
  });
  rebuildConvertedFiles();
  setOverallProgress(0, filesToProcess.length, 'Обработка...', '');

  let success = 0, fallbacks = 0, errors = 0, skipped = 0, stopped = false;
  let lastStarted = -1;
  const startedAt = Date.now();

  try {
    for (let i = 0; i < filesToProcess.length; i++) {
      if (stopRequested) { stopped = true; break; }
      const item = filesToProcess[i];
      lastStarted = i;
      progressCurrentFile.textContent = item.file.name;

      try {
        if (item.action === 'copy' || item.action === 'keep') {
          item.originalBlob = item.file;
          item.result = [{ name: item.newName, blob: item.file }];
          updateFileStatus(i, 'ready', item.action === 'copy' ? '✓ Скопировано' : '✓ Без изменений');
          updateFileProgress(i, 100, '');
          success++;
        } else {
          item.originalBlob = item.file;
          try {
            updateFileStatus(i, 'processing', '⚙️ Обработка');
            const raw = await convertFile(item.file, item.targetExt, i);
            item.result = normalizeResults(raw, item);
            updateFileStatus(i, 'ready', '✓ Готово');
            updateFileProgress(i, 100, '');
            success++;
          } catch (convErr) {
            if (stopRequested) throw convErr;
            if (convErr && convErr.skip) {                       // нет полезной информации: не ошибка и не результат
              item.result = null;
              updateFileStatus(i, 'ignored', '⏭️ Пропущен', `<strong>Нет полезной информации</strong><br>${escapeHtml(convErr.message)}`);
              updateFileProgress(i, 0, '');
              markSkippedName(i);
              skipped++;
            } else {
              console.error('Ошибка конвертации:', convErr);
              const diagnosis = diagnoseError(convErr, item.file, convErr.attempts || []);
              const outcome = await applyFallbackOrError(i, item, diagnosis);
              if (outcome === 'fallback') fallbacks++; else errors++;
            }
          }
        }
      } catch (fatalErr) {
        if (stopRequested) { stopped = true; updateFileStatus(i, 'error', '⏹️ Остановлено'); break; }
        console.error('Критическая ошибка:', fatalErr);
        const diagnosis = diagnoseError(fatalErr, item.file, []);
        updateFileStatus(i, 'error', '✗ Ошибка',
          `<strong>❗ Критическая ошибка</strong><br>${escapeHtml(diagnosis.message)}`, diagnosis);
        errors++;
      }

      await renameByContent(i, item);   // осмысленное имя для автоимён (IMG_…, scan…)
      rebuildConvertedFiles();
      setOverallProgress(i + 1, filesToProcess.length, 'Обработка...', item.file.name);
      await sleep(0);
    }
  } finally {
    isProcessing = false;
    setModeLocked(false);
    convertBtn.disabled = filesToProcess.length === 0;
    stopBtn.disabled = true;
    rebuildConvertedFiles();
  }

  if (stopped) {
    for (let j = lastStarted + 1; j < filesToProcess.length; j++) {
      if (!filesToProcess[j].result) updateFileStatus(j, 'ignored', '⏹️ Не обработан');
    }
  }

  const secs = Math.round((Date.now() - startedAt) / 1000);
  let title = stopped ? '⏹️ Остановлено' : '✓ Готово';
  title += ` · успешно: ${success}`;
  if (fallbacks) title += `, fallback: ${fallbacks}`;
  if (errors) title += `, ошибок: ${errors}`;
  if (skipped) title += `, пропущено: ${skipped}`;
  setOverallProgress(stopped ? progressDone.textContent : filesToProcess.length, filesToProcess.length, title, `Время: ${secs} с`);

  let summary = `${stopped ? '⏹️ Обработка остановлена' : '✅ Конвертация завершена'}\n\n✓ Успешно: ${success}\n`;
  if (fallbacks) summary += `⚠️ Fallback: ${fallbacks}\n`;
  if (errors) summary += `✗ Ошибок: ${errors}\n`;
  if (skipped) summary += `⏭️ Пропущено (нет полезной информации): ${skipped}\n`;
  summary += `⏱️ Время: ${secs} с\n`;
  if (errors) summary += '\n💡 Нажмите «🔄» у проблемных файлов для повтора.';
  showNotice(summary.trim(), errors ? 'warn' : 'ok');
}

/* ============================================================
   Локальный движок (univerter_server.py): LibreOffice + pdf2docx
   DOCX → PDF и PDF → DOCX с максимальным сохранением оформления.
   Если сервис не запущен — всё работает в браузерном режиме.
   ============================================================ */
const HELPER_PORT = 8765;
let helperInfo = null;   // { url, soffice, pdf2docx } или null

function helperCan(to) {
  return !!helperInfo && (to === 'pdf' ? helperInfo.soffice : helperInfo.pdf2docx);
}

function renderHelperStatus() {
  const el = document.getElementById('helperStatus');
  if (!el) return;
  if (!helperInfo) {
    el.textContent = '⚪ Локальный движок не найден: распознавание (OCR) недоступно, DOCX ↔ PDF в упрощённом режиме. Запустите: py univerter_server.py --open';
    el.style.color = 'var(--warn)';
    return;
  }
  const inst = helperInfo.install || {};       // статусы автоустановки пакетов движком (см. /health)
  const ocr = helperInfo.indra
    ? (helperInfo.indra_state === 'error' ? `✗ OCR (Indra: ${helperInfo.indra_error || 'ошибка загрузки'})`
      : helperInfo.indra_state === 'ready' ? 'OCR (Indra) ✓'
      : '⏳ OCR (Indra загружается, при первом запуске скачивается модель)')
    : inst.indra_ocr === 'installing' ? '⏳ OCR (ставлю indra-ocr…)'
    : inst.indra_ocr === 'failed' ? '✗ OCR (не удалось поставить indra-ocr — подробности в консоли движка)'
    : '✗ OCR (Indra не установлена: py install_indra.py)';
  const parts = [`DOCX→PDF ${helperInfo.soffice ? '✓' : '✗ (нет LibreOffice)'}`,
                 `PDF→DOCX ${helperInfo.pdf2docx ? '✓' : inst.pdf2docx === 'installing' ? '⏳ ставлю pdf2docx…' : '✗ (нет pdf2docx)'}`, ocr];
  el.textContent = `🟢 Локальный движок подключён: ${parts.join(', ')}`;
  el.style.color = (helperInfo.indra && helperInfo.indra_state === 'ready') ? 'var(--ok)' : 'var(--warn)';
}

async function probeHelper(force) {
  if (isProcessing && !force) return;
  const cands = [];
  if (/^https?:$/.test(location.protocol) && ['127.0.0.1', 'localhost'].includes(location.hostname)) cands.push(location.origin);
  cands.push(`http://127.0.0.1:${HELPER_PORT}`);
  let found = null;
  for (const url of [...new Set(cands)]) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    try {
      const r = await fetch(url + '/health', { signal: ctl.signal, cache: 'no-store' });
      const j = await r.json();
      // Ответ сервиса не должен подменять его адрес: поля из JSON накладываем на наш url,
      // а не наоборот (иначе чужой сервис на этом порту уведёт все файлы к себе).
      if (j && j.ok) { found = Object.assign({}, j, { url }); break; }
    } catch (e) { /* сервис не запущен */ }
    finally { clearTimeout(t); }
  }
  helperInfo = found;
  renderHelperStatus();
}

async function convertViaHelper(file, to, index, baseName) {
  updateFileStatus(index, 'processing', '🖥️ Локальный движок...');
  updateFileProgress(index, 20, 'Локальный движок...');
  // Для больших файлов (>20 МБ) автоматически используем быстрый режим
  const quality = (file.size > 20 * 1024 * 1024) ? 'fast' : 'high';
  const res = await rejectOnStop(fetchAbortable(
    `${helperInfo.url}/convert?to=${to}&quality=${quality}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
    15 * 60 * 1000, 'локальный движок'));
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error; } catch (e) {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  let warnings = [];
  try { warnings = JSON.parse(decodeURIComponent(res.headers.get('X-Univerter-Warnings') || '[]')); } catch (e) {}
  if (warnings.some(w => w.includes('⚠'))) showNotice(`«${file.name}»:\n${warnings.join('\n')}`, 'warn');
  updateFileProgress(index, 100, '');
  return { name: `${baseName}.${to}`, blob };
}

async function convertFile(file, targetExt, index) {
  const ext = detectFileType(file);
  const baseName = getBaseName(file.name);
  if (!ext) throw new Error('Не поддерживается: неизвестный тип файла');
  if (ext === targetExt) return { name: `${baseName}.${ext}`, blob: file };

  // DOCX ↔ PDF: сначала локальный движок (максимум оформления), при сбое — браузерный режим
  const helperTo = (ext === 'docx' && targetExt === 'pdf') ? 'pdf' : (ext === 'pdf' && targetExt === 'docx') ? 'docx' : null;
  const useHelperEl = document.getElementById('useHelper');
  if (helperTo && useHelperEl && useHelperEl.checked && helperCan(helperTo)) {
    try {
      return await convertViaHelper(file, helperTo, index, baseName);
    } catch (e) {
      if (stopRequested) throw e;
      console.warn('Локальный движок не справился:', e);
      showNotice(`«${file.name}»: локальный движок не справился (${e.message}). Использую браузерный режим.`, 'warn');
    }
  }

  if (ext === 'pdf') return convertPdf(file, targetExt, index, baseName);
  if (IMAGE_EXTS.includes(ext)) return convertImage(file, targetExt, index, baseName);

  if (['txt', 'md', 'markdown'].includes(ext)) {
    const text = await readTextSmart(file);
    if (targetExt === 'md') return { name: baseName + '.md', blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }) };
    if (targetExt === 'docx') return { name: baseName + '.docx', blob: await createSimpleDocx(text) };
    if (targetExt === 'pdf') { await getUnicodeFont(); return { name: baseName + '.pdf', blob: await createPdfFromOps(layoutTextPages(text, { title: baseName })) }; }
  }

  if (DOC_EXTS.includes(ext)) return convertDoc(file, ext, targetExt, index, baseName);

  if (SHEET_EXTS.includes(ext) && (targetExt === 'pdf' || targetExt === 'md')) {
    return convertSpreadsheet(file, index, baseName, targetExt);
  }

  throw new Error(`Не поддерживается: ${ext} → ${targetExt}`);
}

/* Очистка и нормализация Markdown после конвертации */
function cleanupMarkdown(md) {
  if (!md) return '';
  return md
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')           // хвостовые пробелы
    .replace(/\n{3,}/g, '\n\n')           // не больше двух пустых строк
    .replace(/^[ \t]+$/gm, '')            // пустые строки с пробелами
    .replace(/([^\n])\n(#{1,6} )/g, '$1\n\n$2')  // пустая строка перед заголовком
    .replace(/(#{1,6} .*)\n([^\n#])/g, '$1\n\n$2') // пустая строка после заголовка
    .trim() + '\n';
}

/* DOCX → {md, docx, pdf}. Форматы .doc / .rtf не поддерживаются. */
async function convertDoc(file, ext, targetExt, index, baseName) {
  requireLib(typeof mammoth !== 'undefined', 'mammoth.js');
  updateFileStatus(index, 'processing', '📄 Чтение DOCX...');

  // Картинки не встраиваем (base64 раздувает MD на мегабайты)
  const result = await mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '', alt: 'изображение' })) }
  );
  const html = result.value || '';

  if (targetExt === 'md') {
    requireLib(typeof TurndownService !== 'undefined', 'TurndownService');
    const td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*'
    });
    if (typeof turndownPluginGfm !== 'undefined') td.use(turndownPluginGfm.gfm);
    td.addRule('dropImages', { filter: 'img', replacement: () => '\n*[изображение]*\n' });
    td.addRule('preserveBreaks', { filter: 'br', replacement: () => '  \n' });
    const md = cleanupMarkdown(td.turndown(html));
    return {
      name: baseName + '.md',
      blob: new Blob([md], { type: 'text/markdown;charset=utf-8' })
    };
  }

  const text = htmlToPlainText(html);
  if (!text.trim()) throw new Error('Не удалось извлечь текст из документа');

  if (targetExt === 'docx') {
    return { name: baseName + '.docx', blob: await createSimpleDocx(text) };
  }
  if (targetExt === 'pdf') {
    await getUnicodeFont();
    return {
      name: baseName + '.pdf',
      blob: await createPdfFromOps(layoutTextPages(text, { title: baseName }))
    };
  }

  throw new Error(`Не поддерживается: ${ext} → ${targetExt}`);
}

/* Инертный разбор (DOMParser): HTML из документа не попадает в живой DOM
   и не зависит от вёрстки страницы. */
function htmlToPlainText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'UL', 'OL', 'TABLE', 'BLOCKQUOTE', 'PRE']);
  let out = '';
  const walk = (n) => {
    if (n.nodeType === 3) { out += n.nodeValue; return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName;
    if (tag === 'BR') { out += '\n'; return; }
    if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'STYLE') return;
    if (tag === 'LI') {
      const par = n.parentElement;
      out += (par && par.tagName === 'OL') ? `${Array.prototype.indexOf.call(par.children, n) + 1}. ` : '• ';
    }
    n.childNodes.forEach(walk);
    if (tag === 'TD' || tag === 'TH') out += ' | ';
    else if (BLOCK.has(tag)) out += '\n';
  };
  walk(doc.body);
  return out.replace(/ \| \n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ============================================================
   PDF → {md, docx, png}
   ============================================================ */
async function convertPdf(file, targetExt, index, baseName) {
  if (!['md', 'docx', 'png'].includes(targetExt)) throw new Error(`Не поддерживается: pdf → ${targetExt}`);
  updateFileStatus(index, 'processing', '🔎 Открытие PDF...');
  const info = await openPdfSafe(file);
  const pdf = info.pdf;
  filesToProcess[index].pdfInfo = { pages: info.pages, hasText: info.hasText, hasImages: info.hasImages };

  try {
    if (targetExt === 'png') {
      const results = [];
      let skipped = 0;
      for (let p = 1; p <= info.pages; p++) {
        throwIfStopped();
        updateFileProgress(index, (p / info.pages) * 100, `Рендер: стр. ${p}/${info.pages}`);
        let canvas = null;
        try {
          canvas = await renderPageAdaptive(pdf, p, 2500);
          results.push({ name: `${baseName}_стр${p}.png`, blob: await canvasToBlob(canvas, 'image/png') });
        } catch (e) { skipped++; console.error(`Ошибка рендера стр. ${p}:`, e); }
        finally { releaseCanvas(canvas); }
      }
      if (!results.length) throw new Error('Не удалось отрендерить ни одной страницы');
      if (skipped) showNotice(`«${file.name}»: не отрендерено страниц — ${skipped} (остальные сохранены)`, 'warn');
      return results;
    }

    file._docText = '';
    file._docHeadings = [];
    let usefulOcrPages = 0;
    let text = '';
    const images = [];
    const textPageNums = [];
    let ocrPages = 0;

    for (let p = 1; p <= info.pages; p++) {
      throwIfStopped();
      updateFileProgress(index, ((p - 1) / info.pages) * 100, `Стр. ${p}/${info.pages}`);

      // Решение «текст или OCR» принимается для каждой страницы отдельно
      let pageText = '';
      try {
        const page = await pdf.getPage(p);
        pageText = await extractPageText(page);
        page.cleanup();
      } catch (e) { console.warn(`Текст стр. ${p} не извлечён:`, e); }

      if (pageText.replace(/\s/g, '').length >= CONFIG.minPageTextChars && isTextReadable(pageText)) {
        text += `## Страница ${p}\n\n${pageText}\n\n`;
        textPageNums.push(p);
        if (p <= 3) file._docText = ((file._docText || '') + '\n' + pageText).slice(0, DOC_TEXT_MAX);
        continue;
      }

      ocrPages++;
      updateFileStatus(index, 'ocr-processing', `🔍 OCR стр. ${p}/${info.pages}`);
      const pageResult = await processPdfPageRobust(pdf, p, index, info.pages);
      if (pageResult.quality && pageResult.quality.useful) usefulOcrPages++;
      if (p <= 3 && pageResult.headings) file._docHeadings.push(...pageResult.headings);
      const pageName = pageResult.titleText != null ? pageResult.titleText : (pageResult.text || '');
      if (p <= 3 && pageName.trim()) file._docText = ((file._docText || '') + '\n' + pageName).slice(0, DOC_TEXT_MAX);
      if (pageResult.text && pageResult.text.trim()) text += `## Страница ${p}\n\n${pageResult.text}\n\n`;
      else if (targetExt === 'md') text += `## Страница ${p}\n\n*[Страница не распознана]*\n\n`;

      if (targetExt === 'docx' && pageResult.canvas) {
        try {
          const blob = await canvasToBlob(pageResult.canvas, 'image/jpeg', CONFIG.jpegQuality);
          images.push({ pageNum: p, blob, width: pageResult.canvas.width, height: pageResult.canvas.height });
        } catch (e) { console.warn(`Не удалось сохранить изображение стр. ${p}`, e); }
      }
      releaseCanvas(pageResult.canvas);
    }
    // страницы-картинки без полезного текста: ни текстового слоя, ни надёжного OCR — не конвертируем
    if (shouldSkipUseless() && ocrPages > 0 && !textPageNums.length && !usefulOcrPages && ['md', 'docx'].includes(targetExt)) {
      throw makeSkip(`на ${ocrPages} стр. нет надёжно распознанного текста — файл состоит только из изображений без полезной информации`);
    }

    if (targetExt === 'md') {
      if (!text.trim()) throw new Error('Из PDF не извлечён текст');
      // Убираем дублирующие заголовки страниц, если текст уже структурирован
      let md = text;
      if (info.pages === 1) md = md.replace(/^## Страница 1\n\n/, '');
      md = cleanupMarkdown(`# ${baseName}\n\n${md}`);
      return { name: baseName + '.md', blob: new Blob([md], { type: 'text/markdown;charset=utf-8' }) };
    }

    const textRatio = (info.pages - ocrPages) / info.pages;
    if (text.replace(/[#*\[\]]/g, '').trim().length > 200 && (textRatio >= 0.5 || !images.length)) {
      return { name: baseName + '.docx', blob: await createSimpleDocx(text) };
    }
    if (images.length) {
      // страницы с текстовым слоем тоже нужны в итоговом DOCX из картинок
      for (const p of textPageNums) {
        throwIfStopped();
        let c = null;
        try {
          c = await renderPageAdaptive(pdf, p, 2500);
          images.push({ pageNum: p, blob: await canvasToBlob(c, 'image/jpeg', CONFIG.jpegQuality), width: c.width, height: c.height });
        } finally { releaseCanvas(c); }
      }
      images.sort((a, b) => a.pageNum - b.pageNum);
      return { name: baseName + '.docx', blob: await createDocxFromImages(images, baseName) };
    }
    if (text.trim()) return { name: baseName + '.docx', blob: await createSimpleDocx(text) };
    throw new Error('Не удалось получить ни текст, ни изображения из PDF');
  } finally {
    try { await pdf.destroy(); } catch (e) {}
    if (filesToProcess[index]) filesToProcess[index].pdfInfo = { pages: info.pages, hasText: info.hasText, hasImages: info.hasImages };
  }
}

/* ============================================================
   Изображение → {pdf, md, docx}
   ============================================================ */
/* «Пропущено»: не ошибка и не результат — файл не попадает в список готовых */
function makeSkip(message) { const e = new Error(message); e.skip = true; return e; }
function markSkippedName(i) {                      // у пропущенного файла нет результата — не показываем имя, которого не будет
  const el = fileList.querySelector(`li[data-index="${i}"] .file-new-name`);
  if (el) { el.textContent = 'не конвертируется: нет полезной информации'; el.classList.remove('content', 'kept'); }
}
function shouldSkipUseless() { const el = document.getElementById('skipUseless'); return !el || el.checked; }

async function convertImage(file, targetExt, index, baseName) {
  if (!['pdf', 'md', 'docx'].includes(targetExt)) throw new Error(`Не поддерживается: изображение → ${targetExt}`);
  updateFileStatus(index, 'ocr-processing', '🔍 OCR...');
  const source = await loadImageToCanvas(file);
  let ocr;
  try {
    ocr = await ocrCanvas(source, (p, msg) => {
      updateFileProgress(index, p * 0.9, msg);
      progressCurrentFile.textContent = `${file.name} — ${msg}`;
    });
  } catch (e) {
    releaseCanvas(source);
    throw e;
  }
  file._docHeadings = ocr.headings || [];
  file._docText = ocr.titleText != null ? ocr.titleText : (ocr.text || '');   // для имени файла — только уверенно распознанный текст, без повторного OCR

  try {
    if (shouldSkipUseless() && !(ocr.quality && ocr.quality.useful)) {
      const q = ocr.quality || {};
      throw makeSkip(`надёжно распознано слов: ${q.goodWords || 0} (из ${q.totalWords || 0}) — на изображении нет текста, пригодного для документа`);
    }
    if (targetExt === 'pdf') {
      const res = await createPdfWithTextLayer(ocr.canvas, ocr, baseName);
      if (!res.textLayerLines) showNotice(`«${file.name}»: текст на изображении не распознан — в PDF нет текстового слоя`, 'warn');
      return res;
    }

    if (targetExt === 'md') {
      const body = ocr.text.trim() ? ocr.text : '*[Текст не распознан]*';
      const md = cleanupMarkdown(`# ${baseName}\n\n${body}\n`);
      return { name: baseName + '.md', blob: new Blob([md], { type: 'text/markdown;charset=utf-8' }) };
    }

    if (ocr.text.trim().length >= 30) return { name: baseName + '.docx', blob: await createSimpleDocx(ocr.text) };
    const blob = await canvasToBlob(ocr.canvas, 'image/jpeg', CONFIG.jpegQuality);
    return {
      name: baseName + '.docx',
      blob: await createDocxFromImages([{ blob, width: ocr.canvas.width, height: ocr.canvas.height }], baseName)
    };
  } finally {
    releaseCanvas(source);
    if (ocr && ocr.canvas !== source) releaseCanvas(ocr.canvas);
  }
}

/* ============================================================
   Таблица → PDF / MD

   cellDates: true — даты приходят Date-объектами,
   raw: true — числа остаются числами (1234.56).
   ============================================================ */
async function convertSpreadsheet(file, index, baseName, targetExt = 'pdf') {
  if (!['pdf', 'md'].includes(targetExt)) {
    throw new Error(`Не поддерживается: таблица → ${targetExt}`);
  }
  requireLib(typeof XLSX !== 'undefined', 'SheetJS (XLSX)');
  updateFileStatus(index, 'processing', '📊 Чтение таблицы...');

  // CSV: SheetJS по умолчанию читает байты как cp1252 — декодируем сами
  const wb = detectFileType(file) === 'csv'
    ? XLSX.read(await readTextSmart(file), { type: 'string', cellDates: true })
    : XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheets = [];
  wb.SheetNames.forEach((name, i) => {
    throwIfStopped();
    updateFileProgress(index, ((i + 1) / wb.SheetNames.length) * 90, `Лист: ${name}`);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1, defval: '', blankrows: false,
      raw: true
    });
    sheets.push({ name, rows });
  });
  if (!sheets.length) throw new Error('В книге нет листов');

  if (targetExt === 'md') {
    const md = cleanupMarkdown(sheetsToMarkdown(sheets, baseName));
    return {
      name: baseName + '.md',
      blob: new Blob([md], { type: 'text/markdown;charset=utf-8' })
    };
  }

  await getUnicodeFont(); // чтобы ширины колонок считались по реальному шрифту PDF
  const pages = layoutTablePages(sheets, { landscape: true });
  return { name: baseName + '.pdf', blob: await createPdfFromOps(pages, { landscape: true }) };
}

/* Формирует markdown-представление книги.
   - первый лист идёт после `# {baseName}`;
   - каждый лист — `## {name}` + pipe-таблица;
   - шапка = первая строка (A1: оставляем как есть);
   - Date → UTC-геттеры → `YYYY-MM-DD[ HH:MM:SS]`
     (без сдвига по часовому поясу);
   - числа остаются числами (1234.56);
   - `|` экранируется, переносы строк → `<br>`;
   - NULL/undefined → пустая ячейка;
   - пустой лист → `*[Лист пуст]*`. */
function sheetsToMarkdown(sheets, baseName) {
  let md = `# ${baseName}\n\n`;

  const escapeCell = (v) => {
    if (v === null || v === undefined) return '';

    // SheetJS с cellDates: true создаёт Date в UTC (полночь Excel
    // = 00:00 UTC). Читаем UTC-геттерами — дата одинакова в любом
    // часовом поясе браузера (без сдвига на день в UTC-5).
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
      const hasTime = v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds();
      if (!hasTime) return date;
      return `${date} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
    }

    return String(v)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r\n?|\n/g, '<br>')
      .trim();
  };

  for (const sheet of sheets) {
    md += `## ${sheet.name}\n\n`;

    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (!rows.length || !cols) { md += '*[Лист пуст]*\n\n'; continue; }

    const makeRow = (row) =>
      '| ' +
      Array.from({ length: cols }, (_, c) => escapeCell(row[c])).join(' | ') +
      ' |';

    md += makeRow(rows[0]) + '\n';
    md += '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |\n';
    for (let r = 1; r < rows.length; r++) {
      md += makeRow(rows[r]) + '\n';
    }
    md += '\n';
  }
  return md;
}

/* ============================================================
   Fallback. Ветки для .doc / .rtf отсутствуют.
   ============================================================ */
/* PDF → MD в fallback: сначала текстовый слой, OCR только для страниц без текста.
   Если ничего не извлечено — ошибка, а не «успешный» файл из заглушек. */
async function fallbackPdfToMd(info, file, baseName, index, diagnosis) {
  let md = `# ${baseName}\n\n> Fallback-режим\n\n`;
  let textPages = 0, ocrOk = 0, failed = 0;
  let ocrAvailable = diagnosis.type !== 'network' && ocrEngineReady();

  for (let p = 1; p <= info.pages; p++) {
    throwIfStopped();
    progressCurrentFile.textContent = `${file.name} — fallback: стр. ${p}/${info.pages}`;
    updateFileProgress(index, (p / info.pages) * 100, `Fallback: стр. ${p}/${info.pages}`);

    let pageText = '';
    try {
      const page = await info.pdf.getPage(p);
      pageText = await extractPageText(page);
      page.cleanup();
    } catch (e) { console.warn(e); }

    md += `## Страница ${p}\n\n`;
    if (pageText.replace(/\s/g, '').length >= CONFIG.minPageTextChars) {
      md += pageText + '\n\n'; textPages++; continue;
    }
    if (!ocrAvailable) { md += '*[Страница не распознана: OCR недоступен]*\n\n'; failed++; continue; }

    let canvas = null;
    try {
      canvas = await renderPageAdaptive(info.pdf, p, 2000);
      const ocr = await ocrCanvas(canvas);
      md += (ocr.text.trim() || '*[Текст не распознан]*') + '\n\n';
      ocrOk++;
      if (ocr.canvas !== canvas) releaseCanvas(ocr.canvas);
    } catch (e) {
      if (stopRequested) throw e;
      failed++;
      md += '*[Страница не распознана]*\n\n';
      if (e && e.ocrUnavailable) ocrAvailable = false;
    } finally { releaseCanvas(canvas); }
  }

  if (!textPages && !ocrOk) throw new Error('Fallback не смог извлечь ни текст, ни результат OCR');
  return {
    name: baseName + '.md',
    blob: new Blob([md], { type: 'text/markdown;charset=utf-8' }),
    isFallback: true,
    fallbackReason: `Текст: ${textPages} стр., OCR: ${ocrOk} стр.` + (failed ? `, не распознано: ${failed}` : '')
  };
}

async function createFallbackResult(item, diagnosis) {
  const file = item.file;
  const ext = detectFileType(file);
  const baseName = getBaseName(item.newName);
  const targetExt = item.targetExt;
  const index = filesToProcess.indexOf(item);
  console.log('FALLBACK:', file.name, '→', targetExt);

  if (ext === 'pdf') {
    // Пользователь отказался вводить пароль — повторно не спрашиваем
    if (file._passwordCancelled) throw new Error('Пароль не введён — fallback невозможен');
    let info = null;
    try {
      info = await openPdfSafe(file);
      if (targetExt === 'md') {
        const r = await fallbackPdfToMd(info, file, baseName, index, diagnosis);
        diagnosis.attempts.push({ method: 'Fallback: текст + OCR', success: true });
        return r;
      }
      const images = [];
      for (let p = 1; p <= info.pages; p++) {
        throwIfStopped();
        progressCurrentFile.textContent = `${file.name} — fallback: стр. ${p}/${info.pages}`;
        updateFileProgress(index, (p / info.pages) * 100, `Fallback: стр. ${p}/${info.pages}`);
        let canvas = null;
        for (const size of [2000, 1500, 1000, 750]) {
          try { canvas = await renderPageAdaptive(info.pdf, p, size); if (canvas.width) break; }
          catch (e) { console.warn(`Стр. ${p}, ${size}px не сработал:`, e.message); canvas = null; }
        }
        if (!canvas) continue;
        try { images.push({ pageNum: p, blob: await canvasToBlob(canvas, targetExt === 'docx' ? 'image/jpeg' : 'image/png', CONFIG.jpegQuality), width: canvas.width, height: canvas.height }); }
        catch (e) { console.warn(e); }
        finally { releaseCanvas(canvas); }
      }
      if (!images.length) throw new Error('Не удалось извлечь ни одной страницы');
      diagnosis.attempts.push({ method: 'Fallback: рендер страниц', success: true });

      if (targetExt === 'docx') {
        return {
          name: baseName + '.docx',
          blob: await createDocxFromImages(images, baseName),
          isFallback: true, fallbackReason: `Извлечено ${images.length} стр. как изображения и вставлено в DOCX.`
        };
      }
      if (targetExt === 'png') {
        return images.map(img => ({ name: `${baseName}_стр${img.pageNum}.png`, blob: img.blob, isFallback: true, fallbackReason: 'Страницы сохранены как PNG.' }));
      }
    } catch (e) {
      diagnosis.attempts.push({ method: 'Fallback: рендер страниц', success: false, error: e.message });
      throw e;
    } finally {
      if (info) { try { await info.pdf.destroy(); } catch (e) {} }
    }
  }

  if (IMAGE_EXTS.includes(ext) && targetExt === 'pdf') {
    let canvas = null;
    try {
      canvas = await loadImageToCanvas(file);
      const doc = newJsPdf({ orientation: canvas.width > canvas.height ? 'landscape' : 'portrait' });
      const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
      const ratio = Math.min(pw / canvas.width, ph / canvas.height);
      const w = canvas.width * ratio, h = canvas.height * ratio;
      doc.addImage(canvas.toDataURL('image/jpeg', CONFIG.jpegQuality), 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');
      return { name: baseName + '.pdf', blob: doc.output('blob'), isFallback: true, fallbackReason: 'PDF с изображением без текстового слоя (OCR недоступен).' };
    } finally { releaseCanvas(canvas); }
  }

  return {
    name: `${baseName}.${ext || 'bin'}`,
    blob: file,
    isFallback: true,
    fallbackReason: '⚠️ Сохранён исходный файл: конвертация невозможна.'
  };
}

/* ============================================================
   Повтор одного файла.
   Сбрасывает stopRequested, активирует stopBtn, обновляет прогресс.
   ============================================================ */
async function retrySingleFile(index) {
  const item = filesToProcess[index];
  if (!item || isProcessing) { if (isProcessing) alert('Дождитесь окончания обработки'); return; }

  stopRequested = false;          // сбрасываем флаг после «Остановить»
  isProcessing = true;
  setModeLocked(true);
  convertBtn.disabled = true;
  stopBtn.disabled = false;       // даём возможность остановить долгий повтор

  overallProgress.classList.add('active');
  const total = filesToProcess.length;
  const doneBefore = filesToProcess.filter(f => f.result).length;
  setOverallProgress(doneBefore, total, '🔄 Повтор файла...', item.file.name);

  updateFileStatus(index, 'processing', '🔄 Повтор...');
  updateFileProgress(index, 0, '');

  try {
    item.pdfInfo = null;
    item.errorDetails = null;
    item.result = null;
    rebuildConvertedFiles();

    const raw = item.action === 'convert'
      ? await convertFile(item.file, item.targetExt, index)
      : { name: item.newName, blob: item.file };

    item.result = normalizeResults(raw, item);
    await renameByContent(index, item);
    rebuildConvertedFiles();
    updateFileStatus(index, 'ready', '✓ Готово');
    updateFileProgress(index, 100, '');
    showNotice(`✓ Файл «${item.file.name}» успешно обработан при повторе`);
  } catch (err) {
    if (err && err.skip) {
      item.result = null;
      updateFileStatus(index, 'ignored', '⏭️ Пропущен', `<strong>Нет полезной информации</strong><br>${escapeHtml(err.message)}`);
      rebuildConvertedFiles();
      markSkippedName(index);
      showNotice(`⏭️ «${item.file.name}» пропущен: нет полезной информации`, 'warn');
    } else {
    console.error('Повтор не удался:', err);
    if (stopRequested) {
      updateFileStatus(index, 'error', '⏹️ Остановлено');
    } else {
      const diagnosis = diagnoseError(err, item.file, err.attempts || []);
      let outcome = 'error';
      try { outcome = await applyFallbackOrError(index, item, diagnosis); }
      catch (e) { updateFileStatus(index, 'error', '⏹️ Остановлено'); outcome = 'stopped'; }
      if (outcome === 'fallback') await renameByContent(index, item);
      rebuildConvertedFiles();
      if (outcome === 'fallback') showNotice(`⚠️ «${item.file.name}»: повтор не удался, сохранён через fallback`, 'warn');
      else if (outcome === 'error') showNotice(`✗ Повтор не удался: ${err.message}`, 'err');
    }
    }
  } finally {
    isProcessing = false;
    stopRequested = false;
    setModeLocked(false);
    convertBtn.disabled = filesToProcess.length === 0;
    stopBtn.disabled = true;
    const doneAfter = filesToProcess.filter(f => f.result).length;
    setOverallProgress(doneAfter, total, '✓ Повтор завершён', '');
  }
}

/* ============================================================
   Скачивание
   ============================================================ */
function downloadBlob(blob, filename) {
  const name = sanitizeFileName(filename);
  if (typeof saveAs !== 'undefined') { try { saveAs(blob, name); return true; } catch (e) {} }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    return true;
  } catch (e) { console.error('Скачивание не удалось:', e); return false; }
}

function downloadSingleFile(index, isOriginal = false) {
  const item = filesToProcess[index];
  if (!item) { alert('Файл не найден'); return; }
  if (isOriginal) { downloadBlob(item.originalBlob || item.file, item.file.name); return; }
  if (!item.result) { alert('Файл ещё не обработан'); return; }
  const list = Array.isArray(item.result) ? item.result : [item.result];
  list.forEach((r, i) => setTimeout(() => downloadBlob(r.blob, r.name), i * 400));
}

async function downloadZip() {
  rebuildConvertedFiles();
  if (!convertedFiles.length) { alert('Нет готовых файлов'); return; }
  requireLib(typeof JSZip !== 'undefined', 'JSZip');
  try {
    const zip = new JSZip();
    const taken = new Set();
    for (const f of convertedFiles) zip.file(uniqueName(f.name, taken), f.blob);
    const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(content, 'univerter_result.zip');
  } catch (err) { alert('Ошибка ZIP: ' + err.message); }
}

async function downloadAllSeparate() {
  rebuildConvertedFiles();
  if (!convertedFiles.length) { alert('Нет файлов'); return; }
  if (!confirm(`Скачать ${convertedFiles.length} файлов по очереди?\nБраузер может запросить разрешение на множественное скачивание.`)) return;
  const taken = new Set();
  for (const f of convertedFiles) {
    downloadBlob(f.blob, uniqueName(f.name, taken));
    await sleep(500);
  }
}

/* ============================================================
   Сохранение в папку. Fallback без startIn.
   localStorage — под try/catch (Safari private).
   ============================================================ */
async function saveAll() {
  rebuildConvertedFiles();
  if (!convertedFiles.length) { alert('Нет файлов'); return; }

  if (!window.showDirectoryPicker) {
    alert('Ваш браузер не поддерживает сохранение в папку.\n\nРекомендуем использовать Chrome, Edge или Opera.\n\nАльтернатива: скачать файлы в ZIP-архив.');
    if (confirm('Скачать ZIP-архив?')) await downloadZip();
    return;
  }

  try {
    let showInstruction = true;
    try { showInstruction = !localStorage.getItem('univerter_folder_hint_shown'); } catch (e) {}
    if (showInstruction) {
      alert('💡 Совет: создайте или выберите папку "Univerter_results"\n\nВ открывшемся диалоге:\n1. Нажмите "Новая папка" (или выберите существующую)\n2. Назовите её "Univerter_results"\n3. Нажмите "Выбрать"');
      try { localStorage.setItem('univerter_folder_hint_shown', 'true'); } catch (e) {}
    }

    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
    } catch (e) {
      if (e.name === 'AbortError') return;
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (e2) {
        if (e2.name === 'AbortError') return;
        throw e2;
      }
    }

    const existing = [];
    for (const f of convertedFiles) {
      try { await dirHandle.getFileHandle(f.name); existing.push(f.name); } catch (e) {}
    }
    let overwrite = false;
    if (existing.length) {
      overwrite = confirm(`В папке уже есть ${existing.length} файл(ов) с такими именами.\nОК — перезаписать, Отмена — сохранить с новыми именами.`);
    }

    const taken = new Set();
    let count = 0;
    for (const f of convertedFiles) {
      let name = f.name;
      const base = getBaseName(f.name), ext = getExtension(f.name);
      let n = 2;
      // «новые имена» проверяем и по файлам, уже лежащим в папке
      while (taken.has(name) || (!overwrite && await dirHasFile(dirHandle, name))) {
        name = `${base}_${n++}${ext ? '.' + ext : ''}`;
      }
      taken.add(name);
      const handle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try { await writable.write(f.blob); } finally { await writable.close(); }
      count++;
    }

    alert(`✓ Сохранено файлов: ${count}\n\nПапка: ${dirHandle.name}`);

  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Ошибка сохранения:', err);
    alert('Ошибка сохранения: ' + err.message);
  }
}

/* ============================================================
   Остановка. Терминирует воркер и отменяет загрузку моделей,
   если инициализация ещё идёт.
   ============================================================ */
function stopConversion() {
  if (!isProcessing) return;
  stopRequested = true;
  stopBtn.disabled = true;
  progressTitle.textContent = '⏹️ Останавливаемся...';

  // Ожидающие запросы к движку распознавания отклоняем сразу, не дожидаясь таймаута,
  // и прерываем сами HTTP-запросы, чтобы движок не продолжал работу вхолостую.
  stopWaiters.forEach(w => w());
  stopWaiters.clear();
  abortActiveRequests();
}

/* Поиск локального движка при загрузке и периодически */
probeHelper();
setInterval(() => probeHelper(), 20000);

/* Страница полностью запущена (читает сторож загрузки в Univerter.html) */
window.__univerterReady = true;
