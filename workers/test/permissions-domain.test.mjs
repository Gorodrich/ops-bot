import { describe, expect, it } from "vitest";
import { isPermissionApproved } from "../src/permissions/domain";

describe("isPermissionApproved（記名許可・類型B・§5.4）", () => {
  it("必要人数ちょうどで成立する", () => {
    expect(isPermissionApproved(2, 2)).toBe(true);
  });
  it("必要人数未満では成立しない", () => {
    expect(isPermissionApproved(1, 2)).toBe(false);
  });
  it("必要人数を超えても成立する", () => {
    expect(isPermissionApproved(3, 2)).toBe(true);
  });
});
