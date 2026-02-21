import React, { useEffect, useRef } from 'react'

export interface LogEntry {
  ts: number
  direction: 'out' | 'in' | 'info' | 'error'
  message: string
}

interface ActivityLogProps {
  entries: LogEntry[]
}

const DIRECTION_CLASS: Record<LogEntry['direction'], string> = {
  out: 'log-out',
  in: 'log-in',
  info: 'log-info',
  error: 'log-error',
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false })
}

export function ActivityLog({ entries }: ActivityLogProps): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  return (
    <div className="panel flex flex-col flex-1 min-h-0">
      <div className="panel-title">Activity Log</div>

      <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
        {entries.length === 0 ? (
          <p className="text-slate-600 text-xs italic">No activity yet. Connect a gateway and send a call.</p>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className={`log-line ${DIRECTION_CLASS[entry.direction]}`}>
              <span className="text-slate-600 shrink-0">{formatTime(entry.ts)}</span>
              <span className="break-all">{entry.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
