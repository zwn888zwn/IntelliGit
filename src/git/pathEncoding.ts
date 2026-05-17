export function decodeGitQuotedPath(value: string): string {
    if (!value) return value;

    const trimmed = value.trim();
    if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
        return value;
    }

    const body = trimmed.slice(1, -1);
    const bytes: number[] = [];
    let decoded = "";

    const flushBytes = (): void => {
        if (bytes.length === 0) return;
        decoded += Buffer.from(bytes).toString("utf8");
        bytes.length = 0;
    };

    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch !== "\\") {
            flushBytes();
            decoded += ch;
            continue;
        }

        const next = body[i + 1];
        if (next === undefined) {
            flushBytes();
            decoded += ch;
            continue;
        }

        if (/[0-7]/.test(next)) {
            let octal = next;
            let consumed = 1;
            while (consumed < 3 && /[0-7]/.test(body[i + 1 + consumed] ?? "")) {
                octal += body[i + 1 + consumed];
                consumed++;
            }
            bytes.push(Number.parseInt(octal, 8));
            i += consumed;
            continue;
        }

        flushBytes();
        switch (next) {
            case "a":
                decoded += "\x07";
                break;
            case "b":
                decoded += "\b";
                break;
            case "f":
                decoded += "\f";
                break;
            case "n":
                decoded += "\n";
                break;
            case "r":
                decoded += "\r";
                break;
            case "t":
                decoded += "\t";
                break;
            case "v":
                decoded += "\v";
                break;
            case "\\":
            case '"':
                decoded += next;
                break;
            default:
                decoded += next;
                break;
        }
        i += 1;
    }

    flushBytes();
    return decoded;
}
