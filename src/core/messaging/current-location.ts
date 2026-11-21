import type { AttachmentPickers } from "@kesha-antonov/react-native-chat";
import {
  Location,
  LocationAccuracy,
  LocationProfile,
  LocationProvider,
} from "expo-location/next";
import { Platform } from "react-native";
import { sharedLocation } from "./location";

export const locateForChat: NonNullable<
  AttachmentPickers["location"]
> = async () => {
  try {
    const existing = await Location.getForegroundPermissions();
    const permission = existing.granted
      ? existing
      : await Location.requestForegroundPermissions();
    if (!permission.granted) return { status: "denied" };
    if (Platform.OS === "android")
      Location.setLocationProvider(LocationProvider.Android());
    const position = await Location.getPosition({
      maxCachedAge: 15,
      timeout: 12,
      profile:
        permission.accuracy === LocationAccuracy.FULL
          ? LocationProfile.OTHER_NAVIGATION
          : LocationProfile.DEFAULT,
    });
    if (!position || Date.now() - position.timestamp > 30_000)
      return { status: "failed" };
    const coordinates = sharedLocation.safeParse(position.coordinates).data;
    return coordinates
      ? {
          status: "located",
          ...coordinates,
          accuracy: position.horizontalAccuracy ?? undefined,
        }
      : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
};
