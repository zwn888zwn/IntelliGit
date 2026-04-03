// Tab switcher between Commit and Shelf tabs. Uses Chakra UI Tabs
// with custom styling to match the VS Code sidebar appearance.

import React from "react";
import { Tabs, TabList, Tab, TabPanels, TabPanel } from "@chakra-ui/react";

interface Props {
    stashCount: number;
    repositoryLabel: string;
    commitContent: React.ReactNode;
    shelfContent: React.ReactNode;
}

const sharedTabStyles = {
    px: "14px",
    py: "6px",
    minH: "32px",
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--vscode-foreground)",
    opacity: 0.75,
    borderBottom: "2px solid transparent",
    _selected: {
        opacity: 1,
        borderBottomColor: "var(--vscode-focusBorder, #007acc)",
    },
    _hover: { opacity: 0.85 },
} as const;

export function TabBar({
    stashCount,
    repositoryLabel,
    commitContent,
    shelfContent,
}: Props): React.ReactElement {
    const tabs: Array<{ key: string; label: string; content: React.ReactNode }> = [
        { key: "commit", label: "Commit", content: commitContent },
        {
            key: "shelf",
            label: `Stash${stashCount > 0 ? ` (${stashCount})` : ""}`,
            content: shelfContent,
        },
    ];

    return (
        <Tabs variant="unstyled" display="flex" flexDirection="column" h="100%">
            <TabList
                borderBottom="1px solid var(--vscode-panel-border, #444)"
                flexShrink={0}
                justifyContent="space-between"
                alignItems="flex-end"
            >
                <div style={{ display: "flex" }}>
                    {tabs.map((tab) => (
                        <Tab key={tab.key} {...sharedTabStyles}>
                            {tab.label}
                        </Tab>
                    ))}
                </div>
                <div
                    style={{
                        padding: "0 12px 8px",
                        fontSize: "11px",
                        color: "var(--vscode-descriptionForeground)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                    }}
                    title={repositoryLabel}
                >
                    Repo: {repositoryLabel}
                </div>
            </TabList>
            <TabPanels flex={1} overflow="hidden" display="flex" flexDirection="column">
                {tabs.map((tab) => (
                    <TabPanel
                        key={tab.key}
                        p={0}
                        flex={1}
                        display="flex"
                        flexDirection="column"
                        overflow="hidden"
                    >
                        {tab.content}
                    </TabPanel>
                ))}
            </TabPanels>
        </Tabs>
    );
}
