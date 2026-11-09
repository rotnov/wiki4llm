import type { OpenAISnapshot } from "./manifest.js";
export interface Source {
  name: string;
  path: string;
}
export interface Workspace {
  id: string;
  generation: string | null;
  sources: Source[];
  backend?: "qmd" | "openai";
  openai?: OpenAISnapshot;
}
export interface Context {
  tokenId: string;
  principalId: string;
  allowed: string[];
  revision: number;
}
export interface StateReader {
  context(handle: string): Context;
  workspace(id: string): Workspace;
}
