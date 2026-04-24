const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export function formatDateTime(
    iso: string,
    _options?: Intl.DateTimeFormatOptions,
): string {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        const now = new Date();
        const delta = now.getTime() - d.getTime();

        if (delta >= 0 && isSameLocalDay(d, now)) {
            if (delta < HOUR_MS) {
                const minutes = Math.max(1, Math.floor(delta / MINUTE_MS));
                return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
            }

            const hours = Math.floor(delta / HOUR_MS);
            return `${hours} hour${hours === 1 ? "" : "s"} ago`;
        }

        if (isYesterday(d, now)) {
            return `Yesterday ${formatTime(d)}`;
        }

        return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${formatTime(d)}`;
    } catch {
        return iso;
    }
}

function isSameLocalDay(left: Date, right: Date): boolean {
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    );
}

function isYesterday(date: Date, now: Date): boolean {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return isSameLocalDay(date, yesterday);
}

function formatTime(date: Date): string {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value: number): string {
    return value.toString().padStart(2, "0");
}
