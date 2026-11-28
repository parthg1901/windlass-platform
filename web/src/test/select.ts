/** Test helpers for the form select (components/ui/Select.tsx): open its menu and choose a row. */
import { act } from "react";

/** The choices the select's menu lists, by value, opening it first. */
export async function optionsOf(trigger: HTMLElement): Promise<HTMLElement[]> {
	if (trigger.getAttribute("aria-expanded") !== "true") await act(async () => trigger.click());
	const id = trigger.getAttribute("aria-controls");
	const menu = id ? document.getElementById(id) : null;
	return [...(menu ?? document).querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
}

/** Opens the select's menu and chooses the row with this value. */
export async function chooseOption(trigger: HTMLElement, value: string): Promise<void> {
	const row = (await optionsOf(trigger)).find(one => one.dataset.value === value);
	if (!row) throw new Error(`No option ${JSON.stringify(value)} in ${trigger.id || trigger.textContent}`);
	await act(async () => row.click());
}
