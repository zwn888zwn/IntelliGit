import React from "react";
import { IconButton, Tooltip } from "@chakra-ui/react";
import { VscDiffMultiple } from "react-icons/vsc";

export function OpenChangesButton({
    onClick,
    disabled = false,
    title = "Open All Changes",
}: {
    onClick: () => void;
    disabled?: boolean;
    title?: string;
}): React.ReactElement {
    return (
        <Tooltip label={title} fontSize="11px" placement="bottom" openDelay={300}>
            <IconButton
                aria-label={title}
                variant="toolbarGhost"
                size="sm"
                flexShrink={0}
                isDisabled={disabled}
                icon={<VscDiffMultiple size={16} aria-hidden="true" />}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                }}
                onClick={(event) => {
                    event.stopPropagation();
                    onClick();
                }}
            />
        </Tooltip>
    );
}
