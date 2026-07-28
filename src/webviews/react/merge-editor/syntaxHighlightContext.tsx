import { createContext, useContext } from "react";
import type { ShikiTheme } from "./shikiHighlighter";

export interface SyntaxHighlightState {
    ready: boolean;
    lang: string | null;
    theme: ShikiTheme;
}

const DEFAULT_STATE: SyntaxHighlightState = {
    ready: false,
    lang: null,
    theme: "dark-plus",
};

const SyntaxHighlightContext = createContext<SyntaxHighlightState>(DEFAULT_STATE);

export const SyntaxHighlightProvider = SyntaxHighlightContext.Provider;

export function useSyntaxHighlightState(): SyntaxHighlightState {
    return useContext(SyntaxHighlightContext);
}
