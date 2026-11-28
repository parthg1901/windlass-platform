import type { CredentialRef, ModelProvider } from "../../server/src/contract.js";

/** The wire of a saved credential: a Settings key's provider, or a plan's own (`claude-plan`, `chatgpt-plan`). */
export type KeyWire = ModelProvider | "claude-plan" | "chatgpt-plan";
export const wires: Record<KeyWire, { base: string; host: string }>;
export function credentialWire(ref: Pick<CredentialRef, "provider" | "plan">): KeyWire;
export function forwardHost(value: unknown): value is string;
export function forwardPlaceholder(value: unknown): value is string;
export function validProofKey(value: unknown): value is string;
export function harnessMethod(harness: string | undefined, wire: KeyWire, path: string): string | false | undefined;
export const proofHeader: string;
export function forwardProof(key: string, machine: string, method: string, path: string, time: number): string;
