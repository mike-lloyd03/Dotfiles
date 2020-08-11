import fs from 'fs'
import path from 'path'
import { Neovim } from '@chemzqm/neovim'
import { Position, Range, TextEdit } from 'vscode-languageserver-protocol'
import workspace from '../../workspace'
import helper from '../helper'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { Disposable } from '@chemzqm/neovim/lib/api/Buffer'
import { disposeAll } from '../../util'
import Document from '../../model/document'
import { URI } from 'vscode-uri'

let nvim: Neovim
jest.setTimeout(5000)

beforeAll(async () => {
  await helper.setup()
  nvim = helper.nvim
})

afterAll(async () => {
  await helper.shutdown()
})

afterEach(async () => {
  await helper.reset()
})

describe('document model properties', () => {
  it('should parse iskeyword', async () => {
    let doc = await helper.createDocument()
    await nvim.setLine('foo bar')
    doc.forceSync()
    let words = doc.words
    expect(words).toEqual(['foo', 'bar'])
  })

  it('should applyEdits', async () => {
    let doc = await helper.createDocument()
    let edits: TextEdit[] = []
    edits.push({
      range: Range.create(0, 0, 0, 0),
      newText: 'a\n'
    })
    edits.push({
      range: Range.create(0, 0, 0, 0),
      newText: 'b\n'
    })
    await doc.applyEdits(edits)
    let content = doc.getDocumentContent()
    expect(content).toBe('a\nb\n\n')
  })

  it('should parse iskeyword of character range', async () => {
    await nvim.setOption('iskeyword', 'a-z,A-Z,48-57,_')
    let doc = await helper.createDocument()
    let opt = await nvim.getOption('iskeyword')
    expect(opt).toBe('a-z,A-Z,48-57,_')
    await nvim.setLine('foo bar')
    doc.forceSync()
    await helper.wait(100)
    let words = doc.words
    expect(words).toEqual(['foo', 'bar'])
  })

  it('should get word range', async () => {
    await helper.createDocument()
    await nvim.setLine('foo bar')
    await helper.wait(30)
    let doc = await workspace.document
    let range = doc.getWordRangeAtPosition({ line: 0, character: 0 })
    expect(range).toEqual(Range.create(0, 0, 0, 3))
    range = doc.getWordRangeAtPosition({ line: 0, character: 3 })
    expect(range).toBeNull()
    range = doc.getWordRangeAtPosition({ line: 0, character: 4 })
    expect(range).toEqual(Range.create(0, 4, 0, 7))
    range = doc.getWordRangeAtPosition({ line: 0, character: 7 })
    expect(range).toBeNull()
  })

  it('should get symbol ranges', async () => {
    let doc = await helper.createDocument()
    await nvim.setLine('foo bar foo')
    let ranges = doc.getSymbolRanges('foo')
    expect(ranges.length).toBe(2)
  })

  it('should get localify bonus', async () => {
    let doc = await helper.createDocument()
    let { buffer } = doc
    await buffer.setLines(['context content clearTimeout', '', 'product confirm'],
      { start: 0, end: -1, strictIndexing: false })
    await helper.wait(100)
    let pos: Position = { line: 1, character: 0 }
    let res = doc.getLocalifyBonus(pos, pos)
    expect(res.has('confirm')).toBe(true)
    expect(res.has('clearTimeout')).toBe(true)
  })

  it('should get current line', async () => {
    let doc = await helper.createDocument()
    let { buffer } = doc
    await buffer.setLines(['first line', 'second line'],
      { start: 0, end: -1, strictIndexing: false })
    await helper.wait(30)
    let line = doc.getline(1, true)
    expect(line).toBe('second line')
  })

  it('should get cached line', async () => {
    let doc = await helper.createDocument()
    let { buffer } = doc
    await buffer.setLines(['first line', 'second line'],
      { start: 0, end: -1, strictIndexing: false })
    await helper.wait(30)
    doc.forceSync()
    let line = doc.getline(0, false)
    expect(line).toBe('first line')
  })

  it('should add matches to ranges', async () => {
    let doc = await helper.createDocument()
    let buf = doc.buffer
    let lines = [
      'a'.repeat(30),
      'b'.repeat(30),
      'c'.repeat(30),
      'd'.repeat(30)
    ]
    await buf.setLines(lines, { start: 0, end: -1 })
    await helper.wait(100)
    let ranges: Range[] = [
      Range.create(0, 0, 0, 10),
      Range.create(1, 0, 2, 10),
      Range.create(3, 0, 4, 0)]
    nvim.pauseNotification()
    doc.matchAddRanges(ranges, 'Search')
    await nvim.resumeNotification()
    let res = await nvim.call('getmatches')
    let item = res.find(o => o.group == 'Search')
    expect(item).toBeDefined()
    expect(item.pos1).toEqual([1, 1, 10])
    expect(item.pos2).toEqual([2, 1, 30])
    expect(item.pos3).toEqual([3, 1, 10])
    expect(item.pos4).toEqual([4, 1, 30])
  })

  it('should get variable form buffer', async () => {
    await nvim.command('autocmd BufNewFile,BufRead * let b:coc_enabled = 1')
    let doc = await helper.createDocument()
    let val = doc.getVar<number>('enabled')
    expect(val).toBe(1)
  })

  it('should attach change events', async () => {
    let doc = await helper.createDocument()
    await nvim.setLine('abc')
    await helper.wait(50)
    let content = doc.getDocumentContent()
    expect(content.indexOf('abc')).toBe(0)
  })

  it('should not attach change events when b:coc_enabled is false', async () => {
    await nvim.command('autocmd BufNewFile,BufRead *.dis let b:coc_enabled = 0')
    let doc = await helper.createDocument('a.dis')
    let val = doc.getVar<number>('enabled', 0)
    expect(val).toBe(0)
    await nvim.setLine('abc')
    await helper.wait(50)
    let content = doc.getDocumentContent()
    expect(content.indexOf('abc')).toBe(-1)
  })
})

