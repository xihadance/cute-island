import type { ActivityState, OperationKind, StepStatus } from '../../shared/activity'

type IconKind = ActivityState | OperationKind | StepStatus

export function ActivityIcon({ kind, animated = false }: { kind: IconKind; animated?: boolean }) {
  return (
    <svg className={`activity-icon icon-${kind}${animated ? ' is-animated' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(kind === 'running' || kind === 'active' || kind === 'tool') && <><circle className="spinner-track" cx="12" cy="12" r="8" /><path className="spinner-arc" d="M12 4a8 8 0 0 1 8 8" /></>}
      {kind === 'thinking' && <><circle className="thought-dot dot-one" cx="5" cy="12" r="1.4" /><circle className="thought-dot dot-two" cx="12" cy="12" r="1.4" /><circle className="thought-dot dot-three" cx="19" cy="12" r="1.4" /></>}
      {(kind === 'waiting' || kind === 'pending') && <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>}
      {kind === 'approval' && <><path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Z" /><path d="M12 8v5m0 3h.01" /></>}
      {(kind === 'success' || kind === 'done') && <><circle cx="12" cy="12" r="8" /><path className="check-path" d="m8 12 3 3 5-6" /></>}
      {kind === 'error' && <><circle cx="12" cy="12" r="8" /><path d="m9 9 6 6m0-6-6 6" /></>}
      {kind === 'command' && <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m7 9 3 3-3 3" /><path className="terminal-cursor" d="M13 15h4" /></>}
      {kind === 'read' && <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8m-8 4h5" /></>}
      {kind === 'edit' && <><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="m10 14 1-4 7-7 3 3-7 7-4 1Zm6-9 3 3" /></>}
      {kind === 'search' && <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>}
      {kind === 'mcp' && <><path d="m7 8 5-5a4 4 0 0 1 6 6l-4 4m3 3-5 5m-5-5-3-3a4 4 0 0 1 0-6l2-2m1 11 9-9m-5 13 3 3" /></>}
      {kind === 'skill' && <><path d="M12 6c-3-3-6-3-9-2v15c3-1 6-1 9 2 3-3 6-3 9-2V4c-3-1-6-1-9 2Zm0 0v15M6 8l3 1m-3 3 3 1m6-4 3-1m-3 5 3-1" /></>}
      {kind === 'agent' && <><circle cx="12" cy="5" r="3" /><circle cx="5" cy="18" r="3" /><circle cx="19" cy="18" r="3" /><path d="M12 8v4m-7 3v-3h14v3" /></>}
    </svg>
  )
}
