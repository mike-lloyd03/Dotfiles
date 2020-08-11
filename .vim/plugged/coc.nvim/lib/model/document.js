"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const debounce_1 = tslib_1.__importDefault(require("debounce"));
const vscode_languageserver_protocol_1 = require("vscode-languageserver-protocol");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const vscode_uri_1 = require("vscode-uri");
const events_1 = tslib_1.__importDefault(require("../events"));
const array_1 = require("../util/array");
const diff_1 = require("../util/diff");
const fs_1 = require("../util/fs");
const index_1 = require("../util/index");
const position_1 = require("../util/position");
const string_1 = require("../util/string");
const chars_1 = require("./chars");
const logger = require('../util/logger')('model-document');
// wrapper class of TextDocument
class Document {
    constructor(buffer, env, maxFileSize) {
        this.buffer = buffer;
        this.env = env;
        this.maxFileSize = maxFileSize;
        this.isIgnored = false;
        // start id for matchaddpos
        this.colorId = 1080;
        this.size = 0;
        this.eol = true;
        // real current lines
        this.lines = [];
        this._attached = false;
        this._words = [];
        this._onDocumentChange = new vscode_languageserver_protocol_1.Emitter();
        this._onDocumentDetach = new vscode_languageserver_protocol_1.Emitter();
        this.disposables = [];
        this.onDocumentChange = this._onDocumentChange.event;
        this.onDocumentDetach = this._onDocumentDetach.event;
        this.fireContentChanges = debounce_1.default(() => {
            this.nvim.mode.then(m => {
                if (m.blocking) {
                    this.fireContentChanges();
                    return;
                }
                this._fireContentChanges();
            }).logError();
        }, 200);
        this.fetchContent = debounce_1.default(() => {
            this._fetchContent().logError();
        }, 100);
    }
    /**
     * Check if current document should be attached for changes.
     *
     * Currently only attach for empty and `acwrite` buftype.
     */
    get shouldAttach() {
        let { buftype, maxFileSize } = this;
        if (!this.getVar('enabled', true))
            return false;
        if (this.uri.endsWith('%5BCommand%20Line%5D'))
            return true;
        // too big
        if (this.size == -2)
            return false;
        if (maxFileSize && this.size > maxFileSize)
            return false;
        return buftype == '' || buftype == 'acwrite';
    }
    get isCommandLine() {
        return this.uri && this.uri.endsWith('%5BCommand%20Line%5D');
    }
    get enabled() {
        return this.getVar('enabled', true);
    }
    /**
     * All words, extracted by `iskeyword` option.
     */
    get words() {
        return this._words;
    }
    /**
     * Map filetype for languageserver.
     */
    convertFiletype(filetype) {
        let map = this.env.filetypeMap;
        if (filetype == 'javascript.jsx')
            return 'javascriptreact';
        if (filetype == 'typescript.jsx' || filetype == 'typescript.tsx')
            return 'typescriptreact';
        return map[filetype] || filetype;
    }
    /**
     * Get current buffer changedtick.
     */
    get changedtick() {
        return this._changedtick;
    }
    /**
     * Scheme of document.
     */
    get schema() {
        return vscode_uri_1.URI.parse(this.uri).scheme;
    }
    /**
     * Line count of current buffer.
     */
    get lineCount() {
        return this.lines.length;
    }
    /**
     * Initialize document model.
     *
     * @internal
     */
    async init(nvim, token) {
        this.nvim = nvim;
        let { buffer } = this;
        let opts = await nvim.call('coc#util#get_bufoptions', buffer.id);
        if (opts == null)
            return false;
        let buftype = this.buftype = opts.buftype;
        this.size = typeof opts.size == 'number' ? opts.size : 0;
        this.variables = opts.variables;
        this._changedtick = opts.changedtick;
        this.eol = opts.eol == 1;
        let uri = this._uri = index_1.getUri(opts.fullpath, buffer.id, buftype, this.env.isCygwin);
        if (token.isCancellationRequested)
            return false;
        if (this.shouldAttach) {
            let res = await this.attach();
            if (!res)
                return false;
            this._attached = true;
        }
        this._filetype = this.convertFiletype(opts.filetype);
        this.textDocument = vscode_languageserver_textdocument_1.TextDocument.create(uri, this.filetype, 1, this.getDocumentContent());
        this.setIskeyword(opts.iskeyword);
        this.gitCheck();
        if (token.isCancellationRequested) {
            this.detach();
            return false;
        }
        return true;
    }
    async attach() {
        if (this.env.isVim) {
            this.lines = await this.nvim.call('getbufline', [this.bufnr, 1, '$']);
            return true;
        }
        let attached = await this.buffer.attach(false);
        if (!attached)
            return false;
        this.lines = await this.buffer.lines;
        let lastChange;
        this.buffer.listen('lines', (...args) => {
            // avoid neovim send same change multiple times after checktime
            if (lastChange == args[1])
                return;
            lastChange = args[1];
            this.onChange.apply(this, args);
        }, this.disposables);
        this.buffer.listen('detach', async (buf) => {
            this._onDocumentDetach.fire(buf.id);
        }, this.disposables);
        this.buffer.listen('changedtick', (_buf, tick) => {
            this._changedtick = tick;
        }, this.disposables);
        if (this.textDocument) {
            this.fireContentChanges();
        }
        return true;
    }
    onChange(buf, tick, firstline, lastline, linedata
    // more:boolean
    ) {
        if (buf.id !== this.buffer.id || tick == null)
            return;
        this._changedtick = tick;
        let lines = this.lines.slice(0, firstline);
        lines = lines.concat(linedata, this.lines.slice(lastline));
        this.lines = lines;
        this.fireContentChanges();
    }
    /**
     * Make sure current document synced correctly
     */
    async checkDocument() {
        let { buffer } = this;
        this._changedtick = await buffer.changedtick;
        this.lines = await buffer.lines;
        this.fireContentChanges.clear();
        this._fireContentChanges();
    }
    /**
     * Check if document changed after last synchronize
     */
    get dirty() {
        return this.content != this.getDocumentContent();
    }
    _fireContentChanges() {
        let { textDocument } = this;
        // if (paused && !force) return
        let { cursor } = events_1.default;
        try {
            let content = this.getDocumentContent();
            let endOffset = null;
            if (cursor && cursor.bufnr == this.bufnr) {
                endOffset = this.getEndOffset(cursor.lnum, cursor.col, cursor.insert);
            }
            let change = diff_1.getChange(this.content, content, endOffset);
            if (change == null)
                return;
            this.createDocument();
            let { version, uri } = this;
            let start = textDocument.positionAt(change.start);
            let end = textDocument.positionAt(change.end);
            let original = textDocument.getText(vscode_languageserver_protocol_1.Range.create(start, end));
            let changes = [{
                    range: { start, end },
                    rangeLength: change.end - change.start,
                    text: change.newText
                }];
            this._onDocumentChange.fire({
                bufnr: this.bufnr,
                original,
                textDocument: { version, uri },
                contentChanges: changes
            });
            this._words = this.chars.matchKeywords(this.textDocument.getText());
        }
        catch (e) {
            logger.error(e.message);
        }
    }
    /**
     * Buffer number
     */
    get bufnr() {
        return this.buffer.id;
    }
    /**
     * Content of textDocument.
     */
    get content() {
        return this.textDocument.getText();
    }
    /**
     * Coverted filetype.
     */
    get filetype() {
        return this._filetype;
    }
    get uri() {
        return this._uri;
    }
    get version() {
        return this.textDocument ? this.textDocument.version : null;
    }
    async applyEdits(edits, sync = true) {
        if (!Array.isArray(arguments[0]) && Array.isArray(arguments[1])) {
            edits = arguments[1];
        }
        if (edits.length == 0)
            return;
        edits.forEach(edit => {
            edit.newText = edit.newText.replace(/\r/g, '');
        });
        let current = this.lines.join('\n') + (this.eol ? '\n' : '');
        let textDocument = vscode_languageserver_textdocument_1.TextDocument.create(this.uri, this.filetype, 1, current);
        // apply edits to current textDocument
        let applied = vscode_languageserver_textdocument_1.TextDocument.applyEdits(textDocument, edits);
        // could be equal sometimes
        if (current !== applied) {
            let d = diff_1.diffLines(current, applied);
            await this.buffer.setLines(d.replacement, {
                start: d.start,
                end: d.end,
                strictIndexing: false
            });
        }
        if (sync) {
            // can't wait vim sync buffer
            this.lines = (this.eol && applied.endsWith('\n') ? applied.slice(0, -1) : applied).split('\n');
            this.forceSync();
        }
    }
    changeLines(lines, sync = true, check = false) {
        let { nvim } = this;
        let filtered = [];
        for (let [lnum, text] of lines) {
            if (check && this.lines[lnum] != text) {
                filtered.push([lnum, text]);
            }
            this.lines[lnum] = text;
        }
        if (check && !filtered.length)
            return;
        nvim.call('coc#util#change_lines', [this.bufnr, check ? filtered : lines], true);
        if (sync)
            this.forceSync();
    }
    /**
     * Force emit change event when necessary.
     */
    forceSync() {
        this.fireContentChanges.clear();
        this._fireContentChanges();
    }
    /**
     * Get offset from lnum & col
     */
    getOffset(lnum, col) {
        return this.textDocument.offsetAt({
            line: lnum - 1,
            character: col
        });
    }
    /**
     * Check string is word.
     */
    isWord(word) {
        return this.chars.isKeyword(word);
    }
    /**
     * Generate more words by split word with `-`
     */
    getMoreWords() {
        let res = [];
        let { words, chars } = this;
        if (!chars.isKeywordChar('-'))
            return res;
        for (let word of words) {
            word = word.replace(/^-+/, '');
            if (word.includes('-')) {
                let parts = word.split('-');
                for (let part of parts) {
                    if (part.length > 2 &&
                        !res.includes(part) &&
                        !words.includes(part)) {
                        res.push(part);
                    }
                }
            }
        }
        return res;
    }
    /**
     * Current word for replacement
     */
    getWordRangeAtPosition(position, extraChars, current = true) {
        let chars = this.chars.clone();
        if (extraChars && extraChars.length) {
            for (let ch of extraChars) {
                chars.addKeyword(ch);
            }
        }
        let line = this.getline(position.line, current);
        if (line.length == 0 || position.character >= line.length)
            return null;
        if (!chars.isKeywordChar(line[position.character]))
            return null;
        let start = position.character;
        let end = position.character + 1;
        if (!chars.isKeywordChar(line[start])) {
            return vscode_languageserver_protocol_1.Range.create(position, { line: position.line, character: position.character + 1 });
        }
        while (start >= 0) {
            let ch = line[start - 1];
            if (!ch || !chars.isKeyword(ch))
                break;
            start = start - 1;
        }
        while (end <= line.length) {
            let ch = line[end];
            if (!ch || !chars.isKeywordChar(ch))
                break;
            end = end + 1;
        }
        return vscode_languageserver_protocol_1.Range.create(position.line, start, position.line, end);
    }
    gitCheck() {
        let { uri } = this;
        if (!uri.startsWith('file') || this.buftype != '')
            return;
        let filepath = vscode_uri_1.URI.parse(uri).fsPath;
        fs_1.isGitIgnored(filepath).then(isIgnored => {
            this.isIgnored = isIgnored;
        }, () => {
            this.isIgnored = false;
        });
    }
    createDocument(changeCount = 1) {
        let { version, uri, filetype } = this;
        version = version + changeCount;
        this.textDocument = vscode_languageserver_textdocument_1.TextDocument.create(uri, filetype, version, this.getDocumentContent());
    }
    async _fetchContent() {
        if (!this.env.isVim || !this._attached)
            return;
        let { nvim, buffer } = this;
        let { id } = buffer;
        let o = (await nvim.call('coc#util#get_content', id));
        if (!o)
            return;
        let { content, changedtick } = o;
        if (this._changedtick == changedtick)
            return;
        this._changedtick = changedtick;
        let newLines = content.split('\n');
        this.lines = newLines;
        this.fireContentChanges.clear();
        this._fireContentChanges();
    }
    /**
     * Get and synchronize change
     */
    async patchChange(currentLine) {
        if (!this._attached)
            return;
        if (this.env.isVim) {
            if (currentLine) {
                let change = await this.nvim.call('coc#util#get_changeinfo', []);
                if (change.changedtick == this._changedtick)
                    return;
                let { lines } = this;
                let { lnum, line, changedtick } = change;
                this._changedtick = changedtick;
                lines[lnum - 1] = line;
                this.forceSync();
            }
            else {
                this.fetchContent.clear();
                await this._fetchContent();
            }
        }
        else {
            // we have latest lines aftet TextChange on neovim
            this.forceSync();
        }
    }
    /**
     * Get ranges of word in textDocument.
     */
    getSymbolRanges(word) {
        this.forceSync();
        let { textDocument } = this;
        let res = [];
        let content = textDocument.getText();
        let str = '';
        for (let i = 0, l = content.length; i < l; i++) {
            let ch = content[i];
            if ('-' == ch && str.length == 0) {
                continue;
            }
            let isKeyword = this.chars.isKeywordChar(ch);
            if (isKeyword) {
                str = str + ch;
            }
            if (str.length > 0 && !isKeyword && str == word) {
                res.push(vscode_languageserver_protocol_1.Range.create(textDocument.positionAt(i - str.length), textDocument.positionAt(i)));
            }
            if (!isKeyword) {
                str = '';
            }
        }
        return res;
    }
    /**
     * Adjust col with new valid character before position.
     */
    fixStartcol(position, valids) {
        let line = this.getline(position.line);
        if (!line)
            return null;
        let { character } = position;
        let start = line.slice(0, character);
        let col = string_1.byteLength(start);
        let { chars } = this;
        for (let i = start.length - 1; i >= 0; i--) {
            let c = start[i];
            if (c == ' ')
                break;
            if (!chars.isKeywordChar(c) && !valids.includes(c)) {
                break;
            }
            col = col - string_1.byteLength(c);
        }
        return col;
    }
    /**
     * Use matchaddpos for highlight ranges, must use `redraw` command on vim
     */
    matchAddRanges(ranges, hlGroup, priority = 10) {
        let res = [];
        let arr = [];
        let splited = ranges.reduce((p, c) => {
            for (let i = c.start.line; i <= c.end.line; i++) {
                let curr = this.getline(i) || '';
                let sc = i == c.start.line ? c.start.character : 0;
                let ec = i == c.end.line ? c.end.character : curr.length;
                if (sc == ec)
                    continue;
                p.push(vscode_languageserver_protocol_1.Range.create(i, sc, i, ec));
            }
            return p;
        }, []);
        for (let range of splited) {
            let { start, end } = range;
            let line = this.getline(start.line);
            if (start.character == end.character)
                continue;
            arr.push([start.line + 1, string_1.byteIndex(line, start.character) + 1, string_1.byteLength(line.slice(start.character, end.character))]);
        }
        for (let grouped of array_1.group(arr, 8)) {
            let id = this.colorId;
            this.colorId = this.colorId + 1;
            this.nvim.call('matchaddpos', [hlGroup, grouped, priority, id], true);
            res.push(id);
        }
        this.nvim.call('coc#util#add_matchids', [res], true);
        return res;
    }
    /**
     * Highlight ranges in document, return match id list.
     *
     * Note: match id could by namespace id or vim's match id.
     */
    highlightRanges(ranges, hlGroup, srcId, priority = 10) {
        let res = [];
        if (this.env.isVim && !this.env.textprop) {
            res = this.matchAddRanges(ranges, hlGroup, priority);
        }
        else {
            let lineRanges = [];
            for (let range of ranges) {
                if (range.start.line == range.end.line) {
                    lineRanges.push(range);
                }
                else {
                    // split range by lines
                    for (let i = range.start.line; i < range.end.line; i++) {
                        let line = this.getline(i);
                        if (i == range.start.line) {
                            lineRanges.push(vscode_languageserver_protocol_1.Range.create(i, range.start.character, i, line.length));
                        }
                        else if (i == range.end.line) {
                            lineRanges.push(vscode_languageserver_protocol_1.Range.create(i, Math.min(line.match(/^\s*/)[0].length, range.end.character), i, range.end.character));
                        }
                        else {
                            lineRanges.push(vscode_languageserver_protocol_1.Range.create(i, Math.min(line.match(/^\s*/)[0].length, line.length), i, line.length));
                        }
                    }
                }
            }
            for (let range of lineRanges) {
                let { start, end } = range;
                if (position_1.comparePosition(start, end) == 0)
                    continue;
                let line = this.getline(start.line);
                this.buffer.addHighlight({
                    hlGroup,
                    srcId,
                    line: start.line,
                    colStart: string_1.byteIndex(line, start.character),
                    colEnd: end.line - start.line == 1 && end.character == 0 ? -1 : string_1.byteIndex(line, end.character)
                }).logError();
            }
            res.push(srcId);
        }
        return res;
    }
    /**
     * Clear match id list, for vim support namespace, list should be namespace id list.
     */
    clearMatchIds(ids) {
        if (this.env.isVim && !this.env.textprop) {
            this.nvim.call('coc#util#clearmatches', [Array.from(ids)], true);
        }
        else {
            ids = array_1.distinct(Array.from(ids));
            let hasNamesapce = this.nvim.hasFunction('nvim_create_namespace');
            ids.forEach(id => {
                if (hasNamesapce) {
                    this.buffer.clearNamespace(id);
                }
                else {
                    this.buffer.clearHighlight({ srcId: id });
                }
            });
        }
    }
    /**
     * Get cwd of this document.
     */
    async getcwd() {
        let wid = await this.nvim.call('bufwinid', this.buffer.id);
        if (wid == -1)
            return await this.nvim.call('getcwd');
        return await this.nvim.call('getcwd', wid);
    }
    /**
     * Real current line
     */
    getline(line, current = true) {
        if (current)
            return this.lines[line] || '';
        let lines = this.textDocument.getText().split(/\r?\n/);
        return lines[line] || '';
    }
    /**
     * Get lines, zero indexed, end exclude.
     */
    getLines(start, end) {
        return this.lines.slice(start, end);
    }
    /**
     * Get current content text.
     */
    getDocumentContent() {
        let content = this.lines.join('\n');
        return this.eol ? content + '\n' : content;
    }
    /**
     * Get variable value by key, defined by `b:coc_{key}`
     */
    getVar(key, defaultValue) {
        let val = this.variables[`coc_${key}`];
        return val === undefined ? defaultValue : val;
    }
    /**
     * Get position from lnum & col
     */
    getPosition(lnum, col) {
        let line = this.getline(lnum - 1);
        if (!line || col == 0)
            return { line: lnum - 1, character: 0 };
        let pre = string_1.byteSlice(line, 0, col - 1);
        return { line: lnum - 1, character: pre.length };
    }
    /**
     * Get end offset from cursor position.
     * For normal mode, use offset -1 when possible
     */
    getEndOffset(lnum, col, insert) {
        let total = 0;
        let len = this.lines.length;
        for (let i = lnum - 1; i < len; i++) {
            let line = this.lines[i];
            let l = line.length;
            if (i == lnum - 1 && l != 0) {
                // current
                let buf = global.Buffer.from(line, 'utf8');
                let isEnd = buf.byteLength <= col - 1;
                if (!isEnd) {
                    total = total + buf.slice(col - 1, buf.length).toString('utf8').length;
                    if (!insert)
                        total = total - 1;
                }
            }
            else {
                total = total + l;
            }
            if (!this.eol && i == len - 1)
                break;
            total = total + 1;
        }
        return total;
    }
    /**
     * Recreate document with new filetype.
     *
     * @internal
     */
    setFiletype(filetype) {
        let { uri, version } = this;
        this._filetype = this.convertFiletype(filetype);
        version = version ? version + 1 : 1;
        let textDocument = vscode_languageserver_textdocument_1.TextDocument.create(uri, this.filetype, version, this.content);
        this.textDocument = textDocument;
    }
    /**
     * Change iskeyword option of document
     *
     * @internal
     */
    setIskeyword(iskeyword) {
        let chars = this.chars = new chars_1.Chars(iskeyword);
        let additional = this.getVar('additional_keywords', []);
        if (additional && Array.isArray(additional)) {
            for (let ch of additional) {
                chars.addKeyword(ch);
            }
        }
        let lines = this.lines.length > 30000 ? this.lines.slice(0, 30000) : this.lines;
        this._words = this.chars.matchKeywords(lines.join('\n'));
    }
    /**
     * Detach document.
     *
     * @internal
     */
    detach() {
        this._attached = false;
        index_1.disposeAll(this.disposables);
        this.buffer.detach().catch(() => {
            // ignore invalid buffer error
        });
        this.disposables = [];
        this.fetchContent.clear();
        this.fireContentChanges.clear();
        this._onDocumentChange.dispose();
        this._onDocumentDetach.dispose();
    }
    get attached() {
        return this._attached;
    }
    /**
     * Get localify bonus map.
     *
     * @internal
     */
    getLocalifyBonus(sp, ep) {
        let res = new Map();
        let { chars } = this;
        let startLine = Math.max(0, sp.line - 100);
        let endLine = Math.min(this.lineCount, sp.line + 100);
        let content = this.lines.slice(startLine, endLine).join('\n');
        sp = vscode_languageserver_protocol_1.Position.create(sp.line - startLine, sp.character);
        ep = vscode_languageserver_protocol_1.Position.create(ep.line - startLine, ep.character);
        let doc = vscode_languageserver_textdocument_1.TextDocument.create(this.uri, this.filetype, 1, content);
        let headCount = doc.offsetAt(sp);
        let len = content.length;
        let tailCount = len - doc.offsetAt(ep);
        let start = 0;
        let preKeyword = false;
        for (let i = 0; i < headCount; i++) {
            let iskeyword = chars.isKeyword(content[i]);
            if (!preKeyword && iskeyword) {
                start = i;
            }
            else if (preKeyword && (!iskeyword || i == headCount - 1)) {
                if (i - start > 1) {
                    let str = content.slice(start, i);
                    res.set(str, i / headCount);
                }
            }
            preKeyword = iskeyword;
        }
        start = len - tailCount;
        preKeyword = false;
        for (let i = start; i < content.length; i++) {
            let iskeyword = chars.isKeyword(content[i]);
            if (!preKeyword && iskeyword) {
                start = i;
            }
            else if (preKeyword && (!iskeyword || i == len - 1)) {
                if (i - start > 1) {
                    let end = i == len - 1 ? i + 1 : i;
                    let str = content.slice(start, end);
                    let score = res.get(str) || 0;
                    res.set(str, Math.max(score, (len - i + (end - start)) / tailCount));
                }
            }
            preKeyword = iskeyword;
        }
        return res;
    }
}
exports.default = Document;
//# sourceMappingURL=document.js.map