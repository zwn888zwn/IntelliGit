import { JSON_LINE_CHARS, type JsonLine, type JsonPart } from "./types";

type Frame = { type: "object" | "array"; state: "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd" };
type NumberState = "sign" | "zero" | "integer" | "dot" | "fraction" | "exponent" | "exponentSign" | "exponentDigits";

/** Incremental JSON grammar/formatter. Never builds an object tree or a whole scalar. */
export class JsonFormatter {
    constructor(private readonly emitLines = true) {}
    private stack: Frame[] = [];
    private rootStarted = false;
    private mode: "string" | "number" | "literal" | undefined;
    private key = false;
    private escaped = false;
    private unicode = 0;
    private literal = "";
    private literalIndex = 0;
    private numberState: NumberState = "integer";
    private parts: { characters: string[]; kind: JsonPart["kind"] }[] = [];
    private length = 0;
    private depth = 0;
    private continued = false;
    private pending: JsonLine[] = [];
    private sourceLine = 1;
    private sourceColumn = 0;
    private first = true;
    public lineCount = 0;

    *feed(chunk: string): Generator<JsonLine> {
        for (const char of chunk) {
            this.sourceColumn++;
            if (this.first && char === "\uFEFF") { this.first = false; continue; }
            this.first = false;
            this.consume(char);
            if (char === "\n") { this.sourceLine++; this.sourceColumn = 0; }
            if (this.pending.length) {
                yield* this.pending;
                this.pending = [];
            }
        }
    }

    *finish(): Generator<JsonLine> {
        if (this.mode === "number") this.finishNumber();
        if (this.mode || this.stack.length || !this.rootStarted) this.fail("JSON 内容不完整");
        this.flush();
        yield* this.pending;
        this.pending = [];
    }

    private fail(message: string): never {
        throw new Error(`${message}（原文件第 ${this.sourceLine} 行，第 ${this.sourceColumn} 列）`);
    }

    private append(text: string, kind: JsonPart["kind"]): void {
        if (!this.emitLines) return;
        if (!this.length) this.depth = this.stack.length;
        const last = this.parts[this.parts.length - 1];
        if (last?.kind === kind) last.characters.push(text);
        else this.parts.push({ characters: [text], kind });
        this.length += text.length;
        if (this.length >= JSON_LINE_CHARS) this.flush(true);
    }

    private flush(continuation = false): void {
        if (!this.emitLines) return;
        if (this.length) {
            // Join each bounded segment now instead of retaining millions of
            // character-sized string ropes when a page contains a huge scalar.
            const parts = this.parts.map(part => ({ text: part.characters.join(""), kind: part.kind }));
            this.pending.push({ number: ++this.lineCount, depth: this.depth, continued: this.continued, parts });
            this.parts = [];
            this.length = 0;
        }
        this.continued = continuation;
    }

    private startValue(): void {
        const frame = this.stack[this.stack.length - 1];
        if (frame) {
            if (frame.state !== "value" && frame.state !== "valueOrEnd") this.fail("此处需要逗号或结束符");
            frame.state = "commaOrEnd";
        } else {
            if (this.rootStarted) this.fail("JSON 根值之后存在额外内容");
            this.rootStarted = true;
        }
    }

    private consume(char: string): void {
        if (this.mode === "string") {
            if (this.unicode) {
                if (!/^[0-9a-f]$/i.test(char)) this.fail("无效的 Unicode 转义");
                this.unicode--;
            } else if (this.escaped) {
                if (char === "u") this.unicode = 4;
                else if (!'"\\/bfnrt'.includes(char)) this.fail("无效的字符串转义");
                this.escaped = false;
            } else if (char === "\\") this.escaped = true;
            else if (char === '"') {
                this.mode = undefined;
                if (this.key) this.stack[this.stack.length - 1].state = "colon";
            } else if (char.charCodeAt(0) < 32) this.fail("字符串中包含未转义的控制字符");
            this.append(char, this.key ? "key" : "string");
            return;
        }
        if (this.mode === "literal") {
            if (char !== this.literal[this.literalIndex++]) this.fail("无效的 JSON 值");
            this.append(char, "literal");
            if (this.literalIndex === this.literal.length) this.mode = undefined;
            return;
        }
        if (this.mode === "number") {
            if (this.numberChar(char)) { this.append(char, "number"); return; }
            this.finishNumber();
        }
        if (char === " " || char === "\t" || char === "\n" || char === "\r") return;
        const frame = this.stack[this.stack.length - 1];
        if (char === '"') {
            this.key = frame?.type === "object" && (frame.state === "keyOrEnd" || frame.state === "key");
            if (!this.key) this.startValue();
            this.mode = "string";
            this.append(char, this.key ? "key" : "string");
        } else if (char === "{" || char === "[") {
            this.startValue();
            if (this.stack.length >= 512) this.fail("嵌套超过 512 层，已停止预览");
            this.append(char, "punctuation");
            this.flush();
            this.stack.push({ type: char === "{" ? "object" : "array", state: char === "{" ? "keyOrEnd" : "valueOrEnd" });
        } else if (char === "}" || char === "]") {
            if (!frame || frame.type !== (char === "}" ? "object" : "array") ||
                !["keyOrEnd", "valueOrEnd", "commaOrEnd"].includes(frame.state)) this.fail("不匹配的结束符或多余逗号");
            this.flush();
            this.stack.pop();
            this.append(char, "punctuation");
        } else if (char === ":") {
            if (frame?.state !== "colon") this.fail("意外的冒号");
            frame.state = "value";
            this.append(": ", "punctuation");
        } else if (char === ",") {
            if (frame?.state !== "commaOrEnd") this.fail("意外的逗号");
            frame.state = frame.type === "object" ? "key" : "value";
            this.append(char, "punctuation");
            this.flush();
        } else if (char === "-" || /^[0-9]$/.test(char)) {
            this.startValue();
            this.mode = "number";
            this.numberState = char === "-" ? "sign" : char === "0" ? "zero" : "integer";
            this.append(char, "number");
        } else if (char === "t" || char === "f" || char === "n") {
            this.startValue();
            this.mode = "literal";
            this.literal = char === "t" ? "true" : char === "f" ? "false" : "null";
            this.literalIndex = 1;
            this.append(char, "literal");
        } else this.fail("意外的字符");
    }

    private numberChar(char: string): boolean {
        const digit = /^[0-9]$/.test(char);
        switch (this.numberState) {
            case "sign":
                if (!digit) return false;
                this.numberState = char === "0" ? "zero" : "integer"; return true;
            case "zero": case "integer":
                if (digit && this.numberState === "integer") return true;
                if (char === ".") { this.numberState = "dot"; return true; }
                if (char === "e" || char === "E") { this.numberState = "exponent"; return true; }
                return false;
            case "dot": case "fraction":
                if (digit) { this.numberState = "fraction"; return true; }
                if (this.numberState === "fraction" && (char === "e" || char === "E")) { this.numberState = "exponent"; return true; }
                return false;
            case "exponent":
                if (char === "+" || char === "-") { this.numberState = "exponentSign"; return true; }
                if (digit) { this.numberState = "exponentDigits"; return true; }
                return false;
            case "exponentSign": case "exponentDigits":
                if (digit) { this.numberState = "exponentDigits"; return true; }
                return false;
        }
    }

    private finishNumber(): void {
        if (!["zero", "integer", "fraction", "exponentDigits"].includes(this.numberState)) this.fail("无效的数字");
        this.mode = undefined;
    }
}
