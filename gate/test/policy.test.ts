import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectWorkspaces,
  resolveSelection,
  validateSlug,
  validatePattern,
} from "../src/policy.js";
const registry = [
  "amplifier",
  "amplifier-mobile",
  "amplifier-server",
  "amplifierx-mobile",
  "dsx",
];

test("namespace grants match descendants but not the root or a similar prefix", () => {
  assert.deepEqual(
    selectWorkspaces(registry, { allow: ["amplifier-*"], deny: [] }),
    ["amplifier-mobile", "amplifier-server"],
  );
});
test("root and namespace can be granted together", () => {
  assert.deepEqual(
    selectWorkspaces(registry, {
      allow: ["amplifier", "amplifier-*"],
      deny: [],
    }),
    registry.slice(0, 3),
  );
});
test("an owner wildcard grants all registered data workspaces", () => {
  assert.deepEqual(
    selectWorkspaces(registry, { allow: ["*"], deny: [] }),
    registry,
  );
});
test("deny overrides exact and wildcard allows", () => {
  assert.deepEqual(
    selectWorkspaces(registry, { allow: ["*"], deny: ["amplifier-*", "dsx"] }),
    ["amplifier", "amplifierx-mobile"],
  );
});
test("no allow rules grant no workspaces", () => {
  assert.deepEqual(selectWorkspaces(registry, { allow: [], deny: [] }), []);
});
test("token constraints intersect rather than extend principal rights", () => {
  assert.deepEqual(
    selectWorkspaces(
      registry,
      { allow: ["amplifier-*"], deny: [] },
      { allow: ["amplifier-mobile", "dsx"], deny: [] },
    ),
    ["amplifier-mobile"],
  );
});
test("an explicit empty token constraint grants nothing", () => {
  assert.deepEqual(
    selectWorkspaces(
      registry,
      { allow: ["*"], deny: [] },
      { allow: [], deny: [] },
    ),
    [],
  );
});
test("future namespace children inherit a namespace grant", () => {
  assert.deepEqual(
    selectWorkspaces([...registry, "amplifier-new"], {
      allow: ["amplifier-*"],
      deny: [],
    }),
    ["amplifier-mobile", "amplifier-server", "amplifier-new"],
  );
});
test("omitted selection uses the effective grants", () => {
  assert.deepEqual(resolveSelection(["amplifier", "dsx"]), [
    "amplifier",
    "dsx",
  ]);
});
test("selection patterns expand only over effective grants", () => {
  assert.deepEqual(
    resolveSelection(["amplifier-mobile", "dsx"], ["amplifier-*"]),
    ["amplifier-mobile"],
  );
});
test("one forbidden explicit workspace rejects the entire mixed selection", () => {
  assert.throws(() => resolveSelection(["amplifier"], ["amplifier", "dsx"]), {
    code: "ACCESS_DENIED",
  });
});
test("empty authorized and requested selections never become an unfiltered query", () => {
  assert.throws(() => resolveSelection([]), { code: "ACCESS_DENIED" });
  assert.throws(() => resolveSelection(["amplifier"], []), {
    code: "ACCESS_DENIED",
  });
});
test("invalid slugs and ambiguous patterns fail closed", () => {
  for (const slug of [
    "Amplifier",
    "amplifier_foo",
    "../dsx",
    "amplifier%2fmobile",
    "amplifier--mobile",
    "аmplifier",
    "",
    "a".repeat(81),
  ])
    assert.throws(() => validateSlug(slug), { code: "INVALID_INPUT" });
  for (const pattern of [
    "amplifier*",
    "*mobile",
    "amplifier-**",
    "amplifier-?",
    "amplifier-[a-z]",
    "AMP-*",
  ])
    assert.throws(() => validatePattern(pattern), { code: "INVALID_INPUT" });
});
test("selection has a finite workspace limit", () => {
  assert.throws(
    () => resolveSelection(Array.from({ length: 21 }, (_, i) => "ws-" + i)),
    { code: "INVALID_INPUT" },
  );
});
