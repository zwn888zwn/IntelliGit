interface LineDocument {
    lineCount: number;
    lineAt(line: number): { text: string };
}

/**
 * Maps a displayed merge line back to the working document only when the
 * mapping is unambiguous. Conflict markers can shift line numbers, so an
 * exact expected-position match wins; otherwise the full line must be unique.
 */
export function findUniqueSourceLine(
    document: LineDocument,
    displayedLineNumber: number,
    displayedLineText: string,
): number | undefined {
    const expectedLine = displayedLineNumber - 1;
    if (
        expectedLine >= 0 &&
        expectedLine < document.lineCount &&
        document.lineAt(expectedLine).text === displayedLineText
    ) {
        return expectedLine;
    }

    let matchedLine: number | undefined;
    for (let line = 0; line < document.lineCount; line++) {
        if (document.lineAt(line).text !== displayedLineText) continue;
        if (matchedLine !== undefined) return undefined;
        matchedLine = line;
    }
    return matchedLine;
}
