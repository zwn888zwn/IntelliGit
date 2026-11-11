// @vitest-environment jsdom
import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { JsonTreeView } from "../../src/webviews/react/json-preview/JsonTreeView";
import { initReactDomTestEnvironment, mount } from "./utils/reactDomTestUtils";
import type { JsonTreeMessage, JsonTreeNode } from "../../src/services/jsonPreview/types";

const api = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock("../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();
const node = (offset: number, label: string, kind: JsonTreeNode["kind"] = "object"): JsonTreeNode => ({ offset, label, kind, preview: '{ … }', truncated: false });
const emit = (data: JsonTreeMessage) => act(() => { window.dispatchEvent(new MessageEvent("message", { data })); });
const requests = () => api.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === "children");

function openRoot() {
    mount(<JsonTreeView onCodeView={() => {}} />);
    emit({ type: "reset", generation: 1, name: 'large.json', size: 300 * 1024 * 1024 });
    emit({ type: "root", generation: 1, node: node(0, '$', 'array') });
    return requests()[0];
}

describe("JSON first entry expansion", () => {
    it("opens only the first direct container, not its siblings or grandchildren", () => {
        const rootRequest = openRoot();
        emit({ type: "children", generation: 1, parent: 0, request: rootRequest.request,
            nodes: [node(1, '[0]'), node(200, '[1]')], complete: false });
        expect(requests().map(request => request.parent)).toEqual([0, 1]);
        const childRequest = requests()[1];
        emit({ type: "children", generation: 1, parent: 1, request: childRequest.request,
            nodes: [node(10, 'nested')], complete: true });
        expect(requests().map(request => request.parent)).toEqual([0, 1]);
        expect(document.querySelector('button[aria-label="收起 [0]"]')).not.toBeNull();
        expect(document.querySelector('button[aria-label="展开 nested"]')).not.toBeNull();
        const collapse = document.querySelector('button[aria-label="收起 [0]"]')!;
        act(() => { collapse.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        emit({ type: "children", generation: 1, parent: 0, request: rootRequest.request, nodes: [node(300, '[2]')], complete: true });
        expect(document.querySelector('button[aria-label="展开 [0]"]')).not.toBeNull();
        expect(requests()).toHaveLength(2);
    });
    it("does not skip a first scalar to automatically expand later containers", () => {
        const request = openRoot();
        emit({ type: "children", generation: 1, parent: 0, request: request.request,
            nodes: [node(1, '[0]', 'number'), node(200, '[1]')], complete: true });
        expect(requests().map(request => request.parent)).toEqual([0]);
    });
});
