import { describe, expect, it } from "vitest";
import { goImports, goTokens, swaggerReferenceAt } from "../../src/services/go/swaggerReferences";

function reference(source: string, name: string, occurrence = 0) {
    let offset = -1;
    for (let i = 0; i <= occurrence; i++) offset = source.indexOf(name, offset + 1);
    return swaggerReferenceAt(goTokens(source), offset + Math.max(0, name.length - 2));
}

describe("Swagger comment type references", () => {
    it("selects the nested model and response envelope independently", () => {
        const source = '// @Success 200 {object} client_model.SuccessResponse{data=[]service.SolveRespV161} "结果"';
        for (const [name, qualifier] of [["SolveRespV161", "service"], ["SuccessResponse", "client_model"]]) {
            const item = reference(source, name)!;
            expect(item).toMatchObject({ name, qualifier });
            expect(source.slice(item.start, item.end)).toBe(`${qualifier}.${name}`);
        }
        expect(reference(source, "data")).toBeUndefined();
        expect(reference(source, "结果")).toBeUndefined();
    });
    it.each([
        '// @Param data body []api.Request true "request"',
        '// @Failure 400 {object} api.Request',
        '// @Response 200 {array} api.Request',
        '// @Success 200 {object} Envelope[data.Request]',
        '// @Success 200 {object} Envelope{data=map[string][]api.Request, error=api.Failure}',
    ])("recognizes supported annotation type expressions: %s", source => {
        expect(reference(source, "Request")).toMatchObject({ name: "Request" });
    });
    it("does not intercept code, descriptions, string literals or block comment examples", () => {
        for (const source of [
            'var x api.Request',
            '// @Description see api.Request',
            '// @Router /api.Request [post]',
            'const example = `\n// @Success 200 {object} api.Request\n`',
            '/*\n// @Success 200 {object} api.Request\n*/',
            '// @Param data body string true "api.Request"',
        ]) expect(reference(source, "Request")).toBeUndefined();
        expect(reference('// @Param data body string true "text"', "string")).toBeUndefined();
    });
    it("keeps import aliases, blank imports and raw import offsets", () => {
        const source = `package controller
// import "wrong/package"
import alias "example.com/types"
import (
  _ "example.com/client_model"
  "example.com/api/v2"
  raw \`example.com/raw\`
)
const sample = \`import "wrong/again"\`
`;
        const imports = goImports(goTokens(source));
        expect(imports.map(({ alias, path }) => ({ alias, path }))).toEqual([
            { alias: "alias", path: "example.com/types" },
            { alias: "_", path: "example.com/client_model" },
            { alias: undefined, path: "example.com/api/v2" },
            { alias: "raw", path: "example.com/raw" },
        ]);
        for (const item of imports) expect(source.slice(item.offset, item.offset + item.path.length)).toBe(item.path);
    });
});
