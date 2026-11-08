import assert from 'node:assert/strict';

/** Derive required keys, primitive types and recursive array/object shape directly
 * from a capture. The facade's documented gap extension permits null scalars and
 * empty collections, never missing keys or a different non-null primitive type.
 * Private capture metadata is provenance, not insurance evidence or part of our service.
 */
export function assertShape(capture: unknown, actual: unknown, path = '$', nullableGaps = false): void {
  if (capture === null) return; // a null-only observation carries no non-null type evidence
  if (Array.isArray(capture)) {
    assert.ok(Array.isArray(actual), `${path}: expected array`);
    // Different captured records sometimes have additive optional fields. Every
    // observed record shape must be representable by every returned record.
    for (const item of actual) for (const sample of capture) assertShape(sample, item, `${path}[]`, nullableGaps);
  } else if (typeof capture === 'object') {
    assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual), `${path}: expected object`);
    for (const [key, value] of Object.entries(capture)) {
      if (key.startsWith('_')) continue; // Capture annotations are outside the wire contract.
      assert.ok(Object.hasOwn(actual, key), `${path}.${key}: missing required key`);
      assertShape(value, (actual as Record<string, unknown>)[key], `${path}.${key}`, nullableGaps);
    }
  } else if (!(nullableGaps && actual === null)) {
    assert.equal(typeof actual, typeof capture, `${path}: wrong primitive type`);
  }
}

export function assertPremiums(captures: { id: string; premium: number }[], response: { plans: { id: string; premium: number }[] }, gapHeader: string) {
  let equal = 0, absent = 0;
  for (const captured of captures) {
    const actual = response.plans.find(p => p.id === captured.id);
    if (actual) {
      assert.equal(Math.round(actual.premium * 100), Math.round(captured.premium * 100), `${captured.id}: premium differs`);
      equal++;
    } else {
      assert.ok(gapHeader.includes(`public_plan_unavailable:${captured.id}`), `${captured.id}: absence must be in gaps`);
      absent++;
    }
  }
  assert.equal(equal, 43, '43 public captured plans must match');
  assert.equal(absent, 7, '7 carrier-only captured plans must be absent');
  return { equal, absent };
}
