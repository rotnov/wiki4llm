import assert from "node:assert/strict";

// Check wire output, including prose retained by connectors that flatten schemas.
export function assertParameterGuidance(tools: any[]) {
  const expected: Record<string, Record<string, string[]>> = {
    list_workspaces: {
      offset: ["0", "100000", "default 0", "nextOffset"],
      limit: ["1", "50", "default 20"],
    },
    query: {
      query: ["1", "4096"],
      workspaces: ["20", "80", "omitted"],
      mode: ["lex", "vec", "hybrid"],
      limit: ["1", "20", "default 10"],
    },
    find_documents: {
      workspace: ["exact", "authorized"],
      query: ["literal", "1", "1024"],
      repository: ["exact", "case-sensitive", "256"],
      limit: ["1", "20", "default 5"],
    },
    get: {
      ref: ["8192", "query", "find_documents"],
      fromLine: ["1", "1000000", "default 1"],
      maxLines: ["1", "200", "omitted", "all"],
      format: ["parsed", "default", "original"],
    },
    multi_get: {
      refs: ["1", "20", "8192", "find_documents"],
      maxLines: ["1", "200", "omitted", "all"],
      format: ["parsed", "default", "original"],
    },
    status: { workspaces: ["20", "80", "omitted"] },
  };
  for (const [name, fields] of Object.entries(expected)) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    assert.equal(
      tool.outputSchema,
      undefined,
      `${name} uses JSON text content`,
    );
    for (const [field, terms] of Object.entries(fields)) {
      for (const term of terms) {
        assert.ok(
          tool.inputSchema.properties[field].description?.includes(term),
          `${name}.${field} field description missing ${term}`,
        );
      }
    }
  }
  for (const tool of tools)
    assert.ok(
      tool.description.length <= 400,
      `${tool.name} tool prose must stay concise`,
    );
  const essential: Record<string, string[]> = {
    list_workspaces: [
      "authorized",
      "limit 1-50",
      "default 20",
      "offset",
      "default 0",
      "nextOffset",
      "null",
    ],
    query: [
      "authorized",
      "limit 1-20",
      "default 10",
      "workspaces",
      "omitted",
      "all",
      "20",
      "lex",
      "vec",
      "hybrid",
      "default hybrid",
    ],
    find_documents: [
      "OpenAI",
      "literal",
      "workspace",
      "repository",
      "limit 1-20",
      "default 5",
      "hasMore",
      "QMD",
    ],
    get: [
      "query",
      "maxLines 1-200",
      "full",
      "fromLine",
      "one-based",
      "default 1",
    ],
    multi_get: ["authorized", "1-20", "first line", "maxLines 1-200", "full"],
    status: ["authorized", "workspaces", "omitted", "all", "20"],
  };
  for (const [name, terms] of Object.entries(essential)) {
    const description = tools.find((t) => t.name === name).description;
    for (const term of terms)
      assert.ok(
        description.includes(term),
        `${name} tool description missing ${term}`,
      );
  }
  for (const name of ["query", "get", "multi_get"]) {
    const description = tools.find((t) => t.name === name).description;
    for (const term of [
      "local",
      "repository",
      "relative path",
      "own tools",
      "revision differences",
      "source.sha256 hashes original bytes",
    ])
      assert.ok(
        description.includes(term),
        `${name} missing local-source guidance ${term}`,
      );
  }
  for (const name of ["get", "multi_get"]) {
    const properties = tools.find((t) => t.name === name).inputSchema
      .properties;
    assert.equal(properties.format.default, "parsed");
    assert.equal(properties.maxLines.default, undefined);
  }
  const list = tools.find((t) => t.name === "list_workspaces");
  assert.equal(list.inputSchema.properties.limit.maximum, 50);
  assert.equal(list.inputSchema.properties.limit.default, 20);
}
