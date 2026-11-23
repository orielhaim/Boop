import { createContext, useContext } from "react";

export const TabFabVisibility = createContext<{
  setChatsVisible: (visible: boolean) => void;
  setPeopleVisible: (visible: boolean) => void;
} | null>(null);

export function useTabFabVisibility() {
  return useContext(TabFabVisibility);
}
