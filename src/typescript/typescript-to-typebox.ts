/*--------------------------------------------------------------------------

@typebox/codegen

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---------------------------------------------------------------------------*/

import { Formatter } from '../common/index'
import * as ts from 'typescript'

export class TypeScriptToTypeBoxError extends Error {
  constructor(public readonly diagnostics: ts.Diagnostic[]) {
    super('')
  }
}

// --------------------------------------------------------------------------
// TypeScriptToTypeBox
// --------------------------------------------------------------------------
export interface TypeScriptToTypeBoxOptions {
  /**
   * Setting this to true will ensure all types are exports as const values. This setting is
   * used by the TypeScriptToTypeBoxModel to gather TypeBox definitions during runtime eval
   * pass. The default is false
   */
  useExportEverything: boolean
  /**
   * Specifies if the output code should specify a default `import` statement. For TypeScript
   * generated code this is typically desirable, but for Model generated code, the `Type`
   * build is passed in into scope as a variable. The default is true.
   */
  useTypeBoxImport: boolean
  /**
   * Specifies if the output types should include an identifier associated with the assigned
   * variable name. This is useful for remapping model types to targets, but optional for
   * for TypeBox which can operate on vanilla JS references. The default is false.
   */
  useIdentifiers: boolean
}
/** Generates TypeBox types from TypeScript code */
export namespace TypeScriptToTypeBox {
  // ------------------------------------------------------------------------------------------------------------
  // Transpile Options
  // ------------------------------------------------------------------------------------------------------------
  const transpilerOptions: ts.TranspileOptions = {
    compilerOptions: {
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
  }
  // ------------------------------------------------------------------------------------------------------------
  // Transpile States
  // ------------------------------------------------------------------------------------------------------------
  // (auto) tracked for recursive types and used to associate This type references
  let recursiveDeclaration: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | null = null
  // (auto) tracked for injecting typebox import statements
  let useImports = false
  // (auto) tracked for injecting TSchema import statements
  let useGenerics = false
  // (auto) tracked for cases where composition requires deep clone
  let useTypeClone = false
  // (auto) tracked for each generated type.
  const typeNames = new Set<string>()
  // (option) export override to ensure all schematics
  let useExportsEverything = false
  // (option) inject identifiers
  let useIdentifiers = false
  // ------------------------------------------------------------------------------------------------------------
  // AST Query
  // ------------------------------------------------------------------------------------------------------------
  function FindRecursiveParent(decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, node: ts.Node): boolean {
    return (ts.isTypeReferenceNode(node) && decl.name.getText() === node.typeName.getText()) || node.getChildren().some((node) => FindRecursiveParent(decl, node))
  }
  function IsRecursiveType(decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration) {
    return ts.isTypeAliasDeclaration(decl) ? [decl.type].some((node) => FindRecursiveParent(decl, node)) : decl.members.some((node) => FindRecursiveParent(decl, node))
  }
  function IsReadonlyProperty(node: ts.PropertySignature): boolean {
    return node.modifiers !== undefined && node.modifiers.find((modifier) => modifier.getText() === 'readonly') !== undefined
  }
  function IsOptionalProperty(node: ts.PropertySignature) {
    return node.questionToken !== undefined
  }
  function IsExport(node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration | ts.ModuleDeclaration): boolean {
    return useExportsEverything || (node.modifiers !== undefined && node.modifiers.find((modifier) => modifier.getText() === 'export') !== undefined)
  }
  function IsNamespace(node: ts.ModuleDeclaration) {
    return node.flags === ts.NodeFlags.Namespace
  }
  // ------------------------------------------------------------------------------------------------------------
  // Identifiers
  // ------------------------------------------------------------------------------------------------------------
  // Note: This function is only called when 'useIdentifiers' is true. What we're trying to achieve with
  // identifier injection is a referential type model over the default inline model. For the purposes of
  // code generation, we tend to prefer referential types as these can be both inlined or referenced in
  // the codegen target; and where different targets may have different referential requirements. It
  // should be possible to implement a more robust injection mechanism however. For review.
  function InjectIdentifier($id: string, type: string) {
    if (!useIdentifiers) return type
    // indexer type
    if (type.lastIndexOf(']') === type.length - 1) useTypeClone = true
    if (type.lastIndexOf(']') === type.length - 1) return `TypeClone.Clone(${type}, { $id: '${$id}' })`

    // referenced type
    if (type.indexOf('(') === -1) return `Type.Ref(${type}, { $id: '${$id}' })`
    if (type.lastIndexOf('()') === type.length - 2) return type.slice(0, type.length - 1) + `{ $id: '${$id}' })`
    if (type.lastIndexOf('})') === type.length - 2) return type.slice(0, type.length - 1) + `, { $id: '${$id}' })`
    if (type.lastIndexOf('])') === type.length - 2) return type.slice(0, type.length - 1) + `, { $id: '${$id}' })`
    return type
  }
  // ------------------------------------------------------------------------------------------------------------
  // Nodes
  // ------------------------------------------------------------------------------------------------------------
  function* SourceFile(node: ts.SourceFile): IterableIterator<string> {
    for (const next of node.getChildren()) {
      yield* Visit(next)
    }
  }
  function* PropertySignature(node: ts.PropertySignature): IterableIterator<string> {
    const [readonly, optional] = [IsReadonlyProperty(node), IsOptionalProperty(node)]
    const type = Collect(node.type)
    if (readonly && optional) {
      return yield `${node.name.getText()}: Type.ReadonlyOptional(${type})`
    } else if (readonly) {
      return yield `${node.name.getText()}: Type.Readonly(${type})`
    } else if (optional) {
      return yield `${node.name.getText()}: Type.Optional(${type})`
    } else {
      return yield `${node.name.getText()}: ${type}`
    }
  }
  function* ArrayTypeNode(node: ts.ArrayTypeNode): IterableIterator<string> {
    const type = Collect(node.elementType)
    yield `Type.Array(${type})`
  }
  function* TupleTypeNode(node: ts.TupleTypeNode): IterableIterator<string> {
    const types = node.elements.map((type) => Collect(type)).join(',\n')
    yield `Type.Tuple([\n${types}\n])`
  }
  function* UnionTypeNode(node: ts.UnionTypeNode): IterableIterator<string> {
    const types = node.types.map((type) => Collect(type)).join(',\n')
    yield `Type.Union([\n${types}\n])`
  }
  function* MethodSignature(node: ts.MethodSignature): IterableIterator<string> {
    const parameters = node.parameters.map((parameter) => Collect(parameter)).join(', ')
    const returnType = node.type === undefined ? `Type.Unknown()` : Collect(node.type)
    yield `${node.name.getText()}: Type.Function([${parameters}], ${returnType})`
  }
  // prettier-ignore
  function* TemplateLiteralTypeNode(node: ts.TemplateLiteralTypeNode) {
    const collect = node.getChildren().map(node => Collect(node)).join('')
    yield `Type.TemplateLiteral([${collect.slice(0, collect.length - 2)}])` // can't remove trailing here
  }
  // prettier-ignore
  function* TemplateLiteralTypeSpan(node: ts.TemplateLiteralTypeSpan) {
    const collect = node.getChildren().map(node => Collect(node)).join(', ')
    if (collect.length > 0) yield `${collect}`
  }
  function* TemplateHead(node: ts.TemplateHead) {
    if (node.text.length > 0) yield `Type.Literal('${node.text}'), `
  }
  function* TemplateMiddle(node: ts.TemplateMiddle) {
    if (node.text.length > 0) yield `Type.Literal('${node.text}'), `
  }
  function* TemplateTail(node: ts.TemplateTail) {
    if (node.text.length > 0) yield `Type.Literal('${node.text}'), `
  }
  function* IntersectionTypeNode(node: ts.IntersectionTypeNode): IterableIterator<string> {
    const types = node.types.map((type) => Collect(type)).join(',\n')
    yield `Type.Intersect([\n${types}\n])`
  }
  function* TypeOperatorNode(node: ts.TypeOperatorNode): IterableIterator<string> {
    if (node.operator === ts.SyntaxKind.KeyOfKeyword) {
      const type = Collect(node.type)
      yield `Type.KeyOf(${type})`
    }
    if (node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      yield Collect(node.type)
    }
  }
  function* Parameter(node: ts.ParameterDeclaration): IterableIterator<string> {
    yield Collect(node.type)
  }
  function* FunctionTypeNode(node: ts.FunctionTypeNode): IterableIterator<string> {
    const parameters = node.parameters.map((param) => Collect(param)).join(', ')
    const returns = Collect(node.type)
    yield `Type.Function([${parameters}], ${returns})`
  }
  function* ConstructorTypeNode(node: ts.ConstructorTypeNode): IterableIterator<string> {
    const parameters = node.parameters.map((param) => Collect(param)).join(', ')
    const returns = Collect(node.type)
    yield `Type.Constructor([${parameters}], ${returns})`
  }
  function* EnumDeclaration(node: ts.EnumDeclaration): IterableIterator<string> {
    useImports = true
    const exports = IsExport(node) ? 'export ' : ''
    const members = node.members.map((member) => member.getText()).join(', ')
    const enumType = `${exports}enum ${node.name.getText()}Enum { ${members} }`
    const type = `${exports}const ${node.name.getText()} = Type.Enum(${node.name.getText()}Enum)`
    yield [enumType, '', type].join('\n')
    typeNames.add(node.name.getText())
  }
  function PropertiesFromTypeElementArray(members: ts.NodeArray<ts.TypeElement>): string {
    const properties = members.filter((member) => !ts.isIndexSignatureDeclaration(member))
    const indexers = members.filter((member) => ts.isIndexSignatureDeclaration(member))
    const propertyCollect = properties.map((property) => Collect(property)).join(',\n')
    const indexer = indexers.length > 0 ? Collect(indexers[indexers.length - 1]) : ''
    if (properties.length === 0 && indexer.length > 0) {
      return `{},\n{\nadditionalProperties: ${indexer}\n }`
    } else if (properties.length > 0 && indexer.length > 0) {
      return `{\n${propertyCollect}\n},\n{\nadditionalProperties: ${indexer}\n }`
    } else {
      return `{\n${propertyCollect}\n}`
    }
  }
  function* TypeLiteralNode(node: ts.TypeLiteralNode): IterableIterator<string> {
    const members = PropertiesFromTypeElementArray(node.members)
    yield* `Type.Object(${members})`
  }
  function* InterfaceDeclaration(node: ts.InterfaceDeclaration): IterableIterator<string> {
    useImports = true
    const isRecursiveType = IsRecursiveType(node)
    if (isRecursiveType) recursiveDeclaration = node
    const heritage = node.heritageClauses !== undefined ? node.heritageClauses.flatMap((node) => Collect(node)) : []
    if (node.typeParameters) {
      useGenerics = true
      const exports = IsExport(node) ? 'export ' : ''
      const constraints = node.typeParameters.map((param) => `${Collect(param)} extends TSchema`).join(', ')
      const parameters = node.typeParameters.map((param) => `${Collect(param)}: ${Collect(param)}`).join(', ')
      const names = node.typeParameters.map((param) => `${Collect(param)}`).join(', ')
      const members = PropertiesFromTypeElementArray(node.members)
      const staticDeclaration = `${exports}type ${node.name.getText()}<${constraints}> = Static<ReturnType<typeof ${node.name.getText()}<${names}>>>`
      const rawTypeExpression = IsRecursiveType(node) ? `Type.Recursive(This => Type.Object(${members}))` : `Type.Object(${members})`
      const typeExpression = heritage.length === 0 ? rawTypeExpression : `Type.Intersect([${heritage.join(', ')}, ${rawTypeExpression}])`
      const type = InjectIdentifier(node.name.getText(), typeExpression)
      const typeDeclaration = `${exports}const ${node.name.getText()} = <${constraints}>(${parameters}) => ${type}`
      yield `${staticDeclaration}\n${typeDeclaration}`
    } else {
      const exports = IsExport(node) ? 'export ' : ''
      const members = PropertiesFromTypeElementArray(node.members)
      const staticDeclaration = `${exports}type ${node.name.getText()} = Static<typeof ${node.name.getText()}>`
      const rawTypeExpression = IsRecursiveType(node) ? `Type.Recursive(This => Type.Object(${members}))` : `Type.Object(${members})`
      const typeExpression = heritage.length === 0 ? rawTypeExpression : `Type.Intersect([${heritage.join(', ')}, ${rawTypeExpression}])`
      const type = InjectIdentifier(node.name.getText(), typeExpression)
      const typeDeclaration = `${exports}const ${node.name.getText()} = ${type}`
      yield `${staticDeclaration}\n${typeDeclaration}`
    }
    typeNames.add(node.name.getText())
    recursiveDeclaration = null
  }
  function* TypeAliasDeclaration(node: ts.TypeAliasDeclaration): IterableIterator<string> {
    useImports = true
    const isRecursiveType = IsRecursiveType(node)
    if (isRecursiveType) recursiveDeclaration = node
    if (node.typeParameters) {
      useGenerics = true
      const exports = IsExport(node) ? 'export ' : ''
      const constraints = node.typeParameters.map((param) => `${Collect(param)} extends TSchema`).join(', ')
      const parameters = node.typeParameters.map((param) => `${Collect(param)}: ${Collect(param)}`).join(', ')
      const names = node.typeParameters.map((param) => Collect(param)).join(', ')
      const $id = node.name.getText()
      const type_0 = Collect(node.type)
      const type_1 = isRecursiveType ? `Type.Recursive(This => ${type_0})` : type_0
      const type_2 = InjectIdentifier($id, type_1)
      const staticDeclaration = `${exports}type ${$id}<${constraints}> = Static<ReturnType<typeof ${$id}<${names}>>>`
      const typeDeclaration = `${exports}const ${node.name.getText()} = <${constraints}>(${parameters}) => ${type_2}`
      yield `${staticDeclaration}\n${typeDeclaration}`
    } else {
      const exports = IsExport(node) ? 'export ' : ''
      const $id = node.name.getText()
      const type_0 = Collect(node.type)
      const type_1 = isRecursiveType ? `Type.Recursive(This => ${type_0})` : type_0
      const type_2 = InjectIdentifier($id, type_1)
      const staticDeclaration = `${exports}type ${$id} = Static<typeof ${$id}>`
      const typeDeclaration = `${exports}const ${$id} = ${type_2}`
      yield `${staticDeclaration}\n${typeDeclaration}`
    }
    typeNames.add(node.name.getText())
    recursiveDeclaration = null
  }
  function* HeritageClause(node: ts.HeritageClause): IterableIterator<string> {
    const types = node.types.map((node) => Collect(node))
    if (types.length === 1) return yield types[0]
    yield `Type.Intersect([${types.join(', ')}])`
  }
  function* IndexedAccessType(node: ts.IndexedAccessTypeNode): IterableIterator<string> {
    const obj = node.objectType.getText()
    const key = node.indexType.getText()
    yield `${obj}.properties[${key}]`
  }
  function* ExpressionWithTypeArguments(node: ts.ExpressionWithTypeArguments): IterableIterator<string> {
    const name = Collect(node.expression)
    const typeArguments = node.typeArguments === undefined ? [] : node.typeArguments.map((node) => Collect(node))
    // todo: default type argument (resolve `= number` from `type Foo<T = number>`)
    return yield typeArguments.length === 0 ? `${name}` : `${name}(${typeArguments.join(', ')})`
  }
  function* TypeParameterDeclaration(node: ts.TypeParameterDeclaration): IterableIterator<string> {
    yield node.name.getText()
  }
  function* ParenthesizedTypeNode(node: ts.ParenthesizedTypeNode): IterableIterator<string> {
    yield Collect(node.type)
  }
  function* RestTypeNode(node: ts.RestTypeNode): IterableIterator<string> {
    yield `Type.Rest()`
  }
  function* ConditionalTypeNode(node: ts.ConditionalTypeNode): IterableIterator<string> {
    const checkType = Collect(node.checkType)
    const extendsType = Collect(node.extendsType)
    const trueType = Collect(node.trueType)
    const falseType = Collect(node.falseType)
    yield `Type.Extends(${checkType}, ${extendsType}, ${trueType}, ${falseType})`
  }
  function* isIndexSignatureDeclaration(node: ts.IndexSignatureDeclaration) {
    // note: we ignore the key and just return the type. this is a mismatch between
    // object and record types. Address in TypeBox by unifying validation paths
    // for objects and record types.
    yield Collect(node.type)
  }
  function* TypeReferenceNode(node: ts.TypeReferenceNode): IterableIterator<string> {
    const name = node.typeName.getText()
    const args = node.typeArguments ? `(${node.typeArguments.map((type) => Collect(type)).join(', ')})` : ''
    if (name === 'Array') return yield `Type.Array${args}`
    if (name === 'Record') return yield `Type.Record${args}`
    if (name === 'Partial') return yield `Type.Partial${args}`
    if (name === 'Uint8Array') return yield `Type.Uint8Array()`
    if (name === 'Date') return yield `Type.Date()`
    if (name === 'Required') return yield `Type.Required${args}`
    if (name === 'Omit') return yield `Type.Omit${args}`
    if (name === 'Pick') return yield `Type.Pick${args}`
    if (name === 'Promise') return yield `Type.Promise${args}`
    if (name === 'ReturnType') return yield `Type.ReturnType${args}`
    if (name === 'InstanceType') return yield `Type.InstanceType${args}`
    if (name === 'Parameters') return yield `Type.Parameters${args}`
    if (name === 'ConstructorParameters') return yield `Type.ConstructorParameters${args}`
    if (name === 'Exclude') return yield `Type.Exclude${args}`
    if (name === 'Extract') return yield `Type.Extract${args}`
    if (recursiveDeclaration !== null && FindRecursiveParent(recursiveDeclaration, node)) return yield `This`
    if (typeNames.has(name)) return yield `${name}${args}`
    if (name in globalThis) return yield `Type.Never()`
    return yield `${name}${args}`
  }
  function* LiteralTypeNode(node: ts.LiteralTypeNode): IterableIterator<string> {
    const text = node.getText()
    if (text === 'null') return yield `Type.Null()`
    yield `Type.Literal(${node.getText()})`
  }
  function* ModuleDeclaration(node: ts.ModuleDeclaration): IterableIterator<string> {
    const export_specifier = IsExport(node) ? 'export ' : ''
    const module_specifier = IsNamespace(node) ? 'namespace' : 'module'
    yield `${export_specifier}${module_specifier} ${node.name.getText()} {`
    yield* Visit(node.body)
    yield `}`
  }
  function* ModuleBlock(node: ts.ModuleBlock): IterableIterator<string> {
    for (const statement of node.statements) {
      yield* Visit(statement)
    }
  }
  function* FunctionDeclaration(node: ts.FunctionDeclaration): IterableIterator<string> {
    // ignore
  }
  function* ClassDeclaration(node: ts.ClassDeclaration): IterableIterator<string> {
    // ignore
  }
  function Collect(node: ts.Node | undefined): string {
    return `${[...Visit(node)].join('')}`
  }
  function* Visit(node: ts.Node | undefined): IterableIterator<string> {
    if (node === undefined) return
    if (ts.isArrayTypeNode(node)) return yield* ArrayTypeNode(node)
    if (ts.isClassDeclaration(node)) return yield* ClassDeclaration(node)
    if (ts.isConditionalTypeNode(node)) return yield* ConditionalTypeNode(node)
    if (ts.isConstructorTypeNode(node)) return yield* ConstructorTypeNode(node)
    if (ts.isEnumDeclaration(node)) return yield* EnumDeclaration(node)
    if (ts.isExpressionWithTypeArguments(node)) return yield* ExpressionWithTypeArguments(node)
    if (ts.isFunctionDeclaration(node)) return yield* FunctionDeclaration(node)
    if (ts.isFunctionTypeNode(node)) return yield* FunctionTypeNode(node)
    if (ts.isHeritageClause(node)) return yield* HeritageClause(node)
    if (ts.isIndexedAccessTypeNode(node)) return yield* IndexedAccessType(node)
    if (ts.isIndexSignatureDeclaration(node)) return yield* isIndexSignatureDeclaration(node)
    if (ts.isInterfaceDeclaration(node)) return yield* InterfaceDeclaration(node)
    if (ts.isLiteralTypeNode(node)) return yield* LiteralTypeNode(node)
    if (ts.isPropertySignature(node)) return yield* PropertySignature(node)
    if (ts.isModuleDeclaration(node)) return yield* ModuleDeclaration(node)
    if (ts.isIdentifier(node)) return yield node.getText()
    if (ts.isIntersectionTypeNode(node)) return yield* IntersectionTypeNode(node)
    if (ts.isUnionTypeNode(node)) return yield* UnionTypeNode(node)
    if (ts.isMethodSignature(node)) return yield* MethodSignature(node)
    if (ts.isModuleBlock(node)) return yield* ModuleBlock(node)
    if (ts.isParameter(node)) return yield* Parameter(node)
    if (ts.isParenthesizedTypeNode(node)) return yield* ParenthesizedTypeNode(node)
    if (ts.isRestTypeNode(node)) return yield* RestTypeNode(node)
    if (ts.isTupleTypeNode(node)) return yield* TupleTypeNode(node)
    if (ts.isTemplateLiteralTypeNode(node)) return yield* TemplateLiteralTypeNode(node)
    if (ts.isTemplateLiteralTypeSpan(node)) return yield* TemplateLiteralTypeSpan(node)
    if (ts.isTemplateHead(node)) return yield* TemplateHead(node)
    if (ts.isTemplateMiddle(node)) return yield* TemplateMiddle(node)
    if (ts.isTemplateTail(node)) return yield* TemplateTail(node)
    if (ts.isTypeAliasDeclaration(node)) return yield* TypeAliasDeclaration(node)
    if (ts.isTypeLiteralNode(node)) return yield* TypeLiteralNode(node)
    if (ts.isTypeOperatorNode(node)) return yield* TypeOperatorNode(node)
    if (ts.isTypeParameterDeclaration(node)) return yield* TypeParameterDeclaration(node)
    if (ts.isTypeReferenceNode(node)) return yield* TypeReferenceNode(node)
    if (ts.isSourceFile(node)) return yield* SourceFile(node)
    if (node.kind === ts.SyntaxKind.ExportKeyword) return yield `export`
    if (node.kind === ts.SyntaxKind.KeyOfKeyword) return yield `Type.KeyOf()`
    if (node.kind === ts.SyntaxKind.NumberKeyword) return yield `Type.Number()`
    if (node.kind === ts.SyntaxKind.BigIntKeyword) return yield `Type.BigInt()`
    if (node.kind === ts.SyntaxKind.StringKeyword) return yield `Type.String()`
    if (node.kind === ts.SyntaxKind.SymbolKeyword) return yield `Type.Symbol()`
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return yield `Type.Boolean()`
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) return yield `Type.Undefined()`
    if (node.kind === ts.SyntaxKind.UnknownKeyword) return yield `Type.Unknown()`
    if (node.kind === ts.SyntaxKind.AnyKeyword) return yield `Type.Any()`
    if (node.kind === ts.SyntaxKind.NeverKeyword) return yield `Type.Never()`
    if (node.kind === ts.SyntaxKind.NullKeyword) return yield `Type.Null()`
    if (node.kind === ts.SyntaxKind.VoidKeyword) return yield `Type.Void()`
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return
    if (node.kind === ts.SyntaxKind.SyntaxList) {
      for (const child of node.getChildren()) {
        yield* Visit(child)
      }
      return
    }
    console.warn('Unhandled:', ts.SyntaxKind[node.kind], node.getText())
  }

