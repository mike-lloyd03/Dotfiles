/// <reference types="node" />
import { Neovim, Buffer, Window } from '@chemzqm/neovim';
import EventEmitter from 'events';
import { Disposable } from 'vscode-languageserver-protocol';
import { Documentation, Env } from '../types';
export interface WindowConfig {
    width: number;
    height: number;
    col: number;
    row: number;
    relative: 'cursor' | 'win' | 'editor';
    style?: string;
}
export default class FloatFactory extends EventEmitter implements Disposable {
    private nvim;
    private env;
    private preferTop;
    private maxHeight;
    private maxWidth?;
    private autoHide;
    private targetBufnr;
    private winid;
    private _bufnr;
    private mutex;
    private disposables;
    private floatBuffer;
    private tokenSource;
    private alignTop;
    private pumAlignTop;
    private cursor;
    private onCursorMoved;
    constructor(nvim: Neovim, env: Env, preferTop?: boolean, maxHeight?: number, maxWidth?: number, autoHide?: boolean);
    private _onCursorMoved;
    private getWindowConfig;
    create(docs: Documentation[], allowSelection?: boolean, offsetX?: number): Promise<void>;
    private createPopup;
    /**
     * Close float window
     */
    close(): void;
    private cancel;
    dispose(): void;
    get bufnr(): number;
    get buffer(): Buffer | null;
    get window(): Window | null;
    activated(): Promise<boolean>;
    private getMaxWindowHeight;
}
