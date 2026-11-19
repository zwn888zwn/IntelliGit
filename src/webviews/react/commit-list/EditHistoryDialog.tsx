import React, { useRef, useState } from "react";
import { Box, Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Textarea } from "@chakra-ui/react";
import type { EditHistoryPrompt } from "../commitGraphTypes";

export function EditHistoryDialog({ prompt, finish }: {
    prompt: EditHistoryPrompt;
    finish: (message?: string) => void;
}) {
    const [message, setMessage] = useState(prompt.message);
    const input = useRef<HTMLTextAreaElement>(null);
    const squash = prompt.operation === "squash";
    const count = prompt.commits.length;
    const title = squash ? `Squash ${count} commits` : `Edit message for ${prompt.commits[0].hash.slice(0, 8)}`;
    const disabled = !message.trim() || (!squash && message === prompt.message);
    return (
        <Modal isOpen onClose={() => finish()} initialFocusRef={input} isCentered motionPreset="none" scrollBehavior="inside">
            <ModalOverlay />
            <ModalContent maxH="calc(100vh - 12px)" maxW="min(540px, 96vw)" my="6px" bg="var(--vscode-editor-background)" color="var(--vscode-editor-foreground)">
                <ModalHeader py={1} fontSize="sm">{title}</ModalHeader>
                <ModalBody fontSize="sm" px={4}>
                    <Box mb={1}>{prompt.repository} / {prompt.branch.replace(/^refs\/heads\//, "")} · {count} local {count === 1 ? "commit" : "commits"}</Box>
                    <Box as="ol" m={0} mb={2} p={0} listStyleType="none" overflowY="auto" maxH="min(15vh, 100px)">
                        {prompt.commits.map(commit => <Box as="li" key={commit.hash} isTruncated title={commit.subject}>
                            <code>{commit.hash.slice(0, 8)}</code> {commit.subject}
                        </Box>)}
                    </Box>
                    <Textarea ref={input} value={message} aria-label="Commit message" size="sm" minH="48px" h="min(18vh, 110px)"
                        bg="var(--vscode-input-background)" color="var(--vscode-input-foreground)"
                        onChange={event => setMessage(event.target.value)} />
                    <Box mt={1} fontSize="xs" color="var(--vscode-descriptionForeground)">
                        {squash ? "The combined commit keeps the final code snapshot." :
                            "The listed commits get new hashes and keep their code snapshots."}
                    </Box>
                </ModalBody>
                <ModalFooter py={1} gap={2}>
                    <Button size="sm" variant="secondary" onClick={() => finish()}>Cancel</Button>
                    <Button size="sm" variant="primary" isDisabled={disabled} onClick={() => finish(message)}>
                        {squash ? "Squash commits" : "Save message"}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
