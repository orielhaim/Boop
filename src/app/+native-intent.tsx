import type { NativeIntent } from "expo-router";
import { acceptsLiveLink } from "@/services/local";

export const redirectSystemPath: NonNullable<
  NativeIntent["redirectSystemPath"]
> = ({ path, initial }) => (initial || acceptsLiveLink() ? path : null);
