import { CancellationToken, CodeAction, CodeActionContext, CodeActionKind, CodeLens, ColorInformation, ColorPresentation, Disposable, DocumentHighlight, DocumentLink, DocumentSelector, DocumentSymbol, FoldingRange, FormattingOptions, Hover, Location, LocationLink, Position, Range, SelectionRange, SignatureHelp, SymbolInformation, TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CodeActionProvider, CodeLensProvider, CompletionItemProvider, DeclarationProvider, DefinitionProvider, DocumentColorProvider, DocumentFormattingEditProvider, DocumentLinkProvider, DocumentRangeFormattingEditProvider, DocumentSymbolProvider, FoldingContext, FoldingRangeProvider, HoverProvider, ImplementationProvider, OnTypeFormattingEditProvider, ReferenceContext, ReferenceProvider, RenameProvider, SelectionRangeProvider, SignatureHelpProvider, TypeDefinitionProvider, WorkspaceSymbolProvider } from './provider';
import { DiagnosticCollection, ISource } from './types';
export interface CompletionSource {
    id: string;
    source: ISource;
    languageIds: string[];
}
export declare function check(_target: any, key: string, descriptor: any): void;
declare class Languages {
    private completeConfig;
    private onTypeFormatManager;
    private documentLinkManager;
    private documentColorManager;
    private foldingRangeManager;
    private renameManager;
    private formatManager;
    private codeActionManager;
    private workspaceSymbolsManager;
    private formatRangeManager;
    private hoverManager;
    private signatureManager;
    private documentSymbolManager;
    private documentHighlightManager;
    private definitionManager;
    private declarationManager;
    private typeDefinitionManager;
    private referenceManager;
    private implementationManager;
    private codeLensManager;
    private selectionRangeManager;
    private cancelTokenSource;
    private completionItemKindMap;
    constructor();
    private get nvim();
    private loadCompleteConfig;
    registerOnTypeFormattingEditProvider(selector: DocumentSelector, provider: OnTypeFormattingEditProvider, triggerCharacters: string[]): Disposable;
    registerCompletionItemProvider(name: string, shortcut: string, languageIds: string | string[] | null, provider: CompletionItemProvider, triggerCharacters?: string[], priority?: number, allCommitCharacters?: string[]): Disposable;
    registerCodeActionProvider(selector: DocumentSelector, provider: CodeActionProvider, clientId: string, codeActionKinds?: CodeActionKind[]): Disposable;
    registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable;
    registerSelectionRangeProvider(selector: DocumentSelector, provider: SelectionRangeProvider): Disposable;
    registerSignatureHelpProvider(selector: DocumentSelector, provider: SignatureHelpProvider, triggerCharacters?: string[]): Disposable;
    registerDocumentSymbolProvider(selector: DocumentSelector, provider: DocumentSymbolProvider): Disposable;
    registerFoldingRangeProvider(selector: DocumentSelector, provider: FoldingRangeProvider): Disposable;
    registerDocumentHighlightProvider(selector: DocumentSelector, provider: any): Disposable;
    registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable;
    registerDocumentLinkProvider(selector: DocumentSelector, provider: DocumentLinkProvider): Disposable;
    registerDocumentColorProvider(selector: DocumentSelector, provider: DocumentColorProvider): Disposable;
    registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable;
    registerDeclarationProvider(selector: DocumentSelector, provider: DeclarationProvider): Disposable;
    registerTypeDefinitionProvider(selector: DocumentSelector, provider: TypeDefinitionProvider): Disposable;
    registerImplementationProvider(selector: DocumentSelector, provider: ImplementationProvider): Disposable;
    registerReferencesProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable;
    registerRenameProvider(selector: DocumentSelector, provider: RenameProvider): Disposable;
    registerWorkspaceSymbolProvider(selector: DocumentSelector, provider: WorkspaceSymbolProvider): Disposable;
    registerDocumentFormatProvider(selector: DocumentSelector, provider: DocumentFormattingEditProvider, priority?: number): Disposable;
    registerDocumentRangeFormatProvider(selector: DocumentSelector, provider: DocumentRangeFormattingEditProvider, priority?: number): Disposable;
    shouldTriggerSignatureHelp(document: TextDocument, triggerCharacter: string): boolean;
    getHover(document: TextDocument, position: Position): Promise<Hover[]>;
    getSignatureHelp(document: TextDocument, position: Position, token: CancellationToken): Promise<SignatureHelp>;
    getDefinition(document: TextDocument, position: Position): Promise<Location[]>;
    getDeclaration(document: TextDocument, position: Position): Promise<Location[] | Location | LocationLink[] | null>;
    getTypeDefinition(document: TextDocument, position: Position): Promise<Location[]>;
    getImplementation(document: TextDocument, position: Position): Promise<Location[]>;
    getReferences(document: TextDocument, context: ReferenceContext, position: Position): Promise<Location[]>;
    getDocumentSymbol(document: TextDocument): Promise<SymbolInformation[] | DocumentSymbol[]>;
    getSelectionRanges(document: TextDocument, positions: Position[]): Promise<SelectionRange[] | null>;
    getWorkspaceSymbols(document: TextDocument, query: string): Promise<SymbolInformation[]>;
    resolveWorkspaceSymbol(symbol: SymbolInformation): Promise<SymbolInformation>;
    provideRenameEdits(document: TextDocument, position: Position, newName: string): Promise<WorkspaceEdit>;
    prepareRename(document: TextDocument, position: Position): Promise<Range | {
        range: Range;
        placeholder: string;
    } | false>;
    provideDocumentFormattingEdits(document: TextDocument, options: FormattingOptions): Promise<TextEdit[]>;
    provideDocumentRangeFormattingEdits(document: TextDocument, range: Range, options: FormattingOptions): Promise<TextEdit[]>;
    /**
     * Get CodeAction list for current document
     *
     * @public
     * @param {TextDocument} document
     * @param {Range} range
     * @param {CodeActionContext} context
     * @returns {Promise<CodeAction[]>}
     */
    getCodeActions(document: TextDocument, range: Range, context: CodeActionContext, silent?: boolean): Promise<Map<string, CodeAction[]>>;
    getDocumentHighLight(document: TextDocument, position: Position): Promise<DocumentHighlight[]>;
    getDocumentLinks(document: TextDocument): Promise<DocumentLink[]>;
    resolveDocumentLink(link: DocumentLink): Promise<DocumentLink>;
    provideDocumentColors(document: TextDocument): Promise<ColorInformation[] | null>;
    provideFoldingRanges(document: TextDocument, context: FoldingContext): Promise<FoldingRange[] | null>;
    provideColorPresentations(color: ColorInformation, document: TextDocument): Promise<ColorPresentation[]>;
    getCodeLens(document: TextDocument): Promise<CodeLens[]>;
    resolveCodeLens(codeLens: CodeLens): Promise<CodeLens>;
    provideDocumentOnTypeEdits(character: string, document: TextDocument, position: Position): Promise<TextEdit[] | null>;
    hasOnTypeProvider(character: string, document: TextDocument): boolean;
    hasProvider(id: string, document: TextDocument): boolean;
    dispose(): void;
    createDiagnosticCollection(owner: string): DiagnosticCollection;
    private createCompleteSource;
    private get token();
    private applyTextEdit;
    private applyAdditionalEdits;
    private getStartColumn;
    private convertVimCompleteItem;
}
declare const _default: Languages;
export default _default;
