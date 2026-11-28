import { branchLabel } from "../lib/branch";
import { CopyButton } from "./Copy";
import { BranchIcon } from "./Icons";

/**
 * A branch as a chip: a feature's branches in words a person reads (lib/branch.ts), any other branch by its own
 * name in monospace, the exact name on hover, and a copy control inside the chip.
 */
export function BranchName({ branch }: { branch: string }) {
	const label = branchLabel(branch);
	return (
		<span className={`branch-name${label === branch ? "" : " branch-name-words"}`} title={branch}>
			<BranchIcon size={11} className="branch-name-icon" />
			<span className="branch-name-text">{label}</span>
			<CopyButton text={branch} label={`Copy the branch name, ${branch}`} />
		</span>
	);
}
