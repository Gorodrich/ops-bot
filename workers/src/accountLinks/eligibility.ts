import type { RolesSetting } from "../settings";
import type { AuthoriseEligibility } from "./domain";

export function eligibilityFromRoles(memberRoles: string[], roles: RolesSetting): AuthoriseEligibility {
  return {
    hasHito: memberRoles.includes(roles.hito),
    hasKariSanka: memberRoles.includes(roles.kari_sanka),
  };
}

export function hasRole(memberRoles: string[], roleId: string): boolean {
  return memberRoles.includes(roleId);
}
