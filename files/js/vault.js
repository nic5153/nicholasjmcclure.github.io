/*
 * NightVector Data Vault: stage observing sessions or calibration libraries
 * locally (FITS headers are read in the browser), upload them to Cloudflare R2
 * through the observing-vault Worker, and browse / download stored folders.
 * The upload and download logic is unchanged from the original NightVector page.
 */
(function () {
    'use strict';

    const DEFAULT_WORKER_URL = 'https://observing-vault.nic5153mcclure.workers.dev';

    const state = {
        files: [],
        cloudObjects: [],
        cloudListedPrefix: null,
        cloudDirectoryObjects: null,
        cloudListRequest: 0
    };

    const byId = id => document.getElementById(id);
    const els = {
        cloudEndpoint: byId('cloud-endpoint'),
        uploadToken: byId('upload-token'),
        cloudPrefix: byId('cloud-prefix'),
        vaultTargetName: byId('vault-target-name'),
        sessionDate: byId('session-date'),
        vaultCollection: byId('vault-collection'),
        cloudInventoryList: byId('cloud-inventory-list'),
        cloudInventoryStatus: byId('cloud-inventory-status'),
        downloadProgressBar: byId('download-progress-bar'),
        vaultCount: byId('vault-count'),
        vaultSize: byId('vault-size'),
        vaultStatus: byId('vault-status'),
        vaultGroups: byId('vault-groups'),
        calibrationSummary: byId('calibration-summary'),
        calibrationSummaryText: byId('calibration-summary-text'),
        cloudStatus: byId('cloud-status'),
        frameKind: byId('frame-kind'),
        directoryInput: byId('directory-input'),
        fitsDropZone: byId('fits-drop-zone'),
        uploadProgressBar: byId('upload-progress-bar'),
        uploadDetail: byId('upload-detail'),
        uploadMode: byId('upload-mode'),
        uploadConcurrency: byId('upload-concurrency')
    };

    /** Rig description for upload keys and manifests, from the shared planner settings. */
    function selectedRig() {
        const rig = window.NVSettings.load().rig;
        return {
            name: rig.name,
            telescope: rig.preset && rig.preset.startsWith('c8') ? 'Celestron C8' : rig.name,
            camera: rig.camera || 'Camera',
            filters: 'LRGB',
            aperture: rig.aperture,
            nativeFocalLength: rig.focalLength,
            reducer: rig.reducer || 1,
            pixelSize: rig.pixelSize,
            guideFocalLength: 120
        };
    }

    els.cloudEndpoint.value = localStorage.getItem('observingCloudEndpoint') || DEFAULT_WORKER_URL;
    els.vaultCollection.value = localStorage.getItem('observingVaultCollection') || 'session';
    els.uploadMode.value = localStorage.getItem('observingUploadMode') || 'auto';
    els.uploadConcurrency.value = localStorage.getItem('observingUploadConcurrency') || '12';
    els.vaultTargetName.value = localStorage.getItem('observingVaultTargetName') || '';
    els.cloudPrefix.value = localStorage.getItem('observingCloudPrefix') || '';
    els.sessionDate.value = new Date(Date.now() - 12 * 3600000).toISOString().slice(0, 10);

    function downloadFile(filename, text, type) {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function saveBlob(filename, blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    function cloudEndpoint() {
        return els.cloudEndpoint.value.trim().replace(/\/$/, '');
    }

    function cloudToken() {
        return els.uploadToken.value.trim();
    }

    function cleanCloudSegment(value, fallback = 'unknown') {
        return String(value || fallback)
            .trim()
            .replace(/[^a-z0-9._ -]/gi, '')
            .replace(/\s+/g, '_')
            .slice(0, 80) || fallback;
    }

    function cloudBatchId() {
        return `batch-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
    }

    function cloudPrefixForItem(item) {
        const date = cleanCloudSegment(item.sessionDate, new Date().toISOString().slice(0, 10));
        const batch = cleanCloudSegment(item.batch, 'batch');
        return item.collection === 'calibration'
            ? `calibration/${cleanCloudSegment(selectedRig().name, 'unknown-rig')}/${date}/${batch}`
            : `observations/${date}/${cleanCloudSegment(item.target, 'unknown-target')}/${batch}`;
    }

    function setCloudPrefix(prefix) {
        els.cloudPrefix.value = prefix;
        localStorage.setItem('observingCloudPrefix', prefix);
    }

    function defaultCloudPrefix() {
        const target = els.vaultTargetName.value.trim();
        const date = els.sessionDate.value || new Date().toISOString().slice(0, 10);
        return els.vaultCollection.value === 'calibration'
            ? `calibration/${cleanCloudSegment(selectedRig().name, 'unknown-rig')}`
            : target
                ? `observations/${cleanCloudSegment(date)}/${cleanCloudSegment(target)}`
                : `observations/${cleanCloudSegment(date)}`;
    }

    function selectCloudDirectory(prefix) {
        // Invalidate an older request so it cannot replace this selection.
        state.cloudListRequest += 1;
        setCloudPrefix(prefix);
        state.cloudListedPrefix = prefix;
        state.cloudObjects = state.cloudDirectoryObjects.filter(object => object.key.startsWith(prefix) && !object.key.endsWith('/'));
        renderCloudInventory();
        renderCloudDirectories();
    }

    function renderCloudDirectories() {
        const container = document.getElementById('cloud-directory-tree');
        container.replaceChildren();
        if (state.cloudDirectoryObjects === null) return;
        const root = { name: 'Bucket root', prefix: '', count: 0, children: new Map() };
        for (const object of state.cloudDirectoryObjects) {
            const parts = object.key.split('/');
            const isFile = !object.key.endsWith('/');
            let node = root;
            if (isFile) node.count += 1;
            for (const part of parts.slice(0, -1)) {
                const prefix = node.prefix + part + '/';
                if (!node.children.has(part)) node.children.set(part, { name: part, prefix, count: 0, children: new Map() });
                node = node.children.get(part);
                if (isFile) node.count += 1;
            }
        }
        const folderButton = node => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'rounded px-2 py-1 text-left mono text-xs break-all ' + (state.cloudListedPrefix === node.prefix ? 'neon-button' : 'ghost-button');
            button.textContent = `📁 ${node.name} (${node.count} files)`;
            button.title = node.prefix || 'Bucket root';
            button.setAttribute('aria-pressed', String(state.cloudListedPrefix === node.prefix));
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                selectCloudDirectory(node.prefix);
            });
            return button;
        };
        container.appendChild(folderButton(root));
        const appendChildren = (node, parent) => {
            for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
                const details = document.createElement('details');
                details.className = 'ml-3 mt-2 border-l border-cyan-300/20 pl-2';
                details.open = Boolean(state.cloudListedPrefix && state.cloudListedPrefix.startsWith(child.prefix));
                const summary = document.createElement('summary');
                summary.className = 'cursor-pointer text-cyan-100';
                summary.appendChild(folderButton(child));
                details.appendChild(summary);
                appendChildren(child, details);
                parent.appendChild(details);
            }
        };
        appendChildren(root, container);
        if (!root.children.size) {
            const message = document.createElement('p');
            message.className = 'mt-2 text-xs text-slate-400';
            message.textContent = 'No subfolders found. Files stored at the bucket root appear below.';
            container.appendChild(message);
        }
    }


    function renderCloudInventory() {
        document.getElementById('cloud-selected-folder').textContent = state.cloudListedPrefix === null
            ? 'Selected folder: none'
            : 'Selected folder: ' + (state.cloudListedPrefix || 'Bucket root');
        els.cloudInventoryList.innerHTML = '';
        if (!state.cloudObjects.length) {
            els.cloudInventoryStatus.textContent = 'Cloud inventory is empty for that prefix.';
            return;
        }
        const total = state.cloudObjects.reduce((sum, object) => sum + object.size, 0);
        els.cloudInventoryStatus.textContent = `${state.cloudObjects.length} object${state.cloudObjects.length === 1 ? '' : 's'} / ${formatBytes(total)} listed.`;
        state.cloudObjects.forEach(object => {
            const row = document.createElement('div');
            row.className = 'rounded-md border border-slate-500/20 bg-slate-950/40 p-2';
            row.innerHTML = `
                <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                        <p class="truncate mono text-[11px] text-cyan-100">${object.key}</p>
                        <p class="mono mt-1 text-[10px] text-slate-500">${formatBytes(object.size)} / ${object.uploaded ? new Date(object.uploaded).toLocaleString() : 'uploaded'}</p>
                    </div>
                    <button class="ghost-button shrink-0 rounded px-2 py-1 mono text-[10px] font-bold" data-key="${encodeURIComponent(object.key)}">Download</button>
                </div>
            `;
            row.querySelector('button').addEventListener('click', () => downloadCloudObject(object));
            els.cloudInventoryList.appendChild(row);
        });
    }

    async function listCloudObjects(requestedPrefix) {
        const endpoint = cloudEndpoint();
        const token = cloudToken();
        if (!endpoint || !token) {
            els.cloudInventoryStatus.textContent = 'Cloud: enter endpoint and upload token first.';
            return;
        }
        const prefix = typeof requestedPrefix === 'string' ? requestedPrefix : (els.cloudPrefix.value.trim() || defaultCloudPrefix());
        const requestId = ++state.cloudListRequest;
        state.cloudObjects = [];
        state.cloudListedPrefix = null;
        renderCloudInventory();
        if (prefix === '') {
            state.cloudDirectoryObjects = null;
            renderCloudDirectories();
        }
        els.cloudPrefix.value = prefix;
        localStorage.setItem('observingCloudPrefix', prefix);
        els.cloudInventoryStatus.textContent = `Cloud: listing ${prefix || 'bucket root'}...`;
        const objects = [];
        let cursor = '';
        let page = 0;
        do {
            const params = new URLSearchParams({ prefix });
            if (cursor) params.set('cursor', cursor);
            const response = await fetch(`${endpoint}/list?${params.toString()}`, {
                headers: { authorization: `Bearer ${token}` }
            }).catch(() => null);
            if (requestId !== state.cloudListRequest) return;
            if (!response) {
                els.cloudInventoryStatus.textContent = 'Cloud: list request blocked or unreachable.';
                return;
            }
            const result = await response.json().catch(() => ({}));
            if (requestId !== state.cloudListRequest) return;
            if (!response.ok || !result.ok || !Array.isArray(result.objects)) {
                els.cloudInventoryStatus.textContent = `Cloud: list failed. ${result.error || response.status}`;
                return;
            }
            objects.push(...result.objects);
            if (result.truncated && !result.cursor) {
                els.cloudInventoryStatus.textContent = 'Cloud: incomplete listing. Refresh and try again.';
                return;
            }
            page += 1;
            cursor = result.truncated && result.cursor ? result.cursor : '';
            els.cloudInventoryStatus.textContent = `Cloud: listed ${objects.length} object${objects.length === 1 ? '' : 's'} across ${page} page${page === 1 ? '' : 's'}...`;
        } while (cursor);
        state.cloudListedPrefix = prefix;
        state.cloudObjects = objects.filter(object => !object.key.endsWith('/'));
        if (prefix === '') state.cloudDirectoryObjects = objects;
        renderCloudInventory();
        renderCloudDirectories();
    }

    async function downloadCloudObject(object) {
        const endpoint = cloudEndpoint();
        const token = cloudToken();
        if (!endpoint || !token) {
            els.cloudInventoryStatus.textContent = 'Cloud: enter endpoint and upload token first.';
            return false;
        }
        els.cloudInventoryStatus.textContent = `Cloud: downloading ${object.key}`;
        const params = new URLSearchParams({ key: object.key });
        const response = await fetch(`${endpoint}/download?${params.toString()}`, {
            headers: { authorization: `Bearer ${token}` }
        }).catch(() => null);
        if (!response || !response.ok) {
            els.cloudInventoryStatus.textContent = `Cloud: download failed for ${object.key}`;
            return false;
        }
        const blob = await response.blob();
        saveBlob(object.key.split('/').pop() || 'download', blob);
        return true;
    }

    async function downloadListedZip() {
        const objects = [...state.cloudObjects];
        if (!objects.length) {
            els.cloudInventoryStatus.textContent = 'Cloud: list a folder before downloading it.';
            return;
        }
        const endpoint = cloudEndpoint();
        const token = cloudToken();
        if (!endpoint || !token) {
            els.cloudInventoryStatus.textContent = 'Cloud: enter endpoint and upload token first.';
            return;
        }
        if (!window.zip) {
            els.cloudInventoryStatus.textContent = 'Cloud: ZIP library unavailable. Reload the page and try again.';
            return;
        }
        const prefix = state.cloudListedPrefix ?? (els.cloudPrefix.value.trim() || defaultCloudPrefix());
        const filename = (prefix.replace(/\/+$/, '').split('/').pop() || 'cloud-files') + '.zip';
        const buttons = ['download-cloud-listed', 'download-cloud-zip'].map(id => document.getElementById(id));
        if (buttons.some(button => button.disabled)) return;
        buttons.forEach(button => { button.disabled = true; });
        let writable;
        let currentKey = '';
        try {
            let file;
            if (typeof window.showSaveFilePicker === 'function') {
                try {
                    // Keep the picker within the original click's user activation.
                    file = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }]
                    });
                } catch (error) {
                    if (error.name === 'AbortError') {
                        els.cloudInventoryStatus.textContent = 'Cloud: ZIP download cancelled.';
                        return;
                    }
                    throw error;
                }
            }
            const entries = objects.map(object => {
                if (!object.key.startsWith(prefix)) {
                    throw new Error('Object is outside the selected prefix. List the folder again.');
                }
                const path = object.key.slice(prefix.length).replace(/^\//, '');
                if (path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
                    throw new Error('Object has an unsupported ZIP path.');
                }
                return { object, path };
            });
            writable = file ? await file.createWritable() : null;
            // Store entries without compression to avoid spending CPU on large FITS files.
            // zip.js supports streaming and ZIP64 for archives over 4 GiB.
            const writer = new window.zip.ZipWriter(writable || new window.zip.BlobWriter('application/zip'), {
                level: 0, bufferedWrite: false, useWebWorkers: false
            });
            els.downloadProgressBar.style.width = '0%';
            for (let index = 0; index < entries.length; index += 1) {
                const { object, path } = entries[index];
                currentKey = object.key;
                els.cloudInventoryStatus.textContent = `Cloud: adding ${currentKey} to ZIP (${index + 1}/${entries.length})`;
                const params = new URLSearchParams({ key: currentKey });
                const response = await fetch(`${endpoint}/download?${params.toString()}`, {
                    headers: { authorization: `Bearer ${token}` }
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                await writer.add(path, response.body || new window.zip.BlobReader(await response.blob()));
                els.downloadProgressBar.style.width = `${Math.round(((index + 1) / entries.length) * 100)}%`;
            }
            els.cloudInventoryStatus.textContent = `Cloud: finishing ZIP (${entries.length}/${entries.length})...`;
            const archive = await writer.close();
            if (!file) saveBlob(filename, archive);
            els.cloudInventoryStatus.textContent = file
                ? `Saved ${entries.length} listed files to ${filename}.`
                : `ZIP ready: ${filename} (${entries.length} files). One browser download started.`;
        } catch (error) {
            if (writable) await writable.abort().catch(() => {});
            els.cloudInventoryStatus.textContent = `Cloud: ZIP download failed${currentKey ? ' for ' + currentKey : ''}. ${error.message}`;
        } finally {
            buttons.forEach(button => { button.disabled = false; });
        }
    }


    async function downloadListedObjects() {
        if (typeof window.showDirectoryPicker !== 'function') {
            return downloadListedZip();
        }

        const objects = [...state.cloudObjects];
        if (!objects.length) {
            els.cloudInventoryStatus.textContent = 'Cloud: list a folder before downloading it.';
            return;
        }
        const endpoint = cloudEndpoint();
        const token = cloudToken();
        if (!endpoint || !token) {
            els.cloudInventoryStatus.textContent = 'Cloud: enter endpoint and upload token first.';
            return;
        }
        const prefix = state.cloudListedPrefix ?? (els.cloudPrefix.value.trim() || defaultCloudPrefix());
        let directory;
        try {
            // Open the picker before any network awaits to retain user activation.
            directory = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (error) {
            els.cloudInventoryStatus.textContent = error.name === 'AbortError'
                ? 'Cloud: folder download cancelled.'
                : `Cloud: could not open the destination folder. ${error.message}`;
            return;
        }

        els.downloadProgressBar.style.width = '0%';
        for (let index = 0; index < objects.length; index += 1) {
            const object = objects[index];
            els.cloudInventoryStatus.textContent = `Cloud: downloading ${object.key} (${index + 1}/${objects.length})`;
            let writable;
            try {
                if (!object.key.startsWith(prefix)) {
                    throw new Error('Object is outside the selected prefix. List the folder again.');
                }
                const relativePath = object.key.slice(prefix.length).replace(/^\//, '');
                const parts = relativePath.split('/');
                if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
                    throw new Error('Object has an unsupported local file path.');
                }
                const filename = parts.pop();
                let parent = directory;
                for (const part of parts) {
                    parent = await parent.getDirectoryHandle(part, { create: true });
                }
                const params = new URLSearchParams({ key: object.key });
                const response = await fetch(`${endpoint}/download?${params.toString()}`, {
                    headers: { authorization: `Bearer ${token}` }
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const file = await parent.getFileHandle(filename, { create: true });
                writable = await file.createWritable();
                if (response.body && typeof response.body.pipeTo === 'function') {
                    await response.body.pipeTo(writable);
                } else {
                    await writable.write(await response.blob());
                    await writable.close();
                }
                els.downloadProgressBar.style.width = `${Math.round(((index + 1) / objects.length) * 100)}%`;
                els.cloudInventoryStatus.textContent = `Cloud: downloaded ${object.key} (${index + 1}/${objects.length})`;
            } catch (error) {
                if (writable) {
                    await writable.abort().catch(() => {});
                }
                els.cloudInventoryStatus.textContent = `Cloud: download failed for ${object.key} (${index + 1}/${objects.length}). ${error.message}`;
                return;
            }
        }
        els.cloudInventoryStatus.textContent = `Downloaded ${objects.length}/${objects.length} listed object${objects.length === 1 ? '' : 's'} to disk.`;
    }

    function formatBytes(bytes) {
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    function calibrationValue(value, suffix = '') {
        return value === null || value === undefined || value === '' ? '?' : `${value}${suffix}`;
    }

    function calibrationSettingsLabel(file) {
        const meta = file.calibration || {};
        return [
            `gain ${calibrationValue(meta.gain)}`,
            `offset ${calibrationValue(meta.offset)}`,
            `temp ${calibrationValue(meta.temperature, 'C')}`,
            `exp ${calibrationValue(meta.exposure, 's')}`,
            `bin ${calibrationValue(meta.binning)}`,
            `filter ${calibrationValue(meta.filter)}`
        ].join(' / ');
    }

    function renderVault() {
        const total = state.files.reduce((sum, file) => sum + file.size, 0);
        const groups = state.files.reduce((acc, file) => {
            const label = file.collection === 'calibration'
                ? `${file.kind} / ${file.sessionDate} / ${calibrationSettingsLabel(file)}`
                : file.kind;
            acc[label] = acc[label] || { count: 0, size: 0 };
            acc[label].count += 1;
            acc[label].size += file.size;
            return acc;
        }, {});
        els.vaultCount.textContent = String(state.files.length);
        els.vaultSize.textContent = formatBytes(total);
        els.vaultStatus.textContent = state.files.length
            ? `Local: ${state.files.length} file${state.files.length === 1 ? '' : 's'} staged, ${formatBytes(total)}.`
            : 'Local: no files staged.';
        els.vaultGroups.innerHTML = '';
        Object.entries(groups).forEach(([kind, group]) => {
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between rounded border border-slate-500/20 bg-slate-950/40 px-2 py-1 mono text-[11px]';
            row.innerHTML = `<span class="text-slate-300">${kind}</span><span class="text-cyan-200">${group.count} / ${formatBytes(group.size)}</span>`;
            els.vaultGroups.appendChild(row);
        });
        const calibrationFiles = state.files.filter(file => file.collection === 'calibration');
        els.calibrationSummary.classList.toggle('hidden', els.vaultCollection.value !== 'calibration' && !calibrationFiles.length);
        if (calibrationFiles.length) {
            const parsed = calibrationFiles.filter(file => file.calibration?.headerParsed).length;
            const distinct = new Set(calibrationFiles.map(file => `${file.kind}/${file.sessionDate}/${calibrationSettingsLabel(file)}`)).size;
            els.calibrationSummaryText.textContent = `${parsed}/${calibrationFiles.length} FITS headers parsed locally / ${distinct} distinct calibration set${distinct === 1 ? '' : 's'}. Missing values remain marked ?.`;
        } else {
            els.calibrationSummaryText.textContent = 'Choose Calibration library, then stage FITS files to read their headers locally.';
        }
        const uploaded = state.files.filter(file => file.remoteKey).length;
        if (state.files.length && uploaded === state.files.length) {
            els.cloudStatus.textContent = `Cloud: ${uploaded} file${uploaded === 1 ? '' : 's'} uploaded.`;
        }
    }

    function inferKind(file, fallback, relativePath = '') {
        const path = (relativePath || file.webkitRelativePath || file.name).toLowerCase();
        const tokens = path.split(/[^a-z0-9]+/).filter(Boolean);
        const hasToken = (...terms) => terms.some(term => tokens.includes(term));
        const defaultKind = fallback === 'Auto' ? 'Unknown' : fallback;
        const filter = hasToken('l', 'lum', 'luminance')
            ? 'L'
            : hasToken('r', 'red')
                ? 'R'
                : hasToken('g', 'green')
                    ? 'G'
                    : hasToken('b', 'blue')
                        ? 'B'
                        : '';
        if (hasToken('darkflat', 'darkflats') || hasToken('dark', 'darks') && hasToken('flat', 'flats')) return 'Dark Flats';
        if (hasToken('flat', 'flats')) {
            return filter ? `Flats ${filter}` : 'Flats';
        }
        if (hasToken('dark', 'darks')) return 'Darks';
        if (hasToken('bias', 'offset')) return 'Bias';
        if (hasToken('light', 'lights')) {
            return filter ? `Lights ${filter}` : 'Lights';
        }
        return defaultKind;
    }

    function fitsValue(raw) {
        const value = String(raw || '').trim();
        if (value.startsWith("'")) {
            const match = value.match(/^'((?:[^']|'')*)'/);
            return match ? match[1].replaceAll("''", "'").trim() : value.slice(1).trim();
        }
        const plain = value.split('/')[0].trim();
        if (plain === 'T') return true;
        if (plain === 'F') return false;
        const number = Number(plain);
        return plain && Number.isFinite(number) ? number : plain;
    }

    async function readFitsHeader(file) {
        if (!/\.(fits?|fts)$/i.test(file.name)) return null;
        const header = {};
        const maxBlocks = Math.min(Math.ceil(file.size / 2880), 64);
        for (let block = 0; block < maxBlocks; block += 1) {
            const text = await file.slice(block * 2880, (block + 1) * 2880).text();
            for (let index = 0; index + 80 <= text.length; index += 80) {
                const card = text.slice(index, index + 80);
                const keyword = card.slice(0, 8).trim();
                if (keyword === 'END') return Object.keys(header).length ? header : null;
                if (!keyword || card[8] !== '=') continue;
                header[keyword] = fitsValue(card.slice(10));
            }
        }
        return Object.keys(header).length ? header : null;
    }

    function firstFitsHeader(header, ...keywords) {
        return keywords.map(keyword => header?.[keyword]).find(value => value !== undefined && value !== null && value !== '');
    }

    function normalizeFitsFilter(value, fallback = '') {
        const filter = String(value || fallback || '').trim().toLowerCase();
        if (['l', 'lum', 'luminance', 'clear'].includes(filter)) return 'L';
        if (['r', 'red'].includes(filter)) return 'R';
        if (['g', 'green'].includes(filter)) return 'G';
        if (['b', 'blue'].includes(filter)) return 'B';
        return String(value || fallback || '').trim();
    }

    function filterFromKind(kind) {
        const match = String(kind || '').match(/\b([LRGB])$/);
        return match ? match[1] : '';
    }

    function calibrationKind(header, fallback) {
        const imageType = String(firstFitsHeader(header, 'IMAGETYP', 'FRAME', 'FRAMETYP') || '').toLowerCase();
        const filter = normalizeFitsFilter(firstFitsHeader(header, 'FILTER'), filterFromKind(fallback));
        if (imageType.includes('dark flat') || imageType.includes('darkflat') || fallback === 'Dark Flats') return 'Dark Flats';
        if (imageType.includes('flat') || fallback.startsWith('Flats')) return filter ? `Flats ${filter}` : 'Flats';
        if (imageType.includes('dark') || fallback === 'Darks') return 'Darks';
        if (imageType.includes('bias') || imageType.includes('offset') || fallback === 'Bias') return 'Bias';
        return fallback === 'Auto' ? 'Unknown' : fallback;
    }

    function calibrationMetadata(header, kind, sessionDate) {
        const binning = firstFitsHeader(header, 'BINNING')
            || [firstFitsHeader(header, 'XBINNING'), firstFitsHeader(header, 'YBINNING')].filter(Boolean).join('x');
        const dateObs = String(firstFitsHeader(header, 'DATE-OBS', 'DATE') || '');
        return {
            headerParsed: Boolean(header),
            date: /^\d{4}-\d{2}-\d{2}/.test(dateObs) ? dateObs.slice(0, 10) : sessionDate,
            temperature: firstFitsHeader(header, 'CCD-TEMP', 'CCD_TEMP', 'SET-TEMP', 'SET_TEMP', 'TEMP'),
            gain: firstFitsHeader(header, 'GAIN', 'EGAIN'),
            offset: firstFitsHeader(header, 'OFFSET', 'BLKLEVEL'),
            exposure: firstFitsHeader(header, 'EXPTIME', 'EXPOSURE'),
            binning: binning || '',
            filter: normalizeFitsFilter(firstFitsHeader(header, 'FILTER'), filterFromKind(kind)),
            camera: firstFitsHeader(header, 'INSTRUME', 'CAMERA') || selectedRig().camera,
            telescope: firstFitsHeader(header, 'TELESCOP') || selectedRig().telescope
        };
    }

    async function stageFiles(fileList) {
        const target = null;
        const typedTarget = els.vaultTargetName.value.trim();
        const sessionDate = els.sessionDate.value || new Date().toISOString().slice(0, 10);
        const collection = els.vaultCollection.value;
        const stagedTarget = typedTarget || (target ? target.name : '');
        const existing = state.files.find(item => item.file && !item.remoteKey);
        const changedObservation = existing
            && collection === 'session'
            && (existing.collection !== collection || existing.sessionDate !== sessionDate || existing.target !== stagedTarget);
        const changedCollection = existing && existing.collection !== collection;
        if (changedObservation || changedCollection) {
            els.vaultStatus.textContent = 'Local: finish uploading or clear the staged batch before switching collection, target, or observing date.';
            return;
        }
        const supported = /\.(fits?|fts|xisf|ser|avi|mp4|mov|mkv|jpe?g|png|tiff?|cr2|cr3|nef|arw|dng)$/i;
        const files = Array.from(fileList || [])
            .map(item => item.file ? item : { file: item, relativePath: item.webkitRelativePath || item.name })
            .filter(item => supported.test(item.file.name) || item.file.type.startsWith('image/') || item.file.type.startsWith('video/'));
        if (!files.length) {
            els.vaultStatus.textContent = 'Local: no supported image, video, FITS, XISF, SER, or RAW files found.';
            return;
        }
        els.vaultStatus.textContent = collection === 'calibration'
            ? `Local: reading FITS headers for ${files.length} staged file${files.length === 1 ? '' : 's'}...`
            : `Local: staging ${files.length} file${files.length === 1 ? '' : 's'}...`;
        const staged = await Promise.all(files.map(async ({ file, relativePath }) => {
            const header = collection === 'calibration' ? await readFitsHeader(file).catch(() => null) : null;
            const inferredKind = inferKind(file, els.frameKind.value, relativePath);
            const kind = collection === 'calibration' ? calibrationKind(header, inferredKind) : inferredKind;
            const calibration = collection === 'calibration' ? calibrationMetadata(header, kind, sessionDate) : null;
            return {
                file,
                relativePath,
                kind,
                calibration
            };
        }));
        staged.forEach(({ file, relativePath, kind, calibration }) => {
            state.files.push({
                name: file.name,
                size: file.size,
                kind,
                collection,
                calibration,
                target: stagedTarget,
                sessionDate: calibration?.date || sessionDate,
                lastModified: new Date(file.lastModified).toISOString(),
                relativePath: relativePath || file.webkitRelativePath || file.name,
                file
            });
        });
        els.vaultStatus.textContent = `Local: staged ${files.length} new file${files.length === 1 ? '' : 's'}.`;
        renderVault();
    }

    function fileFromEntry(entry, relativePath) {
        return new Promise((resolve, reject) => {
            entry.file(
                file => resolve({ file, relativePath: `${relativePath}${file.name}` }),
                reject
            );
        });
    }

    function readDirectoryEntries(reader) {
        return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    }

    async function filesFromEntry(entry, relativePath = '') {
        if (entry.isFile) return [await fileFromEntry(entry, relativePath)];
        if (!entry.isDirectory) return [];
        const directoryPath = `${relativePath}${entry.name}/`;
        const reader = entry.createReader();
        const entries = [];
        while (true) {
            const batch = await readDirectoryEntries(reader);
            if (!batch.length) break;
            entries.push(...batch);
        }
        const nested = await Promise.all(entries.map(item => filesFromEntry(item, directoryPath)));
        return nested.flat();
    }

    async function droppedFiles(dataTransfer) {
        const items = Array.from(dataTransfer.items || []);
        const entries = items
            .map(item => item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)
            .filter(Boolean);
        if (!entries.length) return Array.from(dataTransfer.files || []);
        const nested = await Promise.all(entries.map(entry => filesFromEntry(entry)));
        return nested.flat();
    }

    els.directoryInput.addEventListener('change', async event => {
        await stageFiles(event.target.files);
        els.directoryInput.value = '';
    });
    els.fitsDropZone.addEventListener('dragover', event => {
        event.preventDefault();
        els.fitsDropZone.classList.add('border-green-300/80');
    });
    els.fitsDropZone.addEventListener('dragleave', () => {
        els.fitsDropZone.classList.remove('border-green-300/80');
    });
    els.fitsDropZone.addEventListener('drop', async event => {
        event.preventDefault();
        els.fitsDropZone.classList.remove('border-green-300/80');
        els.vaultStatus.textContent = 'Local: reading dropped files and directories...';
        try {
            await stageFiles(await droppedFiles(event.dataTransfer));
        } catch {
            els.vaultStatus.textContent = 'Local: could not read the dropped directory. Use the directory picker instead.';
        }
    });
    document.getElementById('clear-files').addEventListener('click', () => {
        state.files = [];
        els.directoryInput.value = '';
        els.uploadProgressBar.style.width = '0%';
        els.uploadDetail.textContent = 'Upload queue idle.';
        els.cloudStatus.textContent = 'Cloud: staged queue cleared.';
        renderVault();
    });
    document.getElementById('download-manifest').addEventListener('click', () => {
        const target = null;
        const rig = selectedRig();
        const manifest = {
            createdAt: new Date().toISOString(),
            sessionDate: els.sessionDate.value || new Date().toISOString().slice(0, 10),
            selectedTarget: target ? target.name : null,
            equipment: {
                profile: rig.name,
                telescope: rig.telescope,
                reducer: rig.reducer,
                camera: rig.camera,
                filters: rig.filters,
                apertureMm: rig.aperture,
                focalLengthMm: rig.nativeFocalLength * rig.reducer,
                pixelSizeUm: rig.pixelSize,
                mount: 'Sky-Watcher Wave 100i with counterweight',
                guideScope: rig.guideFocalLength ? `${rig.guideFocalLength}mm guide scope` : 'not specified',
                guideCamera: 'not specified'
            },
            files: state.files.map(({ file, ...metadata }) => metadata)
        };
        downloadFile('observing-session-manifest.json', JSON.stringify(manifest, null, 2), 'application/json');
    });
    els.cloudEndpoint.addEventListener('change', () => {
        localStorage.setItem('observingCloudEndpoint', els.cloudEndpoint.value.trim());
    });
    els.vaultCollection.addEventListener('change', () => {
        localStorage.setItem('observingVaultCollection', els.vaultCollection.value);
        renderVault();
    });
    els.uploadMode.addEventListener('change', () => {
        localStorage.setItem('observingUploadMode', els.uploadMode.value);
    });
    els.uploadConcurrency.addEventListener('change', () => {
        localStorage.setItem('observingUploadConcurrency', els.uploadConcurrency.value);
    });
    els.vaultTargetName.addEventListener('change', () => {
        localStorage.setItem('observingVaultTargetName', els.vaultTargetName.value.trim());
        if (!els.cloudPrefix.value.trim()) {
            els.cloudPrefix.placeholder = defaultCloudPrefix();
        }
    });
    els.sessionDate.addEventListener('change', () => {
        if (!els.cloudPrefix.value.trim()) {
            els.cloudPrefix.placeholder = defaultCloudPrefix();
        }
    });
    els.cloudPrefix.addEventListener('change', () => {
        localStorage.setItem('observingCloudPrefix', els.cloudPrefix.value.trim());
    });
    document.getElementById('browse-all-cloud').addEventListener('click', () => listCloudObjects(''));
    document.getElementById('list-cloud').addEventListener('click', listCloudObjects);
    document.getElementById('browse-latest-cloud').addEventListener('click', async () => {
        const prefix = localStorage.getItem('observingLastCloudPrefix');
        if (!prefix) {
            els.cloudInventoryStatus.textContent = 'No upload batch has been saved from this browser yet.';
            return;
        }
        setCloudPrefix(prefix);
        await listCloudObjects();
    });
    document.getElementById('browse-current-cloud').addEventListener('click', async () => {
        setCloudPrefix(defaultCloudPrefix());
        await listCloudObjects();
    });
    document.getElementById('download-cloud-listed').addEventListener('click', downloadListedObjects);
    document.getElementById('download-cloud-zip').addEventListener('click', downloadListedZip);
    if (typeof window.showDirectoryPicker !== 'function') {
        document.getElementById('download-cloud-listed').hidden = true;
    }
    async function prepareDirectUploadTickets(items, endpoint, token, uploadMode) {
        const tickets = new Map();
        if (uploadMode === 'proxy') return { mode: 'proxy', tickets };
        const chunkSize = 100;
        for (let index = 0; index < items.length; index += chunkSize) {
            const chunk = items.slice(index, index + chunkSize);
            let response;
            try {
                response = await fetch(`${endpoint}/presign-uploads`, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${token}`,
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        uploads: chunk.map(item => ({
                            target: item.target || 'unknown-target',
                            kind: item.kind,
                            date: item.sessionDate,
                            filename: item.name,
                            collection: item.collection || 'session',
                            rig: selectedRig().name,
                            temperature: item.calibration?.temperature ?? '',
                            gain: item.calibration?.gain ?? '',
                            offset: item.calibration?.offset ?? '',
                            exposure: item.calibration?.exposure ?? '',
                            binning: item.calibration?.binning ?? '',
                            filter: item.calibration?.filter ?? '',
                            batch: item.batch || '',
                            sequence: item.sequence || ''
                        }))
                    })
                });
            } catch {
                throw new Error('batch upload preparation blocked or unreachable; check Worker URL');
            }
            const result = await response.json().catch(() => ({}));
            if (response.status === 501) return { mode: 'proxy', tickets: new Map() };
            if (response.status === 404) return { mode: 'legacy', tickets: new Map() };
            if (!response.ok || !result.ok || !Array.isArray(result.uploads)) {
                throw new Error(result.error || `batch upload preparation returned HTTP ${response.status}`);
            }
            result.uploads.forEach((ticket, chunkIndex) => tickets.set(chunk[chunkIndex], ticket));
            els.cloudStatus.textContent = `Cloud: prepared direct R2 tickets ${Math.min(index + chunk.length, items.length)}/${items.length}`;
        }
        return { mode: 'batch', tickets };
    }

    async function uploadSessionFile(item, endpoint, token, directState, directTicket) {
        const params = new URLSearchParams({
            target: item.target || 'unknown-target',
            kind: item.kind,
            date: item.sessionDate,
            filename: item.name,
            collection: item.collection || 'session',
            rig: selectedRig().name,
            temperature: item.calibration?.temperature ?? '',
            gain: item.calibration?.gain ?? '',
            offset: item.calibration?.offset ?? '',
            exposure: item.calibration?.exposure ?? '',
            binning: item.calibration?.binning ?? '',
            filter: item.calibration?.filter ?? '',
            batch: item.batch || '',
            sequence: item.sequence || ''
        });
        if (directState === 'batch') {
            let directResponse;
            try {
                directResponse = await fetch(directTicket.url, {
                    method: 'PUT',
                    body: item.file
                });
            } catch {
                throw new Error('direct R2 upload blocked; configure bucket CORS or select Worker proxy');
            }
            if (!directResponse.ok) {
                throw new Error(`direct R2 upload returned HTTP ${directResponse.status}`);
            }
            item.remoteKey = directTicket.key;
            return 'direct R2';
        }
        if (directState === 'legacy') {
            let signedResponse;
            try {
                signedResponse = await fetch(`${endpoint}/presign-upload?${params.toString()}`, {
                    headers: { authorization: `Bearer ${token}` }
                });
            } catch {
                throw new Error('presigned upload request blocked or unreachable; check Worker URL');
            }
            const signed = await signedResponse.json().catch(() => ({}));
            if (signedResponse.ok && signed.ok && signed.url) {
                let directResponse;
                try {
                    directResponse = await fetch(signed.url, {
                        method: 'PUT',
                        body: item.file
                    });
                } catch {
                    throw new Error('direct R2 upload blocked; configure bucket CORS or select Worker proxy');
                }
                if (!directResponse.ok) {
                    throw new Error(`direct R2 upload returned HTTP ${directResponse.status}`);
                }
                item.remoteKey = signed.key;
                return 'direct R2';
            }
            if (signedResponse.status !== 501) {
                throw new Error(signed.error || `presigned upload returned HTTP ${signedResponse.status}`);
            }
        }

        let response;
        try {
            response = await fetch(`${endpoint}/upload?${params.toString()}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': item.file.type || 'application/fits'
                },
                body: item.file
            });
        } catch {
            throw new Error('request blocked or unreachable; check Worker URL and CORS origin');
        }
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }
        item.remoteKey = result.key;
        return 'Worker proxy';
    }

    document.getElementById('upload-cloud').addEventListener('click', async () => {
        const endpoint = cloudEndpoint();
        const token = cloudToken();
        if (!endpoint || !token) {
            els.cloudStatus.textContent = 'Cloud: enter endpoint and upload token.';
            return;
        }
        const pending = state.files.filter(item => item.file && !item.remoteKey);
        if (!pending.length) {
            els.cloudStatus.textContent = 'Cloud: no staged files waiting for upload.';
            els.uploadDetail.textContent = 'Upload queue idle.';
            els.uploadProgressBar.style.width = '100%';
            return;
        }
        if (new Set(pending.map(item => item.collection)).size > 1) {
            els.cloudStatus.textContent = 'Cloud: this staged batch mixes observations and calibration files. Clear staged files, then upload one collection at a time.';
            return;
        }
        const batch = cloudBatchId();
        pending.forEach((item, index) => {
            item.batch = batch;
            item.sequence = String(index + 1).padStart(4, '0');
        });
        const uploadedPrefixes = [...new Set(pending.map(cloudPrefixForItem))];
        localStorage.setItem('observingCloudEndpoint', endpoint);
        els.uploadProgressBar.style.width = '0%';
        const uploadMode = els.uploadMode.value;
        const concurrency = Math.max(1, Math.min(24, Number(els.uploadConcurrency.value) || 12));
        els.cloudStatus.textContent = 'Cloud: preparing optimized upload batch...';
        let direct;
        try {
            direct = await prepareDirectUploadTickets(pending, endpoint, token, uploadMode);
        } catch (error) {
            els.cloudStatus.textContent = `Cloud: upload preparation failed. ${error.message}`;
            return;
        }
        let nextIndex = 0;
        let completed = 0;
        let completedBytes = 0;
        let active = 0;
        let failure = null;
        const startedAt = Date.now();
        const routes = { 'direct R2': 0, 'Worker proxy': 0 };
        const updateUploadProgress = item => {
            els.uploadProgressBar.style.width = `${Math.round((completed / pending.length) * 100)}%`;
            const routeSummary = routes['direct R2'] ? ' / direct R2' : routes['Worker proxy'] ? ' / Worker proxy' : '';
            const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
            const rate = completedBytes / 1024 / 1024 / elapsedSeconds;
            els.cloudStatus.textContent = `Cloud: uploaded ${completed}/${pending.length} / ${active} active${routeSummary} / ${rate.toFixed(1)} MB/s`;
            if (item) els.uploadDetail.textContent = `${item.kind} / ${item.relativePath || item.name} / ${formatBytes(item.size)}`;
        };
        const uploadWorker = async () => {
            while (!failure) {
                const index = nextIndex;
                nextIndex += 1;
                if (index >= pending.length) return;
                const item = pending[index];
                active += 1;
                updateUploadProgress(item);
                try {
                    const route = await uploadSessionFile(item, endpoint, token, direct.mode, direct.tickets.get(item));
                    routes[route] += 1;
                    completed += 1;
                    completedBytes += item.size;
                } catch (error) {
                    failure = { item, error };
                } finally {
                    active -= 1;
                    updateUploadProgress(item);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => uploadWorker()));
        if (failure) {
            els.cloudStatus.textContent = `Cloud: upload failed for ${failure.item.name}. ${failure.error.message}`;
            els.uploadDetail.textContent = `Failed: ${failure.item.relativePath || failure.item.name}`;
            renderVault();
            return;
        }
        els.uploadDetail.textContent = `Uploaded ${pending.length} file${pending.length === 1 ? '' : 's'} to Cloudflare R2.`;
        const latestPrefix = uploadedPrefixes.length === 1 ? uploadedPrefixes[0] : defaultCloudPrefix();
        setCloudPrefix(latestPrefix);
        localStorage.setItem('observingLastCloudPrefix', latestPrefix);
        state.files = state.files.filter(item => !item.remoteKey);
        state.cloudObjects = [];
        renderVault();
        await listCloudObjects();
    });
    renderVault();
})();
