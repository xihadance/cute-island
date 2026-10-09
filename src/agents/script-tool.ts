import { parse, type Node, type Expression, type CallExpression } from 'acorn'

const UNKNOWN = Symbol('dynamic expression')

/** Read static tool arguments from JavaScript syntax. No expression is executed. */
export function unwrapExec(source: string): { name: string; input: Record<string, unknown> } | null {
  let root: Node
  try { root = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }) }
  catch { return null }
  const pending: Node[] = [root]
  let first: CallExpression | undefined
  while (pending.length) {
    const node = pending.pop()!
    if (node.type === 'CallExpression') {
      const call = node as CallExpression
      const callee = call.callee
      if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' &&
        callee.object.name === 'tools' && callee.property.type === 'Identifier' && (!first || call.start < first.start)) first = call
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value.filter(isNode))
      else if (isNode(value)) pending.push(value)
    }
  }
  if (!first || first.callee.type !== 'MemberExpression' || first.callee.property.type !== 'Identifier') return null
  const name = first.callee.property.name.replace(/^multi_agent_v\d+__/, '')
  const argument = first.arguments[0]
  const value = argument && argument.type !== 'SpreadElement' ? literal(argument) : UNKNOWN
  return { name, input: value !== UNKNOWN && value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'type' in value && typeof value.type === 'string'
}

function literal(node: Expression): unknown {
  if (node.type === 'Literal') {
    return node.value === null || ['string', 'boolean', 'number'].includes(typeof node.value) ? node.value : UNKNOWN
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? UNKNOWN
  if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    const value = literal(node.argument)
    return typeof value === 'number' ? (node.operator === '-' ? -value : value) : UNKNOWN
  }
  if (node.type === 'ArrayExpression') {
    const values = node.elements.map((item) => item && item.type !== 'SpreadElement' ? literal(item) : UNKNOWN)
    return values.includes(UNKNOWN) ? UNKNOWN : values
  }
  if (node.type !== 'ObjectExpression') return UNKNOWN
  const fields = new Map<string, unknown>()
  for (const property of node.properties) {
    // A dynamic spread/key may overwrite preceding fields, so discard those assumptions.
    if (property.type === 'SpreadElement' || property.computed) { fields.clear(); continue }
    const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? String(property.key.value) : undefined
    if (key === undefined) continue
    const value = property.kind === 'init' && !property.method ? literal(property.value) : UNKNOWN
    if (value === UNKNOWN) fields.delete(key)
    else fields.set(key, value)
  }
  return Object.fromEntries(fields)
}
