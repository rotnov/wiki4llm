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
    get: {
      ref: ["8192", "query"],
      fromLine: ["1", "1000000", "default 1"],
      maxLines: ["1", "200", "default 80"],
    },
    multi_get: {
      refs: ["1", "20", "8192"],
      maxLines: ["1", "200", "default 80"],
    },
    status: { workspaces: ["20", "80", "omitted"] },
  };
  for (const [name, fields] of Object.entries(expected)) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    for (const [field, terms] of Object.entries(fields)) {
      for (const term of terms) {
        assert.ok(
          tool.inputSchema.properties[field].description?.includes(term),
          `${name}.${field} field description missing ${term}`,
        );
        assert.ok(
          tool.description?.includes(term),
          `${name} tool description missing ${term}`,
        );
      }
    }
  }
  const list = tools.find((t) => t.name === "list_workspaces");
  assert.equal(list.inputSchema.properties.limit.maximum, 50);
  assert.equal(list.inputSchema.properties.limit.default, 20);
}
