import type { DispatchedAction } from '../types'

export type LogEvent = 'started' | 'folded' | 'effects' | 'settled' | 'rejected' | 'superseded' | 'disposed'

/**
 * Metadata only. No action payload reaches a diagnostic sink through any channel eddy hands a host.
 * The error object itself is the host's and cannot be narrowed.
 */
export type LogRecord = {
  readonly scope: string
  readonly type?: string

  readonly address?: string
  readonly __seq?: number
  readonly __originSeq?: number

  readonly fields?: Readonly<Record<string, readonly string[]>>

  readonly cause?: string
}

export const fromAction = (scope: string, action: DispatchedAction): LogRecord => ({
  scope,
  type: action.type,
  __seq: action.__seq,
  __originSeq: action.__originSeq,
})

/** The scope's own logging gate. Reports whether the line went out, so a deduplicating caller can retry. */
export type Log = (level: 'debug' | 'info' | 'error', event: LogEvent, record: LogRecord) => boolean
