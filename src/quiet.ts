/**
 * The orchestrator's quiet-mode switch. Quiet mode (heavy commands wait while a benchmark holds the
 * machine) used to be switched only in local-rules.json, which an AI orchestrator may not edit
 * (findings 51). This switch lives in memory, expires on its own, and every change is audited.
 */
export interface QuietOverride {
  readonly enabled: boolean
  readonly until: string
  readonly reason: string
  readonly by: string
}

export const MAX_QUIET_MINUTES = 12 * 60

export class QuietSwitch {
  private override: QuietOverride | undefined
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  set(enabled: boolean, minutes: number, reason: string, by: string): QuietOverride {
    const ms = Math.min(Math.max(minutes, 1), MAX_QUIET_MINUTES) * 60_000
    this.override = { enabled, until: new Date(this.now() + ms).toISOString(), reason, by }
    return this.override
  }

  clear(): void {
    this.override = undefined
  }

  /** The switch while it is in force; expired settings fall back to the configured behaviour. */
  current(): QuietOverride | undefined {
    if (this.override !== undefined && Date.parse(this.override.until) <= this.now()) this.override = undefined
    return this.override
  }
}
