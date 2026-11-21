import { z } from "zod";

export const locationTag = "boop:location";
export const sharedLocation = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type SharedLocation = z.infer<typeof sharedLocation>;

export function locationText(location: SharedLocation) {
  return `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
}

export function locationFromText(text: string) {
  if (!/^-?\d{1,2}\.\d{6}, -?\d{1,3}\.\d{6}$/u.test(text)) return;
  const [latitude, longitude] = text.split(", ").map(Number);
  return sharedLocation.safeParse({ latitude, longitude }).data;
}
