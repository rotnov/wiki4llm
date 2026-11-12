import type { Workspace } from "./state-contract.js";
import type { SourceOrigin } from "./manifest.js";
export type SearchMode = "lex" | "vec" | "hybrid";
export interface IndexingStatus {
  id: string;
  status: string;
  total: number;
  completed: number;
  created_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  error?: string;
  publication_id?: string;
}
export type ReadFormat = "parsed" | "original";
export interface Document {
  collection: string;
  path: string;
  title: string;
  body: string;
  original?: {
    mimeType: string;
    byteLength: number;
    sha256: string;
    blob?: string;
  };
  source?: {
    kind: "openai";
    repository: string;
    path: string;
    sourceCommit: string | null;
    repositoryCommit: string | null;
    publicationId: string;
    sha256: string;
    fileKind: string;
    lineBasis: "parsed-text" | "original-text" | "none";
    origin?: SourceOrigin;
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
    format?: ReadFormat,
  ): Promise<Document | undefined>;
  status(
    workspace: Workspace,
    signal: AbortSignal,
  ): Promise<{
    documents: number;
    vectors: number | null;
    backend?: string;
    indexing?: IndexingStatus;
  }>;
}
