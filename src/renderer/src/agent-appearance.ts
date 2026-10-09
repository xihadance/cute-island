export interface AgentAppearance {
  key: string
  label: string
  short: string
  mark: string
  color: string
}

const KNOWN: Array<{ match: (name: string) => boolean; appearance: AgentAppearance }> = [
  {
    match: (name) => name.includes('claude'),
    appearance: { key: 'claude', label: 'Claude Code', short: 'Claude', mark: 'C', color: '#e8a87c' }
  },
  {
    match: (name) => name.includes('codex'),
    appearance: { key: 'codex', label: 'Codex', short: 'Codex', mark: 'X', color: '#f2f2f2' }
  },
  {
    match: (name) => name.includes('gemini'),
    appearance: { key: 'gemini', label: 'Gemini', short: 'Gemini', mark: 'G', color: '#8ab4f8' }
  },
  {
    match: (name) => name.includes('cursor'),
    appearance: { key: 'cursor', label: 'Cursor', short: 'Cursor', mark: '▶', color: '#f5f5f5' }
  }
]

export function agentAppearance(agent: string): AgentAppearance {
  const name = agent.trim().toLowerCase()
  const known = KNOWN.find((item) => item.match(name))
  if (known) return known.appearance
  const label = agent.trim() || 'Agent'
  return {
    key: 'custom',
    label,
    short: label.slice(0, 12),
    mark: label.slice(0, 1).toUpperCase() || 'A',
    color: '#d0d0d0'
  }
}
