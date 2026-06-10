import React from "react";
import {
    Box,
    Button,
    Checkbox,
    Flex,
    FormControl,
    FormLabel,
    Input,
    Modal,
    ModalBody,
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalOverlay,
    Select,
} from "@chakra-ui/react";
import type { RepositoryContextInfo } from "../../../../types";

interface Props {
    isOpen: boolean;
    repositories: RepositoryContextInfo[];
    repoRoot: string;
    message: string;
    keepIndex: boolean;
    selectedCount: number;
    onRepoRootChange: (repoRoot: string) => void;
    onMessageChange: (message: string) => void;
    onKeepIndexChange: (keepIndex: boolean) => void;
    onCancel: () => void;
    onCreate: () => void;
}

export function StashDialog({
    isOpen,
    repositories,
    repoRoot,
    message,
    keepIndex,
    selectedCount,
    onRepoRootChange,
    onMessageChange,
    onKeepIndexChange,
    onCancel,
    onCreate,
}: Props): React.ReactElement {
    const canCreate = repoRoot.trim().length > 0;
    return (
        <Modal isOpen={isOpen} onClose={onCancel} size="xs" isCentered motionPreset="none">
            <ModalOverlay bg="rgba(0, 0, 0, 0.38)" />
            <ModalContent
                mx="10px"
                bg="var(--vscode-sideBar-background, var(--vscode-editor-background))"
                color="var(--vscode-foreground)"
                border="1px solid var(--vscode-panel-border)"
                borderRadius="6px"
                boxShadow="0 8px 30px rgba(0,0,0,0.35)"
            >
                <ModalHeader fontSize="13px" fontWeight={600} py="10px" pr="34px">
                    Create Stash
                </ModalHeader>
                <ModalCloseButton top="7px" right="8px" size="sm" />
                <ModalBody py="4px">
                    <Flex direction="column" gap="10px">
                        <FormControl>
                            <FormLabel fontSize="12px" mb="4px">
                                Git Root
                            </FormLabel>
                            <Select
                                size="sm"
                                value={repoRoot}
                                onChange={(event) => onRepoRootChange(event.target.value)}
                                bg="var(--vscode-input-background)"
                                borderColor="var(--vscode-input-border, var(--vscode-panel-border))"
                                color="var(--vscode-input-foreground)"
                                h="28px"
                                fontSize="12px"
                            >
                                {repositories.map((repository) => (
                                    <option key={repository.root} value={repository.root}>
                                        {repository.relativePath ?? repository.name}
                                    </option>
                                ))}
                            </Select>
                        </FormControl>

                        <FormControl>
                            <FormLabel fontSize="12px" mb="4px">
                                Message
                            </FormLabel>
                            <Input
                                autoFocus
                                size="sm"
                                value={message}
                                placeholder="Shelved changes"
                                onChange={(event) => onMessageChange(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && canCreate) {
                                        onCreate();
                                    }
                                }}
                                bg="var(--vscode-input-background)"
                                borderColor="var(--vscode-input-border, var(--vscode-panel-border))"
                                color="var(--vscode-input-foreground)"
                                h="28px"
                                fontSize="12px"
                            />
                        </FormControl>

                        <Checkbox
                            size="sm"
                            isChecked={keepIndex}
                            onChange={(event) => onKeepIndexChange(event.target.checked)}
                        >
                            Keep index
                        </Checkbox>

                        <Box
                            fontSize="11px"
                            color="var(--vscode-descriptionForeground)"
                            minH="16px"
                        >
                            {selectedCount > 0 ? `${selectedCount} selected file(s)` : "All changes"}
                        </Box>
                    </Flex>
                </ModalBody>
                <ModalFooter gap="8px" py="10px">
                    <Button variant="secondary" size="sm" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button variant="primary" size="sm" onClick={onCreate} isDisabled={!canCreate}>
                        Create Stash
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
