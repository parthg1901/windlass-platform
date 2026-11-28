/**
 * A branch as a person reads it. The platform names a feature's branches by internal ids
 * (server/src/github/feature.ts: `windlass/feature-<item>` and `windlass/feature-<item>-<key>-<part>`);
 * those are said by what they are, and every other branch by its own name. The exact name is
 * still one copy away (BranchName.tsx).
 */
const FEATURE = /^windlass\/feature-i_[a-z0-9]+$/;
const PART = /^windlass\/feature-i_[a-z0-9]+-[a-z][a-z0-9_-]{0,31}-i_[a-z0-9]+$/;

export function branchLabel(branch: string): string {
	if (FEATURE.test(branch)) return "feature branch";
	if (PART.test(branch)) return "part's branch";
	return branch;
}