  export function ImportStatement(options: TypeScriptToTypeBoxOptions): string {
    if (!(useImports && options.useTypeBoxImport)) return ''
    const imported = ['Type', 'Static']
    if (useGenerics) imported.push('TSchema')
    if (useTypeClone) imported.push('TypeClone')
    return `import { ${imported.join(', ')} } from '@sinclair/typebox'`
  }

  /** Generates TypeBox types from TypeScript interface and type definitions */
  export function Generate(
    typescriptCode: string,
    options: TypeScriptToTypeBoxOptions = {
      useExportEverything: false,
      useTypeBoxImport: true,
      useIdentifiers: false,
    },
  ) {
    useExportsEverything = options.useExportEverything
    useIdentifiers = options.useIdentifiers
    typeNames.clear()
    useImports = false
    useGenerics = false
    const source = ts.createSourceFile('types.ts', typescriptCode, ts.ScriptTarget.ESNext, true)
    const declarations = Formatter.Format([...Visit(source)].join('\n\n'))
    const imports = ImportStatement(options)
    const typescript = [imports, '', declarations].join('\n')
    const assertion = ts.transpileModule(typescript, transpilerOptions)
    if (assertion.diagnostics && assertion.diagnostics.length > 0) {
      throw new TypeScriptToTypeBoxError(assertion.diagnostics)
    }
    return typescript
  }
}
