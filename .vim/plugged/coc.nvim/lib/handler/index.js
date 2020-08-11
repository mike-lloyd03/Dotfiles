"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const vscode_languageserver_protocol_1 = require("vscode-languageserver-protocol");
const commands_1 = tslib_1.__importDefault(require("../commands"));
const manager_1 = tslib_1.__importDefault(require("../diagnostic/manager"));
const events_1 = tslib_1.__importDefault(require("../events"));
const languages_1 = tslib_1.__importDefault(require("../languages"));
const manager_2 = tslib_1.__importDefault(require("../list/manager"));
const floatFactory_1 = tslib_1.__importDefault(require("../model/floatFactory"));
const services_1 = tslib_1.__importDefault(require("../services"));
const manager_3 = tslib_1.__importDefault(require("../snippets/manager"));
const util_1 = require("../util");
const convert_1 = require("../util/convert");
const object_1 = require("../util/object");
const position_1 = require("../util/position");
const string_1 = require("../util/string");
const workspace_1 = tslib_1.__importDefault(require("../workspace"));
const codelens_1 = tslib_1.__importDefault(require("./codelens"));
const colors_1 = tslib_1.__importDefault(require("./colors"));
const documentHighlight_1 = tslib_1.__importDefault(require("./documentHighlight"));
const refactor_1 = tslib_1.__importDefault(require("./refactor"));
const search_1 = tslib_1.__importDefault(require("./search"));
const debounce = require("debounce");
const vscode_uri_1 = require("vscode-uri");
const logger = require('../util/logger')('Handler');
const pairs = new Map([
    ['<', '>'],
    ['>', '<'],
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
]);
class Handler {
    constructor(nvim) {
        this.nvim = nvim;
        this.refactorMap = new Map();
        this.documentLines = [];
        this.disposables = [];
        this.labels = {};
        this.selectionRange = null;
        this.getPreferences();
        workspace_1.default.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('coc.preferences')) {
                this.getPreferences();
            }
        });
        this.hoverFactory = new floatFactory_1.default(nvim, workspace_1.default.env);
        this.disposables.push(this.hoverFactory);
        let { signaturePreferAbove, signatureFloatMaxWidth, signatureMaxHeight } = this.preferences;
        this.signatureFactory = new floatFactory_1.default(nvim, workspace_1.default.env, signaturePreferAbove, signatureMaxHeight, signatureFloatMaxWidth, false);
        this.disposables.push(this.signatureFactory);
        events_1.default.on('BufUnload', async (bufnr) => {
            let refactor = this.refactorMap.get(bufnr);
            if (refactor) {
                refactor.dispose();
                this.refactorMap.delete(bufnr);
            }
        }, null, this.disposables);
        events_1.default.on('CursorMovedI', async (bufnr, cursor) => {
            if (!this.signaturePosition)
                return;
            let doc = workspace_1.default.getDocument(bufnr);
            if (!doc)
                return;
            let { line, character } = this.signaturePosition;
            if (cursor[0] - 1 == line) {
                let currline = doc.getline(cursor[0] - 1);
                let col = string_1.byteLength(currline.slice(0, character)) + 1;
                if (cursor[1] >= col)
                    return;
            }
            this.signatureFactory.close();
        }, null, this.disposables);
        events_1.default.on('InsertLeave', () => {
            this.signatureFactory.close();
        }, null, this.disposables);
        events_1.default.on(['TextChangedI', 'TextChangedP'], async () => {
            if (this.preferences.signatureHideOnChange) {
                this.signatureFactory.close();
            }
            this.hoverFactory.close();
        }, null, this.disposables);
        let lastInsert;
        events_1.default.on('InsertCharPre', async (character) => {
            lastInsert = Date.now();
            if (character == ')')
                this.signatureFactory.close();
        }, null, this.disposables);
        events_1.default.on('Enter', async (bufnr) => {
            let { bracketEnterImprove } = this.preferences;
            await this.tryFormatOnType('\n', bufnr);
            if (bracketEnterImprove) {
                let line = await nvim.call('line', '.') - 1;
                let doc = workspace_1.default.getDocument(bufnr);
                if (!doc)
                    return;
                await doc.checkDocument();
                let pre = doc.getline(line - 1);
                let curr = doc.getline(line);
                let prevChar = pre[pre.length - 1];
                if (prevChar && pairs.has(prevChar)) {
                    let nextChar = curr.trim()[0];
                    if (nextChar && pairs.get(prevChar) == nextChar) {
                        let edits = [];
                        let opts = await workspace_1.default.getFormatOptions(doc.uri);
                        let space = opts.insertSpaces ? ' '.repeat(opts.tabSize) : '\t';
                        let preIndent = pre.match(/^\s*/)[0];
                        let currIndent = curr.match(/^\s*/)[0];
                        let newText = '\n' + preIndent + space;
                        let pos = vscode_languageserver_protocol_1.Position.create(line - 1, pre.length);
                        // make sure indent of current line
                        if (preIndent != currIndent) {
                            let newText = doc.filetype == 'vim' ? '  \\ ' + preIndent : preIndent;
                            edits.push({ range: vscode_languageserver_protocol_1.Range.create(vscode_languageserver_protocol_1.Position.create(line, 0), vscode_languageserver_protocol_1.Position.create(line, currIndent.length)), newText });
                        }
                        else if (doc.filetype == 'vim') {
                            edits.push({ range: vscode_languageserver_protocol_1.Range.create(line, currIndent.length, line, currIndent.length), newText: '  \\ ' });
                        }
                        if (doc.filetype == 'vim') {
                            newText = newText + '\\ ';
                        }
                        edits.push({ range: vscode_languageserver_protocol_1.Range.create(pos, pos), newText });
                        await doc.applyEdits(edits);
                        await workspace_1.default.moveTo(vscode_languageserver_protocol_1.Position.create(line, newText.length - 1));
                    }
                }
            }
        }, null, this.disposables);
        events_1.default.on('TextChangedI', async (bufnr) => {
            let curr = Date.now();
            if (!lastInsert || curr - lastInsert > 500)
                return;
            let doc = workspace_1.default.getDocument(bufnr);
            if (!doc || doc.isCommandLine || !doc.attached)
                return;
            let { triggerSignatureHelp, formatOnType } = this.preferences;
            if (!triggerSignatureHelp && !formatOnType)
                return;
            let [pos, line] = await nvim.eval('[coc#util#cursor(), getline(".")]');
            let pre = pos[1] == 0 ? '' : line.slice(pos[1] - 1, pos[1]);
            if (!pre || string_1.isWord(pre))
                return;
            await this.tryFormatOnType(pre, bufnr);
            if (triggerSignatureHelp && languages_1.default.shouldTriggerSignatureHelp(doc.textDocument, pre)) {
                try {
                    let [mode, cursor] = await nvim.eval('[mode(),coc#util#cursor()]');
                    if (mode !== 'i')
                        return;
                    await synchronizeDocument(doc);
                    await this.triggerSignatureHelp(doc, { line: cursor[0], character: cursor[1] });
                }
                catch (e) {
                    logger.error(`Error on signature help:`, e);
                }
            }
        }, null, this.disposables);
        events_1.default.on('InsertLeave', async (bufnr) => {
            if (!this.preferences.formatOnInsertLeave)
                return;
            await util_1.wait(30);
            if (workspace_1.default.insertMode)
                return;
            await this.tryFormatOnType('\n', bufnr, true);
        }, null, this.disposables);
        events_1.default.on('CursorMoved', debounce((bufnr, cursor) => {
            if (!this.preferences.previewAutoClose || !this.hoverPosition)
                return;
            if (this.preferences.hoverTarget == 'float')
                return;
            let arr = [bufnr, cursor[0], cursor[1]];
            if (object_1.equals(arr, this.hoverPosition))
                return;
            let doc = workspace_1.default.documents.find(doc => doc.uri.startsWith('coc://'));
            if (doc && doc.bufnr != bufnr) {
                nvim.command('pclose', true);
            }
        }, 100), null, this.disposables);
        if (this.preferences.currentFunctionSymbolAutoUpdate) {
            events_1.default.on('CursorHold', () => {
                this.getCurrentFunctionSymbol().logError();
            }, null, this.disposables);
        }
        let provider = {
            onDidChange: null,
            provideTextDocumentContent: async () => {
                nvim.pauseNotification();
                nvim.command('setlocal conceallevel=2 nospell nofoldenable wrap', true);
                nvim.command('setlocal bufhidden=wipe nobuflisted', true);
                nvim.command('setfiletype markdown', true);
                nvim.command(`exe "normal! z${Math.min(this.documentLines.length, this.preferences.previewMaxHeight)}\\<cr>"`, true);
                await nvim.resumeNotification();
                return this.documentLines.join('\n');
            }
        };
        this.disposables.push(workspace_1.default.registerTextDocumentContentProvider('coc', provider));
        this.codeLensManager = new codelens_1.default(nvim);
        this.colors = new colors_1.default(nvim);
        this.documentHighlighter = new documentHighlight_1.default(nvim, this.colors);
        this.disposables.push(commands_1.default.registerCommand('editor.action.organizeImport', async (bufnr) => {
            if (!bufnr)
                bufnr = await nvim.call('bufnr', '%');
            let doc = workspace_1.default.getDocument(bufnr);
            if (!doc)
                return false;
            let range = vscode_languageserver_protocol_1.Range.create(0, 0, doc.lineCount, 0);
            let actions = await this.getCodeActions(bufnr, range, [vscode_languageserver_protocol_1.CodeActionKind.SourceOrganizeImports]);
            if (actions && actions.length) {
                await this.applyCodeAction(actions[0]);
                return true;
            }
            workspace_1.default.showMessage(`Organize import action not found.`, 'warning');
            return false;
        }));
        commands_1.default.titles.set('editor.action.organizeImport', 'run organize import code action.');
    }
    async getCurrentFunctionSymbol() {
        let position = await workspace_1.default.getCursorPosition();
        let buffer = await this.nvim.buffer;
        let document = workspace_1.default.getDocument(buffer.id);
        if (!document)
            return;
        let symbols = await this.getDocumentSymbols(document);
        if (!symbols || symbols.length === 0) {
            buffer.setVar('coc_current_function', '', true);
            this.nvim.call('coc#util#do_autocmd', ['CocStatusChange'], true);
            return '';
        }
        symbols = symbols.filter(s => [
            'Class',
            'Method',
            'Function',
        ].includes(s.kind));
        let functionName = '';
        for (let sym of symbols.reverse()) {
            if (sym.range
                && position_1.positionInRange(position, sym.range) == 0
                && !sym.text.endsWith(') callback')) {
                functionName = sym.text;
                let label = this.labels[sym.kind.toLowerCase()];
                if (label)
                    functionName = `${label} ${functionName}`;
                break;
            }
        }
        buffer.setVar('coc_current_function', functionName, true);
        this.nvim.call('coc#util#do_autocmd', ['CocStatusChange'], true);
        return functionName;
    }
    async hasProvider(id) {
        let bufnr = await this.nvim.call('bufnr', '%');
        let doc = workspace_1.default.getDocument(bufnr);
        if (!doc)
            return false;
        return languages_1.default.hasProvider(id, doc.textDocument);
    }
    async onHover() {
        let { document, position } = await workspace_1.default.getCurrentState();
        let hovers = await languages_1.default.getHover(document, position);
        if (hovers && hovers.length) {
            let hover = hovers.find(o => vscode_languageserver_protocol_1.Range.is(o.range));
            if (hover) {
                let doc = workspace_1.default.getDocument(document.uri);
                if (doc) {
                    let ids = doc.matchAddRanges([hover.range], 'CocHoverRange', 999);
                    setTimeout(() => {
                        this.nvim.call('coc#util#clearmatches', [ids], true);
                    }, 1000);
                }
            }
            await this.previewHover(hovers);
            return true;
        }
        let target = this.preferences.hoverTarget;
        if (target == 'float') {
            this.hoverFactory.close();
        }
        else if (target == 'preview') {
            this.nvim.command('pclose', true);
        }
        return false;
    }
    async gotoDefinition(openCommand) {
        let { document, position } = await workspace_1.default.getCurrentState();
        let definition = await languages_1.default.getDefinition(document, position);
        if (isEmpty(definition)) {
            this.onEmptyLocation('Definition', definition);
            return false;
        }
        await this.handleLocations(definition, openCommand);
        return true;
    }
    async gotoDeclaration(openCommand) {
        let { document, position } = await workspace_1.default.getCurrentState();
        let definition = await languages_1.default.getDeclaration(document, position);
        if (isEmpty(definition)) {
            this.onEmptyLocation('Declaration', definition);
            return false;
        }
        await this.handleLocations(definition, openCommand);
        return true;
    }
    async gotoTypeDefinition(openCommand) {
        let { document, position } = await workspace_1.default.getCurrentState();
        let definition = await languages_1.default.getTypeDefinition(document, position);
        if (isEmpty(definition)) {
            this.onEmptyLocation('Type definition', definition);
            return false;
        }
        await this.handleLocations(definition, openCommand);
        return true;
    }
    async gotoImplementation(openCommand) {
        let { document, position } = await workspace_1.default.getCurrentState();
        let definition = await languages_1.default.getImplementation(document, position);
        if (isEmpty(definition)) {
            this.onEmptyLocation('Implementation', definition);
            return false;
        }
        await this.handleLocations(definition, openCommand);
        return true;
    }
    async gotoReferences(openCommand) {
        let { document, position } = await workspace_1.default.getCurrentState();
        let locs = await languages_1.default.getReferences(document, { includeDeclaration: false }, position);
        if (isEmpty(locs)) {
            this.onEmptyLocation('References', locs);
            return false;
        }
        await this.handleLocations(locs, openCommand);
        return true;
    }
    async getDocumentSymbols(document) {
        document = document || workspace_1.default.getDocument(workspace_1.default.bufnr);
        if (!document)
            return [];
        let symbols = await languages_1.default.getDocumentSymbol(document.textDocument);
        if (!symbols)
            return null;
        if (symbols.length == 0)
            return [];
        let level = 0;
        let res = [];
        let pre = null;
        if (isDocumentSymbols(symbols)) {
            symbols.sort(sortDocumentSymbols);
            symbols.forEach(s => addDoucmentSymbol(res, s, level));
        }
        else {
            symbols.sort(sortSymbolInformations);
            for (let sym of symbols) {
                let { name, kind, location, containerName } = sym;
                if (!containerName || !pre) {
                    level = 0;
                }
                else {
                    if (pre.containerName == containerName) {
                        level = pre.level || 0;
                    }
                    else {
                        let container = getPreviousContainer(containerName, res);
                        level = container ? container.level + 1 : 0;
                    }
                }
                let { start } = location.range;
                let o = {
                    col: start.character + 1,
                    lnum: start.line + 1,
                    text: name,
                    level,
                    kind: convert_1.getSymbolKind(kind),
                    range: location.range,
                    containerName
                };
                res.push(o);
                pre = o;
            }
        }
        return res;
    }
    async getWordEdit() {
        let bufnr = await this.nvim.call('bufnr', '%');
        let doc = workspace_1.default.getDocument(bufnr);
        if (!doc)
            return null;
        let position = await workspace_1.default.getCursorPosition();
        let range = doc.getWordRangeAtPosition(position);
        if (!range || position_1.emptyRange(range))
            return null;
        let curname = doc.textDocument.getText(range);
        if (languages_1.default.hasProvider('rename', doc.textDocument)) {
            await synchronizeDocument(doc);
            let res = await languages_1.default.prepareRename(doc.textDocument, position);
            if (res === false)
                return null;
            let edit = await languages_1.default.provideRenameEdits(doc.textDocument, position, curname);
            if (edit)
                return edit;
        }
        workspace_1.default.showMessage('Rename provider not found, extract word ranges from current buffer', 'more');
        let ranges = doc.getSymbolRanges(curname);
        return {
            changes: {
                [doc.uri]: ranges.map(r => ({ range: r, newText: curname }))
            }
        };
    }
    async rename(newName) {
        let bufnr = await this.nvim.call('bufnr', '%');
        let doc = workspace_1.default.getDocument(bufnr);
        if (!doc)
            return false;
        let { nvim } = this;
        let position = await workspace_1.default.getCursorPosition();
        let range = doc.getWordRangeAtPosition(position);
        if (!range || position_1.emptyRange(range))
            return false;
        if (!languages_1.default.hasProvider('rename', doc.textDocument)) {
            workspace_1.default.showMessage(`Rename provider not found for current document`, 'error');
            return false;
        }
        await synchronizeDocument(doc);
        let res = await languages_1.default.prepareRename(doc.textDocument, position);
        if (res === false) {
            workspace_1.default.showMessage('Invalid position for renmame', 'error');
            return false;
        }
        if (!newName) {
            let curname = await nvim.eval('expand("<cword>")');
            newName = await workspace_1.default.callAsync('input', ['New name: ', curname]);
            nvim.command('normal! :<C-u>', true);
            if (!newName) {
                workspace_1.default.showMessage('Empty name, canceled', 'warning');
                return false;
            }
        }
        let edit = await languages_1.default.provideRenameEdits(doc.textDocument, position, newName);
        if (!edit) {
            workspace_1.default.showMessage('Invalid position for rename', 'warning');
            return false;
        }
        await workspace_1.default.applyEdit(edit);
        return true;
    }
    async documentFormatting() {
        let bufnr = await this.nvim.eval('bufnr("%")');
        let document = workspace_1.default.getDocument(bufnr);
        if (!document)
            return false;
        let options = await workspace_1.default.getFormatOptions(document.uri);
        let textEdits = await languages_1.default.provideDocumentFormattingEdits(document.textDocument, options);
        if (!textEdits || textEdits.length == 0)
            return false;
        await document.applyEdits(textEdits);
        return true;
    }
    async documentRangeFormatting(mode) {
        let document = await workspace_1.default.document;
        if (!document)
            return -1;
        let range;
        if (mode) {
            range = await workspace_1.default.getSelectedRange(mode, document);
            if (!range)
                return -1;
        }
        else {
            let lnum = await this.nvim.getVvar('lnum');
            let count = await this.nvim.getVvar('count');
            let mode = await this.nvim.call('mode');
            // we can't handle
            if (count == 0 || mode == 'i' || mode == 'R')
                return -1;
            range = vscode_languageserver_protocol_1.Range.create(lnum - 1, 0, lnum - 1 + count, 0);
        }
        let options = await workspace_1.default.getFormatOptions(document.uri);
        let textEdits = await languages_1.default.provideDocumentRangeFormattingEdits(document.textDocument, range, options);
        if (!textEdits)
            return -1;
        await document.applyEdits(textEdits);
        return 0;
    }
    async getTagList() {
        let position = await workspace_1.default.getCursorPosition();
        let document = await workspace_1.default.document;
        let word = await this.nvim.call('expand', '<cword>');
        if (!word)
            return null;
        if (!languages_1.default.hasProvider('definition', document.textDocument)) {
            return null;
        }
        let definitions = await languages_1.default.getDefinition(document.textDocument, position);
        return definitions.map(location => {
            let parsedURI = vscode_uri_1.URI.parse(location.uri);
            const filename = parsedURI.scheme == 'file' ? parsedURI.fsPath : parsedURI.toString();
            return {
                name: word,
                cmd: `keepjumps ${location.range.start.line + 1} | normal ${location.range.start.character + 1}|`,
                filename,
            };
        });
    }
    async runCommand(id, ...args) {
        if (id) {
            await events_1.default.fire('Command', [id]);
            let res = await commands_1.default.executeCommand(id, ...args);
            if (args.length == 0) {
                await commands_1.default.addRecent(id);
            }
            return res;
        }
        else {
            await manager_2.default.start(['commands']);
        }
    }
    async getCodeActions(bufnr, range, only) {
        let document = workspace_1.default.getDocument(bufnr);
        if (!document)
            return [];
        range = range || vscode_languageserver_protocol_1.Range.create(0, 0, document.lineCount, 0);
        let diagnostics = manager_1.default.getDiagnosticsInRange(document.textDocument, range);
        let context = { diagnostics };
        if (only && Array.isArray(only))
            context.only = only;
        let codeActionsMap = await languages_1.default.getCodeActions(document.textDocument, range, context);
        if (!codeActionsMap)
            return [];
        let codeActions = [];
        for (let clientId of codeActionsMap.keys()) {
            let actions = codeActionsMap.get(clientId);
            for (let action of actions) {
                codeActions.push(Object.assign({ clientId }, action));
            }
        }
        codeActions.sort((a, b) => {
            if (a.isPrefered && !b.isPrefered) {
                return -1;
            }
            if (b.isPrefered && !a.isPrefered) {
                return 1;
            }
            return 0;
        });
        return codeActions;
    }
    async doCodeAction(mode, only) {
        let bufnr = await this.nvim.call('bufnr', '%');
        let range;
        if (mode)
            range = await workspace_1.default.getSelectedRange(mode, workspace_1.default.getDocument(bufnr));
        let codeActions = await this.getCodeActions(bufnr, range, Array.isArray(only) ? only : null);
        if (only && typeof only == 'string') {
            codeActions = codeActions.filter(o => o.title == only || (o.command && o.command.title == only));
        }
        if (!codeActions || codeActions.length == 0) {
            workspace_1.default.showMessage(`CodeAction${only ? ' ' + only : ''} not found`, 'warning');
            return;
        }
        if (!only || codeActions.length > 1) {
            let idx = await workspace_1.default.showQuickpick(codeActions.map(o => o.title));
            if (idx == -1)
                return;
            let action = codeActions[idx];
            if (action)
                await this.applyCodeAction(action);
        }
        else {
            await this.applyCodeAction(codeActions[0]);
        }
    }
    /**
     * Get current codeActions
     *
     * @public
     * @returns {Promise<CodeAction[]>}
     */
    async getCurrentCodeActions(mode, only) {
        let bufnr = await this.nvim.call('bufnr', '%');
        let document = workspace_1.default.getDocument(bufnr);
        if (!document)
            return [];
        let range;
        if (mode)
            range = await workspace_1.default.getSelectedRange(mode, workspace_1.default.getDocument(bufnr));
        return await this.getCodeActions(bufnr, range, only);
    }
    async doQuickfix() {
        let actions = await this.getCurrentCodeActions(null, [vscode_languageserver_protocol_1.CodeActionKind.QuickFix]);
        if (!actions || actions.length == 0) {
            workspace_1.default.showMessage('No quickfix action available', 'warning');
            return false;
        }
        await this.applyCodeAction(actions[0]);
        await this.nvim.command(`silent! call repeat#set("\\<Plug>(coc-fix-current)", -1)`);
        return true;
    }
    async applyCodeAction(action) {
        let { command, edit } = action;
        if (edit)
            await workspace_1.default.applyEdit(edit);
        if (command) {
            if (commands_1.default.has(command.command)) {
                commands_1.default.execute(command);
            }
            else {
                let clientId = action.clientId;
                let service = services_1.default.getService(clientId);
                let params = {
                    command: command.command,
                    arguments: command.arguments
                };
                if (service.client) {
                    let { client } = service;
                    client
                        .sendRequest(vscode_languageserver_protocol_1.ExecuteCommandRequest.type, params)
                        .then(undefined, error => {
                        workspace_1.default.showMessage(`Execute '${command.command} error: ${error}'`, 'error');
                    });
                }
            }
        }
    }
    async doCodeLensAction() {
        await this.codeLensManager.doAction();
    }
    async fold(kind) {
        let document = await workspace_1.default.document;
        let win = await this.nvim.window;
        let foldmethod = await win.getOption('foldmethod');
        if (foldmethod != 'manual') {
            workspace_1.default.showMessage('foldmethod option should be manual!', 'warning');
            return false;
        }
        let ranges = await languages_1.default.provideFoldingRanges(document.textDocument, {});
        if (ranges == null) {
            workspace_1.default.showMessage('no folding range provider found', 'warning');
            return false;
        }
        if (!ranges || ranges.length == 0) {
            workspace_1.default.showMessage('no range found', 'warning');
            return false;
        }
        if (kind) {
            ranges = ranges.filter(o => o.kind == kind);
        }
        if (ranges && ranges.length) {
            await win.setOption('foldenable', true);
            for (let range of ranges.reverse()) {
                let { startLine, endLine } = range;
                let cmd = `${startLine + 1}, ${endLine + 1}fold`;
                this.nvim.command(cmd, true);
            }
            return true;
        }
        return false;
    }
    async pickColor() {
        await this.colors.pickColor();
    }
    async pickPresentation() {
        await this.colors.pickPresentation();
    }
    async highlight() {
        let bufnr = await this.nvim.call('bufnr', '%');
        await this.documentHighlighter.highlight(bufnr);
    }
    async getSymbolsRanges() {
        let document = await workspace_1.default.document;
        let highlights = await this.documentHighlighter.getHighlights(document);
        if (!highlights)
            return null;
        return highlights.map(o => o.range);
    }
    async links() {
        let doc = await workspace_1.default.document;
        let links = await languages_1.default.getDocumentLinks(doc.textDocument);
        links = links || [];
        let res = [];
        for (let link of links) {
            if (link.target) {
                res.push(link);
            }
            else {
                link = await languages_1.default.resolveDocumentLink(link);
                res.push(link);
            }
        }
        return links;
    }
    async openLink() {
        let { document, position } = await workspace_1.default.getCurrentState();
        let links = await languages_1.default.getDocumentLinks(document);
        if (!links || links.length == 0)
            return false;
        for (let link of links) {
            if (position_1.positionInRange(position, link.range)) {
                let { target } = link;
                if (!target) {
                    link = await languages_1.default.resolveDocumentLink(link);
                    target = link.target;
                }
                if (target) {
                    await workspace_1.default.openResource(target);
                    return true;
                }
                return false;
            }
        }
        return false;
    }
    async getCommands() {
        let list = commands_1.default.commandList;
        let res = [];
        let { titles } = commands_1.default;
        for (let item of list) {
            res.push({
                id: item.id,
                title: titles.get(item.id) || ''
            });
        }
        return res;
    }
    /*
     * supportedSymbols must be string values of symbolKind
     */
    async selectSymbolRange(inner, visualmode, supportedSymbols) {
        let { nvim } = this;
        let bufnr = await nvim.eval('bufnr("%")');
        let doc = workspace_1.default.getDocument(bufnr);
        if (!doc)
            return;
        let range;
        if (visualmode) {
            range = await workspace_1.default.getSelectedRange(visualmode, doc);
        }
        else {
            let pos = await workspace_1.default.getCursorPosition();
            range = vscode_languageserver_protocol_1.Range.create(pos, pos);
        }
        let symbols = await this.getDocumentSymbols(doc);
        if (!symbols || symbols.length === 0) {
            workspace_1.default.showMessage('No symbols found', 'warning');
            return;
        }
        let properties = symbols.filter(s => s.kind == 'Property');
        symbols = symbols.filter(s => supportedSymbols.includes(s.kind));
        let selectRange;
        for (let sym of symbols.reverse()) {
            if (sym.range && !object_1.equals(sym.range, range) && position_1.rangeInRange(range, sym.range)) {
                selectRange = sym.range;
                break;
            }
        }
        if (!selectRange) {
            for (let sym of properties) {
                if (sym.range && !object_1.equals(sym.range, range) && position_1.rangeInRange(range, sym.range)) {
                    selectRange = sym.range;
                    break;
                }
            }
        }
        if (inner && selectRange) {
            let { start, end } = selectRange;
            let line = doc.getline(start.line + 1);
            let endLine = doc.getline(end.line - 1);
            selectRange = vscode_languageserver_protocol_1.Range.create(start.line + 1, line.match(/^\s*/)[0].length, end.line - 1, endLine.length);
        }
        if (selectRange)
            await workspace_1.default.selectRange(selectRange);
    }
    async tryFormatOnType(ch, bufnr, insertLeave = false) {
        if (!ch || string_1.isWord(ch) || !this.preferences.formatOnType)
            return;
        if (manager_3.default.getSession(bufnr) != null)
            return;
        let doc = workspace_1.default.getDocument(bufnr);
        if (!doc)
            return;
        if (!languages_1.default.hasOnTypeProvider(ch, doc.textDocument))
            return;
        const filetypes = this.preferences.formatOnTypeFiletypes;
        if (filetypes.length && !filetypes.includes(doc.filetype)) {
            // Only check formatOnTypeFiletypes when set, avoid breaking change
            return;
        }
        let position = await workspace_1.default.getCursorPosition();
        let origLine = doc.getline(position.line);
        let pos = insertLeave ? { line: position.line, character: origLine.length } : position;
        try {
            let { changedtick } = doc;
            await synchronizeDocument(doc);
            let edits = await languages_1.default.provideDocumentOnTypeEdits(ch, doc.textDocument, pos);
            // changed by other process
            if (doc.changedtick != changedtick || edits == null)
                return;
            if (insertLeave) {
                edits = edits.filter(edit => edit.range.start.line < position.line + 1);
            }
            if (edits && edits.length) {
                await doc.applyEdits(edits);
                let newLine = doc.getline(position.line);
                if (newLine.length > origLine.length) {
                    let character = position.character + (newLine.length - origLine.length);
                    await workspace_1.default.moveTo(vscode_languageserver_protocol_1.Position.create(position.line, character));
                }
            }
        }
        catch (e) {
            if (!/timeout\s/.test(e.message)) {
                console.error(`Error on formatOnType: ${e.message}`);
            }
        }
    }
    async triggerSignatureHelp(document, position) {
        if (this.signatureTokenSource) {
            this.signatureTokenSource.cancel();
            this.signatureTokenSource = null;
        }
        let part = document.getline(position.line).slice(0, position.character);
        if (part.endsWith(')')) {
            this.signatureFactory.close();
            return;
        }
        let tokenSource = this.signatureTokenSource = new vscode_languageserver_protocol_1.CancellationTokenSource();
        let token = tokenSource.token;
        let timer = setTimeout(() => {
            if (!token.isCancellationRequested) {
                tokenSource.cancel();
            }
        }, 3000);
        let signatureHelp = await languages_1.default.getSignatureHelp(document.textDocument, position, token);
        clearTimeout(timer);
        if (token.isCancellationRequested || !signatureHelp || signatureHelp.signatures.length == 0) {
            this.signatureFactory.close();
            return false;
        }
        let { activeParameter, activeSignature, signatures } = signatureHelp;
        if (activeSignature) {
            // make active first
            let [active] = signatures.splice(activeSignature, 1);
            if (active)
                signatures.unshift(active);
        }
        if (this.preferences.signatureHelpTarget == 'float') {
            let offset = 0;
            let paramDoc = null;
            let docs = signatures.reduce((p, c, idx) => {
                let activeIndexes = null;
                let nameIndex = c.label.indexOf('(');
                if (idx == 0 && activeParameter != null) {
                    let active = c.parameters[activeParameter];
                    if (active) {
                        let after = c.label.slice(nameIndex == -1 ? 0 : nameIndex);
                        paramDoc = active.documentation;
                        if (typeof active.label === 'string') {
                            let str = after.slice(0);
                            let ms = str.match(new RegExp('\\b' + active.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'));
                            let index = ms ? ms.index : str.indexOf(active.label);
                            if (index != -1) {
                                activeIndexes = [
                                    index + nameIndex,
                                    index + active.label.length + nameIndex
                                ];
                            }
                        }
                        else {
                            activeIndexes = active.label;
                        }
                    }
                }
                if (activeIndexes == null) {
                    activeIndexes = [nameIndex + 1, nameIndex + 1];
                }
                if (offset == 0) {
                    offset = activeIndexes[0] + 1;
                }
                p.push({
                    content: c.label,
                    filetype: document.filetype,
                    active: activeIndexes
                });
                if (paramDoc) {
                    let content = typeof paramDoc === 'string' ? paramDoc : paramDoc.value;
                    if (content.trim().length) {
                        p.push({
                            content,
                            filetype: vscode_languageserver_protocol_1.MarkupContent.is(c.documentation) ? 'markdown' : 'txt'
                        });
                    }
                }
                if (idx == 0 && c.documentation) {
                    let { documentation } = c;
                    let content = typeof documentation === 'string' ? documentation : documentation.value;
                    if (content.trim().length) {
                        p.push({
                            content,
                            filetype: vscode_languageserver_protocol_1.MarkupContent.is(c.documentation) ? 'markdown' : 'txt'
                        });
                    }
                }
                return p;
            }, []);
            let session = manager_3.default.getSession(document.bufnr);
            if (session && session.isActive) {
                let { value } = session.placeholder;
                if (!value.includes('\n'))
                    offset += value.length;
                this.signaturePosition = vscode_languageserver_protocol_1.Position.create(position.line, position.character - value.length);
            }
            else {
                this.signaturePosition = position;
            }
            await this.signatureFactory.create(docs, true, offset);
            // show float
        }
        else {
            let columns = workspace_1.default.env.columns;
            signatures = signatures.slice(0, workspace_1.default.env.cmdheight);
            let signatureList = [];
            for (let signature of signatures) {
                let parts = [];
                let { label } = signature;
                label = label.replace(/\n/g, ' ');
                if (label.length >= columns - 16) {
                    label = label.slice(0, columns - 16) + '...';
                }
                let nameIndex = label.indexOf('(');
                if (nameIndex == -1) {
                    parts = [{ text: label, type: 'Normal' }];
                }
                else {
                    parts.push({
                        text: label.slice(0, nameIndex),
                        type: 'Label'
                    });
                    let after = label.slice(nameIndex);
                    if (signatureList.length == 0 && activeParameter != null) {
                        let active = signature.parameters[activeParameter];
                        if (active) {
                            let start;
                            let end;
                            if (typeof active.label === 'string') {
                                let str = after.slice(0);
                                let ms = str.match(new RegExp('\\b' + active.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'));
                                let idx = ms ? ms.index : str.indexOf(active.label);
                                if (idx == -1) {
                                    parts.push({ text: after, type: 'Normal' });
                                }
                                else {
                                    start = idx;
                                    end = idx + active.label.length;
                                }
                            }
                            else {
                                [start, end] = active.label;
                                start = start - nameIndex;
                                end = end - nameIndex;
                            }
                            if (start != null && end != null) {
                                parts.push({ text: after.slice(0, start), type: 'Normal' });
                                parts.push({ text: after.slice(start, end), type: 'MoreMsg' });
                                parts.push({ text: after.slice(end), type: 'Normal' });
                            }
                        }
                    }
                    else {
                        parts.push({
                            text: after,
                            type: 'Normal'
                        });
                    }
                }
                signatureList.push(parts);
            }
            this.nvim.callTimer('coc#util#echo_signatures', [signatureList], true);
        }
        return true;
    }
    async showSignatureHelp() {
        let buffer = await this.nvim.buffer;
        let document = workspace_1.default.getDocument(buffer.id);
        if (!document)
            return false;
        let position = await workspace_1.default.getCursorPosition();
        return await this.triggerSignatureHelp(document, position);
    }
    async handleLocations(definition, openCommand) {
        if (!definition)
            return;
        let locations = Array.isArray(definition) ? definition : [definition];
        let len = locations.length;
        if (len == 0)
            return;
        if (len == 1 && openCommand !== false) {
            let location = definition[0];
            if (vscode_languageserver_protocol_1.LocationLink.is(definition[0])) {
                let link = definition[0];
                location = vscode_languageserver_protocol_1.Location.create(link.targetUri, link.targetRange);
            }
            let { uri, range } = location;
            await workspace_1.default.jumpTo(uri, range.start, openCommand);
        }
        else {
            await workspace_1.default.showLocations(definition);
        }
    }
    async getSelectionRanges() {
        let { document, position } = await workspace_1.default.getCurrentState();
        let selectionRanges = await languages_1.default.getSelectionRanges(document, [position]);
        if (selectionRanges && selectionRanges.length)
            return selectionRanges;
        return null;
    }
    async selectRange(visualmode, forward) {
        let { nvim } = this;
        let positions = [];
        let bufnr = await nvim.call('bufnr', '%');
        let doc = workspace_1.default.getDocument(bufnr);
        if (!doc)
            return;
        if (!forward && (!this.selectionRange || !visualmode))
            return;
        if (visualmode) {
            let range = await workspace_1.default.getSelectedRange(visualmode, doc);
            positions.push(range.start, range.end);
        }
        else {
            let position = await workspace_1.default.getCursorPosition();
            positions.push(position);
        }
        if (!forward) {
            let curr = vscode_languageserver_protocol_1.Range.create(positions[0], positions[1]);
            let { selectionRange } = this;
            while (selectionRange && selectionRange.parent) {
                if (object_1.equals(selectionRange.parent.range, curr)) {
                    break;
                }
                selectionRange = selectionRange.parent;
            }
            if (selectionRange && selectionRange.parent) {
                await workspace_1.default.selectRange(selectionRange.range);
            }
            return;
        }
        let selectionRanges = await languages_1.default.getSelectionRanges(doc.textDocument, positions);
        if (selectionRanges == null) {
            workspace_1.default.showMessage('Selection range provider not found for current document', 'warning');
            return;
        }
        if (!selectionRanges || selectionRanges.length == 0) {
            workspace_1.default.showMessage('No selection range found', 'warning');
            return;
        }
        let mode = await nvim.eval('mode()');
        if (mode != 'n')
            await nvim.eval(`feedkeys("\\<Esc>", 'in')`);
        let selectionRange;
        if (selectionRanges.length == 1) {
            selectionRange = selectionRanges[0];
        }
        else if (positions.length > 1) {
            let r = vscode_languageserver_protocol_1.Range.create(positions[0], positions[1]);
            selectionRange = selectionRanges[0];
            while (selectionRange) {
                if (object_1.equals(r, selectionRange.range)) {
                    selectionRange = selectionRange.parent;
                    continue;
                }
                if (position_1.positionInRange(positions[1], selectionRange.range) == 0) {
                    break;
                }
                selectionRange = selectionRange.parent;
            }
        }
        if (!selectionRange)
            return;
        this.selectionRange = selectionRanges[0];
        await workspace_1.default.selectRange(selectionRange.range);
    }
    async codeActionRange(start, end, only) {
        let listArgs = ['--normal', '--number-select', 'actions', `-start`, start + '', `-end`, end + ''];
        if (only == 'quickfix') {
            listArgs.push('-quickfix');
        }
        else if (only == 'source') {
            listArgs.push('-source');
        }
        await manager_2.default.start(listArgs);
    }
    /**
     * Refactor of current symbol
     */
    async doRefactor() {
        let [bufnr, cursor, filetype] = await this.nvim.eval('[bufnr("%"),coc#util#cursor(),&filetype]');
        let doc = workspace_1.default.getDocument(bufnr);
        if (!doc)
            return;
        let position = { line: cursor[0], character: cursor[1] };
        let res = await languages_1.default.prepareRename(doc.textDocument, position);
        if (res === false) {
            workspace_1.default.showMessage('Invalid position for rename', 'error');
            return;
        }
        let edit = await languages_1.default.provideRenameEdits(doc.textDocument, position, 'newname');
        if (!edit) {
            workspace_1.default.showMessage('Empty workspaceEdit from server', 'warning');
            return;
        }
        let refactor = await refactor_1.default.createFromWorkspaceEdit(edit, filetype);
        if (!refactor.buffer)
            return;
        this.refactorMap.set(refactor.buffer.id, refactor);
    }
    async saveRefactor(bufnr) {
        let refactor = this.refactorMap.get(bufnr);
        if (refactor) {
            await refactor.saveRefactor();
        }
    }
    async search(args) {
        let cwd = await this.nvim.call('getcwd');
        let refactor = new refactor_1.default();
        await refactor.createRefactorBuffer();
        if (!refactor.buffer)
            return;
        this.refactorMap.set(refactor.buffer.id, refactor);
        let search = new search_1.default(this.nvim);
        search.run(args, cwd, refactor).logError();
    }
    async previewHover(hovers) {
        let lines = [];
        let target = this.preferences.hoverTarget;
        let i = 0;
        let docs = [];
        for (let hover of hovers) {
            let { contents } = hover;
            if (i > 0)
                lines.push('---');
            if (Array.isArray(contents)) {
                for (let item of contents) {
                    if (typeof item === 'string') {
                        if (item.trim().length) {
                            lines.push(...item.split('\n'));
                            docs.push({ content: item, filetype: 'markdown' });
                        }
                    }
                    else {
                        let content = item.value.trim();
                        if (target == 'preview') {
                            content = '``` ' + item.language + '\n' + content + '\n```';
                        }
                        lines.push(...content.trim().split('\n'));
                        docs.push({ filetype: item.language, content: item.value });
                    }
                }
            }
            else if (typeof contents == 'string') {
                lines.push(...contents.split('\n'));
                docs.push({ content: contents, filetype: 'markdown' });
            }
            else if (vscode_languageserver_protocol_1.MarkedString.is(contents)) {
                let content = contents.value.trim();
                if (target == 'preview') {
                    content = '``` ' + contents.language + '\n' + content + '\n```';
                }
                lines.push(...content.split('\n'));
                docs.push({ filetype: contents.language, content: contents.value });
            }
            else if (vscode_languageserver_protocol_1.MarkupContent.is(contents)) {
                lines.push(...contents.value.split('\n'));
                docs.push({ filetype: contents.kind == 'markdown' ? 'markdown' : 'txt', content: contents.value });
            }
            i++;
        }
        if (target == 'echo') {
            const msg = lines.join('\n').trim();
            if (msg.length) {
                await this.nvim.call('coc#util#echo_hover', msg);
            }
        }
        else if (target == 'float') {
            manager_1.default.hideFloat();
            await this.hoverFactory.create(docs);
        }
        else {
            this.documentLines = lines;
            let arr = await this.nvim.call('getcurpos');
            this.hoverPosition = [workspace_1.default.bufnr, arr[1], arr[2]];
            await this.nvim.command(`pedit coc://document`);
        }
    }
    getPreferences() {
        let config = workspace_1.default.getConfiguration('coc.preferences');
        let hoverTarget = config.get('hoverTarget', 'float');
        if (hoverTarget == 'float' && !workspace_1.default.env.floating && !workspace_1.default.env.textprop) {
            hoverTarget = 'preview';
        }
        let signatureConfig = workspace_1.default.getConfiguration('signature');
        let signatureHelpTarget = signatureConfig.get('target', 'float');
        if (signatureHelpTarget == 'float' && !workspace_1.default.floatSupported) {
            signatureHelpTarget = 'echo';
        }
        this.labels = workspace_1.default.getConfiguration('suggest').get('completionItemKindLabels', {});
        this.preferences = {
            hoverTarget,
            signatureHelpTarget,
            signatureMaxHeight: signatureConfig.get('maxWindowHeight', 8),
            triggerSignatureHelp: signatureConfig.get('enable', true),
            triggerSignatureWait: Math.max(signatureConfig.get('triggerSignatureWait', 50), 50),
            signaturePreferAbove: signatureConfig.get('preferShownAbove', true),
            signatureFloatMaxWidth: signatureConfig.get('floatMaxWidth', 60),
            signatureHideOnChange: signatureConfig.get('hideOnTextChange', false),
            formatOnType: config.get('formatOnType', false),
            formatOnTypeFiletypes: config.get('formatOnTypeFiletypes', []),
            formatOnInsertLeave: config.get('formatOnInsertLeave', false),
            bracketEnterImprove: config.get('bracketEnterImprove', true),
            previewMaxHeight: config.get('previewMaxHeight', 12),
            previewAutoClose: config.get('previewAutoClose', false),
            currentFunctionSymbolAutoUpdate: config.get('currentFunctionSymbolAutoUpdate', false),
        };
    }
    onEmptyLocation(name, location) {
        if (location == null) {
            workspace_1.default.showMessage(`${name} provider not found for current document`, 'warning');
        }
        else if (location.length == 0) {
            workspace_1.default.showMessage(`${name} not found`, 'warning');
        }
    }
    dispose() {
        this.colors.dispose();
        util_1.disposeAll(this.disposables);
    }
}
exports.default = Handler;
function getPreviousContainer(containerName, symbols) {
    if (!symbols.length)
        return null;
    let i = symbols.length - 1;
    let last = symbols[i];
    if (last.text == containerName) {
        return last;
    }
    while (i >= 0) {
        let sym = symbols[i];
        if (sym.text == containerName) {
            return sym;
        }
        i--;
    }
    return null;
}
function sortDocumentSymbols(a, b) {
    let ra = a.selectionRange;
    let rb = b.selectionRange;
    if (ra.start.line < rb.start.line) {
        return -1;
    }
    if (ra.start.line > rb.start.line) {
        return 1;
    }
    return ra.start.character - rb.start.character;
}
function addDoucmentSymbol(res, sym, level) {
    let { name, selectionRange, kind, children, range } = sym;
    let { start } = selectionRange;
    res.push({
        col: start.character + 1,
        lnum: start.line + 1,
        text: name,
        level,
        kind: convert_1.getSymbolKind(kind),
        range,
        selectionRange
    });
    if (children && children.length) {
        children.sort(sortDocumentSymbols);
        for (let sym of children) {
            addDoucmentSymbol(res, sym, level + 1);
        }
    }
}
function sortSymbolInformations(a, b) {
    let sa = a.location.range.start;
    let sb = b.location.range.start;
    let d = sa.line - sb.line;
    return d == 0 ? sa.character - sb.character : d;
}
function isDocumentSymbol(a) {
    return a && !a.hasOwnProperty('location');
}
function isEmpty(location) {
    if (!location)
        return true;
    if (Array.isArray(location) && location.length == 0)
        return true;
    return false;
}
function isDocumentSymbols(a) {
    return isDocumentSymbol(a[0]);
}
async function synchronizeDocument(doc) {
    let { changedtick } = doc;
    await doc.patchChange();
    if (changedtick != doc.changedtick) {
        await util_1.wait(50);
    }
}
//# sourceMappingURL=index.js.map