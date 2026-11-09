import type { Workspace } from "./state-contract.js";
export type SearchMode = "lex" | "vec" | "hybrid";
export interface Document {
  collection: string;
  path: string;
  title: string;
  body: string;
  source?: {
    kind: "openai";
    repository: string;
    path: string;
    sourceCommit: string | null;
    repositoryCommit: string | null;
    publicationId: string;
    sha256: string;
    fileKind: string;
    lineBasis: "parsed-text";
  };
}
export interface Hit extends Document {
  score: number;
}
export interface Backend {
  search(
    workspace: Workspace,
    query: string,
    mode: SearchMode,
    limit: number,
    signal: AbortSignal,
  ): Promise<Hit[]>;
  read(
    workspace: Workspace,
    collection: string,
    path: string,
    signal: AbortSignal,
  ): Promise<Document | undefined>;
  status(
    workspace: Workspace,
    signal: AbortSignal,
  ): Promise<{ documents: number; vectors: number | null; backend?: string }>;
}
