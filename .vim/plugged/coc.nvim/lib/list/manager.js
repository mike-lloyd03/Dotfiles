"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ListManager = void 0;
const tslib_1 = require("tslib");
const debounce_1 = tslib_1.__importDefault(require("debounce"));
const vscode_languageserver_protocol_1 = require("vscode-languageserver-protocol");
const events_1 = tslib_1.__importDefault(require("../events"));
const extensions_1 = tslib_1.__importDefault(require("../extensions"));
const util_1 = require("../util");
const workspace_1 = tslib_1.__importDefault(require("../workspace"));
const highligher_1 = tslib_1.__importDefault(require("../model/highligher"));
const configuration_1 = tslib_1.__importDefault(require("./configuration"));
const history_1 = tslib_1.__importDefault(require("./history"));
const mappings_1 = tslib_1.__importDefault(require("./mappings"));
const prompt_1 = tslib_1.__importDefault(require("./prompt"));
const commands_1 = tslib_1.__importDefault(require("./source/commands"));
const diagnostics_1 = tslib_1.__importDefault(require("./source/diagnostics"));
const extensions_2 = tslib_1.__importDefault(require("./source/extensions"));
const folders_1 = tslib_1.__importDefault(require("./source/folders"));
const links_1 = tslib_1.__importDefault(require("./source/links"));
const lists_1 = tslib_1.__importDefault(require("./source/lists"));
const location_1 = tslib_1.__importDefault(require("./source/location"));
const outline_1 = tslib_1.__importDefault(require("./source/outline"));
const output_1 = tslib_1.__importDefault(require("./source/output"));
const services_1 = tslib_1.__importDefault(require("./source/services"));
const sources_1 = tslib_1.__importDefault(require("./source/sources"));
const symbols_1 = tslib_1.__importDefault(require("./source/symbols"));
const actions_1 = tslib_1.__importDefault(require("./source/actions"));
const ui_1 = tslib_1.__importDefault(require("./ui"));
const worker_1 = tslib_1.__importDefault(require("./worker"));
const logger = require('../util/logger')('list-manager');
const mouseKeys = ['<LeftMouse>', '<LeftDrag>', '<LeftRelease>', '<2-LeftMouse>'];
class ListManager {
    constructor() {
        this.plugTs = 0;
        this.disposables = [];
        this.args = [];
        this.listArgs = [];
        this.listMap = new Map();
        this.activated = false;
        this.executing = false;
    }
    init(nvim) {
        this.nvim = nvim;
        this.config = new configuration_1.default();
        this.prompt = new prompt_1.default(nvim, this.config);
        this.history = new history_1.default(this);
        this.mappings = new mappings_1.default(this, nvim, this.config);
        this.worker = new worker_1.default(nvim, this);
        this.ui = new ui_1.default(nvim, this.config);
        events_1.default.on('VimResized', () => {
            if (this.isActivated)
                nvim.command('redraw!', true);
        }, null, this.disposables);
        events_1.default.on('InputChar', this.onInputChar, this, this.disposables);
        events_1.default.on('FocusGained', debounce_1.default(() => {
            if (this.activated)
                this.prompt.drawPrompt();
        }, 100), null, this.disposables);
        events_1.default.on('BufEnter', debounce_1.default(async () => {
            let { bufnr } = this.ui;
            if (!bufnr)
                return;
            if (!this.activated) {
                this.ui.hide();
                return;
            }
            let curr = await nvim.call('bufnr', '%');
            if (curr == bufnr) {
                this.prompt.start();
            }
            else {
                nvim.pauseNotification();
                this.prompt.cancel();
                await nvim.resumeNotification();
            }
        }, 100), null, this.disposables);
        this.ui.onDidChangeLine(debounce_1.default(async () => {
            if (!this.activated)
                return;
            let previewing = await nvim.call('coc#util#has_preview');
            let mode = await this.nvim.mode;
            if (mode.blocking || mode.mode != 'n')
                return;
            if (previewing)
                await this.doAction('preview');
        }, 100), null, this.disposables);
        this.ui.onDidLineChange(debounce_1.default(async () => {
            let { autoPreview } = this.listOptions;
            if (!autoPreview || !this.activated)
                return;
            await this.doAction('preview');
        }, 100), null, this.disposables);
        this.ui.onDidChangeLine(this.resolveItem, this, this.disposables);
        this.ui.onDidLineChange(this.resolveItem, this, this.disposables);
        this.ui.onDidOpen(() => {
            if (this.currList) {
                if (typeof this.currList.doHighlight == 'function') {
                    this.currList.doHighlight();
                }
            }
        }, null, this.disposables);
        this.ui.onDidClose(async () => {
            await this.cancel();
        }, null, this.disposables);
        this.ui.onDidChange(() => {
            if (this.activated) {
                this.updateStatus();
            }
            this.prompt.drawPrompt();
        }, null, this.disposables);
        this.ui.onDidDoubleClick(async () => {
            await this.doAction();
        }, null, this.disposables);
        this.worker.onDidChangeItems(async ({ items, highlights, reload, append }) => {
            if (!this.activated)
                return;
            if (append) {
                this.ui.addHighlights(highlights, true);
                await this.ui.appendItems(items);
            }
            else {
                this.ui.addHighlights(highlights);
                await this.ui.drawItems(items, this.name, this.listOptions, reload);
            }
        }, null, this.disposables);
        this.registerList(new links_1.default(nvim));
        this.registerList(new location_1.default(nvim));
        this.registerList(new symbols_1.default(nvim));
        this.registerList(new outline_1.default(nvim));
        this.registerList(new commands_1.default(nvim));
        this.registerList(new extensions_2.default(nvim));
        this.registerList(new diagnostics_1.default(nvim));
        this.registerList(new sources_1.default(nvim));
        this.registerList(new services_1.default(nvim));
        this.registerList(new output_1.default(nvim));
        this.registerList(new lists_1.default(nvim, this.listMap));
        this.registerList(new folders_1.default(nvim));
        this.registerList(new actions_1.default(nvim));
    }
    async start(args) {
        if (this.activated)
            return;
        let res = this.parseArgs(args);
        if (!res)
            return;
        this.args = args;
        this.activated = true;
        let { list, options, listArgs } = res;
        try {
            await this.getCharMap();
            let res = await this.nvim.eval('[win_getid(),bufnr("%"),winheight("%")]');
            this.reset();
            this.listOptions = options;
            this.currList = list;
            this.listArgs = listArgs;
            this.cwd = workspace_1.default.cwd;
            this.history.load();
            this.window = this.nvim.createWindow(res[0]);
            this.buffer = this.nvim.createBuffer(res[1]);
            this.savedHeight = res[2];
            this.prompt.start(options);
            await this.worker.loadItems();
        }
        catch (e) {
            await this.cancel();
            let msg = e instanceof Error ? e.message : e.toString();
            workspace_1.default.showMessage(`Error on "CocList ${list.name}": ${msg}`, 'error');
            logger.error(e);
        }
    }
    async resume() {
        let { name, ui, currList, nvim } = this;
        if (!currList)
            return;
        this.activated = true;
        this.window = await nvim.window;
        this.prompt.start();
        await ui.resume(name, this.listOptions);
        if (this.listOptions.autoPreview) {
            await this.doAction('preview');
        }
    }
    async doAction(name) {
        let { currList } = this;
        name = name || currList.defaultAction;
        let action = currList.actions.find(o => o.name == name);
        if (!action) {
            workspace_1.default.showMessage(`Action ${name} not found`, 'error');
            return;
        }
        let items;
        if (name == 'preview') {
            let item = await this.ui.item;
            items = item ? [item] : [];
        }
        else {
            items = await this.ui.getItems();
        }
        if (items.length)
            await this.doItemAction(items, action);
    }
    async previous() {
        let { ui } = this;
        let item = ui.getItem(-1);
        if (!item)
            return;
        ui.index = ui.index - 1;
        await this.doItemAction([item], this.defaultAction);
        await ui.echoMessage(item);
    }
    async next() {
        let { ui } = this;
        let item = ui.getItem(1);
        if (!item)
            return;
        ui.index = ui.index + 1;
        await this.doItemAction([item], this.defaultAction);
        await ui.echoMessage(item);
    }
    async cancel(close = true) {
        let { nvim, ui, savedHeight } = this;
        if (!this.activated) {
            nvim.call('coc#list#stop_prompt', [], true);
            return;
        }
        this.activated = false;
        this.worker.stop();
        this.history.add();
        nvim.pauseNotification();
        nvim.command('pclose', true);
        this.prompt.cancel();
        if (close) {
            ui.hide();
            if (this.window) {
                nvim.call('coc#list#restore', [this.window.id, savedHeight], true);
            }
        }
        await nvim.resumeNotification();
    }
    switchMatcher() {
        let { matcher, interactive } = this.listOptions;
        if (interactive)
            return;
        const list = ['fuzzy', 'strict', 'regex'];
        let idx = list.indexOf(matcher) + 1;
        if (idx >= list.length)
            idx = 0;
        this.listOptions.matcher = list[idx];
        this.prompt.matcher = list[idx];
        this.worker.drawItems();
    }
    async togglePreview() {
        let { nvim } = this;
        let has = await nvim.call('coc#list#has_preview');
        if (has) {
            await nvim.command('pclose');
            await nvim.command('redraw');
        }
        else {
            await this.doAction('preview');
        }
    }
    async chooseAction() {
        let { nvim, currList } = this;
        if (!this.activated)
            return;
        let { actions, defaultAction } = currList;
        let names = actions.map(o => o.name);
        let idx = names.indexOf(defaultAction);
        if (idx != -1) {
            names.splice(idx, 1);
            names.unshift(defaultAction);
        }
        let shortcuts = new Set();
        let choices = [];
        let invalids = [];
        for (let name of names) {
            let i = 0;
            for (let ch of name) {
                if (!shortcuts.has(ch)) {
                    shortcuts.add(ch);
                    choices.push(`${name.slice(0, i)}&${name.slice(i)}`);
                    break;
                }
                i++;
            }
            if (i == name.length) {
                invalids.push(name);
            }
        }
        if (invalids.length) {
            logger.error(`Can't create shortcut for actions: ${invalids.join(',')} of "${currList.name}" list`);
            names = names.filter(s => !invalids.includes(s));
        }
        await nvim.call('coc#list#stop_prompt');
        let n = await nvim.call('confirm', ['Choose action:', choices.join('\n')]);
        await util_1.wait(10);
        this.prompt.start();
        if (n)
            await this.doAction(names[n - 1]);
    }
    get name() {
        let { currList } = this;
        return currList ? currList.name : 'anonymous';
    }
    get list() {
        return this.currList;
    }
    parseArgs(args) {
        let options = [];
        let interactive = false;
        let autoPreview = false;
        let numberSelect = false;
        let name;
        let input = '';
        let matcher = 'fuzzy';
        let position = 'bottom';
        let listArgs = [];
        let listOptions = [];
        for (let arg of args) {
            if (!name && arg.startsWith('-')) {
                listOptions.push(arg);
            }
            else if (!name) {
                if (!/^\w+$/.test(arg)) {
                    workspace_1.default.showMessage(`Invalid list option: "${arg}"`, 'error');
                    return null;
                }
                name = arg;
            }
            else {
                listArgs.push(arg);
            }
        }
        name = name || 'lists';
        let config = workspace_1.default.getConfiguration(`list.source.${name}`);
        if (!listOptions.length && !listArgs.length)
            listOptions = config.get('defaultOptions', []);
        if (!listArgs.length)
            listArgs = config.get('defaultArgs', []);
        for (let opt of listOptions) {
            if (opt.startsWith('--input')) {
                input = opt.slice(8);
            }
            else if (opt == '--number-select' || opt == '-N') {
                numberSelect = true;
            }
            else if (opt == '--auto-preview' || opt == '-A') {
                autoPreview = true;
            }
            else if (opt == '--regex' || opt == '-R') {
                matcher = 'regex';
            }
            else if (opt == '--strict' || opt == '-S') {
                matcher = 'strict';
            }
            else if (opt == '--interactive' || opt == '-I') {
                interactive = true;
            }
            else if (opt == '--top') {
                position = 'top';
            }
            else if (opt == '--tab') {
                position = 'tab';
            }
            else if (opt == '--ignore-case' || opt == '--normal' || opt == '--no-sort') {
                options.push(opt.slice(2));
            }
            else {
                workspace_1.default.showMessage(`Invalid option "${opt}" of list`, 'error');
                return null;
            }
        }
        let list = this.listMap.get(name);
        if (!list) {
            workspace_1.default.showMessage(`List ${name} not found`, 'error');
            return null;
        }
        if (interactive && !list.interactive) {
            workspace_1.default.showMessage(`Interactive mode of "${name}" list not supported`, 'error');
            return null;
        }
        return {
            list,
            listArgs,
            options: {
                numberSelect,
                autoPreview,
                input,
                interactive,
                matcher,
                position,
                ignorecase: options.includes('ignore-case') ? true : false,
                mode: !options.includes('normal') ? 'insert' : 'normal',
                sort: !options.includes('no-sort') ? true : false
            },
        };
    }
    updateStatus() {
        let { ui, currList, activated, nvim } = this;
        if (!activated)
            return;
        let buf = nvim.createBuffer(ui.bufnr);
        let status = {
            mode: this.prompt.mode.toUpperCase(),
            args: this.args.join(' '),
            name: currList.name,
            total: this.worker.length,
            cwd: this.cwd,
        };
        buf.setVar('list_status', status, true);
        if (ui.window)
            nvim.command('redraws', true);
    }
    async onInputChar(ch, charmod) {
        let { mode } = this.prompt;
        let mapped = this.charMap.get(ch);
        let now = Date.now();
        if (mapped == '<plug>' || now - this.plugTs < 2) {
            this.plugTs = now;
            return;
        }
        if (!ch)
            return;
        if (ch == '\x1b') {
            await this.cancel();
            return;
        }
        if (!this.activated) {
            this.nvim.call('coc#list#stop_prompt', [], true);
            return;
        }
        try {
            if (mode == 'insert') {
                await this.onInsertInput(ch, charmod);
            }
            else {
                await this.onNormalInput(ch, charmod);
            }
        }
        catch (e) {
            workspace_1.default.showMessage(`Error on input ${ch}: ${e}`);
            logger.error(e);
        }
    }
    async onInsertInput(ch, charmod) {
        let { nvim } = this;
        let inserted = this.charMap.get(ch) || ch;
        if (mouseKeys.includes(inserted)) {
            await this.onMouseEvent(inserted);
            return;
        }
        if (this.listOptions.numberSelect) {
            let code = ch.charCodeAt(0);
            if (code >= 48 && code <= 57) {
                let n = Number(ch);
                if (n == 0)
                    n = 10;
                if (this.ui.length >= n) {
                    nvim.pauseNotification();
                    this.ui.setCursor(Number(ch), 0);
                    await nvim.resumeNotification();
                    await this.doAction();
                }
                return;
            }
        }
        let done = await this.mappings.doInsertKeymap(inserted);
        if (done || charmod || this.charMap.has(ch))
            return;
        for (let s of ch) {
            let code = s.codePointAt(0);
            if (code == 65533)
                return;
            // exclude control characer
            if (code < 32 || code >= 127 && code <= 159)
                return;
            await this.prompt.acceptCharacter(s);
        }
    }
    async onNormalInput(ch, _charmod) {
        let inserted = this.charMap.get(ch) || ch;
        if (mouseKeys.includes(inserted)) {
            await this.onMouseEvent(inserted);
            return;
        }
        let done = await this.mappings.doNormalKeymap(inserted);
        if (!done)
            await this.feedkeys(inserted);
    }
    onMouseEvent(key) {
        switch (key) {
            case '<LeftMouse>':
                return this.ui.onMouse('mouseDown');
            case '<LeftDrag>':
                return this.ui.onMouse('mouseDrag');
            case '<LeftRelease>':
                return this.ui.onMouse('mouseUp');
            case '<2-LeftMouse>':
                return this.ui.onMouse('doubleClick');
        }
    }
    async feedkeys(key, remap = true) {
        let { nvim } = this;
        key = key.startsWith('<') && key.endsWith('>') ? `\\${key}` : key;
        await nvim.call('coc#list#stop_prompt', [1]);
        await nvim.call('eval', [`feedkeys("${key}", "${remap ? 'i' : 'in'}")`]);
        this.prompt.start();
    }
    async command(command) {
        let { nvim } = this;
        await nvim.call('coc#list#stop_prompt', [1]);
        await nvim.command(command);
        this.prompt.start();
    }
    async normal(command, bang = true) {
        let { nvim } = this;
        await nvim.call('coc#list#stop_prompt', [1]);
        await nvim.command(`normal${bang ? '!' : ''} ${command}`);
        this.prompt.start();
    }
    async call(fname) {
        if (!this.currList || !this.window)
            return;
        await this.nvim.call('coc#list#stop_prompt', []);
        let buf = await this.window.buffer;
        let targets = await this.ui.getItems();
        let context = {
            name: this.currList.name,
            args: this.listArgs,
            input: this.prompt.input,
            winid: this.window.id,
            bufnr: buf.id,
            targets
        };
        let res = await this.nvim.call(fname, [context]);
        this.prompt.start();
        return res;
    }
    async showHelp() {
        // echo help
        await this.cancel();
        let { list, nvim } = this;
        if (!list)
            return;
        let previewHeight = await nvim.eval('&previewheight');
        nvim.pauseNotification();
        nvim.command(`belowright ${previewHeight}sp +setl\\ previewwindow [LIST HELP]`, true);
        nvim.command('setl nobuflisted noswapfile buftype=nofile bufhidden=wipe', true);
        await nvim.resumeNotification();
        let hasOptions = list.options && list.options.length;
        let buf = await nvim.buffer;
        let highligher = new highligher_1.default();
        highligher.addLine('NAME', 'Label');
        highligher.addLine(`  ${list.name} - ${list.description || ''}\n`);
        highligher.addLine('SYNOPSIS', 'Label');
        highligher.addLine(`  :CocList [LIST OPTIONS] ${list.name}${hasOptions ? ' [ARGUMENTS]' : ''}\n`);
        if (list.detail) {
            highligher.addLine('DESCRIPTION', 'Label');
            let lines = list.detail.split('\n').map(s => '  ' + s);
            highligher.addLine(lines.join('\n') + '\n');
        }
        if (hasOptions) {
            highligher.addLine('ARGUMENTS', 'Label');
            highligher.addLine('');
            for (let opt of list.options) {
                highligher.addLine(opt.name, 'Special');
                highligher.addLine(`  ${opt.description}`);
                highligher.addLine('');
            }
            highligher.addLine('');
        }
        let config = workspace_1.default.getConfiguration(`list.source.${list.name}`);
        if (Object.keys(config).length) {
            highligher.addLine('CONFIGURATIONS', 'Label');
            highligher.addLine('');
            let props = {};
            extensions_1.default.all.forEach(extension => {
                let { packageJSON } = extension;
                let { contributes } = packageJSON;
                if (!contributes)
                    return;
                let { configuration } = contributes;
                if (configuration) {
                    let { properties } = configuration;
                    if (properties) {
                        for (let key of Object.keys(properties)) {
                            props[key] = properties[key];
                        }
                    }
                }
            });
            for (let key of Object.keys(config)) {
                let val = config[key];
                let name = `list.source.${list.name}.${key}`;
                let description = props[name] && props[name].description ? props[name].description : key;
                highligher.addLine(`  "${name}"`, 'MoreMsg');
                highligher.addText(` - ${description}, current value: `);
                highligher.addText(JSON.stringify(val), 'Special');
            }
            highligher.addLine('');
        }
        highligher.addLine('ACTIONS', 'Label');
        highligher.addLine(`  ${list.actions.map(o => o.name).join(', ')}`);
        highligher.addLine('');
        highligher.addLine(`see ':h coc-list-options' for available list options.`, 'Comment');
        nvim.pauseNotification();
        highligher.render(buf, 0, -1);
        nvim.command('setl nomod', true);
        nvim.command('setl nomodifiable', true);
        nvim.command('normal! gg', true);
        nvim.command('nnoremap <buffer> q :bd!<CR>', true);
        await nvim.resumeNotification();
    }
    get context() {
        return {
            options: this.listOptions,
            args: this.listArgs,
            input: this.prompt.input,
            window: this.window,
            buffer: this.buffer,
            listWindow: this.ui.window,
            cwd: this.cwd
        };
    }
    registerList(list) {
        const { name } = list;
        let exists = this.listMap.get(name);
        if (this.listMap.has(name)) {
            if (exists) {
                if (typeof exists.dispose == 'function') {
                    exists.dispose();
                }
                this.listMap.delete(name);
            }
            workspace_1.default.showMessage(`list "${name}" recreated.`);
        }
        this.listMap.set(name, list);
        extensions_1.default.addSchemeProperty(`list.source.${name}.defaultOptions`, {
            type: 'array',
            default: list.interactive ? ['--interactive'] : [],
            description: `Default list options of "${name}" list, only used when both list option and argument are empty.`,
            uniqueItems: true,
            items: {
                type: 'string',
                enum: ['--top', '--normal', '--no-sort', '--input', '--tab',
                    '--strict', '--regex', '--ignore-case', '--number-select',
                    '--interactive', '--auto-preview']
            }
        });
        extensions_1.default.addSchemeProperty(`list.source.${name}.defaultArgs`, {
            type: 'array',
            default: [],
            description: `Default argument list of "${name}" list, only used when list argument is empty.`,
            uniqueItems: true,
            items: { type: 'string' }
        });
        return vscode_languageserver_protocol_1.Disposable.create(() => {
            if (typeof list.dispose == 'function') {
                list.dispose();
            }
            this.listMap.delete(name);
        });
    }
    get names() {
        return Array.from(this.listMap.keys());
    }
    toggleMode() {
        let { mode } = this.prompt;
        this.prompt.mode = mode == 'normal' ? 'insert' : 'normal';
        this.updateStatus();
    }
    getConfig(key, defaultValue) {
        return this.config.get(key, defaultValue);
    }
    get isActivated() {
        return this.activated;
    }
    stop() {
        this.worker.stop();
    }
    reset() {
        this.window = null;
        this.listOptions = null;
        this.prompt.reset();
        this.worker.stop();
        this.ui.reset();
    }
    dispose() {
        if (this.config) {
            this.config.dispose();
        }
        util_1.disposeAll(this.disposables);
    }
    async getCharMap() {
        if (this.charMap)
            return;
        this.charMap = new Map();
        let chars = await this.nvim.call('coc#list#get_chars');
        Object.keys(chars).forEach(key => {
            this.charMap.set(chars[key], key);
        });
        return;
    }
    async doItemAction(items, action) {
        if (this.executing)
            return;
        this.executing = true;
        let { nvim } = this;
        let shouldCancel = action.persist !== true && action.name != 'preview';
        try {
            if (shouldCancel) {
                await this.cancel();
            }
            else if (action.name != 'preview') {
                await nvim.call('coc#list#stop_prompt');
            }
            if (!shouldCancel && !this.isActivated)
                return;
            await this.nvim.command('stopinsert');
            if (action.multiple) {
                await Promise.resolve(action.execute(items, this.context));
            }
            else if (action.parallel) {
                await Promise.all(items.map(item => Promise.resolve(action.execute(item, this.context))));
            }
            else {
                for (let item of items) {
                    await Promise.resolve(action.execute(item, this.context));
                }
            }
            if (!shouldCancel) {
                if (!this.isActivated) {
                    this.nvim.command('pclose', true);
                    return;
                }
                nvim.pauseNotification();
                if (action.name != 'preview') {
                    this.prompt.start();
                }
                this.ui.restoreWindow();
                nvim.resumeNotification(false, true).logError();
                if (action.reload)
                    await this.worker.loadItems(true);
            }
        }
        catch (e) {
            console.error(e);
            if (!shouldCancel && this.activated) {
                this.prompt.start();
            }
        }
        this.executing = false;
    }
    async resolveItem() {
        if (!this.activated)
            return;
        let index = this.ui.index;
        let item = this.ui.getItem(0);
        if (!item || item.resolved)
            return;
        let { list } = this;
        if (typeof list.resolveItem == 'function') {
            let resolved = await list.resolveItem(item);
            if (resolved && index == this.ui.index) {
                await this.ui.updateItem(resolved, index);
            }
        }
    }
    get defaultAction() {
        let { currList } = this;
        let { defaultAction } = currList;
        return currList.actions.find(o => o.name == defaultAction);
    }
}
exports.ListManager = ListManager;
exports.default = new ListManager();
//# sourceMappingURL=manager.js.map