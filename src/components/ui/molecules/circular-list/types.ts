import type { ReactNode } from "react";
import type { FlatListProps } from "react-native";

export interface ICircularList<T> extends Pick<
  FlatListProps<T>,
  "keyExtractor" | "onViewableItemsChanged" | "viewabilityConfig"
> {
  data: T[];
  initialWidth: number;
  rtl: boolean;
  reduceMotion: boolean;
  renderItem: (item: T) => ReactNode;
}
