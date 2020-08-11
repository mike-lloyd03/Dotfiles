import { Disposable } from 'vscode-languageserver-protocol';
import { PopupChangeEvent, InsertChange, VimCompleteItem } from './types';
export declare type Result = void | Promise<void>;
export declare type BufEvents = 'BufHidden' | 'BufEnter' | 'BufWritePost' | 'CursorHold' | 'InsertLeave' | 'TermOpen' | 'TermClose' | 'InsertEnter' | 'BufCreate' | 'BufUnload' | 'BufWritePre' | 'CursorHoldI' | 'Enter';
export declare type EmptyEvents = 'FocusGained' | 'VimLeave';
export declare type InsertChangeEvents = 'TextChangedP' | 'TextChangedI';
export declare type TaskEvents = 'TaskExit' | 'TaskStderr' | 'TaskStdout';
export declare type AllEvents = BufEvents | EmptyEvents | MoveEvents | TaskEvents | InsertChangeEvents | 'CompleteDone' | 'TextChanged' | 'MenuPopupChanged' | 'InsertCharPre' | 'FileType' | 'BufWinEnter' | 'BufWinLeave' | 'VimResized' | 'DirChanged' | 'OptionSet' | 'Command' | 'BufReadCmd' | 'GlobalChange' | 'InputChar';
export declare type MoveEvents = 'CursorMoved' | 'CursorMovedI';
export declare type OptionValue = string | number | boolean;
export interface CursorPosition {
    bufnr: number;
    lnum: number;
    col: number;
    insert: boolean;
}
declare class Events {
    private handlers;
    private _cursor;
    private insertMode;
    get cursor(): CursorPosition;
    fire(event: string, args: any[]): Promise<void>;
    on(event: EmptyEvents | AllEvents[], handler: () => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: BufEvents, handler: (bufnr: number) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: MoveEvents, handler: (bufnr: number, cursor: [number, number]) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: InsertChangeEvents, handler: (bufnr: number, info: InsertChange) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'TextChanged', handler: (bufnr: number, changedtick: number) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'TaskExit', handler: (id: string, code: number) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'TaskStderr' | 'TaskStdout', handler: (id: string, lines: string[]) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'BufReadCmd', handler: (scheme: string, fullpath: string) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'VimResized', handler: (columns: number, lines: number) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'Command', handler: (name: string) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'MenuPopupChanged', handler: (event: PopupChangeEvent, cursorline: number) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'CompleteDone', handler: (item: VimCompleteItem) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'InsertCharPre', handler: (character: string) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'FileType', handler: (filetype: string, bufnr: number) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'BufWinEnter' | 'BufWinLeave', handler: (bufnr: number, winid: number) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'DirChanged', handler: (cwd: string) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'OptionSet' | 'GlobalChange', handler: (option: string, oldVal: OptionValue, newVal: OptionValue) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
    on(event: 'InputChar', handler: (character: string, mode: number) => Result, thisArg?: any, disposables?: Disposable[]): Disposable;
}
declare const _default: Events;
export default _default;
