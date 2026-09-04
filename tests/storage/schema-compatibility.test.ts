import { describe, expect, it } from "vitest";
import { createPgInt8SafeTypes } from "../../src/storage/pg-int8.js";
import { normalizePgTextArray } from "../../src/storage/schema-compatibility.js";

describe("PostgreSQL foreign-key column result normalization", () => {
  it("accepts the node-postgres decoded text[] shape and raw PostgreSQL array text", () => {
    // pg_attribute.attname is PostgreSQL `name`, so array_agg(attname) is
    // name[] (OID 1003). node-postgres leaves that result as wire text. The
    // production query casts attname::text, yielding text[] (OID 1009), but
    // the normalizer also protects callers from the uncast/raw shape.
    const rawNameArray = createPgInt8SafeTypes().getTypeParser(1003)('{"project_id"}');
    expect(rawNameArray).toBe('{"project_id"}');
    expect(normalizePgTextArray(rawNameArray, "fk.columns")).toEqual(["project_id"]);

    const decodedTextArray = createPgInt8SafeTypes().getTypeParser(1009)('{"project_id"}');
    expect(decodedTextArray).toEqual(["project_id"]);
    expect(normalizePgTextArray(decodedTextArray, "fk.columns")).toEqual(["project_id"]);

    expect(normalizePgTextArray('{"owner_key","project_id"}', "fk.columns")).toEqual([
      "owner_key",
      "project_id",
    ]);
    expect(normalizePgTextArray('["owner_key","project_id"]', "fk.columns")).toEqual([
      "owner_key",
      "project_id",
    ]);
  });

  it("rejects a non-array catalog value instead of allowing join() to fail later", () => {
    expect(() => normalizePgTextArray("project_id", "fk.columns")).toThrow(/not a text\[\]/);
    expect(() => normalizePgTextArray(["project_id", 1], "fk.columns")).toThrow(/not a text\[\]/);
  });
});
