/**
 * The names of a plan's tier as the provider's account data spells them, made readable for the plan's row
 * ("a@b.com · Max"). A value this does not know is shown title-cased as it came, never refused.
 */

/** "self_serve_business" → "Self Serve Business". */
function titleCased(raw: string): string {
	return raw
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map(word => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
		.join(" ")
		.slice(0, 40);
}

const CLAUDE_TIERS: Record<string, string> = {
	max: "Max",
	maxplan: "Max",
	max5: "Max",
	max5x: "Max",
	max20: "Ultra",
	max20x: "Ultra",
	pro: "Pro",
	team: "Team",
	enterprise: "Enterprise",
	free: "Free",
};

/** Anthropic's `organization_type` ("claude_max") or a subscription type ("Claude Max 20x subscription"). */
export function claudePlanLabel(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const key = raw
		.toLowerCase()
		.replace(/[\s_-]+/g, "")
		.replace(/^claude/, "")
		.replace(/subscription$/, "");
	return CLAUDE_TIERS[key] ?? titleCased(raw);
}

const CHATGPT_TIERS: Record<string, string> = {
	free: "Free",
	go: "Go",
	plus: "Plus",
	pro: "Pro",
	prolite: "Pro",
	promax: "Pro",
	team: "Business",
	business: "Business",
	self_serve_business_usage_based: "Business",
	self_serve_business_prolite: "Business",
	enterprise: "Enterprise",
	ent26: "Enterprise",
	enterprise_cbp_automation: "Enterprise",
	enterprise_cbp_usage_based: "Enterprise",
	edu: "Edu",
	edu_plus: "Edu",
	edu_pro: "Edu",
};

/** The `chatgpt_plan_type` of an OpenAI sign-in's claims ("plus"). "unknown" names no plan. */
export function chatgptPlanLabel(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw.trim() || raw === "unknown") return null;
	return CHATGPT_TIERS[raw.toLowerCase()] ?? titleCased(raw);
}

/** "a@b.com · Plus", or whichever half is known; null when neither is. */
export function accountLabel(email: string | null | undefined, tier: string | null): string | null {
	return [email?.slice(0, 200), tier].filter(Boolean).join(" · ") || null;
}
