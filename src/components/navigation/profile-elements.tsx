import type { ComponentProps } from "react";
import Transition from "react-native-screen-transitions";
import { profileElementId } from "@/core/marmot/conversation-route";
import { useTheme } from "@/theme";

export function ProfileElement({
  profile,
  part,
  ...props
}: Omit<ComponentProps<typeof Transition.Boundary>, "id"> & {
  profile?: string;
  part: Parameters<typeof profileElementId>[1];
}) {
  const { reduceMotion } = useTheme();
  return (
    <Transition.Boundary
      {...props}
      id={profileElementId(profile ?? "", part)}
      enabled={Boolean(profile) && !reduceMotion}
    />
  );
}
