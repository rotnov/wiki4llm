import assert from "node:assert/strict";
import test from "node:test";
import * as errors from "../src/errors.js";

for (const [stage, limitBytes, explanation] of [
  ["provider_response", 2097152, "gate's 2 MiB response-read limit"],
  ["parsed_content", 2097152, "2 MiB parsed-text limit"],
  ["tool_response", 65536, "64 KiB logical response budget"],
  ["tool_response", 4194304, "4 MiB logical response budget"],
] as const)
  test(`size errors expose only fixed ${stage}/${limitBytes} diagnostics`, () => {
    assert.equal(typeof (errors as any).ContentTooLargeError, "function");
    const error = new (errors as any).ContentTooLargeError(stage, limitBytes);
    error.message = "private message";
    error.stack = "private stack";
    error.providerBody = "private body";
    assert.equal(error.code, "CONTENT_TOO_LARGE");
    assert.ok(Object.isFrozen(error.diagnostics));
    const wire = errors.publicError(error);
    assert.ok(wire.includes(explanation));
    assert.deepEqual(JSON.parse(wire.split(" Diagnostics: ")[1]!), {
      stage,
      limitBytes,
    });
    assert.ok(!wire.includes("private"));
  });

test("size diagnostics reject unknown stages and nonmatching limits", () => {
  assert.equal(typeof (errors as any).ContentTooLargeError, "function");
  for (const [stage, limitBytes] of [
    ["private stage", 2097152],
    ["provider_response", 65536],
    ["parsed_content", 4194304],
    ["tool_response", 2097152],
    ["tool_response", "private limit"],
  ])
    assert.throws(
      () => new (errors as any).ContentTooLargeError(stage, limitBytes),
    );
  const generic = errors.publicError(
    new errors.GateError("CONTENT_TOO_LARGE", "private message"),
  );
  assert.match(generic, /^CONTENT_TOO_LARGE:/);
  assert.ok(!generic.includes("private"));
  assert.ok(!generic.includes("Diagnostics:"));
});
