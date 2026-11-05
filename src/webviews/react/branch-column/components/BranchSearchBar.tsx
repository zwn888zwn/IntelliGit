import React from "react";
import { LuSearch, LuX } from "react-icons/lu";
import { SEARCH_CLEAR_BUTTON_STYLE, SEARCH_CONTAINER_STYLE, SEARCH_INPUT_STYLE } from "../styles";
import { PANEL_SEARCH_FIELD_STYLE } from "../../shared/panelStyles";

export interface Props {
    value: string;
    onChange: (value: string) => void;
    onClear: () => void;
}

export function BranchSearchBar({ value, onChange, onClear }: Props): React.ReactElement {
    return (
        <div style={SEARCH_CONTAINER_STYLE}>
            <div className="intelligit-search-field" style={{ ...PANEL_SEARCH_FIELD_STYLE, flex: 1 }}>
                <LuSearch size={14} style={{ flexShrink: 0 }} />
                <input
                    className="branch-search-input"
                    type="text"
                    aria-label="Search branches"
                    placeholder="Search branches"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    style={SEARCH_INPUT_STYLE}
                />
                {value.length > 0 && (
                    <button
                        type="button"
                        aria-label="Clear branch search"
                        title="Clear"
                        onClick={onClear}
                        style={SEARCH_CLEAR_BUTTON_STYLE}
                    >
                        <LuX size={14} />
                    </button>
                )}
            </div>
        </div>
    );
}
