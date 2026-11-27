import type { ComponentProps } from "react";
import type { BlankStack } from "react-native-screen-transitions/expo-router";

type ChatStackRouter = NonNullable<
  ComponentProps<typeof BlankStack>["UNSTABLE_router"]
>;

export const chatStackRouter: ChatStackRouter = (router) => ({
  getStateForAction(state, action, options) {
    if (
      action.type === "PRELOAD" &&
      action.payload &&
      "name" in action.payload &&
      action.payload.name === "chat/[key]"
    ) {
      const warm = state.routes
        .slice(state.index + 1)
        .find((route) => route.name === "chat/[key]");
      if (warm) return { state, affectedRouteKey: warm.key };
    }

    // A popped route still belongs to BlankStack until its close finishes.
    // Only never-opened routes may be promoted from the preload slot.
    return router.getStateForAction(state, action, options);
  },
});
