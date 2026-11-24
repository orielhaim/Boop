export const profilePhotoPolicies = ["everyone", "contacts", "nobody"] as const;
export type ProfilePhotoPolicy = (typeof profilePhotoPolicies)[number];

export function photoAllowed(
  policy: ProfilePhotoPolicy,
  blocked: boolean,
  contact: boolean,
) {
  return (
    !blocked && (policy === "everyone" || (policy === "contacts" && contact))
  );
}
