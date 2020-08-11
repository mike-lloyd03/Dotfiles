"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const debounce_1 = tslib_1.__importDefault(require("debounce"));
const events_1 = tslib_1.__importDefault(require("events"));
const mutex_1 = require("../util/mutex");
const vscode_languageserver_protocol_1 = require("vscode-languageserver-protocol");
const events_2 = tslib_1.__importDefault(require("../events"));
const manager_1 = tslib_1.__importDefault(require("../snippets/manager"));
const util_1 = require("../util");
const workspace_1 = tslib_1.__importDefault(require("../workspace"));
const floatBuffer_1 = tslib_1.__importDefault(require("./floatBuffer"));
const object_1 = require("../util/object");
const string_1 = require("../util/string");
const logger = require('../util/logger')('model-float');
// factory class for floating window
class FloatFactory extends events_1.default {
    constructor(nvim, env, preferTop = false, maxHeight = 999, maxWidth, autoHide = true) {
        super();
        this.nvim = nvim;
        this.env = env;
        this.preferTop = preferTop;
        this.maxHeight = maxHeight;
        this.maxWidth = maxWidth;
        this.autoHide = autoHide;
        this.winid = 0;
        this._bufnr = 0;
        this.disposables = [];
        this.alignTop = false;
        this.pumAlignTop = false;
        if (!workspace_1.default.floatSupported)
            return;
        this.mutex = new mutex_1.Mutex();
        this.floatBuffer = new floatBuffer_1.default(nvim);
        events_2.default.on('BufEnter', bufnr => {
            if (bufnr == this._bufnr
                || bufnr == this.targetBufnr)
                return;
            this.close();
        }, null, this.disposables);
        events_2.default.on('MenuPopupChanged', (ev, cursorline) => {
            let pumAlignTop = this.pumAlignTop = cursorline > ev.row;
            if (pumAlignTop == this.alignTop) {
                this.close();
            }
        }, null, this.disposables);
        this.onCursorMoved = debounce_1.default(this._onCursorMoved.bind(this), 200);
        events_2.default.on('CursorMoved', this.onCursorMoved, null, this.disposables);
        events_2.default.on('CursorMovedI', this.onCursorMoved, null, this.disposables);
        this.disposables.push(vscode_languageserver_protocol_1.Disposable.create(() => {
            this.onCursorMoved.clear();
            this.cancel();
        }));
    }
    _onCursorMoved(bufnr, cursor) {
        let { insertMode } = workspace_1.default;
        if (bufnr == this._bufnr)
            return;
        if (bufnr == this.targetBufnr && object_1.equals(cursor, this.cursor)) {
            // cursor not moved
            return;
        }
        if (this.autoHide) {
            this.close();
            return;
        }
        if (!insertMode || bufnr != this.targetBufnr) {
            this.close();
            return;
        }
    }
    getWindowConfig(docs, win_position, offsetX = 0) {
        let { columns } = this.env;
        let lines = this.env.lines - this.env.cmdheight - 1;
        let { preferTop } = this;
        let alignTop = false;
        let [row, col] = win_position;
        let max = this.getMaxWindowHeight(docs);
        if (preferTop && row >= max) {
            alignTop = true;
        }
        else if (!preferTop && lines - row - 1 >= max) {
            alignTop = false;
        }
        else if ((preferTop && row >= 3) || (!preferTop && row >= lines - row - 1)) {
            alignTop = true;
        }
        let maxHeight = alignTop ? row : lines - row - 1;
        maxHeight = Math.min(maxHeight, this.maxHeight || lines);
        let maxWidth = Math.min(this.maxWidth || 80, 80, columns);
        let { width, height } = floatBuffer_1.default.getDimension(docs, maxWidth, maxHeight);
        if (col - offsetX + width > columns) {
            offsetX = col + width - columns;
        }
        this.alignTop = alignTop;
        return {
            height,
            width,
            row: alignTop ? -height : 1,
            col: offsetX == 0 ? 0 : -offsetX,
            relative: 'cursor'
        };
    }
    async create(docs, allowSelection = false, offsetX = 0) {
        if (!workspace_1.default.floatSupported)
            return;
        this.onCursorMoved.clear();
        if (docs.length == 0 || docs.every(doc => doc.content.length == 0)) {
            this.close();
            return;
        }
        this.cancel();
        let release = await this.mutex.acquire();
        try {
            await this.createPopup(docs, allowSelection, offsetX);
            release();
        }
        catch (e) {
            logger.error(`Error on create popup:`, e.message);
            this.close();
            release();
        }
    }
    async createPopup(docs, allowSelection = false, offsetX = 0) {
        let tokenSource = this.tokenSource = new vscode_languageserver_protocol_1.CancellationTokenSource();
        let token = tokenSource.token;
        let { nvim, alignTop, pumAlignTop, floatBuffer } = this;
        // get options
        let arr = await this.nvim.call('coc#util#get_float_mode', [allowSelection, alignTop, pumAlignTop]);
        if (!arr || token.isCancellationRequested)
            return;
        let [mode, targetBufnr, win_position, cursor] = arr;
        this.targetBufnr = targetBufnr;
        this.cursor = cursor;
        let config = this.getWindowConfig(docs, win_position, offsetX);
        // calculat highlights
        await floatBuffer.setDocuments(docs, config.width);
        if (token.isCancellationRequested)
            return;
        if (mode == 's')
            nvim.call('feedkeys', ['\x1b', "in"], true);
        // create window
        let res = await this.nvim.call('coc#util#create_float_win', [this.winid, this._bufnr, config]);
        if (!res)
            return;
        this.onCursorMoved.clear();
        let winid = this.winid = res[0];
        let bufnr = this._bufnr = res[1];
        if (token.isCancellationRequested)
            return;
        nvim.pauseNotification();
        if (workspace_1.default.isNvim) {
            nvim.command(`noa call win_gotoid(${winid})`, true);
            this.floatBuffer.setLines(bufnr);
            nvim.command(`noa normal! gg0`, true);
            nvim.command('noa wincmd p', true);
        }
        else {
            // no need to change cursor position
            this.floatBuffer.setLines(bufnr, winid);
            nvim.call('win_execute', [winid, `noa normal! gg0`], true);
            nvim.command('redraw', true);
        }
        this.emit('show', winid, bufnr);
        let [, err] = await nvim.resumeNotification();
        if (err)
            throw new Error(`Error on ${err[0]}: ${err[1]} - ${err[2]}`);
        if (mode == 's' && !token.isCancellationRequested) {
            await manager_1.default.selectCurrentPlaceholder(false);
            await util_1.wait(50);
        }
        this.onCursorMoved.clear();
    }
    /**
     * Close float window
     */
    close() {
        let { winid } = this;
        this.cancel();
        if (winid) {
            // TODO: sometimes this won't work at all
            this.nvim.call('coc#util#close_win', [winid], true);
            this.winid = 0;
            if (workspace_1.default.isVim)
                this.nvim.command('redraw', true);
        }
    }
    cancel() {
        let { tokenSource } = this;
        if (tokenSource) {
            tokenSource.cancel();
            this.tokenSource = null;
        }
    }
    dispose() {
        this.removeAllListeners();
        util_1.disposeAll(this.disposables);
    }
    get bufnr() {
        return this._bufnr;
    }
    get buffer() {
        return this.bufnr ? this.nvim.createBuffer(this.bufnr) : null;
    }
    get window() {
        return this.winid ? this.nvim.createWindow(this.winid) : null;
    }
    async activated() {
        if (!this.winid)
            return false;
        return await this.nvim.call('coc#util#valid_float_win', [this.winid]);
    }
    getMaxWindowHeight(docs) {
        let maxWidth = Math.min(this.maxWidth || 80, 80, this.env.columns);
        let w = maxWidth - 2;
        let h = 0;
        for (let doc of docs) {
            let lines = doc.content.split(/\r?\n/);
            for (let s of lines) {
                if (s.length == 0) {
                    h = h + 1;
                }
                else {
                    h = h + Math.ceil(string_1.byteLength(s.replace(/\t/g, '  ')) / w);
                }
            }
        }
        return Math.min(this.maxHeight, h);
    }
}
exports.default = FloatFactory;
//# sourceMappingURL=floatFactory.js.map