describe('document synchronize', () => {
  it('should synchronize on lines change', async () => {
    let document = await helper.createDocument()
    let doc = TextDocument.create('untitled:1', 'txt', 1, document.getDocumentContent())
    let disposables = []
    document.onDocumentChange(e => {
      TextDocument.update(doc, e.contentChanges, 2)
    }, null, disposables)
    // document.on
    await nvim.setLine('abc')
    document.forceSync()
    expect(doc.getText()).toBe('abc\n')
    disposeAll(disposables)
  })

  it('should synchronize changes after applyEdits', async () => {
    let document = await helper.createDocument()
    let doc = TextDocument.create('untitled:1', 'txt', 1, document.getDocumentContent())
    let disposables = []
    document.onDocumentChange(e => {
      TextDocument.update(doc, e.contentChanges, 2)
    }, null, disposables)
    await nvim.setLine('abc')
    await document.applyEdits([TextEdit.insert({ line: 0, character: 0 }, '')])
    expect(doc.getText()).toBe('abc\n')
    disposeAll(disposables)
  })
})

describe('document recreate', () => {
  async function assertDocument(fn: (doc: Document) => Promise<void>): Promise<void> {
    let disposables: Disposable[] = []
    let fsPath = path.join(__dirname, 'document.txt')
    fs.writeFileSync(fsPath, '{\nfoo\n}\n', 'utf8')
    await helper.edit(fsPath)
    let document = await workspace.document
    document.forceSync()
    let doc = TextDocument.create(document.uri, 'txt', document.version, document.getDocumentContent())
    let uri = doc.uri
    workspace.onDidOpenTextDocument(e => {
      if (e.uri == uri) {
        doc = TextDocument.create(e.uri, 'txt', e.version, e.getText())
      }
    }, null, disposables)
    workspace.onDidCloseTextDocument(e => {
      if (e.uri == doc.uri) doc = null
    }, null, disposables)
    workspace.onDidChangeTextDocument(e => {
      TextDocument.update(doc, e.contentChanges, e.textDocument.version)
    }, null, disposables)
    await fn(document)
    document = await workspace.document
    document.forceSync()
    let text = document.getDocumentContent()
    expect(doc).toBeDefined()
    expect(doc.getText()).toBe(text)
    disposeAll(disposables)
    fs.unlinkSync(fsPath)
  }

  it('should synchronize after make changes', async () => {
    await assertDocument(async () => {
      await nvim.call('setline', [1, 'a'])
      await nvim.call('setline', [2, 'b'])
    })
  })

  it('should synchronize after edit', async () => {
    await assertDocument(async doc => {
      let fsPath = URI.parse(doc.uri).fsPath
      fs.writeFileSync(fsPath, '{\n}\n', 'utf8')
      await nvim.command('edit')
      await helper.wait(50)
      await nvim.call('deletebufline', [doc.bufnr, 1])
      doc = await workspace.document
      let content = doc.getDocumentContent()
      expect(content).toBe('}\n')
    })
  })
  it('should synchronize after force edit', async () => {
    await assertDocument(async doc => {
      let fsPath = URI.parse(doc.uri).fsPath
      fs.writeFileSync(fsPath, '{\n}\n', 'utf8')
      await nvim.command('edit')
      await helper.wait(50)
      await nvim.call('deletebufline', [doc.bufnr, 1])
      doc = await workspace.document
      let content = doc.getDocumentContent()
      expect(content).toBe('}\n')
    })
  })
})

describe('document getEndOffset', () => {
  it('should getEndOffset #1', async () => {
    let doc = await helper.createDocument()
    await doc.buffer.setLines(['', ''], { start: 0, end: -1, strictIndexing: false })
    await helper.wait(30)
    let end = doc.getEndOffset(1, 1, false)
    expect(end).toBe(2)
    end = doc.getEndOffset(2, 1, false)
    expect(end).toBe(1)
  })

  it('should getEndOffset #2', async () => {
    let doc = await helper.createDocument()
    await doc.buffer.setLines(['a', ''], { start: 0, end: -1, strictIndexing: false })
    await helper.wait(30)
    let end = doc.getEndOffset(1, 1, false)
    expect(end).toBe(2)
  })

  it('should getEndOffset #3', async () => {
    let doc = await helper.createDocument()
    await doc.buffer.setLines(['a'], { start: 0, end: -1, strictIndexing: false })
    await helper.wait(30)
    let end = doc.getEndOffset(1, 2, false)
    expect(end).toBe(1)
  })

  it('should getEndOffset #4', async () => {
    let doc = await helper.createDocument()
    await doc.buffer.setLines(['你好', ''], { start: 0, end: -1, strictIndexing: false })
    await helper.wait(30)
    let end = doc.getEndOffset(1, 1, false)
    expect(end).toBe(3)
    end = doc.getEndOffset(1, 1, true)
    expect(end).toBe(4)
  })
})
