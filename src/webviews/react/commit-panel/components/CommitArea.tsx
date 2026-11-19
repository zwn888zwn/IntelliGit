// Bottom area of the commit tab: amend checkbox, commit message textarea,
// and commit/commit+push buttons.

import React from "react";
import { Flex, Box, Textarea, Button } from "@chakra-ui/react";
import { VscCheckbox } from "./VscCheckbox";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";

interface Props {
    commitMessage: string;
    isAmend: boolean;
    canAmend: boolean;
    onOpenMerge?: () => void;
    onMessageChange: (message: string) => void;
    onAmendChange: (isAmend: boolean) => void;
    onCommit: () => void;
    onCommitAndPush: () => void;
}

export function CommitArea({
    commitMessage,
    isAmend,
    canAmend,
    onOpenMerge,
    onMessageChange,
    onAmendChange,
    onCommit,
    onCommitAndPush,
}: Props): React.ReactElement {
    const amendCheckboxId = "commit-area-amend-checkbox";
    return (
        <Flex direction="column" overflow="hidden" flex={1}>
            {onOpenMerge ? (
                <Button size="xs" variant="link" alignSelf="flex-start" mx="7px" minH="24px" onClick={onOpenMerge}>
                    Open Merge Conflicts to finish merge
                </Button>
            ) : <Flex
                as="label"
                htmlFor={amendCheckboxId}
                align="center"
                gap="5px"
                px="7px"
                py="3px"
                fontSize="12px"
                minH="24px"
                cursor={canAmend ? "pointer" : "default"}
                opacity={canAmend ? 1 : 0.55}
                title={canAmend ? undefined : "Amend requires an unpushed commit in a single repository."}
            >
                <VscCheckbox
                    isChecked={isAmend}
                    disabled={!canAmend}
                    onChange={() => onAmendChange(!isAmend)}
                    inputId={amendCheckboxId}
                    inputTestId="amend-checkbox"
                />
                <Box as="span" color="var(--vscode-foreground)" opacity={0.9}>
                    Amend
                </Box>
            </Flex>}
            <Box px="7px" flex={1} overflow="hidden">
                <Textarea
                    isReadOnly={Boolean(onOpenMerge)}
                    value={commitMessage}
                    onChange={(e) => onMessageChange(e.target.value)}
                    placeholder="Commit Message"
                    resize="none"
                    w="100%"
                    h="100%"
                    bg="rgba(16, 21, 31, 0.72)"
                    color="var(--vscode-input-foreground)"
                    border="1px solid"
                    borderColor="rgba(176, 186, 205, 0.35)"
                    borderRadius="3px"
                    p="7px 9px"
                    fontFamily={SYSTEM_FONT_STACK}
                    fontSize="12px"
                    _placeholder={{ color: "var(--vscode-input-placeholderForeground)" }}
                    _focus={{ borderColor: "#5a8fe9" }}
                />
            </Box>
            <Flex align="center" gap="8px" p="6px 7px 8px">
                <Button
                    variant="primary"
                    size="sm"
                    isDisabled={Boolean(onOpenMerge)}
                    onClick={onCommit}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                >
                    Commit
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    isDisabled={Boolean(onOpenMerge)}
                    onClick={onCommitAndPush}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                >
                    Commit and Push...
                </Button>
            </Flex>
        </Flex>
    );
}
