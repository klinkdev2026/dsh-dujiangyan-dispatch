export const MAX_QUIET_MINUTES = 12 * 60;
export class QuietSwitch {
    override;
    now;
    constructor(now = () => Date.now()) {
        this.now = now;
    }
    set(enabled, minutes, reason, by) {
        const ms = Math.min(Math.max(minutes, 1), MAX_QUIET_MINUTES) * 60_000;
        this.override = { enabled, until: new Date(this.now() + ms).toISOString(), reason, by };
        return this.override;
    }
    clear() {
        this.override = undefined;
    }
    /** The switch while it is in force; expired settings fall back to the configured behaviour. */
    current() {
        if (this.override !== undefined && Date.parse(this.override.until) <= this.now())
            this.override = undefined;
        return this.override;
    }
}
