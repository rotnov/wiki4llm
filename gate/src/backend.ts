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
export interface DocumentMetadata {
  collection: string;
  path: string;
  title: string;
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
export interface Document extends DocumentMetadata {
  body: string;
  original?: {
    mimeType: string;
    byteLength: number;
    sha256: string;
    blob?: string;
  };
}
export interface DocumentDiscovery {
  results: DocumentMetadata[];
  hasMore: boolean;
}
export interface Hit extends Document {
  score: number;
}
export interface SearchOptions {
  rewriteQuery?: boolean;
}
export interface EffectiveQuery {
  collection: string;
  search_query: string[] | null;
}
export interface SearchResult {
  hits: Hit[];
  effectiveQueries?: EffectiveQuery[];
}
export interface Backend {
  findDocuments?(
    workspace: Workspace,
    query: string,
    repository: string | undefined,
    limit: number,
    signal: AbortSignal,
  ): Promise<DocumentDiscovery>;
  search(
    workspace: Workspace,
    query: string,
    mode: SearchMode,
    limit: number,
    signal: AbortSignal,
    options?: SearchOptions,
  ): Promise<SearchResult>;
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
