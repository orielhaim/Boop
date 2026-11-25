import { createContext, useContext } from "react";

export const TabFabVisibility = createContext<{
  setChatsVisible: (visible: boolean) => void;
  peopleSection: "contacts" | "calls";
  setPeopleSection: (section: "contacts" | "calls") => void;
} | null>(null);

export function useTabFabVisibility() {
  return useContext(TabFabVisibility);
}
