// ==UserScript==
// @name         Claude Project Files Extractor
// @namespace    http://tampermonkey.net/
// @version      5.0.0
// @description  Download/extract all files from a Claude project as a single ZIP - updated for the new Claude UI (Files dialog), API-first with DOM fallback
// @author       sharmanhall
// @match        https://claude.ai/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=claude.ai
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/541467/Claude%20Project%20Files%20Extractor.user.js
// @updateURL https://update.greasyfork.org/scripts/541467/Claude%20Project%20Files%20Extractor.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // CHANGELOG v5.0.0
    // ============================================================
    // - Updated for the new Claude UI: project files no longer live in a
    //   `ul.grid` of thumbnails; they sit behind the "Files" row
    //   (button[aria-label="Show files"]) which opens a [role="dialog"] list.
    // - New primary strategy: read the files straight from Claude's own
    //   project API (same-origin, uses your session) - full, untruncated
    //   content and no modal clicking.
    // - DOM fallback rewritten for the new Files dialog rows.
    // - Fixed modal closing: the old "first button in dialog" selector now
    //   hits "Search files"; we now use the explicit Close button / Escape.
    // - JSZip loaded via @require (page CSP can block injected <script>).
    // - Filenames keep their spaces; binary files for which only extracted
    //   text is available are saved as "<name>.txt" instead of a corrupt
    //   .pdf/.docx/.odt.
    // ============================================================

    // ============================================================
    // SELECTOR MAP (new UI)
    // ============================================================
    // PROJECT_PAGE:      [data-project-page]
    // PROJECT_TITLE:     [data-project-page] h1
    // SHOW_FILES_BUTTON: button[aria-label="Show files"]
    // FILES_DIALOG:      [role="dialog"] containing .group/frow rows
    // FILE_ROW:          div[class*="group/frow"]
    // FILE_ROW_BUTTON:   row > button[aria-label="<full filename>"]
    // FILE_ROW_CAPTION:  row .text-caption  -> "PDF · 11 pages · 75.4kB · Aug 24"
    // DIALOG_CLOSE:      [role="dialog"] button[aria-label="Close"]
    // ============================================================

    const VERSION = '5.0.0';

    const CONFIG = {
        SCROLL_WAIT_MS: 600,
        DIALOG_WAIT_MS: 5000,
        PREVIEW_WAIT_MS: 4000,
        PREVIEW_CONTENT_WAIT_MS: 1000,
        BETWEEN_FILES_MS: 400,
        MAX_SCROLL_ATTEMPTS: 30,
        MIN_CONTENT_LENGTH: 10
    };

    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    // Extensions whose original bytes are not plain text
    const BINARY_EXTS = ['pdf', 'docx', 'doc', 'odt', 'rtf', 'epub', 'pptx', 'xlsx', 'xls', 'xlsb', 'xlsm', 'ods',
        'zip', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

    const LOG_PREFIX = '[Claude Exporter]';

    const log = {
        info: (msg, ...args) => console.log(`${LOG_PREFIX} ℹ️ ${msg}`, ...args),
        success: (msg, ...args) => console.log(`${LOG_PREFIX} ✅ ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`${LOG_PREFIX} ⚠️ ${msg}`, ...args),
        error: (msg, ...args) => console.error(`${LOG_PREFIX} ❌ ${msg}`, ...args),
        debug: (msg, ...args) => console.log(`${LOG_PREFIX} 🔍 ${msg}`, ...args),
        file: (domName, normalizedName, type, strategy, status) => {
            const emoji = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⚠️';
            console.log(`${LOG_PREFIX} ${emoji} FILE: "${domName}" → "${normalizedName}" [${type}] via ${strategy} = ${status}`);
        }
    };

    // ============================================================
    // FILENAME NORMALIZATION
    // ============================================================

    function normalizeFilename(rawName) {
        if (!rawName || typeof rawName !== 'string') {
            return 'unnamed_file';
        }

        let name = rawName.trim();

        // Illegal characters on Windows/macOS and control chars
        name = name.replace(/[\\/:*?"<>|]/g, '_');
        name = name.replace(/[\x00-\x1F]/g, '');

        // Collapse runs of whitespace
        name = name.replace(/\s+/g, ' ');

        // Leading/trailing dots and spaces (Windows issue)
        name = name.replace(/[. ]+$/, '');
        name = name.replace(/^[. ]+/, '');

        // "file.pdf.pdf" -> "file.pdf"
        name = collapseDuplicateExtensions(name);

        if (!name || name === '_') {
            name = 'unnamed_file';
        }

        return name;
    }

    function collapseDuplicateExtensions(filename) {
        return filename.replace(/(\.[a-z0-9]{1,5})(\1)+$/i, '$1');
    }

    function getExtension(filename) {
        const match = filename.match(/\.([a-zA-Z0-9]+)$/);
        return match ? match[1].toLowerCase() : null;
    }

    function ensureExtension(filename, detectedType) {
        if (getExtension(filename)) {
            return filename;
        }
        const type = (detectedType || '').toLowerCase();
        const ext = /^[a-z0-9]{1,5}$/.test(type) ? type : 'txt';
        return `${filename}.${ext}`;
    }

    function isBinaryName(filename) {
        return BINARY_EXTS.includes(getExtension(filename));
    }

    // ============================================================
    // COLLISION HANDLING
    // ============================================================

    function handleCollision(filename, usedNames) {
        if (!usedNames.has(filename.toLowerCase())) {
            usedNames.add(filename.toLowerCase());
            return filename;
        }

        const ext = getExtension(filename);
        const base = ext ? filename.slice(0, -(ext.length + 1)) : filename;

        let counter = 2;
        let newName;
        do {
            newName = ext ? `${base}__${counter}.${ext}` : `${base}__${counter}`;
            counter++;
        } while (usedNames.has(newName.toLowerCase()));

        usedNames.add(newName.toLowerCase());
        return newName;
    }

    /**
     * Final ZIP entry name. When only extracted text exists for a binary
     * file (pdf/docx/odt...), append .txt so we never write text into a
     * file that claims to be binary.
     */
    function buildOutputName(rawName, type, textOnly, usedNames) {
        let name = ensureExtension(normalizeFilename(rawName), type);
        if (textOnly && isBinaryName(name)) {
            name = `${name}.txt`;
        }
        return handleCollision(name, usedNames);
    }

    // ============================================================
    // GENERIC UTILITIES
    // ============================================================

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitFor(fn, timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const result = fn();
            if (result) return result;
            await sleep(100);
        }
        return null;
    }

    function getCookie(name) {
        const prefix = name + '=';
        for (const part of document.cookie.split(';')) {
            const trimmed = part.trim();
            if (trimmed.startsWith(prefix)) {
                try {
                    return decodeURIComponent(trimmed.slice(prefix.length));
                } catch (e) {
                    return trimmed.slice(prefix.length);
                }
            }
        }
        return null;
    }

    function ensureJSZip() {
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip not available (the @require failed to load)');
        }
    }

    // ============================================================
    // PAGE CONTEXT
    // ============================================================

    function isProjectPage() {
        return !!document.querySelector('[data-project-page]') || /\/project\//.test(location.pathname);
    }

    function getProjectTitle() {
        const selectors = [
            '[data-project-page] h1',
            'h1.font-heading',
            'h1'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            const text = el?.textContent?.trim();
            if (text && text !== 'Claude') return text;
        }

        const renameBtn = document.querySelector('button[aria-label^="Rename "]');
        if (renameBtn) return renameBtn.textContent.trim();

        const urlMatch = location.pathname.match(/\/project\/([^/]+)/);
        if (urlMatch) return urlMatch[1];

        return 'Claude_Project';
    }

    // ============================================================
    // STRATEGY 1: PROJECT API
    // ============================================================

    async function apiGet(path, as = 'json') {
        const res = await fetch(path, { credentials: 'include' });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${path}`);
        }
        if (as === 'json') return res.json();
        if (as === 'blob') return res.blob();
        return res.text();
    }

    function asArray(data) {
        if (Array.isArray(data)) return data;
        if (data && typeof data === 'object') {
            for (const key of ['files', 'docs', 'data', 'items', 'results']) {
                if (Array.isArray(data[key])) return data[key];
            }
        }
        return [];
    }

    async function getOrgId() {
        const fromCookie = getCookie('lastActiveOrg');
        if (fromCookie && UUID_RE.test(fromCookie)) return fromCookie;

        const orgs = asArray(await apiGet('/api/organizations'));
        if (orgs[0]?.uuid) return orgs[0].uuid;
        throw new Error('Could not determine organization id');
    }

    async function getProjectId(orgId, projectTitle) {
        const urlMatch = location.pathname.match(/\/project\/([0-9a-f-]{36})/i);
        if (urlMatch) return urlMatch[1];

        // New UI may not keep the uuid in the URL - look it up by name
        const projects = asArray(await apiGet(`/api/organizations/${orgId}/projects`));
        const matches = projects.filter(p => (p.name || '').trim() === projectTitle);
        if (matches.length === 1) return matches[0].uuid;
        if (matches.length > 1) {
            throw new Error(`Several projects are named "${projectTitle}"; open the project via its /project/<id> URL`);
        }
        throw new Error(`No project named "${projectTitle}" found via API`);
    }

    async function fetchBinary(url) {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!blob.size || /text\/html|application\/json/i.test(blob.type)) {
            throw new Error(`Unexpected response type "${blob.type}"`);
        }
        return blob;
    }

    function binaryCandidates(orgId, file) {
        const uuid = file.file_uuid || file.uuid;
        const name = file.file_name || '';
        const urls = [];
        for (const asset of [file.document_asset, file.preview_asset]) {
            if (asset?.url) urls.push(asset.url);
        }
        if (file.preview_url) urls.push(file.preview_url);
        if (uuid && /\.pdf$/i.test(name)) {
            urls.push(`/api/${orgId}/files/${uuid}/document_pdf`);
        }
        return [...new Set(urls)];
    }

    async function exportViaApi(projectTitle, updateStatus) {
        updateStatus('Reading project via API...');
        const orgId = await getOrgId();
        const projectId = await getProjectId(orgId, projectTitle);
        const base = `/api/organizations/${orgId}/projects/${projectId}`;
        log.info(`API: org=${orgId} project=${projectId}`);

        let docs = [];
        let files = [];
        try {
            docs = asArray(await apiGet(`${base}/docs`));
        } catch (e) {
            log.warn(`docs endpoint failed: ${e.message}`);
        }
        try {
            files = asArray(await apiGet(`${base}/files`));
        } catch (e) {
            log.warn(`files endpoint failed: ${e.message}`);
        }

        if (docs.length === 0 && files.length === 0) {
            throw new Error('API returned no project files');
        }
        log.info(`API: ${docs.length} docs, ${files.length} files`);

        // Merge both lists by filename: binary originals win, extracted
        // text is kept as a fallback.
        const byName = new Map();
        const keyOf = n => collapseDuplicateExtensions((n || '').trim().toLowerCase());

        for (const d of docs) {
            const key = keyOf(d.file_name);
            byName.set(key, { name: d.file_name, text: d.content ?? null, file: null });
        }
        for (const f of files) {
            const key = keyOf(f.file_name);
            const existing = byName.get(key);
            if (existing) {
                existing.file = f;
            } else {
                byName.set(key, { name: f.file_name, text: null, file: f });
            }
        }

        const usedNames = new Set();
        const results = [];
        const entries = [...byName.values()];

        for (let i = 0; i < entries.length; i++) {
            const { name, text, file } = entries[i];
            updateStatus(`API ${i + 1}/${entries.length}: ${name}`);
            const type = getExtension(name || '') || 'txt';

            const metadata = {
                originalDomFilename: name,
                normalizedFilename: null,
                detectedType: type,
                sourceUrl: null,
                exportMethod: null,
                status: 'pending',
                error: null,
                lineCount: null
            };

            let content = null;
            let textOnly = false;

            // Binary original first for binary types
            if (file && isBinaryName(normalizeFilename(name))) {
                for (const url of binaryCandidates(orgId, file)) {
                    try {
                        content = await fetchBinary(url);
                        metadata.sourceUrl = url;
                        metadata.exportMethod = 'api_binary';
                        break;
                    } catch (e) {
                        log.debug(`binary candidate failed for "${name}": ${url} (${e.message})`);
                    }
                }
            }

            if (content === null && typeof text === 'string' && text.length > 0) {
                content = text;
                textOnly = true;
                metadata.exportMethod = isBinaryName(normalizeFilename(name)) ? 'api_extracted_text' : 'api_text';
                metadata.lineCount = `${text.split('\n').length} lines`;
            }

            const filename = buildOutputName(name, type, textOnly, usedNames);
            metadata.normalizedFilename = filename;

            if (content !== null) {
                metadata.status = 'success';
                log.file(name, filename, type, metadata.exportMethod, 'success');
            } else {
                metadata.status = 'unexportable';
                metadata.exportMethod = 'unexportable';
                metadata.error = 'No downloadable original and no extracted text returned by API';
                log.file(name, filename, type, 'api', 'failed');
            }

            results.push({ metadata, content, filename });
        }

        return results;
    }

    // ============================================================
    // STRATEGY 2: DOM (new Files dialog)
    // ============================================================

    function getDialogs() {
        return [...document.querySelectorAll('[role="dialog"]')].filter(d => d.offsetHeight > 0);
    }

    function findFilesDialog() {
        return getDialogs().find(d =>
            d.querySelector('[class*="group/frow"]') ||
            d.querySelector('[data-testid="project-doc-upload"]')
        ) || null;
    }

    async function openFilesDialog() {
        const open = findFilesDialog();
        if (open) return open;

        const btn = document.querySelector('button[aria-label="Show files"]') ||
            [...document.querySelectorAll('[data-project-page] button[aria-label]')]
                .find(b => /\bfiles\b/i.test(b.getAttribute('aria-label')));
        if (!btn) throw new Error('"Files" button not found on project page');

        btn.click();
        const dialog = await waitFor(findFilesDialog, CONFIG.DIALOG_WAIT_MS);
        if (!dialog) throw new Error('Files dialog did not open');
        await sleep(300);
        return dialog;
    }

    function getRowButton(row) {
        return [...row.children].find(el =>
            el.tagName === 'BUTTON' &&
            el.hasAttribute('aria-label') &&
            !/^More options/i.test(el.getAttribute('aria-label'))
        ) || null;
    }

    function readRow(row) {
        const btn = getRowButton(row);
        if (!btn) return null;
        const filename = btn.getAttribute('aria-label').trim();
        const caption = row.querySelector('.text-caption')?.textContent || '';
        const parts = caption.split('·').map(s => s.trim()).filter(Boolean);
        const badge = (parts[0] || '').toLowerCase();
        const type = /^[a-z0-9]{1,5}$/.test(badge) ? badge : (getExtension(filename) || 'txt');
        const lineCount = parts.find(p => /\b(lines?|pages?)\b/i.test(p)) || null;
        return { domFilename: filename, type, isPdf: type === 'pdf' || /\.pdf$/i.test(filename), lineCount };
    }

    async function discoverFilesInDialog(dialog, updateStatus) {
        updateStatus('Scanning Files dialog...');
        const scroller = [...dialog.querySelectorAll('.overflow-y-auto')]
            .find(el => el.querySelector('[class*="group/frow"]')) || dialog;

        let lastCount = -1;
        let stable = 0;
        for (let i = 0; i < CONFIG.MAX_SCROLL_ATTEMPTS && stable < 3; i++) {
            scroller.scrollTop = scroller.scrollHeight;
            await sleep(CONFIG.SCROLL_WAIT_MS);
            const count = dialog.querySelectorAll('[class*="group/frow"]').length;
            log.debug(`Scroll ${i + 1}: ${count} rows`);
            stable = count === lastCount ? stable + 1 : 0;
            lastCount = count;
        }
        scroller.scrollTop = 0;

        const files = [...dialog.querySelectorAll('[class*="group/frow"]')]
            .map(readRow)
            .filter(Boolean);
        log.success(`Discovered ${files.length} files in dialog`);
        return files;
    }

    function findRowButton(dialog, filename) {
        return [...dialog.querySelectorAll('[class*="group/frow"]')]
            .map(getRowButton)
            .find(b => b && b.getAttribute('aria-label').trim() === filename) || null;
    }

    function extractTextContent(root) {
        const contentSelectors = [
            'pre code',
            'pre',
            '.whitespace-pre-wrap',
            '.font-mono',
            '[class*="prose"]',
            '.overflow-auto pre'
        ];

        for (const selector of contentSelectors) {
            const el = root.querySelector(selector);
            if (el && el.textContent.trim().length > CONFIG.MIN_CONTENT_LENGTH) {
                return el.innerText || el.textContent;
            }
        }

        const allText = root.innerText || root.textContent || '';
        return allText.split('\n')
            .map(l => l.trimEnd())
            .filter(l => !/^(Close|Download|Export|PDF|Select|Cancel|OK|\d+\s*lines?|View|Edit|pages?|Search files|Add|Files)$/i.test(l.trim()))
            .join('\n')
            .trim();
    }

    function extractDownloadUrl(root) {
        const link = root.querySelector('a[href*="/document_pdf"]') ||
            root.querySelector('a[href*="/api/"][href*="/files/"]') ||
            root.querySelector('a[download][href]');
        return link ? link.href : null;
    }

    function findCloseButton(dialog) {
        return dialog.querySelector('button[aria-label="Close"]') ||
            dialog.querySelector('button[aria-label*="close" i]') ||
            dialog.querySelector('button[aria-label*="back" i]');
    }

    async function closeDialog(dialog) {
        const btn = findCloseButton(dialog);
        if (btn) {
            btn.click();
        } else {
            const target = document.activeElement || document.body;
            target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        }
        await waitFor(() => !dialog.isConnected || dialog.offsetHeight === 0, 1500);
    }

    /**
     * Open a file row and scrape its preview. The preview may appear as a
     * nested dialog or replace the Files dialog content; both are handled.
     */
    async function exportFileViaDom(fileInfo, usedNames, updateStatus) {
        const { domFilename, type, isPdf, lineCount } = fileInfo;

        const metadata = {
            originalDomFilename: domFilename,
            normalizedFilename: null,
            detectedType: type,
            sourceUrl: null,
            exportMethod: null,
            status: 'pending',
            error: null,
            lineCount
        };

        let content = null;
        let textOnly = false;

        try {
            const filesDialog = await openFilesDialog();
            const btn = findRowButton(filesDialog, domFilename);
            if (!btn) throw new Error('Row not found in Files dialog');

            const dialogsBefore = new Set(getDialogs());
            btn.scrollIntoView({ block: 'center' });
            btn.click();

            const preview = await waitFor(() => {
                const fresh = getDialogs().find(d => !dialogsBefore.has(d));
                if (fresh) return fresh;
                // In-place swap: the rows disappeared from the Files dialog
                if (filesDialog.isConnected && !filesDialog.querySelector('[class*="group/frow"]')) return filesDialog;
                return null;
            }, CONFIG.PREVIEW_WAIT_MS);

            if (!preview) throw new Error('File preview did not open');
            await sleep(CONFIG.PREVIEW_CONTENT_WAIT_MS);

            const url = extractDownloadUrl(preview);
            if (url) {
                try {
                    content = await fetchBinary(url);
                    metadata.sourceUrl = url;
                    metadata.exportMethod = 'dom_download_url';
                } catch (e) {
                    log.debug(`download link failed for "${domFilename}": ${e.message}`);
                }
            }

            if (content === null) {
                const text = extractTextContent(preview);
                if (text && text.length > CONFIG.MIN_CONTENT_LENGTH) {
                    content = text;
                    textOnly = true;
                    metadata.exportMethod = 'dom_text_scrape';
                } else {
                    throw new Error(`Content too short (${text?.length || 0} chars)`);
                }
            }

            metadata.status = 'success';
            await closeDialog(preview);
        } catch (error) {
            metadata.status = 'failed';
            metadata.error = error.message;
            metadata.exportMethod = metadata.exportMethod || 'failed';
            log.error(`Failed to export "${domFilename}": ${error.message}`);
            // Close anything that is not the Files dialog
            const files = findFilesDialog();
            for (const d of getDialogs().reverse()) {
                if (d !== files) await closeDialog(d);
            }
        }

        const filename = buildOutputName(domFilename, type, textOnly || (isPdf && !(content instanceof Blob)), usedNames);
        metadata.normalizedFilename = filename;
        log.file(domFilename, filename, type, metadata.exportMethod, metadata.status);

        await sleep(CONFIG.BETWEEN_FILES_MS);
        return { metadata, content, filename };
    }

    async function exportViaDom(updateStatus) {
        const dialog = await openFilesDialog();
        const files = await discoverFilesInDialog(dialog, updateStatus);
        if (files.length === 0) return [];

        const usedNames = new Set();
        const results = [];
        for (let i = 0; i < files.length; i++) {
            updateStatus(`DOM ${i + 1}/${files.length}: ${files[i].domFilename}`);
            results.push(await exportFileViaDom(files[i], usedNames, updateStatus));
        }

        const filesDialog = findFilesDialog();
        if (filesDialog) await closeDialog(filesDialog);
        return results;
    }

    // ============================================================
    // ZIP CREATION
    // ============================================================

    async function createAndDownloadZip(exportedFiles, projectName, strategy, updateStatus) {
        log.info('Creating ZIP archive...');
        updateStatus('Creating ZIP...');

        const zip = new JSZip();
        const allMetadata = [];

        let successCount = 0;
        let failedCount = 0;
        let unexportableCount = 0;
        let binaryCount = 0;
        let extractedTextCount = 0;

        for (const { metadata, content, filename } of exportedFiles) {
            allMetadata.push(metadata);

            if (content !== null) {
                zip.file(filename, content);
                if (content instanceof Blob) binaryCount++;
                if (/extracted_text/.test(metadata.exportMethod || '')) extractedTextCount++;
                successCount++;
            } else if (metadata.status === 'unexportable') {
                unexportableCount++;
            } else {
                failedCount++;
            }
        }

        const metadataJson = {
            exportDate: new Date().toISOString(),
            projectTitle: projectName,
            url: location.href,
            exporterVersion: VERSION,
            strategy,
            summary: {
                total: exportedFiles.length,
                exported: successCount,
                failed: failedCount,
                unexportable: unexportableCount,
                binaryOriginals: binaryCount,
                extractedTextOnly: extractedTextCount
            },
            files: allMetadata
        };

        zip.file('_export_metadata.json', JSON.stringify(metadataJson, null, 2));

        const zipBlob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
        const safeName = projectName.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'Claude_Project';
        const zipFilename = `${safeName}_export_${timestamp}.zip`;

        const url = URL.createObjectURL(zipBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = zipFilename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        log.success('='.repeat(50));
        log.success(`EXPORT COMPLETE (${strategy})`);
        log.success('='.repeat(50));
        log.info(`Total files:        ${exportedFiles.length}`);
        log.info(`Exported:           ${successCount}`);
        log.info(`Failed:             ${failedCount}`);
        log.info(`Unexportable:       ${unexportableCount}`);
        log.info(`Binary originals:   ${binaryCount}`);
        log.info(`Extracted text only:${extractedTextCount}`);
        log.success('='.repeat(50));

        return { zipFilename, ...metadataJson.summary };
    }

    // ============================================================
    // MAIN EXPORT FUNCTION
    // ============================================================

    let running = false;

    async function exportProject() {
        if (running) return;
        running = true;

        const button = document.querySelector('#claude-export-btn');
        const updateStatus = (msg) => {
            if (button) button.textContent = `🔄 ${msg}`;
            log.info(msg);
        };
        const resetLater = (ms) => setTimeout(() => {
            if (button) button.textContent = '📁 Export Project Files';
        }, ms);

        try {
            ensureJSZip();

            if (!isProjectPage()) {
                updateStatus('Open a project page first');
                resetLater(3000);
                return;
            }

            const projectName = getProjectTitle();
            let results = null;
            let strategy = 'api';

            try {
                results = await exportViaApi(projectName, updateStatus);
            } catch (e) {
                log.warn(`API export unavailable (${e.message}) - falling back to DOM scraping`);
            }

            if (!results || results.length === 0 || results.every(r => r.content === null)) {
                strategy = 'dom';
                results = await exportViaDom(updateStatus);
            }

            if (!results || results.length === 0) {
                updateStatus('No files found!');
                log.error('No files found in project');
                resetLater(3000);
                return;
            }

            const summary = await createAndDownloadZip(results, projectName, strategy, updateStatus);
            updateStatus(`✅ Exported ${summary.exported}/${summary.total} files`);
            resetLater(5000);
        } catch (error) {
            log.error('Export failed:', error);
            updateStatus('❌ Export failed');
            resetLater(3000);
        } finally {
            running = false;
        }
    }

    // ============================================================
    // UI BUTTON
    // ============================================================

    function addExportButton() {
        if (document.querySelector('#claude-export-btn')) return;

        const button = document.createElement('button');
        button.id = 'claude-export-btn';
        button.type = 'button';
        button.textContent = '📁 Export Project Files';
        button.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 12px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            z-index: 10000;
            font-size: 14px;
            font-weight: 600;
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            transition: all 0.3s ease;
            min-width: 200px;
            max-width: 360px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-align: center;
        `;

        button.addEventListener('mouseenter', () => {
            button.style.transform = 'translateY(-2px)';
            button.style.boxShadow = '0 6px 20px rgba(0,0,0,0.3)';
        });
        button.addEventListener('mouseleave', () => {
            button.style.transform = 'translateY(0)';
            button.style.boxShadow = '0 4px 15px rgba(0,0,0,0.2)';
        });

        button.addEventListener('click', exportProject);
        document.body.appendChild(button);
        log.success('Export button added');
    }

    function syncButton() {
        if (!document.body) return;
        addExportButton();
        const button = document.querySelector('#claude-export-btn');
        // Only show on project pages (keep visible while an export runs)
        button.style.display = (isProjectPage() || running) ? '' : 'none';
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    function init() {
        log.info(`Claude Project Files Exporter v${VERSION} initialized`);
        // The SPA re-renders constantly; a cheap poll is lighter than a
        // subtree MutationObserver on claude.ai.
        setInterval(syncButton, 1000);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', syncButton);
        } else {
            syncButton();
        }
    }

    init();

})();
